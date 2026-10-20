import { describe, expect, it } from "vitest";
import { analysePatterns, pearson, sunTimes } from "../src/domain/patterns.js";
import type { RecoveryDay } from "../src/domain/recovery.js";
import type { Workout } from "../src/domain/workout.js";

describe("sunTimes", () => {
  it("gets the solstices right at 52°N to within a few minutes", () => {
    const june = sunTimes("2026-06-21", 52.17, 4.45, "Europe/Amsterdam"), dec = sunTimes("2026-12-21", 52.17, 4.45, "Europe/Amsterdam");
    expect(june.dayLengthHours).toBeGreaterThan(16.5); expect(june.dayLengthHours).toBeLessThan(16.9);
    expect(dec.dayLengthHours).toBeGreaterThan(7.6); expect(dec.dayLengthHours).toBeLessThan(8.0);
    expect(june.sunriseMinutes).toBeGreaterThan(5 * 60 + 10); expect(june.sunriseMinutes).toBeLessThan(5 * 60 + 30);   // ≈05:20 CEST
    expect(dec.sunsetMinutes).toBeGreaterThan(16 * 60 + 20); expect(dec.sunsetMinutes).toBeLessThan(16 * 60 + 40);     // ≈16:30 CET
  });
});

describe("pearson", () => {
  it("skips gaps and needs eight points", () => {
    expect(pearson([1, 2, 3, 4, 5, 6, 7, 8], [2, 4, 6, 8, 10, 12, 14, 16]).r).toBe(1);
    expect(pearson([1, 2, undefined, 4], [1, 2, 3, 4]).n).toBe(3);
  });
});

describe("analysePatterns", () => {
  const day = (i: number, over: Partial<RecoveryDay>): RecoveryDay => ({ date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), source: "health-export", recordedAt: "x", ...over });
  const w = (date: string, activityType: string, hour: number, minutes = 60): Workout => { const start = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`); return { id: `${date}${activityType}${hour}`, activityType, startedAt: new Date(start).toISOString(), endedAt: new Date(start + minutes * 60_000).toISOString(), durationSeconds: minutes * 60, effort: 50, effortModel: "trimp", source: "health-export", recordedAt: date }; };

  it("needs two months of days", () => {
    expect(analysePatterns([day(0, {}), day(1, {})], [], [])).toBeUndefined();
  });

  it("finds a planted pattern: evening sessions on Mondays cost sleep, and says so", () => {
    const days: RecoveryDay[] = [], workouts: Workout[] = [];
    for (let i = 0; i < 400; i++) {
      const d = day(i, { restingHeartRate: 56 + ((i * 7) % 5), hrv: 50 + ((i * 3) % 9), sleepAwakenings: 3 });
      const dow = (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7;
      // Night ending on day i follows day i-1: Mondays (dow 0) hold a late BJJ session, so Tuesday mornings are short.
      const prevDow = (dow + 6) % 7;
      days.push({ ...d, sleepAsleepSeconds: (prevDow === 0 ? 7.0 : 8.2) * 3600, bedtimeMinutes: prevDow === 0 ? 1440 : 1380, wakeMinutes: 420 });
      if (dow === 0) workouts.push(w(d.date, "martialarts", 18, 90));
      if (dow === 2 || dow === 4) workouts.push(w(d.date, "strength", 7, 60));
    }
    const p = analysePatterns(days, workouts, [])!;
    const bjj = p.byActivity.find((a) => a.label === "BJJ")!;
    expect(bjj.sleepHours!.mean).toBeCloseTo(7.0, 1);
    expect(p.byActivity.find((a) => a.label === "Strength Training")!.sleepHours!.mean).toBeCloseTo(8.2, 1);
    expect(p.readings.some((r) => r.startsWith("BJJ nights are the short nights"))).toBe(true);
    expect(p.readings.some((r) => r.includes("ending after 20:00"))).toBe(true);
    expect(p.weekday.find((d) => d.label === "Mon")!.sleepHours!.mean).toBeCloseTo(7.0, 1);
    expect(p.daylight.months).toHaveLength(12);
    expect(p.span.days).toBe(400);
  });
});
