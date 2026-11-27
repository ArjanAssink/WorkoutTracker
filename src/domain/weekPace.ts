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
interface Bucket { total: number; soFar: number; sessions: number; sessionsSoFar: number }
const empty = (): Bucket => ({ total: 0, soFar: 0, sessions: 0, sessionsSoFar: 0 });

export interface WeekPace {
  asOf: string;
  timeZone: "Europe/Amsterdam";
  historyWeeks: number;
  typicalSoFar: number;
  typicalRemaining: number;
  typicalTotal: number;
  projectedEffort?: number;
  projectionPaused: boolean;
  /** Median sessions finished by this local weekday and time in the comparison weeks. */
  typicalSessionsSoFar: number;
  /** Median sessions those weeks still had to come from this point to Sunday night. */
  typicalSessionsRemaining: number;
}

/** Current-week context from up to 12 prior completed calendar weeks, with at least four available. */
export function weekPace(
  workouts: readonly Workout[],
  week: WeekReview,
  now: Date,
  annotation?: WeekAnnotation,
  /** Activities the week's spec leaves out of the session totals. */
  excludeFromCount: readonly string[] = [],
  /** As `ReviewOptions.comparisonFrom`: weeks before it are not part of "usual". */
  comparisonFrom?: string,
): WeekPace | undefined {
  const excluded = new Set(excludeFromCount);
  const localNow = localTime(now.toISOString());
  if (!localNow) return undefined;
  const monday = startOfIsoWeek(new Date(`${localNow.date}T12:00:00Z`)).getTime();
  if (new Date(monday).toISOString().slice(0, 10) !== week.weekStart) return undefined;
  const cutoff = localNow.wall - monday;
  const floorDay = comparisonFrom ? startOfIsoWeek(new Date(`${comparisonFrom}T12:00:00Z`)).getTime() : -Infinity;
  const floor = monday >= floorDay ? floorDay : -Infinity;
  const history = new Map<number, Bucket>();
  let firstRecorded = Infinity;
  for (const workout of workouts) {
    const start = localTime(workout.startedAt), end = localTime(workout.endedAt);
    if (!start || !end || !Number.isFinite(workout.effort) || workout.effort < 0) continue;
    const key = startOfIsoWeek(new Date(`${start.date}T12:00:00Z`)).getTime();
    firstRecorded = Math.min(firstRecorded, key);
    if (key < monday - 12 * WEEK || key >= monday) continue;
    const bucket = history.get(key) ?? empty();
    const counts = !excluded.has(workout.activityType);
    bucket.total += workout.effort;
    if (counts) bucket.sessions++;
    // Only count sessions that would have finished by this local weekday and time.
    if (end.wall - key <= cutoff) { bucket.soFar += workout.effort; if (counts) bucket.sessionsSoFar++; }
    history.set(key, bucket);
  }
  const weeks: Bucket[] = [];
  for (let key = monday - 12 * WEEK; key < monday; key += WEEK) {
    if (key >= firstRecorded && key >= floor) weeks.push(history.get(key) ?? empty());
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
    typicalSessionsSoFar: median(weeks.map((w) => w.sessionsSoFar)),
    typicalSessionsRemaining: median(weeks.map((w) => w.sessions - w.sessionsSoFar)),
    ...(!projectionPaused ? { projectedEffort: week.effort + typicalRemaining } : {}),
  };
}

/**
 * The week in progress has no verdict yet — on a Wednesday every week is "short". The
 * outlook says where it is heading instead: sessions so far plus the sessions usually still
 * to come by Sunday, placed on the same ladder. It never reads below what is already
 * earned, and a perfect week is settled. Session counts only: the very-good minimums and
 * the per-activity targets are left to the verdict once the week is over. Until the first
 * session of the week is logged the projection is only the typical week restated, so it
 * says "no data" rather than a direction.
 */
export type WeekOutlookStatus = "perfect" | "high" | "ontrack" | "low" | "paused" | "nodata";

export interface WeekOutlook {
  status: WeekOutlookStatus;
  /** Sessions so far plus the typical remainder; absent when the projection is paused. */
  projectedSessions?: number;
}

export function weekOutlook(week: WeekReview, pace: WeekPace | undefined): WeekOutlook | undefined {
  if (!pace) return undefined;
  if (week.verdict === "perfect") return { status: "perfect" };
  if (pace.projectionPaused) return { status: "paused" };
  if (week.totalSessions === 0) return { status: "nodata" };
  const projectedSessions = week.totalSessions + pace.typicalSessionsRemaining;
  const status: WeekOutlookStatus = week.verdict === "verygood" || projectedSessions >= week.veryGoodWeekSessions
    ? "high"
    : week.verdict === "good" || projectedSessions >= week.goodWeekSessions
      ? "ontrack"
      : "low";
  return { status, projectedSessions };
}
