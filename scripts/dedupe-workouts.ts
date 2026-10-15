/**
 * Removes duplicate recordings already in the table — the Wahoo ride beside the watch's
 * own, and the like — keeping the preferred copy of each session.
 *
 *   npm run dedupe -- [--dry-run] [--from YYYY-MM-DD]
 */
import { parseArgs } from "node:util";
import process from "node:process";
import { loadTableTarget } from "../src/config/index.js";
import { dedupe } from "../src/domain/dedupe.js";
import { WorkoutRepository } from "../src/storage/workoutRepository.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, from: { type: "string" } } });
  const target = loadTableTarget();
  const repository = WorkoutRepository.fromConnectionString(target.storageConnectionString, target.tableName, target.userId);
  const from = values.from ? new Date(`${values.from}T00:00:00Z`) : new Date("2000-01-01T00:00:00Z");
  const all = await repository.listAll({ from, to: new Date(Date.now() + 86_400_000) });
  const { kept, dropped } = dedupe(all);
  console.log(`Workouts: ${all.length} · kept ${kept.length} · duplicates ${dropped.length}`);
  for (const d of dropped) console.log(`  ${d.dropped.startedAt.slice(0, 16)} ${d.dropped.activityType.padEnd(12)} ${(d.dropped.sourceName ?? "").padEnd(22)} ${Math.round(d.dropped.durationSeconds / 60)} min  ← dropped for ${d.keptFor.sourceName ?? "?"} ${Math.round(d.keptFor.durationSeconds / 60)} min${d.keptFor.averageHeartRate ? ` (HR ${d.keptFor.averageHeartRate})` : ""}`);
  if (values["dry-run"]) { console.log("\nDry run — nothing deleted."); return; }
  for (const d of dropped) await repository.delete(d.dropped.startedAt, d.dropped.id);
  console.log(`\nDeleted ${dropped.length} duplicate${dropped.length === 1 ? "" : "s"}.`);
}

const invokedDirectly = process.argv[1]?.endsWith("dedupe-workouts.js");
if (invokedDirectly) main().catch((e: unknown) => { console.error(`\nFailed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
