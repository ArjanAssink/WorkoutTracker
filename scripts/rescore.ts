/**
 * Recomputes the effort of every stored workout under the current scoring model, in place.
 *
 * Reads the whole table, sorts by date, and scores each workout against the maximum heart
 * rate observed in the trailing year *as of that workout* — so a row sees only the peaks
 * recorded before it, exactly as the import does. Rows whose score does not change are
 * left untouched; the rest are rewritten with the new effort and the reference used.
 *
 *   npm run rescore -- --dry-run     # report what would change
 *   npm run rescore
 *
 * Needs WORKOUTS_STORAGE (or AzureWebJobsStorage). ATHLETE_* from .env supply resting HR
 * and the fallback max.
 */
import { parseArgs } from "node:util";
import process from "node:process";
import { loadAthleteProfile, loadTableTarget } from "../src/config/index.js";
import { trailingMaxHeartRate } from "../src/domain/effort.js";
import { scoreWithReference } from "../src/domain/scoring.js";
import type { Workout } from "../src/domain/workout.js";
import { WorkoutRepository } from "../src/storage/workoutRepository.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  const dry = values["dry-run"];

  const profile = loadAthleteProfile();
  const target = loadTableTarget();
  const repository = WorkoutRepository.fromConnectionString(target.storageConnectionString, target.tableName, target.userId);

  console.log(`Profile: resting ${profile.restingHeartRate} bpm, fallback max ${profile.maxHeartRate} bpm`);
  process.stdout.write("Reading every workout... ");
  const all = await repository.listAll({ from: new Date("2000-01-01T00:00:00Z"), to: new Date(Date.now() + 366 * 86_400_000) });
  all.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  console.log(`${all.length} rows, ${all[0]?.startedAt.slice(0, 10)} → ${all[all.length - 1]?.startedAt.slice(0, 10)}`);

  const observations = all.map((w) => ({ startedAt: w.startedAt, maxHeartRate: w.maxHeartRate }));
  const changed: Workout[] = [];
  const refs = new Map<number, number>();
  let unchanged = 0, estimated = 0, fallback = 0;
  let up = 0, down = 0;

  for (const row of all) {
    const observed = trailingMaxHeartRate(observations, new Date(row.startedAt));
    const { effort, model, maxHeartRateReference } = scoreWithReference(row, profile, observed);
    if (model === "met-minutes") { estimated++; }
    else {
      refs.set(maxHeartRateReference, (refs.get(maxHeartRateReference) ?? 0) + 1);
      if (observed === undefined) fallback++;
    }
    const sameRef = model !== "trimp" || row.maxHeartRateReference === maxHeartRateReference;
    if (row.effort === effort && row.effortModel === model && sameRef) { unchanged++; continue; }
    if (effort > row.effort) up++; else if (effort < row.effort) down++;
    const next: Workout = { ...row, effort, effortModel: model };
    if (model === "trimp") next.maxHeartRateReference = maxHeartRateReference; else delete next.maxHeartRateReference;
    changed.push(next);
  }

  console.log(`\nWould change ${changed.length} rows (${down} lower, ${up} higher), ${unchanged} unchanged, ${estimated} MET estimates untouched`);
  console.log(`Reference max used (TRIMP rows):`);
  for (const [bpm, n] of [...refs].sort((a, b) => a[0] - b[0])) console.log(`  ${bpm} bpm × ${n}${bpm === profile.maxHeartRate && fallback ? "  (includes fallback)" : ""}`);
  if (fallback) console.log(`  ${fallback} rows had no observed max in the trailing year and used the fallback`);

  if (dry) { console.log("\nDry run — nothing written."); return; }
  if (changed.length === 0) { console.log("\nNothing to write."); return; }

  process.stdout.write(`\nWriting ${changed.length} rows... `);
  const written = await repository.upsertMany(changed);
  console.log(`${written} written.`);
}

main().catch((error: unknown) => {
  console.error(`\nRescore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
