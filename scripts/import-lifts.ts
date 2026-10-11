/**
 * Imports the long-term lift log workbook.
 *
 *   npm run lifts -- LongTermLiftProgress.xlsx [--dry-run] [--as-of YYYY-MM-DD]
 *
 * Three sheets, three kinds of record:
 *   "PRs over time"   one row per date: program, bodyweight, and per lift (Bench, Squat,
 *                     Deadlift, OHP) the reps and weight of the top set  → `pr`
 *   "rep PRs"         a board of best weight per rep count per variation → `repmax`
 *                     (undated: a snapshot, stamped with --as-of or the file's date)
 *   "Sheet1"          a training block: program, start date, and a training max per lift
 *                     per week                                           → `tm`
 *
 * Needs WORKOUTS_STORAGE (or AzureWebJobsStorage) unless --dry-run.
 */
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import process from "node:process";
import { loadTableTarget } from "../src/config/index.js";
import { resolveLift } from "../src/domain/strength.js";
import { readWorkbook, type Cell } from "../src/ingest/xlsx.js";
import { LiftRepository, type LiftRecord, type PrRecord, type RepMaxRecord, type TrainingMaxRecord } from "../src/storage/liftRepository.js";

const num = (c: Cell | undefined): number | undefined => (typeof c === "number" && Number.isFinite(c) && c > 0 ? c : undefined);
const str = (c: Cell | undefined): string | undefined => (typeof c === "string" && c.trim() ? c.trim() : undefined);
const isDate = (c: Cell | undefined): c is string => typeof c === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c);

export function parsePrLog(rows: Cell[][], now: string): PrRecord[] {
  const header = rows[0] ?? [];
  // Lift name sits above the "Reps" column of its three-column group.
  const groups = header.map((c, i) => ({ name: str(c), i })).filter((g) => g.name && ["bench", "squat", "deadlift", "ohp"].includes(g.name.toLowerCase()));
  const out: PrRecord[] = [];
  for (const r of rows.slice(2)) {
    if (!isDate(r[0])) continue;
    const program = str(r[1]);
    const bodyweightKg = num(r[2]);
    for (const g of groups) {
      const reps = num(r[g.i]), kg = num(r[g.i + 1]);
      if (!reps || !kg) continue;
      const lift = resolveLift(g.name!);
      out.push({ kind: "pr", date: r[0], lift: lift.slug, family: lift.family, label: lift.label, reps: Math.round(reps), kg,
        ...(program ? { program } : {}), ...(bodyweightKg ? { bodyweightKg } : {}), source: "pr-log", recordedAt: now });
    }
  }
  return out;
}

export function parseRepMaxBoard(rows: Cell[][], asOf: string, now: string): RepMaxRecord[] {
  const repsHeader = (rows[0] ?? []).map((c) => num(c));
  const out: RepMaxRecord[] = [];
  for (const r of rows.slice(1)) {
    const name = str(r[0]);
    if (!name) continue;
    if (/^estimated/i.test(name)) break; // the derived block below the board
    const lift = resolveLift(name);
    repsHeader.forEach((reps, i) => {
      const kg = num(r[i]);
      if (reps && kg) out.push({ kind: "repmax", lift: lift.slug, family: lift.family, label: lift.label, reps: Math.round(reps), kg, asOf, recordedAt: now });
    });
  }
  return out;
}

export function parseBlock(rows: Cell[][], now: string): TrainingMaxRecord[] {
  const programStart = rows.flat().find(isDate);
  const programRow = rows.find((r) => /^progr?am$/i.test(str(r[0]) ?? ""));
  const program = programRow ? str(programRow[1]) : undefined;
  const weeksRow = rows.find((r) => /^total week/i.test(str(r[0]) ?? ""));
  if (!programStart || !program || !weeksRow) return [];
  const weekCols = weeksRow.map((c, i) => ({ week: num(c), i })).filter((w): w is { week: number; i: number } => w.week !== undefined && w.i > 0);
  const out: TrainingMaxRecord[] = [];
  for (const r of rows) {
    const name = str(r[0]);
    if (!name || !/\bTM\s*$/i.test(name)) continue;
    const lift = resolveLift(name);
    for (const { week, i } of weekCols) {
      const kg = num(r[i]);
      if (!kg) continue;
      const date = new Date(Date.parse(`${programStart}T00:00:00Z`) + (week - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
      out.push({ kind: "tm", program, programStart, week: Math.round(week), date, lift: lift.slug, family: lift.family, label: lift.label, kg, recordedAt: now });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, "as-of": { type: "string" } },
  });
  const file = positionals[0];
  if (!file) { console.log("Usage: npm run lifts -- <workbook.xlsx> [--dry-run] [--as-of YYYY-MM-DD]"); process.exit(1); }

  const asOf = values["as-of"] ?? statSync(file).mtime.toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const sheets = readWorkbook(readFileSync(file));
  const sheet = (name: RegExp) => [...sheets.entries()].find(([k]) => name.test(k))?.[1] ?? [];

  const prs = parsePrLog(sheet(/^prs over time$/i), now);
  const repMaxes = parseRepMaxBoard(sheet(/^rep prs$/i), asOf, now);
  const tms = parseBlock(sheet(/^sheet1$/i), now);
  const records: LiftRecord[] = [...prs, ...repMaxes, ...tms];

  console.log(`Sheets: ${[...sheets.keys()].join(", ")}`);
  console.log(`PR log            : ${prs.length} top sets, ${prs[0]?.date} → ${prs[prs.length - 1]?.date}, lifts ${[...new Set(prs.map((p) => p.lift))].join(", ")}`);
  console.log(`Rep-max board     : ${repMaxes.length} entries across ${new Set(repMaxes.map((r) => r.lift)).size} variations, as of ${asOf}`);
  const programs = new Set(tms.map((t) => t.program));
  console.log(`Training maxes    : ${tms.length} week×lift values, ${programs.size} block(s): ${[...programs].join("; ")}`);
  for (const l of new Set(records.filter((r) => r.family === "other").map((r) => r.label))) console.log(`  unrecognised lift kept as "other": ${l}`);

  if (values["dry-run"]) { console.log("\nDry run — nothing written."); return; }
  const target = loadTableTarget();
  const repository = LiftRepository.fromConnectionString(target.storageConnectionString, target.userId);
  await repository.ensureTable();
  console.log(`\nWritten: ${await repository.upsertMany(records)} rows`);
}

const invokedDirectly = process.argv[1]?.endsWith("import-lifts.js");
if (invokedDirectly) main().catch((e: unknown) => { console.error(`\nImport failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
