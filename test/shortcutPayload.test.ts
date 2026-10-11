import { describe, expect, it } from "vitest";
import { PayloadError, parseAppleDate, parseShortcutPayload } from "../src/ingest/shortcutPayload.js";

describe("parseAppleDate", () => {
  it("parses Apple's space-separated export format with an offset", () => {
    expect(parseAppleDate("2026-03-14 07:21:03 +0100")?.toISOString()).toBe("2026-03-14T06:21:03.000Z");
  });

  it("parses an offset written without a colon", () => {
    expect(parseAppleDate("2026-03-14 07:21:03 +0100")?.toISOString()).toBe(
      parseAppleDate("2026-03-14T07:21:03+01:00")?.toISOString(),
    );
  });

  it("treats a zone-less timestamp as UTC rather than guessing the server's locale", () => {
    expect(parseAppleDate("2026-03-14 07:21:03")?.toISOString()).toBe("2026-03-14T07:21:03.000Z");
  });

  it("returns undefined for nonsense", () => {
    expect(parseAppleDate("not a date")).toBeUndefined();
  });
});

describe("parseShortcutPayload", () => {
  const minimal = {
    activityType: "Outdoor Run",
    startedAt: "2026-03-14T07:00:00Z",
    endedAt: "2026-03-14T07:45:00Z",
  };

  it("derives duration from the start/end span when none is given", () => {
    expect(parseShortcutPayload(minimal).durationSeconds).toBe(2700);
  });

  it("prefers an explicit duration, which excludes paused time", () => {
    const parsed = parseShortcutPayload({ ...minimal, duration: "40 min" });
    expect(parsed.durationSeconds).toBe(2400);
  });

  it("derives the end time when only a duration is given", () => {
    const parsed = parseShortcutPayload({
      activityType: "Running",
      startedAt: "2026-03-14T07:00:00Z",
      duration: "30 min",
    });
    expect(parsed.endedAt).toBe("2026-03-14T07:30:00.000Z");
  });

  it("converts the units Shortcuts emits as text", () => {
    const parsed = parseShortcutPayload({
      ...minimal,
      distance: "8.2 km",
      activeEnergy: "512 kcal",
      averageHeartRate: "148 bpm",
    });
    expect(parsed.distanceMeters).toBeCloseTo(8200, 6);
    expect(parsed.activeEnergyKcal).toBe(512);
    expect(parsed.averageHeartRate).toBe(148);
  });

  it("handles miles and kilojoules", () => {
    const parsed = parseShortcutPayload({ ...minimal, distance: "5 mi", activeEnergy: "2000 kJ" });
    expect(parsed.distanceMeters).toBeCloseTo(8046.72, 2);
    expect(parsed.activeEnergyKcal).toBeCloseTo(478.01, 1);
  });

  it("accepts a locale decimal comma", () => {
    expect(parseShortcutPayload({ ...minimal, distance: "8,2 km" }).distanceMeters).toBeCloseTo(8200, 6);
  });

  it("accepts bare numbers, assuming the canonical unit", () => {
    const parsed = parseShortcutPayload({ ...minimal, distance: 8200, activeEnergy: 512 });
    expect(parsed.distanceMeters).toBe(8200);
    expect(parsed.activeEnergyKcal).toBe(512);
  });

  it("accepts the key spellings Shortcuts produces when Health variables are dragged in", () => {
    const parsed = parseShortcutPayload({
      "Workout Type": "Outdoor Run",
      "Start Date": "2026-03-14 07:00:00 +0000",
      "End Date": "2026-03-14 07:45:00 +0000",
      "Total Distance": "8.2 km",
      "Active Calories": "512 kcal",
      Device: "Apple Watch",
    });
    expect(parsed.activityType).toBe("running");
    expect(parsed.durationSeconds).toBe(2700);
    expect(parsed.distanceMeters).toBeCloseTo(8200, 6);
    expect(parsed.sourceName).toBe("Apple Watch");
  });

  it("drops null and empty values rather than failing on them", () => {
    const parsed = parseShortcutPayload({ ...minimal, distance: null, notes: "", maxHeartRate: undefined });
    expect(parsed.distanceMeters).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  it("rejects a payload with no way to determine length", () => {
    expect(() => parseShortcutPayload({ activityType: "Running", startedAt: "2026-03-14T07:00:00Z" })).toThrow(
      PayloadError,
    );
  });

  it("rejects a missing activity type", () => {
    expect(() => parseShortcutPayload({ startedAt: "2026-03-14T07:00:00Z", duration: 600 })).toThrow(PayloadError);
  });

  it("rejects a non-object body", () => {
    expect(() => parseShortcutPayload("nope")).toThrow(PayloadError);
    expect(() => parseShortcutPayload([{ activityType: "Running" }])).toThrow(PayloadError);
  });
});
