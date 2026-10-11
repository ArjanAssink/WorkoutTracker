import { timingSafeEqual } from "node:crypto";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { renderCalendar } from "../domain/calendar.js";
import { displayName, normaliseActivityType } from "../domain/activityType.js";
import { RangeError_, resolveRange } from "../http/dateRange.js";
import { badRequest, json, serverError } from "../http/responses.js";
import { getRepository } from "./shared.js";

/**
 * `GET /api/calendar.ics?token=…` — an iCalendar feed of your workouts.
 *
 * Subscribe to it in any calendar app and each workout shows up as an event.
 *
 * Authentication is a token in the query string rather than the `x-api-key` header every
 * other endpoint uses, because a subscribing calendar client cannot send custom headers.
 * The token is read-only and separate from the ingest key: a subscription URL is stored by
 * the calendar app and synced across devices, so it must not grant write access.
 */

/** A year of events is a few hundred KB and covers what a calendar is useful for. */
const DEFAULT_DAYS = 365;
const MAX_EVENTS = 5000;

export async function calendarFeed(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const settings = config();

  if (!settings.calendarToken) {
    // Not configured is not the same as unauthorised; say so rather than inviting guesses.
    return json(404, { error: "Calendar feed is not enabled — set CALENDAR_TOKEN to turn it on" });
  }

  const url = new URL(request.url);
  if (!tokenMatches(url.searchParams.get("token"), settings.calendarToken)) {
    context.warn("Rejected calendar request with missing or invalid token");
    // No WWW-Authenticate: a calendar client must not pop a credential prompt at the user.
    return json(401, { error: "Invalid or missing token" });
  }

  let range;
  try {
    range = resolveRange(url.searchParams);
  } catch (error) {
    if (error instanceof RangeError_) return badRequest(error.message);
    throw error;
  }
  // resolveRange defaults to 90 days, which is too short for a calendar people scroll back in.
  if (!url.searchParams.get("from") && !url.searchParams.get("days")) {
    range = { from: new Date(range.to.getTime() - DEFAULT_DAYS * 86_400_000), to: range.to };
  }

  const activity = url.searchParams.get("activityType");

  try {
    const repository = await getRepository();
    const workouts = await repository.listAll(range, {
      limit: MAX_EVENTS,
      ...(activity ? { activityType: normaliseActivityType(activity) } : {}),
    });

    const body = renderCalendar(workouts, {
      // Name the calendar after the filter when there is one, so several subscribed
      // feeds are distinguishable in the client's sidebar.
      name: url.searchParams.get("name") || defaultName(activity),
      emoji: url.searchParams.get("emoji") !== "0",
    });

    context.log(`Served calendar feed: ${workouts.length} events`);

    return {
      status: 200,
      body,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="workouts.ics"',
        // Calendar clients poll on their own schedule; this keeps them from hammering it.
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    };
  } catch (error) {
    context.error("Failed to build calendar feed", error);
    return serverError("Failed to build calendar feed");
  }
}

function defaultName(activity: string | null): string {
  return activity ? `Workouts · ${displayName(normaliseActivityType(activity))}` : "Workouts";
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.http("calendarFeed", {
  route: "api/calendar.ics",
  methods: ["GET"],
  authLevel: "anonymous", // Authenticated by the query-string token above.
  handler: calendarFeed,
});
