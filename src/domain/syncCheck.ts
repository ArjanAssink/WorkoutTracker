import { isDuplicate } from "./dedupe.js";
import { workoutId, type Workout, type WorkoutInput } from "./workout.js";

/**
 * Reconciles what the phone has with what the server stored — the native app's "Sync check"
 * screen. Pure: the endpoint parses the phone's workouts with the same parser as the ingest
 * path (so relabels and rounding match), lists the stored rows around them, and asks this.
 *
 * - `stored`: a row with exactly the derived id exists.
 * - `merged`: no row with that id, but a stored row is the same session recorded twice
 *   (`isDuplicate`: the Wahoo ride beside the watch's); the dedupe kept the other copy.
 * - `missing`: neither. Sending it again would store it.
 * Stored rows that no phone workout accounts for come back as `serverOnly` (manual entries,
 * the Strava archive, workouts deleted from Health).
 */
export type SyncCheckStatus = "stored" | "merged" | "missing";

type Stored = Pick<Workout, "id" | "activityType" | "startedAt" | "endedAt" | "durationSeconds" | "source"> & {
  sourceName?: string | undefined;
  averageHeartRate?: number | undefined;
};

export interface SyncCheckRow {
  id: string;
  activityType: string;
  startedAt: string;
  durationSeconds: number;
  status: SyncCheckStatus;
  /** The row it matched: itself when stored, the kept twin when merged. */
  matchedId?: string;
  matchedSource?: string;
}

export interface SyncCheckResult {
  rows: SyncCheckRow[];
  serverOnly: Array<Pick<Stored, "id" | "activityType" | "startedAt" | "durationSeconds"> & { source: string }>;
}

export function reconcile(incoming: WorkoutInput[], stored: Stored[]): SyncCheckResult {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const accounted = new Set<string>();
  const label = (s: Stored) => s.sourceName ?? s.source;

  const rows = incoming.map((w): SyncCheckRow => {
    const id = workoutId(w.activityType, w.startedAt, w.durationSeconds);
    const base = { id, activityType: w.activityType, startedAt: w.startedAt, durationSeconds: w.durationSeconds };
    const exact = byId.get(id);
    if (exact) {
      accounted.add(exact.id);
      return { ...base, status: "stored", matchedId: exact.id, matchedSource: label(exact) };
    }
    const twin = stored.find((s) => isDuplicate(w, s));
    if (twin) {
      accounted.add(twin.id);
      return { ...base, status: "merged", matchedId: twin.id, matchedSource: label(twin) };
    }
    return { ...base, status: "missing" };
  });

  const serverOnly = stored
    .filter((s) => !accounted.has(s.id))
    .map((s) => ({ id: s.id, activityType: s.activityType, startedAt: s.startedAt, durationSeconds: s.durationSeconds, source: label(s) }));
  return { rows, serverOnly };
}
