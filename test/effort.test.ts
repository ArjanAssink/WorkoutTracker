import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, scoreEffort, trimp } from "../src/domain/effort.js";
import type { WorkoutInput } from "../src/domain/workout.js";

const base: WorkoutInput = {
  activityType: "running",
  startedAt: "2026-03-01T08:00:00.000Z",
  endedAt: "2026-03-01T08:30:00.000Z",
  durationSeconds: 1800,
  source: "shortcut",
};

describe("trimp", () => {
  it("grows faster than linearly with intensity", () => {
    const easy = trimp(1800, 120, DEFAULT_PROFILE);
    const hard = trimp(1800, 170, DEFAULT_PROFILE);
    // Same duration, higher HR: the exponential weighting must more than double the load.
    expect(hard).toBeGreaterThan(easy * 2);
  });

  it("scales linearly with duration at fixed intensity", () => {
    const half = trimp(1800, 150, DEFAULT_PROFILE);
    const full = trimp(3600, 150, DEFAULT_PROFILE);
    expect(full).toBeCloseTo(half * 2, 6);
  });

  it("clamps heart rates outside the reserve instead of going negative", () => {
    expect(trimp(1800, 40, DEFAULT_PROFILE)).toBe(0);
    expect(trimp(1800, 260, DEFAULT_PROFILE)).toBe(trimp(1800, DEFAULT_PROFILE.maxHeartRate, DEFAULT_PROFILE));
  });

  it("returns zero rather than dividing by a non-positive reserve", () => {
    expect(trimp(1800, 150, { ...DEFAULT_PROFILE, restingHeartRate: 190, maxHeartRate: 185 })).toBe(0);
  });
});

describe("scoreEffort", () => {
  it("prefers TRIMP when a heart rate is present", () => {
    expect(scoreEffort({ ...base, averageHeartRate: 150 }).model).toBe("trimp");
  });

  it("falls back to MET-minutes when the watch recorded no heart rate", () => {
    expect(scoreEffort(base).model).toBe("met-minutes");
  });

  it("treats a zero heart rate as missing rather than as resting", () => {
    expect(scoreEffort({ ...base, averageHeartRate: 0 }).model).toBe("met-minutes");
  });

  it("keeps the two models on a comparable scale", () => {
    // A 30-minute run at a moderate HR should not differ by an order of magnitude from the
    // MET estimate for the same run; otherwise charts jump wherever HR data is missing.
    const withHr = scoreEffort({ ...base, averageHeartRate: 150 }).effort;
    const withoutHr = scoreEffort(base).effort;
    expect(withHr / withoutHr).toBeGreaterThan(0.4);
    expect(withHr / withoutHr).toBeLessThan(2.5);
  });

  it("rates a longer session as more effort than a shorter one of the same type", () => {
    const short = scoreEffort({ ...base, durationSeconds: 1200 }).effort;
    const long = scoreEffort({ ...base, durationSeconds: 3600 }).effort;
    expect(long).toBeGreaterThan(short);
  });
});
