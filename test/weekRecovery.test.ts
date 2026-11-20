import { describe, expect, it } from "vitest";
import { isLowerEffortWeek, isRestWeekLabel, weekRecovery, weeklyEffortBand } from "../src/domain/weekRecovery.js";
import type { WeekReview } from "../src/domain/goals.js";
const week = (effort = 60, typicalEffort: number | undefined = 100) => ({ weekStart: "2026-10-26", effort, typicalEffort }) as WeekReview;
describe("recovery week classification", () => {
  it("includes the exact threshold, with no rounded-ratio false positives", () => {
    expect(isLowerEffortWeek(week(60))).toBe(true); expect(isLowerEffortWeek(week(60.01))).toBe(false);
  });
  it("requires a positive baseline", () => {
    expect(isLowerEffortWeek({ ...week(), typicalEffort: undefined } as unknown as WeekReview)).toBe(false);
    expect(isLowerEffortWeek(week(0, 0))).toBe(false);
  });
  it("does not classify a partial week's effort as recovery", () => {
    expect(weekRecovery(week(0), undefined, new Date("2026-10-29T12:00:00Z"))).toMatchObject({ complete: false, lowerEffort: false });
    expect(weekRecovery(week(0), undefined, new Date("2026-11-02T00:00:00Z"))).toMatchObject({ complete: true, lowerEffort: true });
  });
  it("keeps manual tags independent of effort", () => {
    expect(weekRecovery(week(150), { label: "Rest week", note: "" }, new Date("2026-11-02"))).toMatchObject({ taggedRest: true, lowerEffort: false });
  });
  it("recognises rest and deload labels, but not vacations as automatically restful", () => {
    for (const label of ["Rest", " Rest week ", "Deload", "Recovery week"]) expect(isRestWeekLabel({ label, note: "" })).toBe(true);
    expect(isRestWeekLabel({ label: "Vacation", note: "" })).toBe(false);
  });
});


describe("weekly effort bands", () => {
  it.each([[0, "recovery"], [60, "recovery"], [60.01, "lighter"], [89.99, "lighter"], [90, "usual"], [100, "usual"], [110, "usual"], [110.01, "higher"], [200, "higher"]] as const)("classifies %s%% of usual as %s", (effort, expected) => {
    expect(weeklyEffortBand(week(effort), true)).toBe(expected);
  });
  it("never assigns a finished-week band to an unfinished week", () => {
    expect(weeklyEffortBand(week(0), false)).toBe("in-progress");
    expect(weeklyEffortBand(week(200), false)).toBe("in-progress");
  });
  it("handles missing and zero baselines", () => {
    expect(weeklyEffortBand(week(0, 0), true)).toBe("unknown");
    const missing = { ...week() }; delete missing.typicalEffort;
    expect(weeklyEffortBand(missing, true)).toBe("unknown");
  });
  it("does not let rest tags override higher recorded effort", () => {
    expect(weekRecovery(week(150), { label: "Rest week", note: "" }, new Date("2026-11-02"))).toMatchObject({ taggedRest: true, effortBand: "higher" });
  });
});
