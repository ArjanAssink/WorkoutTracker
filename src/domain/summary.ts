import { displayName } from "./activityType.js";
import type { Workout } from "./workout.js";

/** How to bucket a span of workouts for a retrospective view. */
export type Granularity = "day" | "week" | "month" | "year";

export interface Totals {
  workouts: number;
  durationSeconds: number;
  distanceMeters: number;
  activeEnergyKcal: number;
  effort: number;
}

export interface Bucket extends Totals {
  /** Bucket start, as `YYYY-MM-DD` for day/week, `YYYY-MM` for month, `YYYY` for year. */
  period: string;
  /** Distinct calendar days with at least one workout — "how often", not "how much". */
  activeDays: number;
  /**
   * Per-activity split within this period, keyed by slug, carrying only the activities
   * actually present. Computed here rather than client-side so a stacked chart and the
   * headline totals cannot disagree — recomputing from the raw workout feed would silently
   * diverge once that feed hits its row cap.
   */
  byActivity: Record<string, Totals>;
}

export interface ActivityBreakdown extends Totals {
  activityType: string;
  label: string;
}

/** The highest heart rate recorded in the range, and the workout it came from. */
export interface PeakHeartRate {
  bpm: number;
  workoutId: string;
  startedAt: string;
  activityType: string;
  label: string;
}

export interface Summary {
  from: string;
  to: string;
  granularity: Granularity;
  /** Null when no workout in the range recorded a maximum. */
  peakHeartRate: PeakHeartRate | null;
  totals: Totals & { activeDays: number };
  buckets: Bucket[];
  byActivity: ActivityBreakdown[];
  /** Longest run of consecutive calendar days with a workout, within the range. */
  longestStreakDays: number;
}

const EMPTY: Totals = {
  workouts: 0,
  durationSeconds: 0,
  distanceMeters: 0,
  activeEnergyKcal: 0,
  effort: 0,
};

/**
 * Every period in the range, in order, whether or not it contains a workout.
 *
 * Buckets are dense on purpose. A sparse series — only the periods you trained — makes a
 * rest week vanish rather than show as a gap, so a chart drawn from it shows an evenly
 * spaced axis that is not evenly spaced in time, and an average over the buckets silently
 * becomes "average per active period" instead of "average per period".
 */
export function enumeratePeriods(from: Date, to: Date, granularity: Granularity): string[] {
  const periods: string[] = [];
  const cursor = startOfPeriod(from, granularity);
  // A zero-length or inverted range yields nothing rather than looping forever.
  while (cursor < to) {
    periods.push(bucketKey(cursor, granularity));
    advance(cursor, granularity);
  }
  return periods;
}

function startOfPeriod(date: Date, granularity: Granularity): Date {
  switch (granularity) {
    case "day":
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    case "week":
      return startOfIsoWeek(date);
    case "month":
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    case "year":
      return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  }
}

function advance(cursor: Date, granularity: Granularity): void {
  switch (granularity) {
    case "day":
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      return;
    case "week":
      cursor.setUTCDate(cursor.getUTCDate() + 7);
      return;
    case "month":
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      return;
    case "year":
      cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
      return;
  }
}

/**
 * Collapses a list of workouts into period buckets and per-activity totals.
 *
 * Pure and synchronous: the whole retrospective view is computed in memory from rows the
 * repository already streamed. At a realistic volume — a workout a day for a decade is under
 * 4,000 rows — this is far cheaper than pushing aggregation into storage, and it keeps the
 * analysis logic testable without an Azure account.
 */
export function summarise(workouts: Workout[], granularity: Granularity, from: Date, to: Date): Summary {
  const buckets = new Map<string, Bucket & { days: Set<string> }>();
  for (const period of enumeratePeriods(from, to, granularity)) {
    buckets.set(period, { period, ...EMPTY, activeDays: 0, byActivity: {}, days: new Set() });
  }
  const activities = new Map<string, ActivityBreakdown>();
  const allDays = new Set<string>();
  const totals: Totals = { ...EMPTY };
  let peak: PeakHeartRate | null = null;

  for (const workout of workouts) {
    if (workout.maxHeartRate && (!peak || workout.maxHeartRate > peak.bpm)) {
      peak = {
        bpm: workout.maxHeartRate,
        workoutId: workout.id,
        startedAt: workout.startedAt,
        activityType: workout.activityType,
        label: displayName(workout.activityType),
      };
    }
    const started = new Date(workout.startedAt);
    const day = isoDay(started);
    allDays.add(day);

    const period = bucketKey(started, granularity);
    let bucket = buckets.get(period);
    if (!bucket) {
      // Defensive: a workout just outside the enumerated range still gets counted
      // rather than silently vanishing from the totals it contributed to.
      bucket = { period, ...EMPTY, activeDays: 0, byActivity: {}, days: new Set() };
      buckets.set(period, bucket);
    }
    bucket.days.add(day);
    accumulate(bucket, workout);

    const within = (bucket.byActivity[workout.activityType] ??= { ...EMPTY });
    accumulate(within, workout);

    let activity = activities.get(workout.activityType);
    if (!activity) {
      activity = { activityType: workout.activityType, label: displayName(workout.activityType), ...EMPTY };
      activities.set(workout.activityType, activity);
    }
    accumulate(activity, workout);

    accumulate(totals, workout);
  }

  const orderedBuckets = [...buckets.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(({ days, ...bucket }) => ({ ...bucket, activeDays: days.size }));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    granularity,
    peakHeartRate: peak,
    totals: { ...round(totals), activeDays: allDays.size },
    buckets: orderedBuckets.map((b) => ({
      ...round(b),
      period: b.period,
      activeDays: b.activeDays,
      byActivity: Object.fromEntries(Object.entries(b.byActivity).map(([k, v]) => [k, round(v)])),
    })),
    // Most-trained activity first — the question is almost always "what do I actually do?".
    byActivity: [...activities.values()]
      .sort((a, b) => b.durationSeconds - a.durationSeconds)
      .map((a) => ({ ...round(a), activityType: a.activityType, label: a.label })),
    longestStreakDays: longestStreak(allDays),
  };
}

function accumulate(target: Totals, workout: Workout): void {
  target.workouts += 1;
  target.durationSeconds += workout.durationSeconds;
  target.distanceMeters += workout.distanceMeters ?? 0;
  target.activeEnergyKcal += workout.activeEnergyKcal ?? 0;
  target.effort += workout.effort;
}

function round<T extends Totals>(totals: T): T {
  return {
    ...totals,
    durationSeconds: Math.round(totals.durationSeconds),
    distanceMeters: Math.round(totals.distanceMeters),
    activeEnergyKcal: Math.round(totals.activeEnergyKcal),
    effort: Math.round(totals.effort * 10) / 10,
  };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function bucketKey(date: Date, granularity: Granularity): string {
  switch (granularity) {
    case "day":
      return isoDay(date);
    case "week":
      return isoDay(startOfIsoWeek(date));
    case "month":
      return date.toISOString().slice(0, 7);
    case "year":
      return date.toISOString().slice(0, 4);
  }
}

/** Monday of the ISO week containing `date`, in UTC. */
export function startOfIsoWeek(date: Date): Date {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay() is 0 for Sunday; ISO weeks start on Monday, so Sunday is 6 days in.
  const offset = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc;
}

function longestStreak(days: Set<string>): number {
  if (days.size === 0) return 0;
  const sorted = [...days].sort();
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    const previous = Date.parse(`${sorted[i - 1]}T00:00:00Z`);
    const day = Date.parse(`${sorted[i]}T00:00:00Z`);
    if (day - previous === 86_400_000) current += 1;
    else current = 1;
    if (current > longest) longest = current;
  }
  return longest;
}
