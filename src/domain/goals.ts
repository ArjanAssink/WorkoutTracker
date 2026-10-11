import { displayName } from "./activityType.js";
import { startOfIsoWeek } from "./summary.js";
import type { Workout } from "./workout.js";

/**
 * Weekly training goals, and how a given week measured up.
 *
 * The model has two independent tests, which is the point. A **perfect** week hits every
 * per-activity target. A **good** week reaches a total session count regardless of how it
 * is composed — so missing jiu-jitsu but getting a run in still counts as showing up. A
 * single combined score would hide exactly that distinction.
 */

export interface GoalTarget {
  activityType: string;
  sessions: number;
}

export interface GoalSpec {
  targets: GoalTarget[];
  /** Sessions needed for a "good" week when the per-activity targets are not all met. */
  goodWeekSessions: number;
}

export const DEFAULT_GOALS: GoalSpec = {
  targets: [
    { activityType: "strength", sessions: 3 },
    { activityType: "martialarts", sessions: 2 }, // BJJ
    { activityType: "taichi", sessions: 1 }, // Capoeira
  ],
  goodWeekSessions: 5,
};

/**
 * Parses `strength:3,martialarts:2,taichi:1` from configuration, so goals can change with
 * an app-setting edit rather than a deploy. Falls back to the defaults on anything
 * unparseable — a typo in a setting should not silently zero out the targets.
 */
export function parseGoalTargets(raw: string | undefined): GoalTarget[] {
  if (!raw?.trim()) return DEFAULT_GOALS.targets;
  const targets: GoalTarget[] = [];
  for (const part of raw.split(",")) {
    const [activityType, count] = part.split(":").map((p) => p.trim());
    const sessions = Number(count);
    if (!activityType || !Number.isFinite(sessions) || sessions <= 0) continue;
    targets.push({ activityType, sessions });
  }
  return targets.length > 0 ? targets : DEFAULT_GOALS.targets;
}

export type Verdict = "perfect" | "good" | "short";

export interface TargetProgress extends GoalTarget {
  label: string;
  actual: number;
  met: boolean;
}

export interface WeekReview {
  /** Monday of the ISO week, `YYYY-MM-DD`. */
  weekStart: string;
  targets: TargetProgress[];
  totalSessions: number;
  activeDays: number;
  durationSeconds: number;
  effort: number;
  verdict: Verdict;
  /** Sessions outside any target, e.g. a run that stood in for a missed class. */
  otherSessions: number;
  /** Every activity that week with its count, targets included. */
  sessionsByActivity: Record<string, number>;
  /**
   * Median effort of the (up to) twelve weeks before this one — roughly a quarter, long
   * enough to be a habit and short enough to still be "you lately". Absent when fewer than
   * four prior weeks exist, since a median of two numbers is not a baseline.
   */
  typicalEffort?: number;
  /** This week's effort as a fraction of {@link typicalEffort}: 1.3 is 30% above. */
  effortRatio?: number;
}

/** Prior weeks a week is compared against. */
export const TYPICAL_WINDOW_WEEKS = 12;
const MIN_WEEKS_FOR_TYPICAL = 4;

export interface Baseline {
  /** Weeks the baseline is computed from. */
  weeks: number;
  medianSessions: number;
  medianDurationSeconds: number;
  medianEffort: number;
}

export interface WeeklyReport {
  spec: GoalSpec;
  /** Oldest first. */
  weeks: WeekReview[];
  /** The most recent complete week — what a Monday summary is about. */
  current: WeekReview | undefined;
  /** Typical week over the preceding weeks, excluding `current`. */
  baseline: Baseline | undefined;
  /** Consecutive weeks up to and including `current` that were good or perfect. */
  streakWeeks: number;
}

export interface ReviewOptions {
  /**
   * Weeks before `from` to evaluate but not return, so that the first returned weeks still
   * have a full comparison window behind them. The caller must supply workouts covering
   * those weeks too. Without this, the first `TYPICAL_WINDOW_WEEKS` rows of any table have
   * no "typical" to compare against.
   */
  leadInWeeks?: number;
}

/** Evaluates each ISO week in the range against the goals. */
export function reviewWeeks(
  workouts: Workout[],
  spec: GoalSpec,
  from: Date,
  to: Date,
  options: ReviewOptions = {},
): WeeklyReport {
  const weeks = new Map<string, { counts: Map<string, number>; days: Set<string>; duration: number; effort: number }>();

  const firstVisible = isoDay(startOfIsoWeek(from));
  const start = startOfIsoWeek(from);
  start.setUTCDate(start.getUTCDate() - 7 * (options.leadInWeeks ?? 0));
  for (const cursor = start; cursor < to; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    weeks.set(isoDay(cursor), { counts: new Map(), days: new Set(), duration: 0, effort: 0 });
  }

  for (const workout of workouts) {
    const started = new Date(workout.startedAt);
    const key = isoDay(startOfIsoWeek(started));
    let week = weeks.get(key);
    if (!week) {
      week = { counts: new Map(), days: new Set(), duration: 0, effort: 0 };
      weeks.set(key, week);
    }
    week.counts.set(workout.activityType, (week.counts.get(workout.activityType) ?? 0) + 1);
    week.days.add(isoDay(started));
    week.duration += workout.durationSeconds;
    week.effort += workout.effort;
  }

  const all = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, week]) => toReview(weekStart, week, spec));

  // Rolling comparison over everything evaluated, lead-in included, so the table can say
  // of any week how it stood against the ones before it — not only the latest.
  all.forEach((review, i) => {
    const prior = all.slice(Math.max(0, i - TYPICAL_WINDOW_WEEKS), i);
    if (prior.length < MIN_WEEKS_FOR_TYPICAL) return;
    const typical = Math.round(median(prior.map((w) => w.effort)) * 10) / 10;
    review.typicalEffort = typical;
    if (typical > 0) review.effortRatio = Math.round((review.effort / typical) * 100) / 100;
  });

  // Only the requested window is returned; the lead-in has done its job.
  const reviews = all.filter((w) => w.weekStart >= firstVisible);
  const current = reviews[reviews.length - 1];
  const prior = reviews.slice(0, -1);

  return {
    spec,
    weeks: reviews,
    current,
    baseline: baselineOf(prior),
    streakWeeks: streakOf(reviews),
  };
}

function toReview(
  weekStart: string,
  week: { counts: Map<string, number>; days: Set<string>; duration: number; effort: number },
  spec: GoalSpec,
): WeekReview {
  const targets: TargetProgress[] = spec.targets.map((target) => {
    const actual = week.counts.get(target.activityType) ?? 0;
    return {
      ...target,
      label: displayName(target.activityType),
      actual,
      met: actual >= target.sessions,
    };
  });

  const totalSessions = [...week.counts.values()].reduce((a, b) => a + b, 0);
  const targeted = targets.reduce((sum, t) => sum + Math.min(t.actual, t.sessions), 0);

  // Perfect is strictly every target met. Good is a total that shows up regardless of mix —
  // these are separate tests, so a substituted session still counts for one and not the other.
  const verdict: Verdict = targets.every((t) => t.met)
    ? "perfect"
    : totalSessions >= spec.goodWeekSessions
      ? "good"
      : "short";

  return {
    weekStart,
    targets,
    totalSessions,
    activeDays: week.days.size,
    durationSeconds: Math.round(week.duration),
    effort: Math.round(week.effort * 10) / 10,
    verdict,
    otherSessions: totalSessions - targeted,
    sessionsByActivity: Object.fromEntries(week.counts),
  };
}

/**
 * The typical week, as a median rather than a mean: one two-hour Capoeira weekend or a
 * fortnight off would drag an average somewhere unrepresentative.
 */
function baselineOf(weeks: WeekReview[]): Baseline | undefined {
  if (weeks.length === 0) return undefined;
  return {
    weeks: weeks.length,
    medianSessions: median(weeks.map((w) => w.totalSessions)),
    medianDurationSeconds: Math.round(median(weeks.map((w) => w.durationSeconds))),
    medianEffort: Math.round(median(weeks.map((w) => w.effort)) * 10) / 10,
  };
}

/** Consecutive good-or-perfect weeks ending at the most recent one. */
function streakOf(weeks: WeekReview[]): number {
  let streak = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (weeks[i]!.verdict === "short") break;
    streak++;
  }
  return streak;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
