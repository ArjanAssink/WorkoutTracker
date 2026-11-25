import { describe, expect, it } from "vitest";
import { buildSeries, CARRY_SECONDS, decodeSeries, encodeSeries, MAX_POINTS, stepFor } from "../src/domain/heartRateSeries.js";

const t0 = Date.parse("2026-03-14T07:00:00Z");
const every = (seconds: number, bpms: number[]) => bpms.map((bpm, i) => ({ at: t0 + i * seconds * 1000, bpm }));

describe("stepFor", () => {
  it("uses 5 s steps for an hour and coarser ones once the count would pass the cap", () => {
    expect(stepFor(3600)).toBe(5);
    expect(stepFor(3600 * 2)).toBe(10);
    expect(stepFor(3600 * 5)).toBe(30);
    for (const d of [600, 3600, 7200, 18_000, 86_400]) expect(Math.ceil(d / stepFor(d))).toBeLessThanOrEqual(MAX_POINTS);
  });
});

describe("buildSeries", () => {
  it("averages the readings in each step", () => {
    // Every second for a minute: steps of 5 s, each the mean of its five readings.
    const s = buildSeries(every(1, Array.from({ length: 60 }, (_, i) => 100 + i)), t0, t0 + 60_000)!;
    expect(s.stepSeconds).toBe(5);
    expect(s.bpm).toHaveLength(12);
    expect(s.bpm[0]).toBe(102);
    expect(s.bpm[11]).toBe(157);
  });

  it("carries a reading across empty steps, then breaks the line at a dropout", () => {
    // Twelve readings 10 s apart, then nothing for five minutes, then one more.
    const samples = [...every(10, Array(12).fill(140)), { at: t0 + 420_000, bpm: 150 }];
    const s = buildSeries(samples, t0, t0 + 425_000)!;
    expect(s.stepSeconds).toBe(5);
    expect(s.bpm[1]).toBe(140); // between two readings 10 s apart
    const lastReading = 22; // 110 s / 5
    expect(s.bpm[lastReading + CARRY_SECONDS / 5]).toBe(140);
    expect(s.bpm[lastReading + CARRY_SECONDS / 5 + 1]).toBeNull();
    expect(s.bpm[84]).toBe(150);
  });

  it("is undefined for a watch glance rather than a recording", () => {
    expect(buildSeries(every(60, [120, 125, 130]), t0, t0 + 3_600_000)).toBeUndefined();
    expect(buildSeries(every(300, Array(12).fill(120)), t0, t0 + 3_600_000)).toBeUndefined();
  });

  it("ignores readings outside the workout and impossible values", () => {
    const samples = [{ at: t0 - 10_000, bpm: 200 }, ...every(5, Array(24).fill(130)), { at: t0 + 30_000, bpm: 5 }];
    const s = buildSeries(samples, t0, t0 + 120_000)!;
    expect(Math.max(...s.bpm.filter((v): v is number => v !== null))).toBe(130);
  });
});

describe("encodeSeries / decodeSeries", () => {
  it("round-trips, gaps included", () => {
    const s = { stepSeconds: 10, bpm: [120, null, null, 135, 140] };
    expect(encodeSeries(s)).toBe("10:120,,,135,140");
    expect(decodeSeries(encodeSeries(s))).toEqual(s);
  });

  it("rejects what it did not write", () => {
    expect(decodeSeries(undefined)).toBeUndefined();
    expect(decodeSeries("abc")).toBeUndefined();
    expect(decodeSeries("0:120")).toBeUndefined();
  });
});
