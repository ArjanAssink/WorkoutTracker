import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { workoutId, type WorkoutInput } from "../src/domain/workout.js";
import { parseHealthExport, type ParseStats } from "../src/ingest/healthExport.js";
import { parseHealthAutoExportBatch } from "../src/ingest/healthAutoExport.js";

/**
 * The native iOS app posts to the Health Auto Export endpoint. A workout it sends must
 * derive the *same* id as the same workout found later in export.xml, or every session is
 * stored twice. These cases pair an export `<Workout>` with the payload the app builds
 * for it (`ios/WorkoutSync/WorkoutPayload.swift`): the export's activity name, the start
 * truncated to whole seconds in Apple's format, the duration in seconds.
 */
async function fromExport(xml: string): Promise<WorkoutInput> {
  const stats: ParseStats = { workoutsSeen: 0, workoutsParsed: 0, skipped: [] };
  const doc = `<?xml version="1.0" encoding="UTF-8"?><HealthData locale="en_NL">${xml}</HealthData>`;
  for await (const w of parseHealthExport(Readable.from([doc]), stats)) return w;
  throw new Error(`export parsed nothing: ${JSON.stringify(stats.skipped)}`);
}

function fromApp(workout: Record<string, unknown>): WorkoutInput {
  const { workouts, skipped } = parseHealthAutoExportBatch({ data: { workouts: [workout] } });
  expect(skipped).toEqual([]);
  return workouts[0]!;
}

const id = (w: WorkoutInput) => workoutId(w.activityType, w.startedAt, w.durationSeconds);

describe("native app ↔ export identity", () => {
  it("an Apple Watch run with a fractional duration", async () => {
    const exported = await fromExport(`
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="45.50666666666667" durationUnit="min"
               sourceName="Apple Watch" startDate="2026-03-14 07:00:03 +0100" endDate="2026-03-14 07:45:33 +0100">
        <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="148.4" minimum="97.6" maximum="176.2" unit="count/min"/>
      </Workout>`);
    const app = fromApp({
      name: "HKWorkoutActivityTypeRunning",
      sourceName: "Apple Watch",
      start: "2026-03-14 07:00:03 +0100",
      end: "2026-03-14 07:45:33 +0100",
      duration: 2730.4,
      avgHeartRate: 148.4,
      maxHeartRate: 176.2,
    });
    expect(app.activityType).toBe(exported.activityType);
    expect(app.startedAt).toBe(exported.startedAt);
    expect(app.durationSeconds).toBe(exported.durationSeconds);
    expect(id(app)).toBe(id(exported));
  });

  it("strength training, sent with the start in another offset", async () => {
    const exported = await fromExport(`
      <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="62" durationUnit="min"
               sourceName="Apple Watch" startDate="2026-07-02 18:30:00 +0200" endDate="2026-07-02 19:32:00 +0200"/>`);
    const app = fromApp({
      name: "HKWorkoutActivityTypeTraditionalStrengthTraining",
      sourceName: "Apple Watch",
      start: "2026-07-02 16:30:00 +0000",
      end: "2026-07-02 17:32:00 +0000",
      duration: 3720,
    });
    expect(id(app)).toBe(id(exported));
  });

  it("applies the same relabels: Strava 'Other' of an hour or more is BJJ", async () => {
    const exported = await fromExport(`
      <Workout workoutActivityType="HKWorkoutActivityTypeOther" duration="105" durationUnit="min"
               sourceName="Strava" startDate="2026-05-04 19:00:00 +0200" endDate="2026-05-04 20:45:00 +0200"/>`);
    const app = fromApp({
      name: "HKWorkoutActivityTypeOther",
      sourceName: "Strava",
      start: "2026-05-04 19:00:00 +0200",
      end: "2026-05-04 20:45:00 +0200",
      duration: 6300,
    });
    expect(exported.activityType).toBe("martialarts");
    expect(app.activityType).toBe("martialarts");
    expect(id(app)).toBe(id(exported));
  });

  it("wrestling is BJJ from either path", async () => {
    const exported = await fromExport(`
      <Workout workoutActivityType="HKWorkoutActivityTypeWrestling" duration="90" durationUnit="min"
               sourceName="Apple Watch" startDate="2026-05-08 19:00:00 +0200" endDate="2026-05-08 20:30:00 +0200"/>`);
    const app = fromApp({
      name: "HKWorkoutActivityTypeWrestling",
      start: "2026-05-08 19:00:00 +0200",
      end: "2026-05-08 20:30:00 +0200",
      duration: 5400,
    });
    expect(id(app)).toBe(id(exported));
  });

  it("a short Strava 'Other' stays other on both paths", async () => {
    const app = fromApp({
      name: "HKWorkoutActivityTypeOther",
      sourceName: "Strava",
      start: "2026-05-04 12:00:00 +0200",
      duration: 1200,
    });
    expect(app.activityType).toBe("other");
  });
});
