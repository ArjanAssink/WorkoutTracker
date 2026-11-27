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

import { dailyRecovery, type RecoverySample } from "../src/domain/recovery.js";
import { dailyWeights, type WeightReading } from "../src/domain/bodyWeight.js";
import { extractNativeRecords } from "../src/ingest/nativeRecords.js";

/**
 * The app's health records are export.xml `<Record>` attributes as JSON. The same records
 * must make the same days through either path: one source per night, the larger step
 * source, the earliest weight.
 */
const RECORDS: Array<Record<string, string>> = [
  // The night ending on the 25th: the watch's staged sleep beside the phone's in-bed guess.
  { type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: "Apple Watch", startDate: "2026-11-24 23:10:00 +0100", endDate: "2026-11-25 01:40:00 +0100", value: "HKCategoryValueSleepAnalysisAsleepCore" },
  { type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: "Apple Watch", startDate: "2026-11-25 01:40:00 +0100", endDate: "2026-11-25 02:40:00 +0100", value: "HKCategoryValueSleepAnalysisAsleepDeep" },
  { type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: "Apple Watch", startDate: "2026-11-25 02:40:00 +0100", endDate: "2026-11-25 04:10:00 +0100", value: "HKCategoryValueSleepAnalysisAsleepREM" },
  { type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: "Apple Watch", startDate: "2026-11-25 04:10:00 +0100", endDate: "2026-11-25 04:20:00 +0100", value: "HKCategoryValueSleepAnalysisAwake" },
  { type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: "Apple Watch", startDate: "2026-11-25 04:20:00 +0100", endDate: "2026-11-25 06:50:00 +0100", value: "HKCategoryValueSleepAnalysisAsleepCore" },
  { type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: "iPhone", startDate: "2026-11-24 22:30:00 +0100", endDate: "2026-11-25 07:00:00 +0100", value: "HKCategoryValueSleepAnalysisInBed" },
  { type: "HKQuantityTypeIdentifierRestingHeartRate", sourceName: "Apple Watch", unit: "count/min", startDate: "2026-11-25 00:00:00 +0100", endDate: "2026-11-25 23:59:00 +0100", value: "52" },
  { type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", sourceName: "Apple Watch", unit: "ms", startDate: "2026-11-25 03:00:00 +0100", endDate: "2026-11-25 03:01:00 +0100", value: "61.5" },
  { type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", sourceName: "Apple Watch", unit: "ms", startDate: "2026-11-25 05:00:00 +0100", endDate: "2026-11-25 05:01:00 +0100", value: "48.5" },
  { type: "HKQuantityTypeIdentifierRespiratoryRate", sourceName: "Apple Watch", unit: "count/min", startDate: "2026-11-25 03:00:00 +0100", endDate: "2026-11-25 03:00:00 +0100", value: "14.5" },
  { type: "HKQuantityTypeIdentifierOxygenSaturation", sourceName: "Apple Watch", unit: "%", startDate: "2026-11-25 03:30:00 +0100", endDate: "2026-11-25 03:30:00 +0100", value: "0.97" },
  { type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature", sourceName: "Apple Watch", unit: "degC", startDate: "2026-11-24 23:00:00 +0100", endDate: "2026-11-25 06:50:00 +0100", value: "35.62" },
  { type: "HKQuantityTypeIdentifierTimeInDaylight", sourceName: "Apple Watch", unit: "min", startDate: "2026-11-25 12:00:00 +0100", endDate: "2026-11-25 12:20:00 +0100", value: "20" },
  // Watch and phone both count the same walk: the day takes the larger source, not the sum.
  { type: "HKQuantityTypeIdentifierStepCount", sourceName: "Apple Watch", unit: "count", startDate: "2026-11-25 08:00:00 +0100", endDate: "2026-11-25 08:30:00 +0100", value: "3200" },
  { type: "HKQuantityTypeIdentifierStepCount", sourceName: "Apple Watch", unit: "count", startDate: "2026-11-25 17:00:00 +0100", endDate: "2026-11-25 17:30:00 +0100", value: "2100" },
  { type: "HKQuantityTypeIdentifierStepCount", sourceName: "iPhone", unit: "count", startDate: "2026-11-25 08:00:00 +0100", endDate: "2026-11-25 08:30:00 +0100", value: "3000" },
  // Two weigh-ins: the earliest of the day wins.
  { type: "HKQuantityTypeIdentifierBodyMass", sourceName: "Health", unit: "kg", startDate: "2026-11-25 07:05:00 +0100", endDate: "2026-11-25 07:05:00 +0100", value: "80.4" },
  { type: "HKQuantityTypeIdentifierBodyMass", sourceName: "Health", unit: "kg", startDate: "2026-11-25 21:00:00 +0100", endDate: "2026-11-25 21:00:00 +0100", value: "81.2" },
];

async function viaExport(records: Array<Record<string, string>>) {
  const attrs = (r: Record<string, string>) => Object.entries(r).map(([k, v]) => `${k}="${v}"`).join(" ");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><HealthData locale="en_NL">${records.map((r) => `<Record ${attrs(r)}/>`).join("")}</HealthData>`;
  const samples: RecoverySample[] = [], weights: WeightReading[] = [];
  const stats: ParseStats = { workoutsSeen: 0, workoutsParsed: 0, skipped: [] };
  for await (const _ of parseHealthExport(Readable.from([xml]), stats, { onRecovery: (s) => samples.push(s), onBodyMass: (w) => weights.push(w) })) { /* no workouts */ }
  return { samples, weights };
}

const strip = <T extends { recordedAt?: string; source?: string }>(rows: T[]) => rows.map(({ recordedAt: _r, source: _s, ...rest }) => rest);

describe("native app ↔ export health records", () => {
  const now = new Date("2026-11-26T10:00:00Z");

  it("makes the same recovery day and weight through either path", async () => {
    const exported = await viaExport(RECORDS);
    const native = extractNativeRecords({ data: { workouts: [], records: RECORDS, recordsWindow: { from: "2026-11-24 12:00:00 +0100" } } });
    expect(native.received).toBe(RECORDS.length);
    expect(native.afterDay).toBe("2026-11-24");

    const a = strip(dailyRecovery({ samples: exported.samples }, "health-export", now));
    const b = strip(dailyRecovery({ samples: native.recovery }, "health-export", now));
    expect(b).toEqual(a);
    const day = b.find((d) => d.date === "2026-11-25")!;
    expect(day).toMatchObject({ steps: 5300, restingHeartRate: 52, hrv: 55, spo2: 97, daylightMinutes: 20, sleepStaged: true });
    expect(day.sleepDeepSeconds).toBe(3600);

    expect(strip(dailyWeights(native.weights, "health-export", now))).toEqual(strip(dailyWeights(exported.weights, "health-export", now)));
    expect(dailyWeights(native.weights, "health-export", now)[0]!.kg).toBeCloseTo(80.4);
  });

  it("accepts numbers where the export has strings", () => {
    const native = extractNativeRecords({ data: { records: [{ ...RECORDS[16], value: 80.4 }], recordsWindow: { from: "2026-11-24 12:00:00 +0100" } } });
    expect(native.weights[0]!.kg).toBeCloseTo(80.4);
  });

  it("writes nothing without a window, since partial days cannot be told from whole ones", () => {
    const native = extractNativeRecords({ data: { records: RECORDS } });
    expect(native.afterDay).toBeUndefined();
    expect(native.recovery).toEqual([]);
    expect(native.received).toBe(RECORDS.length);
  });

  it("ignores bodies without records", () => {
    expect(extractNativeRecords({ data: { workouts: [] } }).received).toBe(0);
  });
});

describe("native app routes", () => {
  it("carries an inline track to the importer, never onto the row", () => {
    const app = fromApp({
      name: "HKWorkoutActivityTypeRunning",
      start: "2026-11-20 07:00:00 +0100",
      duration: 1800,
      route: [[52.1, 4.4], [52.101, 4.401], ["bad"], [52.102, 4.402]],
    });
    expect(app.routeTrack).toEqual([{ lat: 52.1, lon: 4.4 }, { lat: 52.101, lon: 4.401 }, { lat: 52.102, lon: 4.402 }]);
  });

  it("drops a track of fewer than two readable points", () => {
    expect(fromApp({ name: "HKWorkoutActivityTypeRunning", start: "2026-11-20 07:00:00 +0100", duration: 1800, route: [[52.1, 4.4]] }).routeTrack).toBeUndefined();
  });
});
