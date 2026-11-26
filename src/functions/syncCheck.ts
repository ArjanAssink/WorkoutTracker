import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { displayName } from "../domain/activityType.js";
import { reconcile } from "../domain/syncCheck.js";
import { isAuthorised } from "../http/auth.js";
import { BodyParseError, readJsonBody } from "../http/jsonBody.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { HealthAutoExportError, parseHealthAutoExportBatch } from "../ingest/healthAutoExport.js";
import { getRepository } from "./shared.js";

/**
 * POST /api/sync/check — read-only. Takes the same body as the Health Auto Export ingest
 * (the native app sends its last 30 days) and answers, per workout, whether the server has
 * it. Writes nothing and stamps no push, so checking never looks like a sync.
 */
export async function syncCheck(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyParseError) return badRequest(error.message);
    throw error;
  }

  let parsed;
  try {
    parsed = parseHealthAutoExportBatch(body);
  } catch (error) {
    if (error instanceof HealthAutoExportError) return badRequest(error.message);
    throw error;
  }

  // Parsed workouts keep their order; the skipped ones carry their index.
  const rejected = new Set(parsed.skipped.map((s) => s.index));
  const total = parsed.workouts.length + parsed.skipped.length;
  const indexOf = Array.from({ length: total }, (_, i) => i).filter((i) => !rejected.has(i));

  const workouts = parsed.workouts;
  let stored: Awaited<ReturnType<Awaited<ReturnType<typeof getRepository>>["listAll"]>> = [];
  if (workouts.length > 0) {
    const from = new Date(Math.min(...workouts.map((w) => Date.parse(w.startedAt))) - 3_600_000);
    const to = new Date(Math.max(...workouts.map((w) => Date.parse(w.endedAt))) + 3_600_000);
    try {
      stored = await (await getRepository()).listAll({ from, to });
    } catch (error) {
      context.error("Sync check could not read workouts", error);
      return serverError("Failed to read workout history");
    }
  }

  const result = reconcile(workouts, stored);
  const rows = [
    ...result.rows.map((row, i) => ({ index: indexOf[i], ...row, name: displayName(row.activityType) })),
    ...parsed.skipped.map((s) => ({ index: s.index, status: "rejected" as const, reason: s.reason })),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const count = (status: string) => rows.filter((r) => r.status === status).length;

  return ok({
    counts: { sent: total, stored: count("stored"), merged: count("merged"), missing: count("missing"), rejected: count("rejected") },
    rows,
    serverOnly: result.serverOnly.map((s) => ({ ...s, name: displayName(s.activityType) })),
  });
}

app.http("syncCheck", { route: "api/sync/check", methods: ["POST"], authLevel: "anonymous", handler: syncCheck });
