import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { normaliseActivityType } from "../domain/activityType.js";
import { MAX_HR_WINDOW_DAYS, trailingMaxHeartRate, withObservedMax } from "../domain/effort.js";
import { summarise, type Granularity } from "../domain/summary.js";
import { RangeError_, resolveRange } from "../http/dateRange.js";
import { isAuthorised } from "../http/auth.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { getRepository } from "./shared.js";

const GRANULARITIES: Granularity[] = ["day", "week", "month", "year"];

/**
 * `GET /api/summary?from=&to=&days=&granularity=&activityType=`
 *
 * The retrospective view: per-period totals, a per-activity breakdown, active days and the
 * longest streak. This is what answers "how much have I actually trained lately?".
 */
export async function getSummary(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();

  const params = new URL(request.url).searchParams;

  const granularityParam = (params.get("granularity") ?? "week") as Granularity;
  if (!GRANULARITIES.includes(granularityParam)) {
    return badRequest(`'granularity' must be one of: ${GRANULARITIES.join(", ")}`);
  }

  let range;
  try {
    range = resolveRange(params);
  } catch (error) {
    if (error instanceof RangeError_) return badRequest(error.message);
    throw error;
  }

  const activityParam = params.get("activityType");

  try {
    const repository = await getRepository();
    const workouts = await repository.listAll(range, {
      ...(activityParam ? { activityType: normaliseActivityType(activityParam) } : {}),
    });
    // The max-HR reference in force at the end of the range — observed over the trailing
    // year, else the configured fallback — so the dashboard can draw it as a line.
    const windowStart = new Date(range.to.getTime() - MAX_HR_WINDOW_DAYS * 86_400_000);
    const history = windowStart < range.from ? await repository.listAll({ from: windowStart, to: range.to }) : workouts;
    const observed = trailingMaxHeartRate(history, range.to);
    const effective = withObservedMax(settings.profile, observed);
    return ok({
      ...summarise(workouts, granularityParam, range.from, range.to),
      profile: { restingHeartRate: settings.profile.restingHeartRate, maxHeartRate: settings.profile.maxHeartRate },
      referenceMaxHeartRate: { bpm: effective.maxHeartRate, observed: effective.maxHeartRate !== settings.profile.maxHeartRate || observed === effective.maxHeartRate },
    });
  } catch (error) {
    context.error("Failed to build summary", error);
    return serverError("Failed to build summary");
  }
}

app.http("getSummary", {
  route: "api/summary",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getSummary,
});
