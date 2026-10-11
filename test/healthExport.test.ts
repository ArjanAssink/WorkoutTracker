import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseHealthExport, type ParseStats } from "../src/ingest/healthExport.js";
import type { WorkoutInput } from "../src/domain/workout.js";

async function parse(xml: string): Promise<{ workouts: WorkoutInput[]; stats: ParseStats }> {
  const stats: ParseStats = { workoutsSeen: 0, workoutsParsed: 0, skipped: [] };
  const workouts: WorkoutInput[] = [];
  for await (const workout of parseHealthExport(Readable.from([xml]), stats)) workouts.push(workout);
  return { workouts, stats };
}

/** Splits input across chunk boundaries to prove the SAX parse does not rely on framing. */
function chunked(xml: string, size: number): Readable {
  const parts: string[] = [];
  for (let i = 0; i < xml.length; i += size) parts.push(xml.slice(i, i + size));
  return Readable.from(parts);
}

const MODERN = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_NL">
  <Record type="HKQuantityTypeIdentifierHeartRate" value="72" startDate="2026-03-14 06:00:00 +0100"/>
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="45.5" durationUnit="min"
           sourceName="Apple Watch" startDate="2026-03-14 07:00:00 +0100" endDate="2026-03-14 07:45:30 +0100">
    <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="512" unit="kcal"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierBasalEnergyBurned" sum="88" unit="kcal"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="8.2" unit="km"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="148.4" minimum="97.6" maximum="176.2" unit="count/min"/>
  </Workout>
</HealthData>`;

describe("parseHealthExport", () => {
  it("extracts workouts and ignores the Record elements that dominate the file", async () => {
    const { workouts, stats } = await parse(MODERN);
    expect(stats.workoutsSeen).toBe(1);
    expect(stats.workoutsParsed).toBe(1);
    expect(workouts).toHaveLength(1);
  });

  it("reads nested WorkoutStatistics and converts their units", async () => {
    const [workout] = (await parse(MODERN)).workouts;
    expect(workout!.activityType).toBe("running");
    expect(workout!.durationSeconds).toBe(2730);
    expect(workout!.distanceMeters).toBeCloseTo(8200, 6);
    expect(workout!.activeEnergyKcal).toBe(512);
    expect(workout!.totalEnergyKcal).toBe(600);
    expect(workout!.averageHeartRate).toBe(148);
    expect(workout!.minHeartRate).toBe(98);
    expect(workout!.maxHeartRate).toBe(176);
    expect(workout!.sourceName).toBe("Apple Watch");
    expect(workout!.source).toBe("health-export");
  });

  it("falls back to the legacy attributes older exports use", async () => {
    const { workouts } = await parse(`<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="60" durationUnit="min"
               totalDistance="25.5" totalDistanceUnit="km" totalEnergyBurned="640" totalEnergyBurnedUnit="kcal"
               startDate="2026-02-01 18:00:00 +0100" endDate="2026-02-01 19:00:00 +0100"/>
    </HealthData>`);
    expect(workouts[0]!.distanceMeters).toBeCloseTo(25500, 6);
    expect(workouts[0]!.activeEnergyKcal).toBe(640);
  });

  it("sums the per-discipline distances of a multi-sport workout", async () => {
    const { workouts } = await parse(`<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeSwimBikeRun" duration="120" durationUnit="min"
               startDate="2026-06-01 08:00:00 +0000" endDate="2026-06-01 10:00:00 +0000">
        <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceSwimming" sum="1500" unit="m"/>
        <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceCycling" sum="40" unit="km"/>
        <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="10" unit="km"/>
      </Workout>
    </HealthData>`);
    expect(workouts[0]!.distanceMeters).toBeCloseTo(51500, 6);
  });

  it("derives duration from the date span when the duration attribute is absent", async () => {
    const { workouts } = await parse(`<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeYoga"
               startDate="2026-01-05 19:00:00 +0000" endDate="2026-01-05 19:50:00 +0000"/>
    </HealthData>`);
    expect(workouts[0]!.durationSeconds).toBe(3000);
  });

  it("records a skip instead of aborting when one workout is malformed", async () => {
    const { workouts, stats } = await parse(`<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" startDate="not a date" duration="30" durationUnit="min"/>
      <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="30" durationUnit="min"
               startDate="2026-01-02 09:00:00 +0000" endDate="2026-01-02 09:30:00 +0000"/>
    </HealthData>`);
    expect(stats.workoutsSeen).toBe(2);
    expect(workouts).toHaveLength(1);
    expect(stats.skipped).toHaveLength(1);
    expect(workouts[0]!.activityType).toBe("walking");
  });

  it("parses correctly when elements straddle stream chunk boundaries", async () => {
    const stats: ParseStats = { workoutsSeen: 0, workoutsParsed: 0, skipped: [] };
    const workouts: WorkoutInput[] = [];
    for await (const w of parseHealthExport(chunked(MODERN, 7), stats)) workouts.push(w);
    expect(workouts).toHaveLength(1);
    expect(workouts[0]!.distanceMeters).toBeCloseTo(8200, 6);
  });

  it("handles self-closing Workout elements with no statistics", async () => {
    const { workouts } = await parse(`<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="40" durationUnit="min"
               startDate="2026-03-02 17:00:00 +0100" endDate="2026-03-02 17:40:00 +0100"/>
    </HealthData>`);
    expect(workouts[0]!.activityType).toBe("strength");
    expect(workouts[0]!.distanceMeters).toBeUndefined();
  });
});

describe("joining loose heart-rate samples to workouts without statistics", () => {
  // Apple writes every <Record> before any <Workout>; third-party workouts carry no stats.
  const samples = (start: string, minutes: number, perMinute: number, base: number) => {
    const t0 = Date.parse(start.replace(" ", "T").replace(" +0100", "+01:00"));
    const out: string[] = [];
    for (let i = 0; i < minutes * perMinute; i++) {
      const t = new Date(t0 + (i * 60_000) / perMinute);
      const stamp = t.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " +0000");
      out.push(`<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Polar Flow" unit="count/min" value="${base + (i % 20)}" startDate="${stamp}"/>`);
    }
    return out.join("\n");
  };

  it("gives a Polar Flow workout its average, min and max from the samples in its span", async () => {
    const xml = `<HealthData>
      ${samples("2024-01-08 19:00:00 +0100", 100, 2, 110)}
      <Workout workoutActivityType="HKWorkoutActivityTypeMartialArts" duration="100" durationUnit="min" sourceName="Polar Flow"
               startDate="2024-01-08 19:00:00 +0100" endDate="2024-01-08 20:40:00 +0100"/>
    </HealthData>`;
    const { workouts } = await parse(xml);
    expect(workouts).toHaveLength(1);
    expect(workouts[0]!.averageHeartRate).toBe(120); // parser rounds to whole bpm
    expect(workouts[0]!.minHeartRate).toBe(110);
    expect(workouts[0]!.maxHeartRate).toBe(129);
  });

  it("leaves a workout's own statistics alone when it has them", async () => {
    const xml = `<HealthData>
      ${samples("2024-01-08 19:00:00 +0100", 60, 2, 150)}
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="60" durationUnit="min"
               startDate="2024-01-08 19:00:00 +0100" endDate="2024-01-08 20:00:00 +0100">
        <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="140" minimum="100" maximum="170" unit="count/min"/>
      </Workout>
    </HealthData>`;
    const w = (await parse(xml)).workouts[0]!;
    expect(w.averageHeartRate).toBe(140);
    expect(w.maxHeartRate).toBe(170);
  });

  it("ignores a few stray readings — a watch glance is not a recording", async () => {
    const xml = `<HealthData>
      <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="72" startDate="2024-01-08 19:10:00 +0100"/>
      <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="75" startDate="2024-01-08 19:50:00 +0100"/>
      <Workout workoutActivityType="HKWorkoutActivityTypeMartialArts" duration="100" durationUnit="min"
               startDate="2024-01-08 19:00:00 +0100" endDate="2024-01-08 20:40:00 +0100"/>
    </HealthData>`;
    expect((await parse(xml)).workouts[0]!.averageHeartRate).toBeUndefined();
  });

  it("does not bleed samples from a neighbouring session", async () => {
    const xml = `<HealthData>
      ${samples("2024-01-08 17:00:00 +0100", 60, 2, 150)}
      <Workout workoutActivityType="HKWorkoutActivityTypeMartialArts" duration="60" durationUnit="min"
               startDate="2024-01-08 19:00:00 +0100" endDate="2024-01-08 20:00:00 +0100"/>
    </HealthData>`;
    expect((await parse(xml)).workouts[0]!.averageHeartRate).toBeUndefined();
  });

  it("copes with samples that arrive out of order", async () => {
    const xml = `<HealthData>
      ${samples("2024-01-08 19:30:00 +0100", 30, 2, 120)}
      ${samples("2024-01-08 19:00:00 +0100", 30, 2, 100)}
      <Workout workoutActivityType="HKWorkoutActivityTypeMartialArts" duration="60" durationUnit="min"
               startDate="2024-01-08 19:00:00 +0100" endDate="2024-01-08 20:00:00 +0100"/>
    </HealthData>`;
    const w = (await parse(xml)).workouts[0]!;
    expect(w.minHeartRate).toBe(100);
    expect(w.maxHeartRate).toBe(139);
  });
});
