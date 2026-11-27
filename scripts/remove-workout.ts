/**
 * Removes one stored workout and what lives beside it (route, heart-rate series, tags stay —
 * they are the person's own writing and keyed by id, so they simply stop matching anything).
 * For one-off mistakes: a session recorded as the wrong type, or left running.
 *
 *   npm run remove -- <id> <startedAt ISO> [--dry-run]
 *
 * The workout must also be deleted on the phone (Fitness or Health), or the next export
 * import or app re-send stores it again — every path re-derives the same id from Health.
 */
import { parseArgs } from "node:util";
import process from "node:process";
import { loadTableTarget } from "../src/config/index.js";
import { WorkoutRepository } from "../src/storage/workoutRepository.js";
import { RouteRepository } from "../src/storage/routeRepository.js";
import { HeartRateSeriesRepository } from "../src/storage/heartRateSeriesRepository.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
  const [id, startedAt] = positionals;
  if (!id || !startedAt || Number.isNaN(Date.parse(startedAt))) {
    console.log("Usage: npm run remove -- <id> <startedAt ISO, e.g. 2026-11-25T08:04:55.000Z> [--dry-run]");
    process.exit(1);
  }
  const target = loadTableTarget();
  const workouts = WorkoutRepository.fromConnectionString(target.storageConnectionString, target.tableName, target.userId);
  const start = new Date(startedAt);
  const found = (await workouts.listAll({ from: new Date(start.getTime() - 1000), to: new Date(start.getTime() + 1000) })).find((w) => w.id === id);
  if (!found) {
    console.log(`No workout ${id} starting at ${startedAt}. Nothing removed.`);
    process.exit(1);
  }
  console.log(`Workout: ${found.startedAt.slice(0, 16)} ${found.activityType} ${Math.round(found.durationSeconds / 60)} min (${found.sourceName ?? found.source})`);
  if (values["dry-run"]) { console.log("Dry run — nothing removed."); return; }
  await workouts.delete(found.startedAt, found.id);
  const route = await RouteRepository.fromConnectionString(target.storageConnectionString, target.userId).delete(found.startedAt, found.id);
  const series = await HeartRateSeriesRepository.fromConnectionString(target.storageConnectionString, target.userId).delete(found.startedAt, found.id);
  console.log(`Removed the workout${route ? ", its route" : ""}${series ? ", its heart-rate series" : ""}.`);
}

main().catch((e: unknown) => { console.error(`\nFailed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
