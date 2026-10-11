import { metValue } from "./activityType.js";
import type { WorkoutInput } from "./workout.js";

/**
 * Physiological constants for the athlete. Heart-rate-based effort is meaningless without
 * them, so they come from configuration rather than being hard-coded.
 */
export interface AthleteProfile {
  /** Resting heart rate, bpm. */
  restingHeartRate: number;
  /** Maximum heart rate, bpm. */
  maxHeartRate: number;
  /** Body mass in kg, used to turn MET-minutes into a comparable load. */
  weightKg: number;
  /** Banister's exponential weighting factor: 1.92 for men, 1.67 for women. */
  trimpFactor: number;
}

export const DEFAULT_PROFILE: AthleteProfile = {
  restingHeartRate: 60,
  maxHeartRate: 185,
  weightKg: 80,
  trimpFactor: 1.92,
};

export type EffortModel = "trimp" | "met-minutes";

/**
 * How far back to look for an observed maximum heart rate.
 *
 * Max HR is a slowly drifting ceiling, not a monthly statistic. The highest value recorded
 * in a *month* reflects what was done that month, not capacity — an easy month would lower
 * the ceiling and inflate every effort in it. A year nearly always contains one genuinely
 * hard effort, so a quiet stretch cannot deflate the reference, while a new peak raises it
 * from that day forward and old peaks age out as the body changes.
 */
export const MAX_HR_WINDOW_DAYS = 365;

/** An observed maximum this close to resting is a sensor artefact, not a ceiling. */
const MIN_PLAUSIBLE_RESERVE = 40;

/**
 * An observed maximum this far below the configured value is not a ceiling either — it is
 * a year with no hard effort in it. A real max HR does not fall 25+ bpm below a measured
 * one within a few years; a sparse early window of easy sessions easily "observes" 110.
 * Scoring against that would make every moderate workout look maximal.
 */
const MAX_PLAUSIBLE_DROP_BELOW_FALLBACK = 25;

/**
 * The highest maximum heart rate recorded in the window ending at `asOf`, from a list of
 * `(startedAt, maxHeartRate)` observations in any order. Undefined when there are none.
 */
export function trailingMaxHeartRate(
  observations: Iterable<{ startedAt: string; maxHeartRate?: number | undefined }>,
  asOf: Date,
  windowDays: number = MAX_HR_WINDOW_DAYS,
): number | undefined {
  const end = asOf.getTime();
  const start = end - windowDays * 86_400_000;
  let best: number | undefined;
  for (const o of observations) {
    if (!o.maxHeartRate) continue;
    const t = Date.parse(o.startedAt);
    // Inclusive of the workout itself: its own peak is evidence of its own ceiling.
    if (t < start || t > end) continue;
    if (best === undefined || o.maxHeartRate > best) best = o.maxHeartRate;
  }
  return best;
}

/**
 * The profile with its maximum replaced by an observed one, when that observation is
 * usable. Falls back to the configured value when nothing was observed or the observation
 * is implausibly low — scoring against a ceiling just above resting would make a walk look
 * maximal.
 */
export function withObservedMax(profile: AthleteProfile, observed: number | undefined): AthleteProfile {
  if (observed === undefined) return profile;
  if (observed - profile.restingHeartRate < MIN_PLAUSIBLE_RESERVE) return profile;
  if (observed < profile.maxHeartRate - MAX_PLAUSIBLE_DROP_BELOW_FALLBACK) return profile;
  return { ...profile, maxHeartRate: observed };
}

export interface EffortScore {
  effort: number;
  model: EffortModel;
}

/**
 * Banister TRIMP: minutes x heart-rate reserve x an exponential weighting, so time spent
 * near threshold counts far more than the same time spent easy. This is the preferred model
 * whenever the watch recorded an average heart rate.
 */
export function trimp(durationSeconds: number, averageHeartRate: number, profile: AthleteProfile): number {
  const minutes = durationSeconds / 60;
  const reserve = profile.maxHeartRate - profile.restingHeartRate;
  if (reserve <= 0) return 0;
  // Clamp: a stray HR reading outside [resting, max] should saturate, not produce nonsense.
  const ratio = Math.min(1, Math.max(0, (averageHeartRate - profile.restingHeartRate) / reserve));
  return minutes * ratio * 0.64 * Math.exp(profile.trimpFactor * ratio);
}

/**
 * MET-minutes scaled so that it lands on roughly the same numeric range as TRIMP for a
 * typical moderate session. Without this the two models would be incomparable and any chart
 * mixing HR and non-HR workouts would show a cliff wherever the watch dropped its HR signal.
 */
const MET_TO_TRIMP_SCALE = 0.12;

export function metMinutes(durationSeconds: number, activityType: string): number {
  return (durationSeconds / 60) * metValue(activityType);
}

/**
 * Scores a workout, preferring TRIMP and falling back to scaled MET-minutes.
 * Returns which model was used so that reports can flag estimates as such.
 */
export function scoreEffort(workout: WorkoutInput, profile: AthleteProfile = DEFAULT_PROFILE): EffortScore {
  const hr = workout.averageHeartRate;
  if (typeof hr === "number" && hr > 0) {
    return { effort: round1(trimp(workout.durationSeconds, hr, profile)), model: "trimp" };
  }
  const mets = metMinutes(workout.durationSeconds, workout.activityType);
  return { effort: round1(mets * MET_TO_TRIMP_SCALE), model: "met-minutes" };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
