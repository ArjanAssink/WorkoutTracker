import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, MAX_HR_WINDOW_DAYS, trailingMaxHeartRate, withObservedMax } from "../src/domain/effort.js";
import { scoreWithReference } from "../src/domain/scoring.js";
import { buildWorkout, type WorkoutInput } from "../src/domain/workout.js";

const obs = (startedAt: string, maxHeartRate?: number) => ({ startedAt, maxHeartRate });
const asOf = new Date("2026-10-01T12:00:00Z");

describe("trailingMaxHeartRate", () => {
  it("returns the highest max inside the window", () => {
    const peak = trailingMaxHeartRate(
      [obs("2026-03-01T07:00:00Z", 171), obs("2026-07-21T07:00:00Z", 188), obs("2026-09-13T07:00:00Z", 180)],
      asOf,
    );
    expect(peak).toBe(188);
  });

  it("ignores peaks older than the window — a two-year-old reading has aged out", () => {
    const peak = trailingMaxHeartRate([obs("2024-07-21T07:00:00Z", 195), obs("2026-08-09T07:00:00Z", 188)], asOf);
    expect(peak).toBe(188);
  });

  it("ignores peaks after the as-of date, so history is scored only against its own past", () => {
    const peak = trailingMaxHeartRate([obs("2026-06-01T07:00:00Z", 170), obs("2026-11-01T07:00:00Z", 199)], asOf);
    expect(peak).toBe(170);
  });

  it("includes the workout itself — its own peak is evidence of its ceiling", () => {
    expect(trailingMaxHeartRate([obs(asOf.toISOString(), 190)], asOf)).toBe(190);
  });

  it("is order-independent", () => {
    const a = [obs("2026-01-01T07:00:00Z", 160), obs("2026-09-01T07:00:00Z", 185), obs("2026-05-01T07:00:00Z", 175)];
    expect(trailingMaxHeartRate(a, asOf)).toBe(trailingMaxHeartRate([...a].reverse(), asOf));
  });

  it("skips rows with no recorded max and returns undefined when none have one", () => {
    expect(trailingMaxHeartRate([obs("2026-09-01T07:00:00Z"), obs("2026-09-02T07:00:00Z", 0)], asOf)).toBeUndefined();
  });

  it("honours the window boundary exactly", () => {
    const edge = new Date(asOf.getTime() - MAX_HR_WINDOW_DAYS * 86_400_000);
    expect(trailingMaxHeartRate([obs(edge.toISOString(), 177)], asOf)).toBe(177);
    expect(trailingMaxHeartRate([obs(new Date(edge.getTime() - 1).toISOString(), 177)], asOf)).toBeUndefined();
  });
});

describe("withObservedMax", () => {
  it("uses the observed value", () => {
    expect(withObservedMax(DEFAULT_PROFILE, 192).maxHeartRate).toBe(192);
  });

  it("falls back to the profile when nothing was observed", () => {
    expect(withObservedMax(DEFAULT_PROFILE, undefined)).toBe(DEFAULT_PROFILE);
  });

  it("rejects an implausibly low observation rather than scoring a walk as maximal", () => {
    // Resting 60 in the default profile; a "max" of 85 is a sensor artefact.
    expect(withObservedMax(DEFAULT_PROFILE, 85).maxHeartRate).toBe(DEFAULT_PROFILE.maxHeartRate);
  });

  it("rejects a year with no hard effort in it — a ceiling far below the fallback", () => {
    // Fallback 185: 127 from a sparse year of easy sessions is not a max, 170 might be.
    expect(withObservedMax(DEFAULT_PROFILE, 127).maxHeartRate).toBe(DEFAULT_PROFILE.maxHeartRate);
    expect(withObservedMax(DEFAULT_PROFILE, 159).maxHeartRate).toBe(DEFAULT_PROFILE.maxHeartRate);
    expect(withObservedMax(DEFAULT_PROFILE, 160).maxHeartRate).toBe(160);
    expect(withObservedMax(DEFAULT_PROFILE, 170).maxHeartRate).toBe(170);
  });

  it("still lets the observed value exceed the fallback freely", () => {
    expect(withObservedMax(DEFAULT_PROFILE, 199).maxHeartRate).toBe(199);
  });
});

describe("scoreWithReference", () => {
  const run: WorkoutInput = {
    activityType: "running", startedAt: "2026-09-13T06:29:00Z", endedAt: "2026-09-13T06:56:00Z",
    durationSeconds: 1650, averageHeartRate: 150, maxHeartRate: 188, source: "shortcut",
  };

  it("scores lower against a higher observed ceiling — the same run is relatively easier", () => {
    const against185 = scoreWithReference(run, { ...DEFAULT_PROFILE, maxHeartRate: 185 }, undefined).effort;
    const against195 = scoreWithReference(run, { ...DEFAULT_PROFILE, maxHeartRate: 185 }, 195).effort;
    expect(against195).toBeLessThan(against185);
  });

  it("records which ceiling was used", () => {
    expect(scoreWithReference(run, DEFAULT_PROFILE, 192).maxHeartRateReference).toBe(192);
    expect(scoreWithReference(run, DEFAULT_PROFILE, undefined).maxHeartRateReference).toBe(DEFAULT_PROFILE.maxHeartRate);
  });

  it("stores the reference on the workout for TRIMP, but not for a MET estimate", () => {
    const withHr = buildWorkout(run, (w) => scoreWithReference(w, DEFAULT_PROFILE, 192));
    expect(withHr.maxHeartRateReference).toBe(192);
    const { averageHeartRate: _a, maxHeartRate: _m, ...noHr } = run;
    const estimated = buildWorkout(noHr, (w) => scoreWithReference(w, DEFAULT_PROFILE, 192));
    expect(estimated.effortModel).toBe("met-minutes");
    expect(estimated.maxHeartRateReference).toBeUndefined();
  });
});
