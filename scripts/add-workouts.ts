/**
 * Backfills workouts by hand from a small CSV, for sessions that never reached Apple Health.
 *
 *   npm run add -- bjj.csv            # posts each row to /api/workouts
 *   npm run add -- bjj.csv --dry-run  # shows what would be posted
 *
 * CSV, one workout per line, header optional, `#` comments allowed:
 *
 *   start,            duration, activity,     notes
 *   2026-09-02 19:00, 90m,      martialarts,  open mat
 *   2026-09-04 19:00, 1h30,     martialarts
 *
 * `start` is local time in Europe/Amsterdam unless it carries an offset or a Z. Activity is
 * the slug Apple would record (`martialarts` for BJJ, `taichi` for Capoeira) or any name
 * the normaliser understands. Rows are stored as `source: manual`.
 *
 * Needs INGEST_API_KEY (read from .env) and optionally WORKOUTS_URL.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import process from "node:process";

const TIMEZONE = "Europe/Amsterdam";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
  });
  const file = positionals[0];
  if (values.help || !file) {
    console.log("Usage: npm run add -- <workouts.csv> [--dry-run]");
    process.exit(values.help ? 0 : 1);
  }

  const key = process.env["INGEST_API_KEY"];
  const base = (process.env["WORKOUTS_URL"] ?? "").replace(/\/$/, "");
  if (!values["dry-run"] && !key) throw new Error("INGEST_API_KEY is not set (put it in .env)");
  if (!values["dry-run"] && !base) throw new Error("WORKOUTS_URL is not set (put it in .env)");

  const rows = parseCsv(readFileSync(file, "utf8"));
  console.log(`${rows.length} workout${rows.length === 1 ? "" : "s"} in ${file}${values["dry-run"] ? " (dry run)" : ""}`);

  let created = 0, duplicate = 0, failed = 0;
  for (const row of rows) {
    const payload = {
      activityType: row.activity,
      startedAt: toIso(row.start),
      duration: `${toMinutes(row.duration)} min`,
      source: "manual",
      sourceName: "Manual backfill",
      ...(row.notes ? { notes: row.notes } : {}),
    };
    const label = `${payload.startedAt.slice(0, 16).replace("T", " ")}  ${row.activity.padEnd(12)} ${row.duration}`;

    if (values["dry-run"]) { console.log(`  would post  ${label}`); continue; }

    const response = await fetch(`${base}/api/workouts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key! },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as { status?: string; error?: string; details?: string[] };
    if (response.status === 201) { created++; console.log(`  created     ${label}`); }
    else if (response.status === 200) { duplicate++; console.log(`  duplicate   ${label}`); }
    else { failed++; console.log(`  FAILED      ${label}  -> ${body.error ?? response.status} ${(body.details ?? []).join("; ")}`); }
  }

  if (!values["dry-run"]) console.log(`\ncreated ${created}, already present ${duplicate}, failed ${failed}`);
  if (failed) process.exit(1);
}

interface Row { start: string; duration: string; activity: string; notes?: string }

function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = line.split(",").map((c) => c.trim());
    if (i === 0 && /^start/i.test(cells[0] ?? "")) continue; // header
    const [start, duration, activity, ...rest] = cells;
    if (!start || !duration || !activity) throw new Error(`Line ${i + 1}: need start, duration, activity — got "${line}"`);
    rows.push({ start, duration, activity, ...(rest.length ? { notes: rest.join(", ") } : {}) });
  }
  return rows;
}

/**
 * "2026-09-02 19:00" is a local wall-clock time; attach the Amsterdam offset that was in
 * force on that date so DST is handled, rather than assuming UTC and landing an hour off.
 */
function toIso(start: string): string {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(start)) return new Date(start.replace(" ", "T")).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(start);
  if (!m) throw new Error(`Unrecognised start: "${start}" — use YYYY-MM-DD HH:MM`);
  const [, y, mo, d, h, mi, sec] = m;
  const guess = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(sec ?? 0));
  // Offset of the zone at that instant, then shift the wall-clock guess by it.
  const offsetMinutes = zoneOffsetMinutes(new Date(guess));
  return new Date(guess - offsetMinutes * 60_000).toISOString();
}

/** "90m", "90", "1h30", "1h 30m", "1.5h" → minutes. */
export function toMinutes(raw: string): number {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "");
  const hm = /^(\d+(?:\.\d+)?)h(?:(\d+)m?)?$/.exec(text);
  if (hm) return Math.round(Number(hm[1]) * 60 + Number(hm[2] ?? 0));
  const m = /^(\d+(?:\.\d+)?)(?:m|min|mins)?$/.exec(text);
  if (m) return Math.round(Number(m[1]));
  throw new Error(`Unrecognised duration: "${raw}" — use 90m, 1h30 or 1h 30m`);
}

function zoneOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return (asUtc - at.getTime()) / 60_000;
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
