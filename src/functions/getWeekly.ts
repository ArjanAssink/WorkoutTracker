import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { reviewWeeks, TYPICAL_WINDOW_WEEKS } from "../domain/goals.js";
import { startOfIsoWeek } from "../domain/summary.js";
import { isAuthorised } from "../http/auth.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { getRepository } from "./shared.js";

/**
 * `GET /api/weekly?weeks=12&until=YYYY-MM-DD`
 *
 * Each ISO week in the window reviewed against the goals, plus the typical week and the
 * current streak. This is what the Monday summary and the dashboard's goal tracker read.
 *
 * `until` defaults to the end of the **last complete** week — on a Monday morning that is
 * yesterday, so the review covers the week that just finished rather than the empty one
 * that just started. Pass `until=today` to include the week in progress.
 */
const DEFAULT_WEEKS = 12;
const MAX_WEEKS = 104;

export async function getWeekly(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();

  const params = new URL(request.url).searchParams;

  const weeksParam = params.get("weeks");
  const weeks = weeksParam === null ? DEFAULT_WEEKS : Number(weeksParam);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    return badRequest(`'weeks' must be an integer between 1 and ${MAX_WEEKS}`);
  }

  const { from, to } = resolveWindow(params.get("until"), weeks, new Date());
  if (!from) return badRequest(`'until' is not a valid date`);

  try {
    const repository = await getRepository();
    // Load the comparison window behind the first week as well, so every returned week
    // has a "typical" to stand against.
    const leadIn = new Date(from.getTime() - TYPICAL_WINDOW_WEEKS * 7 * 86_400_000);
    const workouts = await repository.listAll({ from: leadIn, to });
    return ok(reviewWeeks(workouts, settings.goals, from, to, { leadInWeeks: TYPICAL_WINDOW_WEEKS }));
  } catch (error) {
    context.error("Failed to build weekly review", error);
    return serverError("Failed to build weekly review");
  }
}

/** [Monday `weeks` ago, Monday after the target week) — ISO-week aligned on both ends. */
export function resolveWindow(
  until: string | null,
  weeks: number,
  now: Date,
): { from: Date | undefined; to: Date } {
  let anchor: Date;
  if (until === null) {
    // Last complete week: the Monday of this week is the exclusive end.
    anchor = new Date(startOfIsoWeek(now).getTime() - 1);
  } else if (until === "today") {
    anchor = now;
  } else {
    anchor = new Date(/^\d{4}-\d{2}-\d{2}$/.test(until) ? `${until}T12:00:00Z` : until);
    if (Number.isNaN(anchor.getTime())) return { from: undefined, to: now };
  }
  const to = new Date(startOfIsoWeek(anchor).getTime() + 7 * 86_400_000);
  const from = new Date(to.getTime() - weeks * 7 * 86_400_000);
  return { from, to };
}

app.http("getWeekly", {
  route: "api/weekly",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getWeekly,
});
