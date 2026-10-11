/**
 * Imports a weekly training log workbook — the "block tracker" sheet with session grids.
 *
 *   npm run block -- Cable_Rack_Summer_2025.xlsx [--dry-run] [--program "Cable Rack Summer 2025"] [--sheet Sheet1]
 *
 * Every exercise row becomes one `set` record: the date and session it sat under, the lift
 * it resolved to, the row weight, the stated RIR, and the sets as written. The Strength
 * page derives the session's top set from these; nothing is thrown away here.
 *
 * The program name labels the block on the PR chart; it defaults to the file name.
 * Needs WORKOUTS_STORAGE (or AzureWebJobsStorage) unless --dry-run.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import process from "node:process";
import { loadTableTarget } from "../src/config/index.js";
import { parseBlockLog, type ExerciseEntry } from "../src/ingest/blockLog.js";
import { readWorkbook } from "../src/ingest/xlsx.js";
import { LiftRepository, type SetRecord } from "../src/storage/liftRepository.js";

export function toSetRecords(entries: ExerciseEntry[], program: string, now: string): SetRecord[] {
  return entries.map((e) => ({
    kind: "set", date: e.date, program, session: e.session, exercise: e.exercise,
    lift: e.lift.slug, family: e.lift.family, label: e.lift.label,
    ...(e.rowKg !== undefined ? { rowKg: e.rowKg } : {}),
    ...(e.rir !== undefined ? { rir: e.rir } : {}),
    sets: JSON.stringify(e.sets),
    ...(e.notes ? { notes: e.notes } : {}),
    source: "block-log", recordedAt: now,
  }));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, program: { type: "string" }, sheet: { type: "string" } },
  });
  const file = positionals[0];
  if (!file) { console.log("Usage: npm run block -- <workbook.xlsx> [--dry-run] [--program NAME] [--sheet NAME]"); process.exit(1); }

  const program = values.program ?? basename(file, extname(file)).replace(/[_-]+/g, " ").trim();
  const now = new Date().toISOString();
  const sheets = readWorkbook(readFileSync(file));
  const rows = values.sheet ? sheets.get(values.sheet) : sheets.values().next().value;
  if (!rows) { console.error(`Sheet not found; the workbook has: ${[...sheets.keys()].join(", ")}`); process.exit(1); }

  const entries = parseBlockLog(rows);
  const records = toSetRecords(entries, program, now);
  const dates = [...new Set(entries.map((e) => e.date))].sort();
  console.log(`Program           : ${program}`);
  console.log(`Sessions          : ${dates.length} dates, ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`Exercise rows     : ${entries.length}, of which ${entries.filter((e) => e.sets.length === 0).length} with no sets parsed`);
  const perLift = new Map<string, number>();
  for (const e of entries) perLift.set(e.lift.label, (perLift.get(e.lift.label) ?? 0) + 1);
  for (const [label, n] of [...perLift].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${label}`);
  for (const e of entries.filter((x) => x.sets.length === 0 && x.rowKg)) console.log(`  unparsed: ${e.date} ${e.exercise} — reps cell empty or unreadable`);

  if (values["dry-run"]) { console.log("\nDry run — nothing written."); return; }
  const target = loadTableTarget();
  const repository = LiftRepository.fromConnectionString(target.storageConnectionString, target.userId);
  await repository.ensureTable();
  console.log(`\nWritten: ${await repository.upsertMany(records)} rows`);
}

const invokedDirectly = process.argv[1]?.endsWith("import-block-log.js");
if (invokedDirectly) main().catch((e: unknown) => { console.error(`\nImport failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
