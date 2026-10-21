import { app, type HttpRequest, type HttpResponseInit, type InvocationContext, type Timer } from "@azure/functions";
import { config } from "../config/index.js";
import { isAuthorised } from "../http/auth.js";
import { ok, unauthorised } from "../http/responses.js";
import { sendTelegram } from "./notifyWeekly.js";
import { getSettingsRepository } from "./shared.js";

/**
 * A dead man's switch for the phone's automations. There are two: the workout batch and
 * the health-metrics batch (sleep, heart rate, steps). Each successful push stamps its own
 * key in the settings table; a daily timer looks at both and, when either has been silent
 * for three days, says so on Telegram. Silence from the phone otherwise looks exactly
 * like a quiet week, or a night with no sleep data.
 *
 *   GET /api/notify/stale   last push of each kind, how old, whether an alert would go out
 */

export type PushKind = "workouts" | "metrics";
const LAST_PUSH_KEY = (kind: PushKind) => `ingest.lastPush.${kind}`;
const ALERTED_KEY = "ingest.staleAlertedAt";
export const STALE_AFTER_DAYS = 3;
/** Once alerted, nag again only after this many more days of silence. */
const REALERT_AFTER_DAYS = 3;

export async function recordPush(kind: PushKind, source: string, context: InvocationContext): Promise<void> {
  try {
    await (await getSettingsRepository()).set(LAST_PUSH_KEY(kind), { at: new Date().toISOString(), source });
  } catch (error) {
    context.warn(`Could not record the push: ${error instanceof Error ? error.message : error}`);
  }
}

export interface PushState { kind: PushKind; lastPush: { at: string; source: string } | null; daysSince: number | null; stale: boolean }
export interface StaleStatus {
  pushes: PushState[];
  alertedAt: string | null;
  wouldAlert: boolean;
}

export async function staleStatus(now = new Date()): Promise<StaleStatus> {
  const settings = await getSettingsRepository();
  const pushes: PushState[] = [];
  for (const kind of ["workouts", "metrics"] as PushKind[]) {
    const last = (await settings.get<{ at: string; source: string }>(LAST_PUSH_KEY(kind))) ?? null;
    const daysSince = last ? (now.getTime() - Date.parse(last.at)) / 86_400_000 : null;
    // No stamp at all means the feature is new, not that the phone is silent: a kind counts only once it has been seen.
    pushes.push({ kind, lastPush: last, daysSince: daysSince === null ? null : Math.round(daysSince * 10) / 10, stale: last !== null && daysSince! >= STALE_AFTER_DAYS });
  }
  const alertedAt = (await settings.get<string>(ALERTED_KEY)) ?? null;
  const sinceAlert = alertedAt ? (now.getTime() - Date.parse(alertedAt)) / 86_400_000 : Infinity;
  return { pushes, alertedAt, wouldAlert: pushes.some((p) => p.stale) && sinceAlert >= REALERT_AFTER_DAYS };
}

export async function staleTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  const now = new Date();
  const s = await staleStatus(now);
  if (!s.wouldAlert) { context.log(`Push watch: ${s.pushes.map((p) => `${p.kind} ${p.lastPush?.at ?? "never"} (${p.daysSince ?? "—"} d)`).join(", ")}`); return; }
  if (!config().telegram) { context.warn("Stale-data alert not sent: Telegram is not configured"); return; }
  const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const quiet = s.pushes.filter((p) => p.stale);
  const names: Record<PushKind, string> = { workouts: "workout export", metrics: "health-metrics export (sleep, heart rate, steps)" };
  const lines = quiet.map((p) => `• the <b>${names[p.kind]}</b> — last seen ${when(p.lastPush!.at)}, ${Math.floor(p.daysSince!)} days ago`);
  await sendTelegram(
    `📵 <b>No data for ${Math.floor(Math.max(...quiet.map((p) => p.daysSince!)))} days</b> from:\n${lines.join("\n")}\nThe automation has probably stopped running: open the shortcut on the phone and run it once; if it fails, check the automation is still enabled.`,
    context, "Stale-data alert",
  );
  await (await getSettingsRepository()).set(ALERTED_KEY, now.toISOString());
}

export async function staleHttp(request: HttpRequest): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  return ok(await staleStatus());
}

app.timer("staleDataTimer", { schedule: "0 30 7 * * *", handler: staleTimer });
app.http("staleStatus", { route: "api/notify/stale", methods: ["GET"], authLevel: "anonymous", handler: staleHttp });
