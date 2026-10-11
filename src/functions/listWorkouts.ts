import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { normaliseActivityType } from "../domain/activityType.js";
import { RangeError_, resolveRange } from "../http/dateRange.js";
import { isAuthorised } from "../http/auth.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { getRepository } from "./shared.js";

/**
 * Rows per request. Raised from 2,000 once the history passed it: the list is oldest-first,
 * so a cap drops the *newest* rows, which is the worst possible truncation for a chart.
 * Ten thousand is roughly three years of this user's daily volume beyond today's total.
 */
const MAX_LIMIT = 10000;

/**
 * `GET /api/workouts?from=&to=&days=&activityType=&limit=`
 *
 * The raw record feed, oldest first. Defaults to the last 90 days.
 */
export async function listWorkouts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();

  const params = new URL(request.url).searchParams;

  let range;
  try {
    range = resolveRange(params);
  } catch (error) {
    if (error instanceof RangeError_) return badRequest(error.message);
    throw error;
  }

  const limitParam = params.get("limit");
  const limit = limitParam === null ? MAX_LIMIT : Number(limitParam);
  if (!Number.isFinite(limit) || limit <= 0) return badRequest(`'limit' must be a positive number`);

  const activityParam = params.get("activityType");

  try {
    const repository = await getRepository();
    const workouts = await repository.listAll(range, {
      limit: Math.min(limit, MAX_LIMIT),
      ...(activityParam ? { activityType: normaliseActivityType(activityParam) } : {}),
    });
    return ok({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      count: workouts.length,
      // Signals that the cap was hit, so a caller can narrow the range rather than
      // silently analysing a truncated history.
      truncated: workouts.length >= Math.min(limit, MAX_LIMIT),
      workouts,
    });
  } catch (error) {
    context.error("Failed to list workouts", error);
    return serverError("Failed to list workouts");
  }
}

app.http("listWorkouts", {
  route: "api/workouts",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: listWorkouts,
});
