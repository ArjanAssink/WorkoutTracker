import { createHash } from "node:crypto";
import { normaliseActivityType, type ActivityType } from "./activityType.js";

/** Where a record came from. Useful when reconciling Shortcut posts against a later export. */
export type WorkoutSource = "shortcut" | "health-export" | "manual";

/**
 * The canonical shape every ingest path produces and every query path returns.
 * Durations are seconds, distances metres, energy kilocalories — one unit per dimension,
 * converted at the edges, so nothing downstream has to ask "which unit is this?".
 */
export interface Workout {
  /** Deterministic, derived from activity + start + duration. See {@link workoutId}. */
  id: string;
  activityType: ActivityType;
  /** ISO-8601 UTC instant the workout started. */
  startedAt: string;
  /** ISO-8601 UTC instant the workout ended. */
  endedAt: string;
  durationSeconds: number;
  distanceMeters?: number;
  activeEnergyKcal?: number;
  totalEnergyKcal?: number;
  averageHeartRate?: number;
  minHeartRate?: number;
  maxHeartRate?: number;
  /** Effort score in arbitrary "training load" points. See `effort.ts`. */
  effort: number;
  /** Which of the two effort models produced {@link effort}. */
  effortModel: "trimp" | "met-minutes";
  /**
   * The maximum heart rate the TRIMP score was computed against — observed over the
   * trailing year where possible, else the configured value. Recorded so a score is
   * auditable and so the reference can change over time without old rows becoming
   * unexplainable.
   */
  maxHeartRateReference?: number;
  source: WorkoutSource;
  /** Device or app that recorded it, e.g. "Apple Watch". */
  sourceName?: string;
  /** Free-form note carried through from the Shortcut, if any. */
  notes?: string;
  /** When this row was written, as opposed to when the workout happened. */
  recordedAt: string;
}

/** A workout before effort scoring — what the parsers hand to {@link buildWorkout}. */
export type WorkoutInput = Omit<Workout, "id" | "effort" | "effortModel" | "recordedAt" | "maxHeartRateReference">;

/**
 * Identity is derived rather than assigned so that re-posting the same workout — a Shortcut
 * that fires twice, or an export.xml re-imported after the Shortcut already logged it — is an
 * idempotent upsert instead of a duplicate. Duration is bucketed to the second because Apple
 * reports it with sub-second jitter across sources.
 */
export function workoutId(activityType: ActivityType, startedAt: string, durationSeconds: number): string {
  const material = `${activityType}|${startedAt}|${Math.round(durationSeconds)}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** Lower bound on a plausible workout, in seconds — anything shorter is noise, not training. */
export const MIN_DURATION_SECONDS = 30;

/** Upper bound, in seconds. Guards against a missing end date producing a 40-year workout. */
export const MAX_DURATION_SECONDS = 24 * 60 * 60;

export class WorkoutValidationError extends Error {
  override readonly name = "WorkoutValidationError";
}

/**
 * Validates an input, computes its identity and effort, and returns the stored shape.
 * Throws {@link WorkoutValidationError} for anything that cannot be a real workout.
 */
export function buildWorkout(
  input: WorkoutInput,
  scoreEffort: (w: WorkoutInput) => { effort: number; model: "trimp" | "met-minutes"; maxHeartRateReference?: number },
  now: Date = new Date(),
): Workout {
  const started = new Date(input.startedAt);
  const ended = new Date(input.endedAt);
  if (Number.isNaN(started.getTime())) {
    throw new WorkoutValidationError(`startedAt is not a valid date: ${input.startedAt}`);
  }
  if (Number.isNaN(ended.getTime())) {
    throw new WorkoutValidationError(`endedAt is not a valid date: ${input.endedAt}`);
  }
  if (ended < started) {
    throw new WorkoutValidationError("endedAt is before startedAt");
  }
  if (input.durationSeconds < MIN_DURATION_SECONDS) {
    throw new WorkoutValidationError(
      `durationSeconds ${input.durationSeconds} is below the ${MIN_DURATION_SECONDS}s minimum`,
    );
  }
  if (input.durationSeconds > MAX_DURATION_SECONDS) {
    throw new WorkoutValidationError(
      `durationSeconds ${input.durationSeconds} exceeds the ${MAX_DURATION_SECONDS}s maximum`,
    );
  }

  const normalised: WorkoutInput = {
    ...input,
    activityType: normaliseActivityType(input.activityType),
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
  };

  const { effort, model, maxHeartRateReference } = scoreEffort(normalised);

  return {
    ...normalised,
    id: workoutId(normalised.activityType, normalised.startedAt, normalised.durationSeconds),
    effort,
    effortModel: model,
    // Only meaningful for TRIMP; a MET estimate never looked at heart rate.
    ...(model === "trimp" && maxHeartRateReference !== undefined ? { maxHeartRateReference } : {}),
    recordedAt: now.toISOString(),
  };
}
