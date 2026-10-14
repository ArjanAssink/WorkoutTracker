import { createHmac, timingSafeEqual } from "node:crypto";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext, type Timer } from "@azure/functions";
import { config } from "../config/index.js";
import { matchWorkout, routeFromStrava, toActivityRecord, toPhotoRecords, type StravaActivityRecord, type StravaPhotoRecord } from "../domain/strava.js";
import { isAuthorised } from "../http/auth.js";
import { json, ok, serverError, unauthorised } from "../http/responses.js";
import { authoriseUrl, CURSOR_KEY, StravaClient, StravaError } from "../strava/client.js";
import { getRepository, getRouteRepository, getSettingsRepository, getStravaRepository } from "./shared.js";

/**
 * Strava: connect once, then sync.
 *
 *   GET  /api/strava/connect?key=   (or x-api-key)  → redirects to Strava's consent page
 *   GET  /api/strava/callback       Strava returns here with a code; tokens go to the settings table
 *   GET  /api/strava/status         connected? last sync? counts
 *   POST /api/strava/sync[?since=YYYY-MM-DD]   pull activities and their photos since the cursor
 *   GET  /api/photos?days=|from=&to=           the photos, newest first — what the pages read
 *
 * A timer syncs daily. Activities are matched to the Apple Health workouts by start time;
 * nothing is created on the workout side, Strava only decorates.
 */

const RATE_SAFE_PHOTO_CALLS = 150;

function stateFor(secret: string): string {
  return createHmac("sha256", secret).update("strava-oauth").digest("hex").slice(0, 32);
}

function callbackUrl(request: HttpRequest): string {
  const base = config().publicUrl ?? new URL(request.url).origin;
  return `${base.replace(/\/$/, "")}/api/strava/callback`;
}

async function client(): Promise<StravaClient> {
  const { strava } = config();
  if (!strava) throw new StravaError("Strava is not configured — set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET");
  return new StravaClient(strava.clientId, strava.clientSecret, await getSettingsRepository());
}

/** The connect link is opened in a browser, which cannot send a header, so `?key=` is accepted there too. */
function authorisedByQuery(request: HttpRequest, expectedKey: string): boolean {
  const presented = new URL(request.url).searchParams.get("key");
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8"), b = Buffer.from(expectedKey, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function connect(request: HttpRequest): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey) && !authorisedByQuery(request, settings.ingestApiKey)) return unauthorised();
  if (!settings.strava) return json(503, { error: "Strava is not configured — set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET" });
  return { status: 302, headers: { location: authoriseUrl(settings.strava.clientId, callbackUrl(request), stateFor(settings.ingestApiKey)) } };
}

export async function callback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  const q = new URL(request.url).searchParams;
  if (q.get("error")) return { status: 400, body: `Strava said: ${q.get("error")}` };
  if (q.get("state") !== stateFor(settings.ingestApiKey)) return { status: 400, body: "State mismatch — start again from /api/strava/connect" };
  const code = q.get("code");
  if (!code) return { status: 400, body: "No code in the callback" };
  try {
    const t = await (await client()).exchangeCode(code);
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: `<!doctype html><meta charset="utf-8"><title>Strava connected</title><body style="font:15px system-ui;padding:40px"><h2>Strava connected${t.athleteName ? ` — ${t.athleteName}` : ""}</h2><p>The first sync runs now; later ones run daily. <a href="/api/map">Back to the routes</a>.</p>` };
  } catch (error) {
    context.error("Strava callback failed", error);
    return { status: 502, body: error instanceof Error ? error.message : "Strava token exchange failed" };
  }
}

export interface SyncResult {
  activities: number;
  matched: number;
  photos: number;
  routes: number;
  cursor: string;
  rateLimited: boolean;
}

/** Everything since the cursor (or `since`), activity by activity; stops early when the rate limit nears. */
export async function sync(context: InvocationContext, since?: Date): Promise<SyncResult> {
  const c = await client();
  const settings = await getSettingsRepository();
  const cursorIso = since?.toISOString() ?? (await settings.get<string>(CURSOR_KEY)) ?? "2010-01-01T00:00:00Z";
  const after = Math.floor(Date.parse(cursorIso) / 1000);
  const activities = await c.activitiesAfter(after);
  if (activities.length === 0) return { activities: 0, matched: 0, photos: 0, routes: 0, cursor: cursorIso, rateLimited: false };

  const first = Date.parse(activities[0]!.start_date), last = Date.parse(activities[activities.length - 1]!.start_date);
  const workouts = await (await getRepository()).listAll({ from: new Date(first - 3_600_000), to: new Date(last + 86_400_000) });
  const existingRoutes = new Set((await (await getRouteRepository()).list(new Date(first - 3_600_000), new Date(last + 86_400_000))).map((r) => r.workoutId));

  const records: StravaActivityRecord[] = [], photos: StravaPhotoRecord[] = [], routes = [];
  let matched = 0, photoCalls = 0, rateLimited = false, cursor = cursorIso;
  for (const a of activities) {
    const workout = matchWorkout(a, workouts);
    if (workout) matched++;
    records.push(toActivityRecord(a, workout));
    if (workout && !existingRoutes.has(workout.id)) { const r = routeFromStrava(a, workout); if (r) routes.push(r); }
    if ((a.total_photo_count ?? 0) > 0) {
      if (photoCalls >= RATE_SAFE_PHOTO_CALLS) { rateLimited = true; break; }
      try { photoCalls++; photos.push(...toPhotoRecords(a, await c.photos(a.id), workout)); }
      catch (error) { if (error instanceof StravaError && error.status === 429) { rateLimited = true; break; } context.warn(`Photos for ${a.id} failed: ${error instanceof Error ? error.message : error}`); }
    }
    cursor = new Date(a.start_date).toISOString();
  }
  const strava = await getStravaRepository();
  await strava.upsertActivities(records);
  if (photos.length) await strava.upsertPhotos(photos);
  if (routes.length) await (await getRouteRepository()).upsertMany(routes);
  // The cursor sits one second before the last activity taken, so a re-run picks it up again and nothing is skipped.
  await settings.set(CURSOR_KEY, new Date(Date.parse(cursor) - 1000).toISOString());
  context.log(`Strava sync: ${records.length} activities, ${matched} matched, ${photos.length} photos, ${routes.length} routes${rateLimited ? " (stopped at the rate limit; run again later)" : ""}`);
  return { activities: records.length, matched, photos: photos.length, routes: routes.length, cursor, rateLimited };
}

export async function syncHttp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  const sinceParam = new URL(request.url).searchParams.get("since");
  const since = sinceParam ? new Date(`${sinceParam}T00:00:00Z`) : undefined;
  if (since && Number.isNaN(since.getTime())) return json(400, { error: "'since' is not a valid date" });
  try {
    return ok(await sync(context, since));
  } catch (error) {
    context.error("Strava sync failed", error);
    return json(error instanceof StravaError ? 502 : 500, { error: error instanceof Error ? error.message : "Strava sync failed" });
  }
}

export async function status(request: HttpRequest): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  if (!settings.strava) return ok({ configured: false, connected: false });
  const store = await getSettingsRepository();
  const tokens = await (await client()).tokens();
  return ok({ configured: true, connected: Boolean(tokens), athlete: tokens?.athleteName ?? null, cursor: (await store.get<string>(CURSOR_KEY)) ?? null, connectUrl: "/api/strava/connect" });
}

export async function photosHttp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  try {
    const q = new URL(request.url).searchParams;
    const to = new Date(Date.now() + 86_400_000);
    const from = q.get("from") ? new Date(`${q.get("from")}T00:00:00Z`) : new Date("2010-01-01T00:00:00Z");
    const photos = (await (await getStravaRepository()).photos(from, to)).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    return ok({ count: photos.length, photos });
  } catch (error) {
    context.error("Failed to list photos", error);
    return serverError("Failed to list photos");
  }
}

export async function stravaTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  if (!config().strava) return;
  try { await sync(context); } catch (error) { context.error("Strava daily sync failed", error); }
}

app.http("stravaConnect", { route: "api/strava/connect", methods: ["GET"], authLevel: "anonymous", handler: connect });
app.http("stravaCallback", { route: "api/strava/callback", methods: ["GET"], authLevel: "anonymous", handler: callback });
app.http("stravaStatus", { route: "api/strava/status", methods: ["GET"], authLevel: "anonymous", handler: status });
app.http("stravaSync", { route: "api/strava/sync", methods: ["POST"], authLevel: "anonymous", handler: syncHttp });
app.http("photos", { route: "api/photos", methods: ["GET"], authLevel: "anonymous", handler: photosHttp });
app.timer("stravaDailySync", { schedule: "0 20 3 * * *", handler: stravaTimer });
