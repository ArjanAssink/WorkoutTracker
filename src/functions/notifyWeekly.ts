import { app, type HttpRequest, type HttpResponseInit, type InvocationContext, type Timer } from "@azure/functions";
import { config } from "../config/index.js";
import { reviewWeeks, TYPICAL_WINDOW_WEEKS } from "../domain/goals.js";
import { composeWeeklySummary } from "../domain/weeklySummary.js";
import { isAuthorised } from "../http/auth.js";
import { json, ok, unauthorised } from "../http/responses.js";
import { resolveWindow } from "./getWeekly.js";
import { getRepository } from "./shared.js";

/**
 * The Monday-morning summary, delivered to Telegram.
 *
 * Two entry points share one implementation: a timer for the real schedule, and an
 * authenticated HTTP endpoint so the message can be previewed or sent on demand without
 * waiting a week to find out it is wrong.
 */

const REVIEW_WEEKS = 12;
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
  const leadIn = new Date(from!.getTime() - TYPICAL_WINDOW_WEEKS * 7 * 86_400_000);
  const workouts = await repository.listAll({ from: leadIn, to });
  const report = reviewWeeks(workouts, settings.goals, from!, to, { leadInWeeks: TYPICAL_WINDOW_WEEKS });
  return { text: composeWeeklySummary(report), weekStart: report.current?.weekStart };
}

export async function sendTelegram(text: string, context: InvocationContext, what = "Weekly summary"): Promise<void> {
  const { telegram } = config();
  if (!telegram) throw new Error("Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");

  const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    // Telegram's error body says what is wrong (bad chat id, HTML parse error…); the
    // token is in the URL, never in the message, so this is safe to log.
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram responded ${response.status}: ${body.slice(0, 300)}`);
  }
  context.log(`${what} sent to Telegram`);
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
  const { text } = await buildSummary(now);
  await sendTelegram(text, context);
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
    await sendTelegram(text, context);
    return ok({ sent: true, weekStart });
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
