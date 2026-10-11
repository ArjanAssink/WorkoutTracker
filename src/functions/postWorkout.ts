import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { scoreWithReference } from "../domain/scoring.js";
import { buildWorkout, WorkoutValidationError } from "../domain/workout.js";
import { isAuthorised } from "../http/auth.js";
import { BodyParseError, readJsonBody } from "../http/jsonBody.js";
import { badRequest, created, ok, serverError, unauthorised } from "../http/responses.js";
import { PayloadError, parseShortcutPayload } from "../ingest/shortcutPayload.js";
import { announceMilestones } from "./notifyMilestones.js";
import { getRepository, observedMaxResolver } from "./shared.js";

/**
 * The endpoint an Apple Shortcut posts to when a workout ends.
 *
 * Responds 201 for a newly recorded workout and 200 when the same workout is posted again,
 * so a Shortcut that retries on a flaky connection cannot create duplicates. The response
 * echoes the stored record, which makes the Shortcut easy to debug from the phone.
 */
export async function postWorkout(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) {
    context.warn("Rejected workout post with missing or invalid API key");
    return unauthorised();
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyParseError) {
      return badRequest(error.message, error.received ? [`received: ${error.received}`] : []);
    }
    throw error;
  }

  try {
    const input = parseShortcutPayload(body);
    const repository = await getRepository();
    const observedMax = await observedMaxResolver(repository, [input]);
    const workout = buildWorkout(input, (w) => scoreWithReference(w, settings.profile, observedMax(w)));

    const { created: isNew } = await repository.upsert(workout);

    context.log(
      `${isNew ? "Recorded" : "Re-received"} ${workout.activityType} on ${workout.startedAt} ` +
        `(${Math.round(workout.durationSeconds / 60)} min, effort ${workout.effort})`,
    );

    // A new workout may have just made the week good, or set a record; say so now.
    if (isNew) await announceMilestones([workout], context);

    const payload = { status: isNew ? "created" : "duplicate", workout };
    return isNew ? created(payload) : ok(payload);
  } catch (error) {
    if (error instanceof PayloadError) return badRequest(error.message, error.issues);
    if (error instanceof WorkoutValidationError) return badRequest(error.message);
    context.error("Failed to record workout", error);
    return serverError("Failed to record workout");
  }
}

app.http("postWorkout", {
  route: "api/workouts",
  methods: ["POST"],
  authLevel: "anonymous", // Authenticated by the x-api-key header instead; see http/auth.ts.
  handler: postWorkout,
});
