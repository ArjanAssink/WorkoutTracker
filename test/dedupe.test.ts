import { describe, expect, it } from "vitest";
import { dedupe, duplicatesOf, isDuplicate, overlapShare } from "../src/domain/dedupe.js";
import type { Workout } from "../src/domain/workout.js";

const w = (id: string, start: string, minutes: number, extra: Partial<Workout> = {}): Workout => {
  const s = Date.parse(start);
  return { id, activityType: "cycling", startedAt: new Date(s).toISOString(), endedAt: new Date(s + minutes * 60_000).toISOString(), durationSeconds: minutes * 60, effort: 10, effortModel: "met-minutes", source: "health-export", recordedAt: start, ...extra };
};
const watch = w("watch", "2026-10-10T17:02:10Z", 72, { sourceName: "Apple Watch", averageHeartRate: 141 });
const wahoo = w("wahoo", "2026-10-10T17:01:30Z", 70, { sourceName: "Strava" });

describe("duplicate recordings", () => {
  it("sees a Wahoo ride and the watch's own as one session", () => {
    expect(overlapShare(watch, wahoo)).toBeGreaterThan(0.95);
    expect(isDuplicate(watch, wahoo)).toBe(true);
  });
  it("keeps two rides that merely follow each other, and never merges different activities", () => {
    expect(isDuplicate(watch, w("later", "2026-10-10T18:20:00Z", 40))).toBe(false);
    expect(isDuplicate(watch, { ...wahoo, activityType: "walking" })).toBe(false);
    expect(isDuplicate(watch, w("far", "2026-10-10T17:30:00Z", 70))).toBe(false); // starts 28 min later: a different session even though they overlap
  });
  it("keeps the copy with heart rate, else the longer, else the one recorded first", () => {
    expect(dedupe([wahoo, watch]).kept.map((x) => x.id)).toEqual(["watch"]);
    const noHr = { ...watch, averageHeartRate: undefined } as Workout;
    expect(dedupe([wahoo, noHr]).kept.map((x) => x.id)).toEqual(["watch"]); // longer
    const shorter = w("short", "2026-10-10T17:02:10Z", 60, { recordedAt: "2026-10-10T19:00:00Z" });
    expect(dedupe([wahoo, shorter]).kept.map((x) => x.id)).toEqual(["wahoo"]);
  });
  it("reports what it dropped and leaves everything else in order", () => {
    const run = w("run", "2026-10-11T07:00:00Z", 30, { activityType: "running" });
    const { kept, dropped } = dedupe([run, wahoo, watch]);
    expect(kept.map((x) => x.id)).toEqual(["watch", "run"]);
    expect(dropped).toEqual([{ dropped: wahoo, keptFor: watch }]);
  });
  it("tells an ingest whether an arrival replaces stored twins or is dropped", () => {
    expect(duplicatesOf(watch, [wahoo])).toEqual({ twins: [wahoo], incomingWins: true });
    expect(duplicatesOf(wahoo, [watch])).toEqual({ twins: [watch], incomingWins: false });
    expect(duplicatesOf(wahoo, [])).toEqual({ twins: [], incomingWins: false });
  });
});
