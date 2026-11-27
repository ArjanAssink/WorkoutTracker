import { app, type HttpRequest, type HttpResponseInit, type InvocationContext, type Timer } from "@azure/functions";
import { config } from "../config/index.js";
import { reviewWeeks, TYPICAL_WINDOW_WEEKS } from "../domain/goals.js";
import { isRestWeekLabel } from "../domain/weekRecovery.js";
import { composeWeeklySummary, restWeekFocus } from "../domain/weeklySummary.js";
import { isAuthorised } from "../http/auth.js";
import { json, ok, unauthorised } from "../http/responses.js";
import { resolveWindow } from "./getWeekly.js";
import { notify } from "./notifications.js";
import { getRepository, getSettingsRepository } from "./shared.js";
import { readComparisonFrom } from "./weeklyComparison.js";

/**
 * The Monday-morning summary, delivered to Telegram and kept as a notification.
 *
 * Two entry points share one implementation: a timer for the real schedule, and an
 * authenticated HTTP endpoint so the message can be previewed or sent on demand without
 * waiting a week to find out it is wrong.
 */

const REVIEW_WEEKS = 12;
const REST_HISTORY_WEEKS = 52;
const TIMEZONE = "Europe/Amsterdam";
const SEND_HOUR_LOCAL = 10;

/**
 * Builds the summary for the last complete week.
 * `now` is injectable so the HTTP preview can ask "what would Monday have said?".
 */
export async function buildSummary(now: Date): Promise<{ text: string; weekStart: string | undefined }> {
  const settings = config();
  const { from, to } = resolveWindow(null, REVIEW_WEEKS, now);
  const repository = await getRepository();
  const historyFrom = resolveWindow(null, REST_HISTORY_WEEKS, now).from!;
  const leadIn = new Date(historyFrom.getTime() - TYPICAL_WINDOW_WEEKS * 7 * 86_400_000);
  const [workouts, annotations, comparisonFrom] = await Promise.all([
    repository.listAll({ from: leadIn, to }),
    (await getSettingsRepository()).datedRange<import("../domain/weekAnnotation.js").WeekAnnotation>("week.annotation.", historyFrom.toISOString().slice(0, 10), new Date(to.getTime() + 7 * 86400000).toISOString().slice(0, 10)),
    readComparisonFrom(),
  ]);
  const options = { leadInWeeks: TYPICAL_WINDOW_WEEKS, ...(comparisonFrom ? { comparisonFrom } : {}) };
  const report = reviewWeeks(workouts, settings.goalSchedule, from!, to, options);
  const history = reviewWeeks(workouts, settings.goalSchedule, historyFrom, to, options);
  const thisWeek = annotations[to.toISOString().slice(0, 10)];
  let text = composeWeeklySummary(report, { weeks: history.weeks, annotations });
  if (isRestWeekLabel(thisWeek) && thisWeek) text += ["", "", "😴 <b>This week: rest / recovery</b>", ...restWeekFocus(thisWeek)].join("\n");
  return { text, weekStart: report.current?.weekStart };
}

/**
 * Timer. Linux Flex Consumption does not honour WEBSITE_TIME_ZONE, so the schedule is in
 * UTC and fires at both 08:00 and 09:00 on Mondays; the handler then sends only when it is
 * 10:00 in Amsterdam. That is what keeps the time right on both sides of a DST change.
 */
export async function weeklyTimer(timer: Timer, context: InvocationContext): Promise<void> {
  const now = new Date();
  const localHour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: TIMEZONE }).format(now),
  );
  if (localHour !== SEND_HOUR_LOCAL && !timer.isPastDue) {
    context.log(`Skipping: ${localHour}:00 in ${TIMEZONE}, waiting for ${SEND_HOUR_LOCAL}:00`);
    return;
  }
  if (!config().telegram) {
    context.warn("Weekly summary not sent: Telegram is not configured");
    return;
  }
  const { text, weekStart } = await buildSummary(now);
  await notify({ kind: "weekly", html: text, ...(weekStart ? { meta: { weekStart } } : {}) }, context, "Weekly summary", now);
}

/**
 * `GET  /api/notify/weekly`            preview the message as text
 * `POST /api/notify/weekly`            send it now
 * `?for=YYYY-MM-DD`                    build it as if run on that date
 */
export async function weeklyHttp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();

  const forParam = new URL(request.url).searchParams.get("for");
  const now = forParam ? new Date(`${forParam}T12:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) return json(400, { error: "'for' is not a valid date" });

  const { text, weekStart } = await buildSummary(now);

  if (request.method === "GET") {
    return { status: 200, body: text, headers: { "content-type": "text/plain; charset=utf-8" } };
  }

  if (!settings.telegram) {
    return json(503, { error: "Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
  }
  try {
    const sent = await notify({ kind: "weekly", html: text, ...(weekStart ? { meta: { weekStart } } : {}) }, context, "Weekly summary");
    return ok({ sent: true, weekStart, notificationId: sent.id });
  } catch (error) {
    context.error("Failed to send weekly summary", error);
    return json(502, { error: error instanceof Error ? error.message : "Failed to send" });
  }
}

app.timer("weeklySummaryTimer", {
  // Mondays at 08:00 and 09:00 UTC — see weeklyTimer for why both.
  schedule: "0 0 8,9 * * 1",
  handler: weeklyTimer,
});

app.http("weeklySummary", {
  route: "api/notify/weekly",
  methods: ["GET", "POST"],
  authLevel: "anonymous", // x-api-key, as everywhere else.
  handler: weeklyHttp,
});
