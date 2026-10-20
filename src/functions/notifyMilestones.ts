import { app, type HttpRequest, type HttpResponseInit, type InvocationContext, type Timer } from "@azure/functions";
import { config } from "../config/index.js";
import { reviewWeeks, specFor, TYPICAL_WINDOW_WEEKS } from "../domain/goals.js";
import { composeCheckIn, detectMilestones, type Milestone } from "../domain/milestones.js";
import { startOfIsoWeek } from "../domain/summary.js";
import type { Workout } from "../domain/workout.js";
import { isAuthorised } from "../http/auth.js";
import { json, ok, unauthorised } from "../http/responses.js";
import { sendTelegram } from "./notifyWeekly.js";
import { getMilestoneRepository, getRepository } from "./shared.js";

/**
 * Messages between the Monday summaries.
 *
 * Milestones fire from the ingest paths the moment a workout lands: the week turning good
 * or perfect, a streak, a record. Each is announced once per week — the Health Auto Export
 * automation re-posts the same days every morning, so the "already sent" state is what
 * stops a Wednesday's good news from arriving every day until Sunday.
 *
 * The check-in is a timer: Thursday evening, where the week stands and what Sunday still
 * needs. Both have HTTP previews, as the weekly summary does.
 */

const TIMEZONE = "Europe/Amsterdam";
const LOOKBACK_WEEKS = 52;
const CHECKIN_HOUR_LOCAL = 18;
const WEEK_MS = 7 * 86_400_000;

export interface MilestoneEvaluation {
  weekStart: string;
  /** Not yet announced this week. */
  due: Milestone[];
  alreadySent: string[];
  /** What to record once `due` has gone out: the due keys and whatever they imply. */
  toMark: string[];
}

/** What the week in progress has earned, given that `arrived` just landed. */
export async function evaluateMilestones(arrived: Workout[], now: Date): Promise<MilestoneEvaluation> {
  const settings = config();
  const weekStart = startOfIsoWeek(now);
  const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
  const weekKey = weekStart.toISOString().slice(0, 10);
  const touched = arrived.filter((w) => { const t = Date.parse(w.startedAt); return t >= weekStart.getTime() && t < weekEnd.getTime(); });
  if (touched.length === 0) return { weekStart: weekKey, due: [], alreadySent: [], toMark: [] };

  const from = new Date(weekStart.getTime() - LOOKBACK_WEEKS * WEEK_MS);
  const history = await (await getRepository()).listAll({ from, to: weekEnd });
  const report = reviewWeeks(history, settings.goalSchedule, from, weekEnd);
  const found = detectMilestones({
    spec: specFor(settings.goalSchedule, weekKey), profile: settings.profile, weeks: report.weeks, streakWeeks: report.streakWeeks,
    history, arrived: touched, timeZone: TIMEZONE,
  });

  const sent = await (await getMilestoneRepository()).sentKeys(weekKey);
  const fresh = found.filter((m) => !sent.has(m.key));
  const implied = new Set(fresh.flatMap((m) => m.implies ?? []));
  const due = fresh.filter((m) => !implied.has(m.key));
  return { weekStart: weekKey, due, alreadySent: [...sent], toMark: [...new Set([...due.map((m) => m.key), ...implied])] };
}

/** Called from the ingest paths. Never throws: a failed message must not fail the ingest. */
export async function announceMilestones(arrived: Workout[], context: InvocationContext, now = new Date()): Promise<void> {
  try {
    const result = await evaluateMilestones(arrived, now);
    if (result.due.length === 0) return;
    if (!config().telegram) { context.log(`Milestones earned but Telegram is not configured: ${result.due.map((m) => m.key).join(", ")}`); return; }
    await sendTelegram(result.due.map((m) => m.text).join("\n\n"), context, `Milestones (${result.due.map((m) => m.key).join(", ")})`);
    await (await getMilestoneRepository()).markSent(result.weekStart, result.toMark, now.toISOString());
  } catch (error) {
    context.error("Milestone check failed", error);
  }
}

async function currentWeekWorkouts(now: Date): Promise<Workout[]> {
  const weekStart = startOfIsoWeek(now);
  return (await getRepository()).listAll({ from: weekStart, to: new Date(weekStart.getTime() + WEEK_MS) });
}

/**
 * `GET  /api/notify/milestones`   what the week in progress has earned, and what was already sent
 * `POST /api/notify/milestones`   send whatever is due now
 */
export async function milestonesHttp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  const now = new Date();
  const arrived = await currentWeekWorkouts(now);
  if (request.method === "GET") {
    const result = await evaluateMilestones(arrived, now);
    return ok({ weekStart: result.weekStart, due: result.due.map(({ key, text }) => ({ key, text })), alreadySent: result.alreadySent });
  }
  if (!settings.telegram) return json(503, { error: "Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
  const before = await evaluateMilestones(arrived, now);
  await announceMilestones(arrived, context, now);
  return ok({ weekStart: before.weekStart, sent: before.due.map((m) => m.key) });
}

/** The Thursday check-in text, or undefined when the week is already perfect. */
export async function buildCheckIn(now: Date): Promise<{ text: string | undefined; weekStart: string }> {
  const settings = config();
  const weekStart = startOfIsoWeek(now);
  const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
  const from = new Date(weekStart.getTime() - TYPICAL_WINDOW_WEEKS * WEEK_MS);
  const history = await (await getRepository()).listAll({ from, to: weekEnd });
  const report = reviewWeeks(history, settings.goalSchedule, from, weekEnd);
  const week = report.current;
  const weekKey = weekStart.toISOString().slice(0, 10);
  if (!week) return { text: undefined, weekStart: weekKey };
  return { text: composeCheckIn(week, specFor(settings.goalSchedule, weekKey), now, TIMEZONE, report.baseline?.medianSessions), weekStart: weekKey };
}

/** Thursdays at 16:00 and 17:00 UTC; sends only when it is 18:00 in Amsterdam (see weeklyTimer). */
export async function checkInTimer(timer: Timer, context: InvocationContext): Promise<void> {
  const now = new Date();
  const localHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: TIMEZONE }).format(now));
  if (localHour !== CHECKIN_HOUR_LOCAL && !timer.isPastDue) { context.log(`Skipping check-in: ${localHour}:00 in ${TIMEZONE}`); return; }
  if (!config().telegram) { context.warn("Check-in not sent: Telegram is not configured"); return; }
  const { text } = await buildCheckIn(now);
  if (!text) { context.log("Check-in skipped: the week is already perfect"); return; }
  await sendTelegram(text, context, "Check-in");
}

/**
 * `GET  /api/notify/checkin[?for=YYYY-MM-DD]`   preview the check-in as text
 * `POST /api/notify/checkin`                     send it now
 */
export async function checkInHttp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  const forParam = new URL(request.url).searchParams.get("for");
  const now = forParam ? new Date(`${forParam}T18:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) return json(400, { error: "'for' is not a valid date" });
  const { text, weekStart } = await buildCheckIn(now);
  if (request.method === "GET") {
    return { status: 200, body: text ?? "(nothing to say: the week is already perfect)", headers: { "content-type": "text/plain; charset=utf-8" } };
  }
  if (!settings.telegram) return json(503, { error: "Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
  if (!text) return ok({ sent: false, weekStart, reason: "week already perfect" });
  try {
    await sendTelegram(text, context, "Check-in");
    return ok({ sent: true, weekStart });
  } catch (error) {
    context.error("Failed to send check-in", error);
    return json(502, { error: error instanceof Error ? error.message : "Failed to send" });
  }
}

app.timer("checkInTimer", { schedule: "0 0 16,17 * * 4", handler: checkInTimer });
app.http("milestones", { route: "api/notify/milestones", methods: ["GET", "POST"], authLevel: "anonymous", handler: milestonesHttp });
app.http("checkIn", { route: "api/notify/checkin", methods: ["GET", "POST"], authLevel: "anonymous", handler: checkInHttp });
