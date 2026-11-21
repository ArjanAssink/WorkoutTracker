import type { Workout } from "./workout.js";
import type { WeekReview } from "./goals.js";
import type { WeekAnnotation } from "./weekAnnotation.js";
import { isRestWeekLabel } from "./weekRecovery.js";
import { startOfIsoWeek } from "./summary.js";

const DAY = 86400000, WEEK = 7 * DAY;
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
/** Calendar-time coordinates let historical comparisons keep the same local weekday/time across DST. */
function localTime(iso: string): { date: string; wall: number } | undefined {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const p = Object.fromEntries(clock.formatToParts(instant).map((part) => [part.type, part.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, wall: Date.parse(`${date}T${p.hour}:${p.minute}:${p.second}Z`) };
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
export interface WeekPace {
  asOf: string;
  timeZone: "Europe/Amsterdam";
  historyWeeks: number;
  typicalSoFar: number;
  typicalRemaining: number;
  typicalTotal: number;
  projectedEffort?: number;
  projectionPaused: boolean;
}

/** Current-week context from up to 12 prior completed calendar weeks, with at least four available. */
export function weekPace(workouts: readonly Workout[], week: WeekReview, now: Date, annotation?: WeekAnnotation): WeekPace | undefined {
  const localNow = localTime(now.toISOString());
  if (!localNow) return undefined;
  const monday = startOfIsoWeek(new Date(`${localNow.date}T12:00:00Z`)).getTime();
  if (new Date(monday).toISOString().slice(0, 10) !== week.weekStart) return undefined;
  const cutoff = localNow.wall - monday;
  const history = new Map<number, { total: number; soFar: number }>();
  let firstRecorded = Infinity;
  for (const workout of workouts) {
    const start = localTime(workout.startedAt), end = localTime(workout.endedAt);
    if (!start || !end || !Number.isFinite(workout.effort) || workout.effort < 0) continue;
    const key = startOfIsoWeek(new Date(`${start.date}T12:00:00Z`)).getTime();
    firstRecorded = Math.min(firstRecorded, key);
    if (key < monday - 12 * WEEK || key >= monday) continue;
    const bucket = history.get(key) ?? { total: 0, soFar: 0 };
    bucket.total += workout.effort;
    // Only count sessions that would have finished by this local weekday and time.
    if (end.wall - key <= cutoff) bucket.soFar += workout.effort;
    history.set(key, bucket);
  }
  const weeks: Array<{ total: number; soFar: number }> = [];
  for (let key = monday - 12 * WEEK; key < monday; key += WEEK) {
    if (key >= firstRecorded) weeks.push(history.get(key) ?? { total: 0, soFar: 0 });
  }
  if (weeks.length < 4) return undefined;
  const typicalTotal = median(weeks.map((w) => w.total));
  if (typicalTotal <= 0) return undefined;
  const typicalSoFar = median(weeks.map((w) => w.soFar));
  const typicalRemaining = median(weeks.map((w) => w.total - w.soFar));
  const projectionPaused = isRestWeekLabel(annotation);
  return {
    asOf: now.toISOString(), timeZone: "Europe/Amsterdam", historyWeeks: weeks.length,
    typicalSoFar, typicalRemaining, typicalTotal, projectionPaused,
    ...(!projectionPaused ? { projectedEffort: week.effort + typicalRemaining } : {}),
  };
}
