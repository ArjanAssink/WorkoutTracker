import type { WeekReview } from "./goals.js";
import type { WeekAnnotation } from "./weekAnnotation.js";

export function isRestWeekLabel(annotation: WeekAnnotation | undefined): boolean {
  return /^(rest(?: week)?|deload(?: week)?|recovery week)$/i.test(annotation?.label.trim() ?? "");
}

export function isLowerEffortWeek(week: WeekReview): boolean {
  return week.typicalEffort !== undefined && week.typicalEffort > 0 && week.effort <= week.typicalEffort * 0.6;
}

export type WeeklyEffortBand = "recovery" | "lighter" | "usual" | "higher" | "in-progress" | "unknown";

/** Compare recorded effort only; tags and goal verdicts do not influence this band. */
export function weeklyEffortBand(week: WeekReview, complete: boolean): WeeklyEffortBand {
  if (!complete) return "in-progress";
  if (week.typicalEffort === undefined || week.typicalEffort <= 0) return "unknown";
  if (isLowerEffortWeek(week)) return "recovery";
  if (week.effort < week.typicalEffort * 0.9) return "lighter";
  if (week.effort > week.typicalEffort * 1.1) return "higher";
  return "usual";
}

/** Current/future weeks may be tagged, but cannot qualify from a partial effort total. */
export function weekRecovery(week: WeekReview, annotation: WeekAnnotation | undefined, now: Date) {
  const complete = Date.parse(`${week.weekStart}T00:00:00Z`) + 7 * 86400000 <= now.getTime();
  const comparable = week.typicalEffort !== undefined && week.typicalEffort > 0;
  return {
    complete,
    effortBand: weeklyEffortBand(week, complete),
    taggedRest: isRestWeekLabel(annotation),
    lowerEffort: complete && isLowerEffortWeek(week),
    ...(comparable ? { effortPercent: week.effort / week.typicalEffort! * 100 } : {}),
  };
}
