import type { Workout, WorkoutInput } from "./workout.js";

/**
 * The same session recorded twice: a ride on the Wahoo (reaching Health through Strava)
 * while the watch runs its own cycling workout. Apple keeps both; the ids differ because
 * the start times and durations differ by seconds; counted twice, a week looks busier
 * than it was. Two workouts of the same activity that overlap most of their time are one.
 *
 * Which copy wins: the one with heart rate, then the longer, then the one recorded first.
 * Pure, so the import, the ingest paths and the cleanup CLI apply the same rule.
 */

/** Overlap, as a share of the shorter workout, above which two recordings are one session. */
export const DUPLICATE_OVERLAP = 0.6;
/** Starts further apart than this are never the same session, however they overlap. */
export const DUPLICATE_START_WINDOW_MS = 15 * 60_000;

type Like = Pick<WorkoutInput, "activityType" | "startedAt" | "endedAt" | "durationSeconds"> & { averageHeartRate?: number | undefined; recordedAt?: string; sourceName?: string | undefined };

export function overlapShare(a: Like, b: Like): number {
  const a0 = Date.parse(a.startedAt), a1 = Date.parse(a.endedAt), b0 = Date.parse(b.startedAt), b1 = Date.parse(b.endedAt);
  const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const shorter = Math.max(1, Math.min(a1 - a0, b1 - b0));
  return overlap / shorter;
}

export function isDuplicate(a: Like, b: Like): boolean {
  if (a.activityType !== b.activityType) return false;
  if (Math.abs(Date.parse(a.startedAt) - Date.parse(b.startedAt)) > DUPLICATE_START_WINDOW_MS) return false;
  return overlapShare(a, b) >= DUPLICATE_OVERLAP;
}

/** Negative when `a` should be kept over `b`. */
export function preference(a: Like, b: Like): number {
  const hr = (w: Like) => (w.averageHeartRate ? 1 : 0);
  if (hr(a) !== hr(b)) return hr(b) - hr(a);
  if (a.durationSeconds !== b.durationSeconds) return b.durationSeconds - a.durationSeconds;
  return (a.recordedAt ?? "").localeCompare(b.recordedAt ?? "");
}

/**
 * Drops duplicates from a list, keeping the preferred copy of each session. Returns what to
 * keep and the pairs dropped, so an import can say what it merged.
 */
export function dedupe<T extends Like>(workouts: T[]): { kept: T[]; dropped: Array<{ dropped: T; keptFor: T }> } {
  const sorted = [...workouts].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const kept: T[] = [], dropped: Array<{ dropped: T; keptFor: T }> = [];
  for (const w of sorted) {
    // Only recent keeps can overlap: anything that started more than the window ago cannot.
    let twin: T | undefined;
    for (let i = kept.length - 1; i >= 0; i--) { const k = kept[i]!; if (Date.parse(w.startedAt) - Date.parse(k.startedAt) > DUPLICATE_START_WINDOW_MS) break; if (isDuplicate(w, k)) { twin = k; break; } }
    if (!twin) { kept.push(w); continue; }
    if (preference(w, twin) < 0) { kept[kept.indexOf(twin)] = w; dropped.push({ dropped: twin, keptFor: w }); }
    else dropped.push({ dropped: w, keptFor: twin });
  }
  return { kept: kept.sort((a, b) => a.startedAt.localeCompare(b.startedAt)), dropped };
}

/** Among stored workouts, the ones a new arrival duplicates — and whether the arrival should replace them. */
export function duplicatesOf<T extends Like>(incoming: Like, stored: T[]): { twins: T[]; incomingWins: boolean } {
  const twins = stored.filter((s) => isDuplicate(incoming, s));
  return { twins, incomingWins: twins.length > 0 && twins.every((t) => preference(incoming, t) < 0) };
}

export type { Workout };
