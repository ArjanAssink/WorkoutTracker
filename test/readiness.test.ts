import { describe, expect, it } from "vitest";
import { dailyEffort, loadBand, readiness, readinessVerdict, recoveryStatus, trainingLoad, type TrainingLoad } from "../src/domain/readiness.js";
import { ratingLabel, type Rating, type RatingComponent, type RecoveryDay } from "../src/domain/recovery.js";
import type { Workout } from "../src/domain/workout.js";

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function workout(date: string, effort: number): Workout {
  const at = `${date}T17:00:00Z`;
  return { id: at, activityType: "running", startedAt: at, endedAt: at, durationSeconds: 3600, effort, effortModel: "trimp", source: "manual", recordedAt: at };
}
const rating = (score: number, extra: RatingComponent[] = []): Rating => ({ score, label: ratingLabel(score), components: [{ key: "sleep", label: "Sleep", score, weight: 30, detail: "" }, ...extra] });

const AS_OF = "2026-11-27";
/** `days` days ending on AS_OF, one session every other day at `effort`, the last `recentDays` at `recentEffort`. */
function history(effort: number, recentEffort = effort, recentDays = 7, days = 180): Workout[] {
  const out: Workout[] = [];
  for (let i = days - 1; i >= 0; i--) if (i % 2 === 0) out.push(workout(shift(AS_OF, -i), i < recentDays ? recentEffort : effort));
  return out;
}

describe("dailyEffort", () => {
  it("is dense and sums sessions on the same day", () => {
    const days = dailyEffort([workout("2026-11-02", 50), workout("2026-11-02", 30)], "2026-11-01", "2026-11-03");
    expect(days).toEqual([{ date: "2026-11-01", effort: 0 }, { date: "2026-11-02", effort: 80 }, { date: "2026-11-03", effort: 0 }]);
  });
});

describe("trainingLoad", () => {
  it("is balanced at a steady rhythm", () => {
    const load = trainingLoad(history(100), AS_OF)!;
    expect(load.band).toBe("balanced");
    expect(load.ratio).toBeGreaterThan(0.85);
    expect(load.ratio).toBeLessThan(1.15);
    expect(load.typical7Effort).toBeGreaterThan(300);
  });
  it("spikes when the last week doubles", () => {
    expect(trainingLoad(history(100, 250), AS_OF)!.band).toBe("spiking");
  });
  it("is fresh after an easy week", () => {
    expect(trainingLoad(history(100, 20), AS_OF)!.band).toBe("fresh");
  });
  it("ignores sessions after asOf", () => {
    const steady = trainingLoad(history(100), AS_OF)!;
    expect(trainingLoad([...history(100), workout(shift(AS_OF, 1), 900)], AS_OF)).toEqual(steady);
  });
  it("needs six weeks of training to compare against", () => {
    expect(trainingLoad(history(100, 100, 7, 10), AS_OF)).toBeUndefined();
    expect(trainingLoad([], AS_OF)).toBeUndefined();
  });
  it("bands at Gabbett's thresholds", () => {
    expect([0.79, 0.8, 1.3, 1.31, 1.5, 1.51].map(loadBand)).toEqual(["fresh", "balanced", "balanced", "building", "building", "spiking"]);
  });
});

describe("recoveryStatus", () => {
  // Sixty days alternating 70 and 80: mean 75, sd ≈ 5.
  const past = Array.from({ length: 60 }, (_, i) => ({ date: shift(AS_OF, -60 + i), rating: rating(i % 2 ? 80 : 70) }));
  it("reads today against your own usual, not a fixed cut-off", () => {
    expect(recoveryStatus([...past, { date: AS_OF, rating: rating(76) }], AS_OF)!.band).toBe("usual");
    expect(recoveryStatus([...past, { date: AS_OF, rating: rating(83) }], AS_OF)!.band).toBe("above");
    const low = recoveryStatus([...past, { date: AS_OF, rating: rating(68) }], AS_OF)!;
    expect(low.band).toBe("below");
    expect(low.rating.label).toBe("okay"); // absolutely fine, relatively low — the point of the band
    expect(low.usual).toMatchObject({ mean: 75, days: 60 });
    expect(low.trend).toHaveLength(7);
    expect(low.trend.at(-1)).toEqual({ date: AS_OF, score: 68 });
  });
  it("does not call a two-point wobble 'above' when the history is flat", () => {
    const flat = Array.from({ length: 30 }, (_, i) => ({ date: shift(AS_OF, -30 + i), rating: rating(75) }));
    expect(recoveryStatus([...flat, { date: AS_OF, rating: rating(77) }], AS_OF)!.band).toBe("usual");
  });
  it("has no band under two weeks of history", () => {
    const s = recoveryStatus([...past.slice(-5), { date: AS_OF, rating: rating(90) }], AS_OF)!;
    expect(s.band).toBeUndefined();
    expect(s.rating.score).toBe(90);
  });
  it("flags a rating that is days old, and ignores the future", () => {
    const s = recoveryStatus([...past, { date: shift(AS_OF, 3), rating: rating(20) }], AS_OF)!;
    expect(s.date).toBe(shift(AS_OF, -1));
    expect(s.stale).toBe(false);
    expect(recoveryStatus(past.slice(0, 50), AS_OF)!.stale).toBe(true);
    expect(recoveryStatus([], AS_OF)).toBeUndefined();
  });
});

describe("readinessVerdict", () => {
  const status = (band: "above" | "usual" | "below", extra: RatingComponent[] = [], stale = false) =>
    ({ date: AS_OF, rating: rating(75, extra), band, ageDays: stale ? 4 : 0, stale, trend: [] });
  const load = (band: TrainingLoad["band"]): TrainingLoad => ({ acute: 1, chronic: 1, ratio: 1, band, last7Effort: 0, typical7Effort: 0 });

  it("reads the pair, never one blended number", () => {
    expect(readinessVerdict(status("above"), load("balanced"))!.key).toBe("push");
    expect(readinessVerdict(status("above"), load("building"))!.key).toBe("absorbing");
    expect(readinessVerdict(status("usual"), load("balanced"))!.key).toBe("as-planned");
    expect(readinessVerdict(status("usual"), load("fresh"))!.key).toBe("room");
    expect(readinessVerdict(status("below"), load("fresh"))!.key).toBe("take-it-easy");
    expect(readinessVerdict(status("below"), load("spiking"))!.key).toBe("ease-off");
    expect(readinessVerdict(status("above"), load("spiking"))!.tone).toBe("caution");
  });
  it("says what it rests on", () => {
    expect(readinessVerdict(status("below"), load("building"))!.because).toEqual(["recovery below your usual", "load building above the last six weeks"]);
  });
  it("puts the illness tell ahead of everything", () => {
    const v = readinessVerdict(status("above", [{ key: "temp", label: "Wrist temperature", score: 20, weight: 5, detail: "+0.4 °C vs baseline" }]), load("fresh"))!;
    expect(v.key).toBe("illness");
    expect(v.because[0]).toBe("wrist temperature up (+0.4 °C vs baseline)");
  });
  it("falls back to load alone when the night is missing or stale", () => {
    expect(readinessVerdict(undefined, load("fresh"))!.key).toBe("room");
    expect(readinessVerdict(status("below", [], true), load("balanced"))!.key).toBe("as-planned");
    expect(readinessVerdict(undefined, undefined)).toBeUndefined();
  });
});

describe("readiness", () => {
  // Ninety steady nights, then last night short with a high resting heart rate.
  const nights: RecoveryDay[] = Array.from({ length: 120 }, (_, i) => {
    const date = shift(AS_OF, -119 + i), last = date === AS_OF;
    return { date, source: "health-export", recordedAt: date, sleepAsleepSeconds: last ? 5 * 3600 : (7 + (i % 3) * 0.2) * 3600, restingHeartRate: last ? 58 : 50 + (i % 2), hrv: last ? 40 : 60 + (i % 4) };
  });
  it("rates last night against the quarter before it and reads it with the load", () => {
    const r = readiness(nights, history(100, 260), AS_OF);
    expect(r.recovery!.date).toBe(AS_OF);
    expect(r.recovery!.band).toBe("below");
    expect(r.load!.band).toBe("spiking");
    expect(r.verdict!.key).toBe("ease-off");
  });
  it("never reads tomorrow's row", () => {
    const tomorrow = { ...nights[0]!, date: shift(AS_OF, 1), sleepAsleepSeconds: 9 * 3600 };
    expect(readiness([...nights, tomorrow], [], AS_OF).recovery!.date).toBe(AS_OF);
  });
  it("is empty with nothing to read", () => {
    expect(readiness([], [], AS_OF)).toEqual({ asOf: AS_OF });
  });
});
