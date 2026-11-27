import { describe, expect, it } from "vitest";
import { reconcile } from "../src/domain/syncCheck.js";
import { workoutId, type Workout, type WorkoutInput } from "../src/domain/workout.js";

function input(activityType: string, startedAt: string, minutes: number, extra: Partial<WorkoutInput> = {}): WorkoutInput {
  const end = new Date(Date.parse(startedAt) + minutes * 60_000).toISOString();
  return { activityType, startedAt, endedAt: end, durationSeconds: minutes * 60, source: "health-export", ...extra };
}

function stored(w: WorkoutInput, extra: Partial<Workout> = {}) {
  return { id: workoutId(w.activityType, w.startedAt, w.durationSeconds), activityType: w.activityType, startedAt: w.startedAt, endedAt: w.endedAt, durationSeconds: w.durationSeconds, source: w.source, ...extra };
}

describe("reconcile", () => {
  const run = input("running", "2026-11-20T07:00:00.000Z", 45);
  const lift = input("strength", "2026-11-21T17:00:00.000Z", 60);

  it("marks a workout with the same derived id as stored", () => {
    const { rows, serverOnly } = reconcile([run], [stored(run, { sourceName: "Health Auto Export" })]);
    expect(rows[0]).toMatchObject({ status: "stored", matchedSource: "Health Auto Export" });
    expect(serverOnly).toEqual([]);
  });

  it("marks one with no row and no twin as missing", () => {
    const { rows } = reconcile([run, lift], [stored(run)]);
    expect(rows.map((r) => r.status)).toEqual(["stored", "missing"]);
  });

  it("recognises the same session kept under its other recording as merged", () => {
    // The Wahoo ride via Strava starts 40 s later and runs a minute shorter; the dedupe kept it.
    const watch = input("cycling", "2026-11-22T09:00:00.000Z", 90);
    const wahoo = input("cycling", "2026-11-22T09:00:40.000Z", 89, { sourceName: "Strava" });
    const { rows, serverOnly } = reconcile([watch], [stored(wahoo, { sourceName: "Strava" })]);
    expect(rows[0]).toMatchObject({ status: "merged", matchedSource: "Strava" });
    expect(serverOnly).toEqual([]);
  });

  it("does not call a different activity at the same time merged", () => {
    const walk = input("walking", "2026-11-20T07:00:00.000Z", 45);
    expect(reconcile([walk], [stored(run)]).rows[0]!.status).toBe("missing");
  });

  it("lists stored rows the phone does not account for as server-only", () => {
    const manual = input("martialarts", "2026-11-23T19:00:00.000Z", 90, { source: "manual" });
    const { serverOnly } = reconcile([run], [stored(run), stored(manual)]);
    expect(serverOnly).toEqual([expect.objectContaining({ activityType: "martialarts", source: "manual" })]);
  });
});
