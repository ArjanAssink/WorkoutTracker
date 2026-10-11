import { describe, expect, it } from "vitest";
import {
  circularSd, dailyRecovery, nightOf, weeklyRecovery, withBaselines, type RecoverySample,
} from "../src/domain/recovery.js";
import type { Workout } from "../src/domain/workout.js";
import { extractRecovery } from "../src/ingest/healthAutoExport.js";

const watch = "Watch", phone = "iPhone";
const seg = (stage: RecoverySample["stage"], start: string, end: string, sourceName = watch): RecoverySample =>
  ({ metric: "sleep", start, end, value: 1, stage, sourceName });

// A real-shaped night: in bed 23:10, asleep 23:30 → 06:50 with two short wakes.
const night = [
  seg("core", "2026-10-07 23:30:00 +0200", "2026-10-08 00:40:00 +0200"),
  seg("deep", "2026-10-08 00:40:00 +0200", "2026-10-08 01:30:00 +0200"),
  seg("core", "2026-10-08 01:30:00 +0200", "2026-10-08 03:00:00 +0200"),
  seg("awake", "2026-10-08 03:00:00 +0200", "2026-10-08 03:03:00 +0200"),
  seg("rem", "2026-10-08 03:03:00 +0200", "2026-10-08 04:00:00 +0200"),
  seg("core", "2026-10-08 04:00:00 +0200", "2026-10-08 06:20:00 +0200"),
  seg("awake", "2026-10-08 06:20:00 +0200", "2026-10-08 06:21:30 +0200"),
  seg("rem", "2026-10-08 06:21:30 +0200", "2026-10-08 06:50:00 +0200"),
  seg("inBed", "2026-10-07 23:10:00 +0200", "2026-10-08 06:55:00 +0200", phone),
];

describe("nightOf", () => {
  it("files a sleep by the morning it ends on, by wall clock", () => {
    expect(nightOf("2026-10-07 23:30:00 +0200")).toBe("2026-10-08");
    expect(nightOf("2026-10-08 02:00:00 +0200")).toBe("2026-10-08");
    expect(nightOf("2026-10-08 14:00:00 +0200")).toBe("2026-10-08"); // an afternoon nap stays with its day
    expect(nightOf("2026-10-08 16:00:00 +0200")).toBe("2026-10-09"); // an evening doze is the next night's
  });
});

describe("dailyRecovery — sleep", () => {
  it("assembles a staged night from the watch and ignores the phone's in-bed duplicate for totals", () => {
    const [d] = dailyRecovery({ samples: night }, "health-export");
    expect(d!.date).toBe("2026-10-08");
    expect(d!.sleepAsleepSeconds).toBe((70 + 50 + 90 + 57 + 140 + 28.5) * 60);
    expect(d!.sleepDeepSeconds).toBe(50 * 60);
    expect(d!.sleepRemSeconds).toBe((57 + 28.5) * 60);
    expect(d!.sleepAwakeSeconds).toBe(4.5 * 60);
    expect(d!.sleepAwakenings).toBe(2);
    expect(d!.sleepStaged).toBe(true);
    expect(d!.sleepSourceName).toBe(watch);
    expect(d!.sleepStart).toBe("2026-10-07T21:30:00.000Z");
    expect(d!.bedtimeMinutes).toBe(23 * 60 + 30);
    expect(d!.wakeMinutes).toBe(6 * 60 + 50);
  });

  it("falls back to in-bed time when no source has stages", () => {
    const [d] = dailyRecovery({ samples: [seg("inBed", "2017-01-03 23:00:00 +0100", "2017-01-04 07:00:00 +0100", "Clock")] }, "health-export");
    expect(d!.sleepAsleepSeconds).toBeUndefined(); // in-bed is not a measurement of sleep
    expect(d!.sleepInBedSeconds).toBe(8 * 3600);
    expect(d!.sleepStaged).toBe(false);
    expect(d!.bedtimeMinutes).toBe(23 * 60);
  });

  it("drops a fragment too short to be a night", () => {
    expect(dailyRecovery({ samples: [seg("core", "2026-10-08 14:00:00 +0200", "2026-10-08 14:10:00 +0200")] }, "health-export")).toEqual([]);
  });

  it("takes a pre-summarised night from Health Auto Export in hours", () => {
    const [d] = dailyRecovery({ nights: [{ end: "2026-10-08T06:50:00+02:00", start: "2026-10-07T23:30:00+02:00", asleepHours: 7, deepHours: 0.8, remHours: 1.4, coreHours: 4.8, awakeHours: 0.1, inBedHours: 7.7 }] }, "health-auto-export");
    expect(d!.date).toBe("2026-10-08");
    expect(d!.sleepAsleepSeconds).toBe(25200);
    expect(d!.sleepStaged).toBe(true);
    expect(d!.bedtimeMinutes).toBe(23 * 60 + 30);
  });
});

describe("dailyRecovery — the daytime and overnight quantities", () => {
  const q = (metric: RecoverySample["metric"], start: string, value: number): RecoverySample => ({ metric, start, end: start, value });
  it("averages HRV over the day, files respiratory rate under the morning, scales SpO₂ to percent", () => {
    const days = dailyRecovery({ samples: [
      q("restingHeartRate", "2026-10-08 00:18:00 +0200", 57.4),
      q("hrv", "2026-10-08 03:18:00 +0200", 60), q("hrv", "2026-10-08 15:00:00 +0200", 40),
      q("respiratoryRate", "2026-10-07 23:51:00 +0200", 14), q("respiratoryRate", "2026-10-08 05:00:00 +0200", 16),
      q("spo2", "2026-10-08 10:00:00 +0200", 0.97),
      q("wristTemperature", "2026-10-07 23:09:00 +0200", 36.41),
      q("daylight", "2026-10-08 10:23:00 +0200", 5), q("daylight", "2026-10-08 10:28:00 +0200", 5),
    ] }, "health-export");
    expect(days).toHaveLength(1);
    const d = days[0]!;
    expect(d).toMatchObject({ date: "2026-10-08", restingHeartRate: 57, hrv: 50, hrvSamples: 2, respiratoryRate: 15, spo2: 97, wristTemperature: 36.41, daylightMinutes: 10 });
  });
  it("rejects implausible values rather than storing a glitch", () => {
    expect(dailyRecovery({ samples: [q("restingHeartRate", "2026-10-08 00:18:00 +0200", 300)] }, "health-export")).toEqual([]);
  });
});

describe("withBaselines", () => {
  it("gives each day the median of its previous four weeks, once a week of values exists", () => {
    const days = Array.from({ length: 40 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), restingHeartRate: 55 + (i % 3), hrv: 50, source: "health-export" as const, recordedAt: "x",
    }));
    const v = withBaselines(days);
    expect(v[3]!.restingHeartRateBaseline).toBeUndefined();
    expect(v[10]!.restingHeartRateBaseline).toBe(56);
    expect(v[39]!.hrvBaseline).toBe(50);
  });
});

describe("weeklyRecovery", () => {
  it("joins the week's training load with how its nights went", () => {
    const w = (startedAt: string, effort: number): Workout => ({ id: startedAt, activityType: "strength", startedAt, endedAt: startedAt, durationSeconds: 3600, effort, effortModel: "trimp", source: "shortcut", recordedAt: startedAt });
    const days = [
      { date: "2026-03-09", sleepAsleepSeconds: 7 * 3600, sleepDeepSeconds: 3600, sleepRemSeconds: 1.5 * 3600, sleepStaged: true, sleepAwakenings: 2, bedtimeMinutes: 23 * 60, restingHeartRate: 56, hrv: 48, source: "health-export" as const, recordedAt: "x" },
      { date: "2026-03-10", sleepAsleepSeconds: 6 * 3600, sleepDeepSeconds: 0.5 * 3600, sleepRemSeconds: 3600, sleepStaged: true, sleepAwakenings: 4, bedtimeMinutes: 24 * 60 + 30, restingHeartRate: 60, hrv: 40, source: "health-export" as const, recordedAt: "x" },
      { date: "2026-03-11", sleepAsleepSeconds: 8 * 3600, sleepDeepSeconds: 3600, sleepRemSeconds: 2 * 3600, sleepStaged: true, sleepAwakenings: 0, bedtimeMinutes: 22 * 60 + 30, restingHeartRate: 55, hrv: 55, source: "health-export" as const, recordedAt: "x" },
    ];
    const [week] = weeklyRecovery(days, [w("2026-03-09T07:00:00Z", 80), w("2026-03-11T07:00:00Z", 120)], new Date("2026-03-09T00:00:00Z"), new Date("2026-03-16T00:00:00Z"));
    expect(week).toMatchObject({ weekStart: "2026-03-09", sessions: 2, effort: 200, nights: 3, asleepSeconds: 7 * 3600, awakenings: 2, restingHeartRate: 57, hrv: 47.7 });
    expect(week!.deepPct).toBeCloseTo((2.5 / 21) * 100, 0);
    expect(week!.bedtimeSdMinutes).toBeGreaterThan(40);
    expect(week!.bedtimeMinutes).toBe(23 * 60);
  });
});

describe("circularSd", () => {
  it("treats times either side of midnight as close together", () => {
    expect(circularSd([23 * 60 + 50, 24 * 60 + 10, 10, 1430])).toBeLessThan(15);
    expect(circularSd([22 * 60, 2 * 60])).toBeGreaterThan(100);
  });
});

describe("extractRecovery — Health Auto Export metrics", () => {
  it("reads nights and the quantities, ignoring metrics it does not know", () => {
    const body = { data: { metrics: [
      { name: "sleep_analysis", units: "hr", data: [{ date: "2026-10-08 06:50:00 +0200", sleepStart: "2026-10-07 23:30:00 +0200", sleepEnd: "2026-10-08 06:50:00 +0200", inBed: 7.7, asleep: 7, core: 4.8, deep: 0.8, rem: 1.4, awake: 0.1, source: "Watch" }] },
      { name: "resting_heart_rate", units: "bpm", data: [{ date: "2026-10-08 00:18:00 +0200", qty: 57 }] },
      { name: "heart_rate_variability", units: "ms", data: [{ date: "2026-10-08 03:18:00 +0200", qty: 48.2 }] },
      { name: "blood_oxygen_saturation", units: "%", data: [{ date: "2026-10-08 10:00:00 +0200", qty: 97 }] },
      { name: "step_count", units: "count", data: [{ date: "2026-10-08 10:00:00 +0200", qty: 9000 }] },
    ] } };
    const { samples, nights } = extractRecovery(body);
    expect(nights).toHaveLength(1);
    expect(nights[0]).toMatchObject({ asleepHours: 7, deepHours: 0.8, sourceName: "Watch" });
    expect(samples.map((s) => s.metric)).toEqual(["restingHeartRate", "hrv", "spo2"]);
    const [d] = dailyRecovery(extractRecovery(body), "health-auto-export");
    expect(d).toMatchObject({ date: "2026-10-08", restingHeartRate: 57, hrv: 48.2, spo2: 97, sleepAsleepSeconds: 25200 });
  });
  it("returns nothing for a payload without metrics", () => {
    expect(extractRecovery({ data: { workouts: [] } })).toEqual({ samples: [], nights: [] });
  });
});
