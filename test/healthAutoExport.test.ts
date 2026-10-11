import { describe, expect, it } from "vitest";
import {
  extractWorkoutArray,
  HealthAutoExportError,
  parseHealthAutoExportBatch,
  resolveDuration,
} from "../src/ingest/healthAutoExport.js";
import { buildWorkout, workoutId } from "../src/domain/workout.js";
import { scoreEffort } from "../src/domain/effort.js";
import { parseShortcutPayload } from "../src/ingest/shortcutPayload.js";

/** A v2 workout exactly as the app's documentation describes it. */
const V2 = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "Running",
  start: "2024-02-06 07:00:00 -0800",
  end: "2024-02-06 07:30:00 -0800",
  duration: 1800,
  distance: { qty: 3.5, units: "mi" },
  activeEnergyBurned: { qty: 350, units: "kcal" },
  avgHeartRate: { qty: 150, units: "bpm" },
  maxHeartRate: { qty: 175, units: "bpm" },
};

/** The v1 legacy shape: different energy key, no duration, no heart rate. */
const V1 = {
  name: "Running",
  start: "2024-02-06 07:00:00 -0800",
  end: "2024-02-06 07:30:00 -0800",
  activeEnergy: { qty: 350, units: "kcal" },
  distance: { qty: 3.5, units: "mi" },
};

describe("extractWorkoutArray", () => {
  it("reads the envelope the app actually sends", () => {
    expect(extractWorkoutArray({ data: { workouts: [V2], metrics: [] } })).toHaveLength(1);
  });

  it("accepts a bare workouts key and a plain array", () => {
    expect(extractWorkoutArray({ workouts: [V2] })).toHaveLength(1);
    expect(extractWorkoutArray([V2])).toHaveLength(1);
  });

  it("accepts a single unwrapped workout, which a per-workout Shortcut would post", () => {
    expect(extractWorkoutArray(V2)).toHaveLength(1);
    expect(parseHealthAutoExportBatch(V2).workouts[0]!.activityType).toBe("running");
  });

  it("returns undefined when there is no workouts array to find", () => {
    expect(extractWorkoutArray({ data: { metrics: [] } })).toBeUndefined();
    expect(extractWorkoutArray({})).toBeUndefined();
    expect(extractWorkoutArray(null)).toBeUndefined();
    expect(extractWorkoutArray("nope")).toBeUndefined();
  });
});

describe("resolveDuration", () => {
  it("reads a seconds duration as seconds", () => {
    expect(resolveDuration(1800, 1800)).toBe(1800);
  });

  it("reads a minutes duration as minutes, by comparing against the span", () => {
    // 30 alongside a 1800s span can only mean minutes.
    expect(resolveDuration(30, 1800)).toBe(1800);
  });

  it("prefers duration over the span, so paused time stays excluded", () => {
    // 25 minutes of work inside a 30-minute wall-clock window.
    expect(resolveDuration(1500, 1800)).toBe(1500);
  });

  it("falls back to the span when there is no duration", () => {
    expect(resolveDuration(undefined, 1800)).toBe(1800);
    expect(resolveDuration(0, 1800)).toBe(1800);
  });

  it("assumes seconds when there is nothing to compare against", () => {
    expect(resolveDuration(1800, undefined)).toBe(1800);
  });
});

describe("measurement shapes the app actually sends", () => {
  // The first real export rejected all nineteen workouts: activeEnergy arrived as a
  // per-sample array, and a strict schema turned that into total data loss.
  const base = { name: "Running", start: V1.start, end: V1.end };

  it("sums a per-sample energy series", () => {
    const w = parseHealthAutoExportBatch({
      workouts: [{ ...base, activeEnergy: [
        { date: "2024-02-06 07:00:00 -0800", qty: 100, units: "kcal" },
        { date: "2024-02-06 07:10:00 -0800", qty: 150, units: "kcal" },
        { date: "2024-02-06 07:20:00 -0800", qty: 100, units: "kcal" },
      ] }],
    }).workouts[0]!;
    expect(w.activeEnergyKcal).toBe(350);
  });

  it("sums a per-sample distance series and converts its units", () => {
    const w = parseHealthAutoExportBatch({
      workouts: [{ ...base, distance: [{ qty: 2, units: "km" }, { qty: 1.5, units: "km" }] }],
    }).workouts[0]!;
    expect(w.distanceMeters).toBeCloseTo(3500, 6);
  });

  it("averages a heart-rate series for avg and takes the peak for max", () => {
    const w = parseHealthAutoExportBatch({
      workouts: [{ ...base, heartRate: [
        { date: "x", Avg: 140, Min: 120, Max: 160, units: "bpm" },
        { date: "y", Avg: 160, Min: 150, Max: 180, units: "bpm" },
      ] }],
    }).workouts[0]!;
    expect(w.averageHeartRate).toBe(150);
    expect(w.minHeartRate).toBe(120);
    expect(w.maxHeartRate).toBe(180);
  });

  it("still reads the plain { qty, units } object form", () => {
    const w = parseHealthAutoExportBatch({ workouts: [{ ...base, activeEnergy: { qty: 350, units: "kcal" } }] })
      .workouts[0]!;
    expect(w.activeEnergyKcal).toBe(350);
  });

  it("reads a bare number, assuming the canonical unit", () => {
    const w = parseHealthAutoExportBatch({ workouts: [{ ...base, distance: 5000 }] }).workouts[0]!;
    expect(w.distanceMeters).toBe(5000);
  });

  it("keeps the workout when a measurement is a shape it cannot read at all", () => {
    const { workouts, skipped } = parseHealthAutoExportBatch({
      workouts: [{ ...base, activeEnergy: "a lot", distance: { nonsense: true }, avgHeartRate: [] }],
    });
    expect(skipped).toEqual([]);
    expect(workouts[0]!.activityType).toBe("running");
    expect(workouts[0]!.durationSeconds).toBe(1800);
    expect(workouts[0]!.activeEnergyKcal).toBeUndefined();
    expect(workouts[0]!.distanceMeters).toBeUndefined();
  });

  it("ignores null and empty series rather than writing zeroes", () => {
    const w = parseHealthAutoExportBatch({
      workouts: [{ ...base, activeEnergy: null, distance: [], maxHeartRate: undefined }],
    }).workouts[0]!;
    expect(w.activeEnergyKcal).toBeUndefined();
    expect(w.distanceMeters).toBeUndefined();
  });

  it("only ever rejects a workout for missing identity or timing", () => {
    const { skipped } = parseHealthAutoExportBatch({
      workouts: [
        { start: V1.start, end: V1.end },                 // no name
        { name: "Running" },                              // no start
        { name: "Running", start: "nope", end: V1.end },  // unparseable start
        { name: "Running", start: V1.start },             // no end and no duration
      ],
    });
    expect(skipped).toHaveLength(4);
  });
});

describe("parseHealthAutoExportBatch", () => {
  it("parses the documented v2 shape, converting units", () => {
    const { workouts, skipped } = parseHealthAutoExportBatch({ data: { workouts: [V2] } });
    expect(skipped).toEqual([]);
    const w = workouts[0]!;
    expect(w.activityType).toBe("running");
    expect(w.startedAt).toBe("2024-02-06T15:00:00.000Z");
    expect(w.durationSeconds).toBe(1800);
    expect(w.distanceMeters).toBeCloseTo(5632.7, 1); // 3.5 mi
    expect(w.activeEnergyKcal).toBe(350);
    expect(w.averageHeartRate).toBe(150);
    expect(w.maxHeartRate).toBe(175);
    expect(w.source).toBe("health-export");
  });

  it("parses the v1 legacy shape, deriving duration from the span", () => {
    const w = parseHealthAutoExportBatch({ data: { workouts: [V1] } }).workouts[0]!;
    expect(w.durationSeconds).toBe(1800);
    expect(w.activeEnergyKcal).toBe(350);
    expect(w.averageHeartRate).toBeUndefined();
  });

  it("normalises Apple's long activity names", () => {
    const names = [
      ["Traditional Strength Training", "strength"],
      ["High Intensity Interval Training", "hiit"],
      ["Functional Strength Training", "functionalstrength"],
      ["Outdoor Cycle", "cycling"],
    ] as const;
    for (const [name, expected] of names) {
      const w = parseHealthAutoExportBatch({ workouts: [{ ...V1, name }] }).workouts[0]!;
      expect(w.activityType, name).toBe(expected);
    }
  });

  it("ignores fields it does not know about", () => {
    const w = parseHealthAutoExportBatch({
      workouts: [{ ...V2, temperature: { qty: 11, units: "degC" }, elevationUp: { qty: 120, units: "m" }, route: [] }],
    }).workouts[0]!;
    expect(w.activityType).toBe("running");
  });

  it("drops a measurement with an unrecognised unit but keeps the workout", () => {
    const w = parseHealthAutoExportBatch({
      workouts: [{ ...V2, distance: { qty: 3.5, units: "furlongs" } }],
    }).workouts[0]!;
    expect(w.distanceMeters).toBeUndefined();
    expect(w.activeEnergyKcal).toBe(350);
  });

  it("converts kilojoules", () => {
    const w = parseHealthAutoExportBatch({
      workouts: [{ ...V2, activeEnergyBurned: { qty: 2000, units: "kJ" } }],
    }).workouts[0]!;
    expect(w.activeEnergyKcal).toBeCloseTo(478.01, 1);
  });

  it("skips one bad workout without losing the rest of the batch", () => {
    const { workouts, skipped } = parseHealthAutoExportBatch({
      data: { workouts: [V2, { name: "Running", start: "not a date" }, { ...V1, name: "Yoga" }] },
    });
    expect(workouts).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.index).toBe(1);
  });

  it("skips a workout with no way to determine its length", () => {
    const { workouts, skipped } = parseHealthAutoExportBatch({ workouts: [{ name: "Yoga", start: V1.start }] });
    expect(workouts).toHaveLength(0);
    expect(skipped[0]!.reason).toMatch(/neither an end time nor a duration/);
  });

  it("rejects a payload with no workouts array at all", () => {
    expect(() => parseHealthAutoExportBatch({ data: { metrics: [] } })).toThrow(HealthAutoExportError);
  });

  it("handles an empty batch as a no-op", () => {
    expect(parseHealthAutoExportBatch({ data: { workouts: [] } })).toEqual({ workouts: [], skipped: [] });
  });

  it("gives the same id as the Shortcut path for the same workout, so the two deduplicate", () => {
    const fromApp = buildWorkout(
      parseHealthAutoExportBatch({ workouts: [V2] }).workouts[0]!,
      (w) => scoreEffort(w),
    );
    const fromShortcut = buildWorkout(
      parseShortcutPayload({
        activityType: "Outdoor Run",
        startedAt: "2024-02-06T15:00:00Z",
        endedAt: "2024-02-06T15:30:00Z",
      }),
      (w) => scoreEffort(w),
    );
    expect(fromApp.id).toBe(fromShortcut.id);
    expect(fromApp.id).toBe(workoutId("running", "2024-02-06T15:00:00.000Z", 1800));
  });
});
