import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { dailyWeights, localDay, MAX_KG, MIN_KG, toKg, type WeightReading } from "../src/domain/bodyWeight.js";
import { parseHealthExport } from "../src/ingest/healthExport.js";
import { extractWeightReadings } from "../src/ingest/healthAutoExport.js";

describe("toKg", () => {
  it("converts the units scales and Apple use", () => {
    expect(toKg(80, "kg")).toBe(80);
    expect(toKg(176.37, "lb")).toBeCloseTo(80, 1);
    expect(toKg(80000, "g")).toBe(80);
    expect(toKg(12.6, "st")).toBeCloseTo(80, 0);
  });
  it("rejects nonsense", () => {
    expect(toKg(80, "furlongs")).toBeUndefined();
    expect(toKg(0, "kg")).toBeUndefined();
    expect(toKg(NaN, "kg")).toBeUndefined();
  });
});

describe("localDay", () => {
  it("uses the local day Apple wrote, not the UTC day", () => {
    // 00:30 local on the 2nd is still the 1st in UTC; the person weighed in on the 2nd.
    expect(localDay("2026-10-02 00:30:00 +0200")).toBe("2026-10-02");
  });
  it("falls back to the UTC day for a bare instant", () => {
    expect(localDay("2026-10-01T22:30:00Z")).toBe("2026-10-01");
  });
});

describe("dailyWeights", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("keeps the earliest reading of each day — the morning weigh-in", () => {
    const out = dailyWeights([
      { at: "2026-10-01 21:00:00 +0200", kg: 82.4 },
      { at: "2026-10-01 07:10:00 +0200", kg: 81.1 },
      { at: "2026-10-02 07:05:00 +0200", kg: 81.0 },
    ], "health-export", now);
    expect(out.map((w) => [w.date, w.kg])).toEqual([["2026-10-01", 81.1], ["2026-10-02", 81]]);
    expect(out[0]!.measuredAt).toBe("2026-10-01T05:10:00.000Z");
  });
  it("drops implausible readings instead of charting a glitch", () => {
    const out = dailyWeights([
      { at: "2026-10-01 07:00:00 +0200", kg: MIN_KG - 1 },
      { at: "2026-10-02 07:00:00 +0200", kg: MAX_KG + 1 },
      { at: "2026-10-03 07:00:00 +0200", kg: 80 },
    ], "manual", now);
    expect(out).toHaveLength(1);
  });
  it("rounds to a tenth and carries the source", () => {
    const [w] = dailyWeights([{ at: "2026-10-01T06:00:00Z", kg: 80.26, sourceName: "Withings" }], "health-export", now);
    expect(w!.kg).toBe(80.3);
    expect(w!.sourceName).toBe("Withings");
    expect(w!.source).toBe("health-export");
  });
});

describe("parseHealthExport body-mass hook", () => {
  it("picks weigh-ins off the stream without disturbing workouts", async () => {
    const xml = `<HealthData>
      <Record type="HKQuantityTypeIdentifierHeartRate" value="72" unit="count/min" startDate="2026-03-14 06:00:00 +0100"/>
      <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Withings" value="81.4" unit="kg" startDate="2026-03-14 06:45:00 +0100"/>
      <Record type="HKQuantityTypeIdentifierBodyMass" value="179.5" unit="lb" startDate="2026-03-15 06:40:00 +0100"/>
      <Workout workoutActivityType="HKWorkoutActivityTypeYoga" duration="30" durationUnit="min" startDate="2026-03-14 19:00:00 +0100" endDate="2026-03-14 19:30:00 +0100"/>
    </HealthData>`;
    const readings: WeightReading[] = [];
    const workouts = [];
    for await (const w of parseHealthExport(Readable.from([xml]), undefined, { onBodyMass: (r) => readings.push(r) })) workouts.push(w);
    expect(workouts).toHaveLength(1);
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({ kg: 81.4, sourceName: "Withings" });
    expect(readings[1]!.kg).toBeCloseTo(81.4, 1);
  });
});

describe("extractWeightReadings (Health Auto Export metrics)", () => {
  it("reads weight_body_mass and converts units", () => {
    const readings = extractWeightReadings({ data: { workouts: [], metrics: [
      { name: "step_count", units: "count", data: [{ date: "2026-10-01 00:00:00 +0200", qty: 9000 }] },
      { name: "weight_body_mass", units: "lb", data: [{ date: "2026-10-01 07:00:00 +0200", qty: 176.37 }] },
    ] } });
    expect(readings).toHaveLength(1);
    expect(readings[0]!.kg).toBeCloseTo(80, 1);
  });
  it("ignores lean/fat mass metrics that also mention mass", () => {
    const readings = extractWeightReadings({ data: { metrics: [{ name: "lean_body_mass", units: "kg", data: [{ date: "2026-10-01 07:00:00 +0200", qty: 65 }] }] } });
    expect(readings).toHaveLength(0);
  });
  it("is empty for a workouts-only payload", () => {
    expect(extractWeightReadings({ data: { workouts: [] } })).toEqual([]);
    expect(extractWeightReadings("nope")).toEqual([]);
  });
});
