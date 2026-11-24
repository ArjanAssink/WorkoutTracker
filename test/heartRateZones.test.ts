import { describe, expect, it } from "vitest";
import {
  buildHistogram, decodeHistogram, encodeHistogram, presentWorkout, workoutZones, zoneBounds, zoneOf, zoneSeconds,
  MAX_SAMPLE_GAP_SECONDS,
} from "../src/domain/heartRateZones.js";

const t0 = Date.parse("2026-03-14T07:00:00Z");
const every = (seconds: number, bpms: number[]) => bpms.map((bpm, i) => ({ at: t0 + i * seconds * 1000, bpm }));

describe("zoneOf", () => {
  // Resting 50, max 190: reserve 140. Zone floors at 60/70/80/90% → 134, 148, 162, 176.
  it("splits the reserve at 60/70/80/90%", () => {
    expect(zoneBounds(50, 190)).toEqual([50, 134, 148, 162, 176]);
    expect(zoneOf(100, 50, 190)).toBe(0);
    expect(zoneOf(133, 50, 190)).toBe(0);
    expect(zoneOf(134, 50, 190)).toBe(1);
    expect(zoneOf(150, 50, 190)).toBe(2);
    expect(zoneOf(170, 50, 190)).toBe(3);
    expect(zoneOf(176, 50, 190)).toBe(4);
    expect(zoneOf(200, 50, 190)).toBe(4);
  });

  it("puts everything below 60% of reserve, resting included, in zone 1", () => {
    expect(zoneOf(40, 50, 190)).toBe(0);
  });
});

describe("buildHistogram", () => {
  it("credits each sample with the time until the next, the last with the time to the end", () => {
    const samples = every(5, [120, 120, 121, 121, 121, 122, 122, 122, 122, 122, 122, 122]);
    const h = buildHistogram(samples, t0, t0 + 60_000)!;
    expect(h.from).toBe(120);
    // 11 gaps of 5 s, the last sample runs to t0+60 s (5 s).
    expect(h.seconds).toEqual([10, 15, 35]);
    expect(h.seconds.reduce((a, b) => a + b, 0)).toBe(60);
  });

  it("caps a dropout rather than smearing one reading across it", () => {
    const samples = [...every(5, Array(10).fill(130)), { at: t0 + 50_000 + 600_000, bpm: 160 }];
    const h = buildHistogram(samples, t0, t0 + 660_000)!;
    const at130 = h.seconds[0]!;
    expect(at130).toBe(45 + MAX_SAMPLE_GAP_SECONDS);
  });

  it("ignores samples outside the workout", () => {
    const samples = every(5, Array(20).fill(140));
    const h = buildHistogram([{ at: t0 - 60_000, bpm: 60 }, ...samples], t0, t0 + 100_000)!;
    expect(h.from).toBe(140);
  });

  it("refuses a watch glance: too few samples, or too sparse", () => {
    expect(buildHistogram(every(5, [140, 141, 142]), t0, t0 + 15_000)).toBeUndefined();
    // Ten readings over an hour is one per six minutes.
    expect(buildHistogram(every(360, Array(10).fill(140)), t0, t0 + 3_600_000)).toBeUndefined();
  });
});

describe("encoding", () => {
  it("round-trips", () => {
    const h = { from: 98, seconds: [0, 12, 300, 4] };
    expect(encodeHistogram(h)).toBe("98:0,12,300,4");
    expect(decodeHistogram(encodeHistogram(h))).toEqual(h);
  });

  it("returns undefined for anything malformed", () => {
    expect(decodeHistogram(undefined)).toBeUndefined();
    expect(decodeHistogram("")).toBeUndefined();
    expect(decodeHistogram("98;1,2")).toBeUndefined();
  });
});

describe("zoneSeconds / workoutZones", () => {
  it("sums the histogram into five zones", () => {
    // 130 bpm (Z1), 140 (Z2), 160 (Z3), 170 (Z4), 180 (Z5) against 50/190.
    const h = { from: 130, seconds: Array.from({ length: 51 }, (_, i) => ([0, 10, 30, 40, 50].includes(i) ? 60 : 0)) };
    expect(zoneSeconds(h, 50, 190)).toEqual([60, 60, 60, 60, 60]);
  });

  it("zones a stored workout against the max it was scored with, not the fallback", () => {
    const row = { heartRateHistogram: "160:600", maxHeartRateReference: 170 };
    // Against 170: (160-50)/120 = 92% → zone 5. Against a 190 fallback it would be zone 3.
    expect(workoutZones(row, 50, 190)).toEqual([0, 0, 0, 0, 600]);
    expect(workoutZones({ heartRateHistogram: "160:600" }, 50, 190)).toEqual([0, 0, 600, 0, 0]);
  });

  it("is undefined for a workout with no sample stream", () => {
    expect(workoutZones({ maxHeartRateReference: 180 }, 50, 190)).toBeUndefined();
  });
});

describe("presentWorkout", () => {
  it("swaps the histogram for zone seconds and the bpm floors of that workout's own reference", () => {
    const out = presentWorkout({ id: "a", heartRateHistogram: "160:600", maxHeartRateReference: 170 }, 50, 190);
    expect(out).toEqual({ id: "a", maxHeartRateReference: 170, heartRateZones: [0, 0, 0, 0, 600], heartRateZoneBpm: [50, 122, 134, 146, 158] });
    expect("heartRateHistogram" in out).toBe(false);
  });

  it("adds nothing for a workout without a histogram", () => {
    expect(presentWorkout({ id: "b", maxHeartRateReference: 170 }, 50, 190)).toEqual({ id: "b", maxHeartRateReference: 170 });
  });
});
