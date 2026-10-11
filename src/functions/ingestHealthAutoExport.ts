import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { scoreWithReference } from "../domain/scoring.js";
import { buildWorkout, WorkoutValidationError, type Workout } from "../domain/workout.js";
import { isAuthorised } from "../http/auth.js";
import { BodyParseError, readJsonBody } from "../http/jsonBody.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { extractRecovery, extractWeightReadings, HealthAutoExportError, parseHealthAutoExportBatch, type BatchResult } from "../ingest/healthAutoExport.js";
import { dailyRecovery } from "../domain/recovery.js";
import { dailyWeights } from "../domain/bodyWeight.js";
import type { WorkoutInput } from "../domain/workout.js";
import { announceMilestones } from "./notifyMilestones.js";
import { getBodyWeightRepository, getRecoveryRepository, getRepository, observedMaxResolver } from "./shared.js";

/**
 * Batch ingest for the Health Auto Export app, which is how workouts get here
 * automatically — the Health app does not expose workouts to Shortcuts.
 *
 * Configure a REST API automation pointing at this route with an `x-api-key` header.
 */

/**
 * Cap per request. The app warns that an un-batched export can run to hundreds of
 * megabytes; this bounds the work and tells the user to turn on Batch Requests rather
 * than timing out halfway through writing.
 */
const MAX_WORKOUTS_PER_REQUEST = 5000;

export async function ingestHealthAutoExport(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) {
    context.warn("Rejected Health Auto Export post with missing or invalid API key");
    return unauthorised();
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyParseError) {
      // Echo what arrived: this endpoint is driven from a phone, where there is no other
      // way to see what the Shortcut actually sent.
      return badRequest(error.message, error.received ? [`received: ${error.received}`] : []);
    }
    throw error;
  }

  // Weight rides along under data.metrics when the automation exports it. It is optional
  // and independent of the workouts: a metrics-only payload is still a valid request.
  const weights = dailyWeights(extractWeightReadings(body), "health-auto-export");
  let weightsWritten = 0;
  if (weights.length > 0) {
    try {
      weightsWritten = await (await getBodyWeightRepository()).upsertMany(weights);
    } catch (error) {
      context.error("Failed to store body weight", error);
      return serverError("Failed to store body weight");
    }
  }

  // Sleep and the overnight signals ride along the same way; rows merge, so a batch with
  // only resting heart rate leaves the night already stored alone.
  const recovery = dailyRecovery(extractRecovery(body), "health-auto-export");
  let recoveryWritten = 0;
  if (recovery.length > 0) {
    try {
      recoveryWritten = await (await getRecoveryRepository()).upsertMany(recovery);
    } catch (error) {
      context.error("Failed to store recovery data", error);
      return serverError("Failed to store recovery data");
    }
  }

  let parsed: BatchResult;
  try {
    parsed = parseHealthAutoExportBatch(body);
  } catch (error) {
    if (error instanceof HealthAutoExportError) {
      if (weightsWritten > 0 || recoveryWritten > 0) return ok({ received: 0, written: 0, skipped: 0, details: [], weightsWritten, recoveryWritten });
      return badRequest(error.message);
    }
    throw error;
  }

  if (parsed.workouts.length > MAX_WORKOUTS_PER_REQUEST) {
    return badRequest(
      `Batch of ${parsed.workouts.length} exceeds the ${MAX_WORKOUTS_PER_REQUEST} limit — ` +
        `enable "Batch Requests" in the automation`,
    );
  }

  const ready: Workout[] = [];
  const rejected: Array<{ index: number; reason: string }> = [...parsed.skipped];

  let repository;
  let observedMax: (w: WorkoutInput) => number | undefined;
  try {
    repository = await getRepository();
    observedMax = await observedMaxResolver(repository, parsed.workouts);
  } catch (error) {
    context.error("Failed to read heart-rate history", error);
    return serverError("Failed to read workout history");
  }

  parsed.workouts.forEach((input, index) => {
    try {
      ready.push(buildWorkout(input, (w) => scoreWithReference(w, settings.profile, observedMax(w))));
    } catch (error) {
      if (error instanceof WorkoutValidationError) {
        rejected.push({ index, reason: error.message });
        return;
      }
      throw error;
    }
  });

  try {
    const written = await repository.upsertMany(ready);
    // The batch re-posts the same days every morning; the milestone state keeps that quiet.
    if (written > 0) await announceMilestones(ready, context);

    context.log(
      `Health Auto Export: ${written} workouts written, ${rejected.length} skipped` +
        (ready.length ? ` (${ready[0]!.startedAt} … ${ready[ready.length - 1]!.startedAt})` : ""),
    );

    // Always 200 when the payload itself was well-formed: a non-2xx makes the app retry
    // the identical batch, and a workout that failed validation will fail again forever.
    return ok({
      received: parsed.workouts.length + parsed.skipped.length,
      written,
      skipped: rejected.length,
      // Bounded: a pathological batch should not produce a megabyte of error text.
      details: rejected.slice(0, 10),
      ...(weightsWritten > 0 ? { weightsWritten } : {}),
    });
  } catch (error) {
    context.error("Failed to store Health Auto Export batch", error);
    return serverError("Failed to store workouts");
  }
}

app.http("ingestHealthAutoExport", {
  route: "api/ingest/health-auto-export",
  methods: ["POST"],
  authLevel: "anonymous", // Authenticated by the x-api-key header; see http/auth.ts.
  handler: ingestHealthAutoExport,
});
