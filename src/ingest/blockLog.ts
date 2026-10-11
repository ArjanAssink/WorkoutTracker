import { resolveLift, type Lift } from "../domain/strength.js";
import type { Cell } from "./xlsx.js";

/**
 * The weekly training log: one sheet, session grids laid side by side and stacked down.
 *
 * A grid starts at its label column ("Full Body A", "Push Hinge Pull", …). Its header row
 * carries "weight", "rep target", "sets" and a `dd/mm/yyyy - …` cell; the rows beneath are
 * exercises with the name at the label column and the values at the header's absolute
 * columns, reps in the column after "sets". Two things make this fiddly, both learned from
 * the real file: "Bar height" / "Safety height" columns may sit between the label and
 * "weight" and may be blank in the header row, so the label is the *leftmost* non-empty
 * cell within three columns of "weight" — not the nearest; and the reps are free text in
 * a dozen hand-written notations, handled by {@link parseSetTokens}.
 */

export interface LoggedSet {
  /** Load in kg; "bw" when the set was explicitly bodyweight (`BWx7`). */
  kg: number | "bw" | undefined;
  reps: number;
  /** Written with `~` or `?` — the lifter was not sure. */
  uncertain?: boolean;
  /** A myo-rep match set. */
  myo?: boolean;
}

export interface ExerciseEntry {
  /** ISO date of the session. */
  date: string;
  session: string;
  exercise: string;
  lift: Lift;
  /** The row's working weight, when it was a number. */
  rowKg: number | undefined;
  target: string;
  /** Reps in reserve the set was taken to, when stated; undefined means not stated. */
  rir: number | undefined;
  sets: LoggedSet[];
  notes: string;
}

interface Grid {
  row: number;
  label: string;
  L: number;
  W: number;
  T: number | undefined;
  Z: number;
  date: string;
}

const text = (c: Cell | undefined): string => (c === null || c === undefined ? "" : typeof c === "number" ? String(c) : String(c)).trim();
const DATE = /(\d{2})\/(\d{2})\/(\d{4})/;

function isoDate(raw: string): string | undefined {
  const m = DATE.exec(raw);
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? undefined : iso;
}

export function findGrids(rows: Cell[][]): Grid[] {
  const grids: Grid[] = [];
  rows.forEach((r, i) => {
    r.forEach((cell, W) => {
      if (W === 0 || text(cell).toLowerCase() !== "weight") return;
      let L: number | undefined;
      for (let k = Math.max(0, W - 3); k < W; k++) if (text(r[k])) { L = k; break; }
      if (L === undefined) return;
      const cols = new Map<string, number>();
      for (let k = L; k < Math.min(r.length, L + 14); k++) { const t = text(r[k]).toLowerCase(); if (t && !cols.has(t)) cols.set(t, k); }
      const Z = cols.get("sets");
      const dateCell = r.slice(L, L + 14).map(text).find((t) => DATE.test(t));
      const date = dateCell ? isoDate(dateCell) : undefined;
      if (Z === undefined || !date) return;
      grids.push({ row: i, label: text(r[L]), L, W, T: cols.get("rep target"), Z, date });
    });
  });
  return grids;
}

/** `2 RIR` → 2, `0--1 RIR` → 0 (the lower bound), `1-2 rir` in the notes → 1. */
export function parseRir(target: string, notes = ""): number | undefined {
  for (const src of [target, notes]) {
    const range = /(\d+)\s*-+\s*(\d+)\s*rir/i.exec(src);
    if (range) return Math.min(Number(range[1]), Number(range[2]));
    const single = /(?:~\s*)?(\d+)\s*rir/i.exec(src);
    if (single) return Number(single[1]);
  }
  return undefined;
}

/**
 * Turns the reps cell into sets. Everything here was seen in the real log:
 *   `10,10,8`             reps at the row weight
 *   `100x1,95x10,8,6`     explicit weight×reps; later bare numbers inherit the last weight
 *   `105x1x100x8,6,5`     an "x" typed where a comma was meant
 *   `102,5x5,90x8`        a decimal comma inside a weight
 *   `10.7.-`              dots used as separators
 *   `BWx7`                bodyweight
 *   `14,MYO 14` `myo25`   myo-rep match sets
 *   `~5?` `7 of 6?`       uncertain counts
 *   `-` `0` `8,8-`        a skipped or failed set
 */
export function parseSetTokens(raw: string, rowKg: number | undefined): LoggedSet[] {
  let s = raw.trim().toLowerCase();
  if (!s || /^skipped/.test(s)) return [];
  // A decimal comma ("102,5x5") is indistinguishable from two sets ("5,10,75x5") by shape
  // alone; the row's own weight breaks the tie: a plate fraction is joined when the result
  // is within half to one-and-a-half times the row weight, which a back-off or top single is.
  if (rowKg !== undefined) {
    s = s.replace(/(^|,)(\d+),(5|25|75)(?=x)/g, (m, lead: string, whole: string, frac: string) => {
      const joined = Number(`${whole}.${frac}`);
      return joined >= rowKg * 0.5 && joined <= rowKg * 1.5 ? `${lead}${whole}.${frac}` : m;
    });
  }
  s = s.replace(/x(\d+)x/g, "x$1,");                   // "105x1x100x8" → "105x1,100x8"
  if (!s.includes("x") && /^\d+(\.\d+)+\.?-?$/.test(s) && (s.match(/\./g) ?? []).length >= 2) s = s.replace(/\./g, ","); // "10.7.-"
  const out: LoggedSet[] = [];
  let lastKg: number | "bw" | undefined;
  for (const tokenRaw of s.split(/[,;]/)) {
    const token = tokenRaw.trim().replace(/-+$/, "");
    if (!token || token === "–") continue;
    let m: RegExpExecArray | null;
    if (/^\d+(?:\.\d+)?\s*x$/.test(token)) continue;  // "102.5x" — a set begun and never written down
    if ((m = /^bw\s*x\s*(\d+)/.exec(token))) { lastKg = "bw"; out.push({ kg: "bw", reps: Number(m[1]) }); continue; }
    if ((m = /^(\d+(?:\.\d+)?)\s*x\s*(\d+)/.exec(token))) { lastKg = Number(m[1]); const reps = Number(m[2]); if (reps > 0) out.push({ kg: lastKg, reps }); continue; }
    const myo = /myo/.test(token);
    if ((m = /(\d+)/.exec(token))) {
      const reps = Number(m[1]);
      if (reps <= 0) continue;
      const uncertain = /[~?]/.test(token) || /\bof\b/.test(token);
      out.push({ kg: lastKg ?? rowKg, reps, ...(uncertain ? { uncertain: true } : {}), ...(myo ? { myo: true } : {}) });
    }
  }
  return out;
}

/** Every exercise row in the sheet, attributed to its session. */
export function parseBlockLog(rows: Cell[][]): ExerciseEntry[] {
  const grids = findGrids(rows);
  const byColumn = new Map<number, Grid[]>();
  for (const g of grids) (byColumn.get(g.L) ?? byColumn.set(g.L, []).get(g.L)!).push(g);
  const headerRows = new Set(grids.map((g) => g.row));
  const entries: ExerciseEntry[] = [];

  rows.forEach((r, i) => {
    if (headerRows.has(i)) return;
    for (const [L, list] of byColumn) {
      const name = text(r[L]);
      if (!name) continue;
      const grid = [...list].reverse().find((g) => g.row < i);
      if (!grid) continue;
      // Another grid may have started in this column since; the latest header above wins,
      // which is what the reverse find gives us.
      const kgText = text(r[grid.W]);
      const rowKg = /^\d+(\.\d+)?$/.test(kgText) ? Number(kgText) : undefined;
      const target = grid.T !== undefined ? text(r[grid.T]) : "";
      const repsText = text(r[grid.Z + 1]);
      const notes = r.slice(grid.Z + 2, grid.Z + 6).map(text).filter(Boolean).join(" ");
      if (!repsText && !kgText) continue; // a note line in the name column, not an exercise
      entries.push({
        date: grid.date, session: grid.label, exercise: name, lift: resolveLift(name), rowKg, target,
        rir: parseRir(target, notes), sets: parseSetTokens(repsText, rowKg), notes,
      });
    }
  });
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}
