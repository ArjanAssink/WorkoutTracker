/**
 * Imports an Apple Health `export.xml` into the workouts table.
 *
 * Run locally rather than as an endpoint: the export is typically hundreds of megabytes,
 * which is far past what an HTTP trigger should accept, and this is a one-off backfill
 * rather than something the phone does. The parse streams, so memory stays flat, and rows
 * are flushed in batches as they are produced.
 *
 *   npm run import -- export.xml --dry-run        # no configuration needed
 *   npm run import -- ~/Downloads/apple_health_export/export.xml
 *   npm run import -- export.xml --since 2024-01-01
 *
 * A real run needs WORKOUTS_STORAGE (or AzureWebJobsStorage). Effort is scored with
 * ATHLETE_RESTING_HR / ATHLETE_MAX_HR from this shell — not the Function App's settings.
 */
import { parseArgs } from "node:util";
import process from "node:process";
import { loadAthleteProfile, loadTableTarget } from "../src/config/index.js";
import { trailingMaxHeartRate } from "../src/domain/effort.js";
import { scoreWithReference } from "../src/domain/scoring.js";
import { buildWorkout, WorkoutValidationError, type Workout, type WorkoutInput } from "../src/domain/workout.js";
import { parseHealthExport, type ParseStats } from "../src/ingest/healthExport.js";
import { WorkoutRepository } from "../src/storage/workoutRepository.js";
import { BodyWeightRepository } from "../src/storage/bodyWeightRepository.js";
import { dailyWeights, type WeightReading } from "../src/domain/bodyWeight.js";

const BATCH_SIZE = 100;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      since: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const file = positionals[0];
  if (values.help || !file) {
    console.log("Usage: npm run import -- <path to export.xml> [--since YYYY-MM-DD] [--dry-run]");
    process.exit(values.help ? 0 : 1);
  }

  const since = values.since ? new Date(`${values.since}T00:00:00Z`) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`--since is not a valid date: ${values.since}`);
  }

  // A dry run parses and reports only, so it deliberately requires no configuration at
  // all — you can point it at an export before you have an Azure account.
  const profile = loadAthleteProfile();
  const target = values["dry-run"] ? undefined : loadTableTarget();
  const repository = target
    ? WorkoutRepository.fromConnectionString(target.storageConnectionString, target.tableName, target.userId)
    : undefined;
  await repository?.ensureTable();

  const stats: ParseStats = { workoutsSeen: 0, workoutsParsed: 0, skipped: [] };
  let batch: Workout[] = [];
  let written = 0;
  let filtered = 0;
  let invalid = 0;

  console.log(`Reading ${file}${values["dry-run"] ? " (dry run — nothing will be written)" : ""}`);
  console.log(`Effort profile: resting ${profile.restingHeartRate} bpm, max ${profile.maxHeartRate} bpm (fallback — observed trailing-year max is used where available)`);

  // Pass one: parse everything. The export streams because it is huge, but almost all of
  // it is heart-rate samples; the workouts themselves are a few thousand small objects.
  // Holding them lets each row be scored against the peaks recorded *before* it, which
  // requires date order — and Apple's export is not reliably chronological.
  const all: WorkoutInput[] = [];
  const readings: WeightReading[] = [];
  for await (const input of parseHealthExport(file, stats, { onBodyMass: (r) => readings.push(r) })) all.push(input);
  all.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // --since only limits what is written; earlier rows still inform the reference max.
  const observations = all.map((w) => ({ startedAt: w.startedAt, maxHeartRate: w.maxHeartRate }));

  let lowest = Infinity, highest = -Infinity;

  // Pass two: score and write in date order.
  for (const input of all) {
    if (since && new Date(input.startedAt) < since) {
      filtered++;
      continue;
    }
    let workout: Workout;
    try {
      const observed = trailingMaxHeartRate(observations, new Date(input.startedAt));
      workout = buildWorkout(input, (w) => scoreWithReference(w, profile, observed));
      if (workout.maxHeartRateReference !== undefined) {
        lowest = Math.min(lowest, workout.maxHeartRateReference);
        highest = Math.max(highest, workout.maxHeartRateReference);
      }
    } catch (error) {
      if (error instanceof WorkoutValidationError) {
        invalid++;
        continue;
      }
      throw error;
    }
    batch.push(workout);
    if (batch.length >= BATCH_SIZE) {
      written += await flush(repository, batch);
      batch = [];
      process.stdout.write(`\r  imported ${written}...`);
    }
  }
  written += await flush(repository, batch);

  // Body weight: one row per day, earliest reading wins. Same storage account.
  const weights = dailyWeights(readings, "health-export").filter((w) => !since || w.date >= since.toISOString().slice(0, 10));
  let weightsWritten = 0;
  if (weights.length > 0 && target) {
    const weightRepo = BodyWeightRepository.fromConnectionString(target.storageConnectionString, target.userId);
    await weightRepo.ensureTable();
    weightsWritten = await weightRepo.upsertMany(weights);
  }

  process.stdout.write("\r");
  if (readings.length) {
    console.log(`Weight readings    : ${readings.length} → ${weights.length} days${values["dry-run"] ? " (would write)" : ` (${weightsWritten} written)`}`);
  }
  if (Number.isFinite(lowest)) {
    console.log(`Max HR reference   : ${lowest}–${highest} bpm across the range (trailing-year observed)`);
  }
  console.log(`Workouts in export : ${stats.workoutsSeen}`);
  console.log(`Parsed             : ${stats.workoutsParsed}`);
  if (filtered) console.log(`Skipped (--since)  : ${filtered}`);
  if (invalid) console.log(`Skipped (invalid)  : ${invalid}`);
  if (stats.skipped.length) {
    console.log(`Skipped (unparsed) : ${stats.skipped.length}`);
    for (const skip of stats.skipped.slice(0, 5)) {
      console.log(`  - ${skip.reason} (${skip.attributes["workoutActivityType"] ?? "unknown type"})`);
    }
    if (stats.skipped.length > 5) console.log(`  ...and ${stats.skipped.length - 5} more`);
  }
  console.log(`${values["dry-run"] ? "Would write" : "Written"}      : ${written}`);
}

async function flush(repository: WorkoutRepository | undefined, batch: Workout[]): Promise<number> {
  if (batch.length === 0) return 0;
  if (!repository) return batch.length;
  return repository.upsertMany(batch);
}

main().catch((error: unknown) => {
  console.error(`\nImport failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
