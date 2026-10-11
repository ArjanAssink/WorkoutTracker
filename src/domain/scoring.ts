import { type AthleteProfile, scoreEffort, withObservedMax } from "./effort.js";
import type { WorkoutInput } from "./workout.js";

/**
 * The one way a workout gets scored. Every write path — import, Shortcut, batch ingest —
 * goes through this so that "which max heart rate did we use" has a single answer.
 *
 * `observedMax` is the trailing-year peak as of the workout's own date; the caller supplies
 * it because where it comes from differs (an in-memory pass over an export, a storage query
 * for a single ingest). The returned reference is what the row records.
 */
export function scoreWithReference(
  workout: WorkoutInput,
  profile: AthleteProfile,
  observedMax: number | undefined,
): { effort: number; model: "trimp" | "met-minutes"; maxHeartRateReference: number } {
  const effective = withObservedMax(profile, observedMax);
  const { effort, model } = scoreEffort(workout, effective);
  return { effort, model, maxHeartRateReference: effective.maxHeartRate };
}
