import { describe, expect, it } from "vitest";
import { buildWorkout, workoutId, WorkoutValidationError, type WorkoutInput } from "../src/domain/workout.js";
import { scoreEffort } from "../src/domain/effort.js";

const score = (w: WorkoutInput) => scoreEffort(w);

const input: WorkoutInput = {
  activityType: "running",
  startedAt: "2026-03-14T07:00:00.000Z",
  endedAt: "2026-03-14T07:45:00.000Z",
  durationSeconds: 2700,
  source: "shortcut",
};

describe("workoutId", () => {
  it("is stable for the same workout", () => {
    expect(workoutId("running", input.startedAt, 2700)).toBe(workoutId("running", input.startedAt, 2700));
  });

  it("ignores sub-second duration jitter between sources", () => {
    expect(workoutId("running", input.startedAt, 2700.4)).toBe(workoutId("running", input.startedAt, 2700));
  });

  it("separates different workouts", () => {
    expect(workoutId("running", input.startedAt, 2700)).not.toBe(workoutId("cycling", input.startedAt, 2700));
    expect(workoutId("running", input.startedAt, 2700)).not.toBe(
      workoutId("running", "2026-03-14T08:00:00.000Z", 2700),
    );
  });
});

describe("buildWorkout", () => {
  it("normalises the activity type on the way in", () => {
    expect(buildWorkout({ ...input, activityType: "Outdoor Run" }, score).activityType).toBe("running");
  });

  it("gives the Shortcut and export paths the same id for the same workout", () => {
    const fromShortcut = buildWorkout({ ...input, source: "shortcut" }, score);
    const fromExport = buildWorkout(
      { ...input, source: "health-export", activityType: "HKWorkoutActivityTypeRunning" },
      score,
    );
    expect(fromExport.id).toBe(fromShortcut.id);
  });

  it("normalises timestamps to ISO UTC", () => {
    const built = buildWorkout({ ...input, startedAt: "2026-03-14 08:00:00 +0100" }, score);
    expect(built.startedAt).toBe("2026-03-14T07:00:00.000Z");
  });

  it("stamps recordedAt separately from when the workout happened", () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const built = buildWorkout(input, score, now);
    expect(built.recordedAt).toBe(now.toISOString());
    expect(built.startedAt).not.toBe(built.recordedAt);
  });

  it("rejects a workout shorter than the noise floor", () => {
    expect(() => buildWorkout({ ...input, durationSeconds: 5 }, score)).toThrow(WorkoutValidationError);
  });

  it("rejects an implausibly long workout, which usually means a bad end date", () => {
    expect(() => buildWorkout({ ...input, durationSeconds: 200_000 }, score)).toThrow(WorkoutValidationError);
  });

  it("rejects an end before the start", () => {
    expect(() => buildWorkout({ ...input, endedAt: "2026-03-14T06:00:00.000Z" }, score)).toThrow(
      WorkoutValidationError,
    );
  });

  it("rejects unparseable dates", () => {
    expect(() => buildWorkout({ ...input, startedAt: "nope" }, score)).toThrow(WorkoutValidationError);
  });
});
