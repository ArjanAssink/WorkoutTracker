import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findGrids, parseBlockLog, parseRir, parseSetTokens } from "../src/ingest/blockLog.js";
import { readWorkbook, type Cell } from "../src/ingest/xlsx.js";

describe("parseSetTokens — every notation seen in the real log", () => {
  const reps = (s: string, kg?: number) => parseSetTokens(s, kg);
  it("plain reps at the row weight", () => {
    expect(reps("10,10,8", 85)).toEqual([{ kg: 85, reps: 10 }, { kg: 85, reps: 10 }, { kg: 85, reps: 8 }]);
  });
  it("explicit weight×reps, with later bare numbers inheriting the last weight", () => {
    expect(reps("100x1,95x10,8,6", 95)).toEqual([{ kg: 100, reps: 1 }, { kg: 95, reps: 10 }, { kg: 95, reps: 8 }, { kg: 95, reps: 6 }]);
    expect(reps("115x1,107.5x6,3,95x8", 107.5)).toEqual([{ kg: 115, reps: 1 }, { kg: 107.5, reps: 6 }, { kg: 107.5, reps: 3 }, { kg: 95, reps: 8 }]);
  });
  it("an x typed where a comma was meant", () => {
    expect(reps("105x1x100x8,6,5", 100)).toEqual([{ kg: 105, reps: 1 }, { kg: 100, reps: 8 }, { kg: 100, reps: 6 }, { kg: 100, reps: 5 }]);
  });
  it("a decimal comma inside a weight", () => {
    expect(reps("102,5x5,90x8", 102.5)).toEqual([{ kg: 102.5, reps: 5 }, { kg: 90, reps: 8 }]);
    expect(reps("122,5x1,112,5x8,6,102,5x5", 112.5)).toEqual([{ kg: 122.5, reps: 1 }, { kg: 112.5, reps: 8 }, { kg: 112.5, reps: 6 }, { kg: 102.5, reps: 5 }]);
    expect(reps("6,25x24", 5)).toEqual([{ kg: 6.25, reps: 24 }]);
  });
  it("dots used as separators", () => {
    expect(reps("10.7.-", 5)).toEqual([{ kg: 5, reps: 10 }, { kg: 5, reps: 7 }]);
  });
  it("bodyweight sets", () => {
    expect(reps("10,6,BWx7", 12.5)).toEqual([{ kg: 12.5, reps: 10 }, { kg: 12.5, reps: 6 }, { kg: "bw", reps: 7 }]);
  });
  it("myo-rep match sets", () => {
    expect(reps("14,MYO 14", 12)).toEqual([{ kg: 12, reps: 14 }, { kg: 12, reps: 14, myo: true }]);
    expect(reps("25,myo25", 15)).toEqual([{ kg: 15, reps: 25 }, { kg: 15, reps: 25, myo: true }]);
  });
  it("uncertain counts", () => {
    expect(reps("10,9,~5?", 85)).toEqual([{ kg: 85, reps: 10 }, { kg: 85, reps: 9 }, { kg: 85, reps: 5, uncertain: true }]);
    expect(reps("105x1,97.5x10,7 of 6?,5,90x6", 97.5)[2]).toEqual({ kg: 97.5, reps: 7, uncertain: true });
  });
  it("skipped and failed sets", () => {
    expect(reps("5,5,-", 85)).toEqual([{ kg: 85, reps: 5 }, { kg: 85, reps: 5 }]);
    expect(reps("8,8-", 0)).toEqual([{ kg: 0, reps: 8 }, { kg: 0, reps: 8 }]);
    expect(reps("5,3,0", 15)).toEqual([{ kg: 15, reps: 5 }, { kg: 15, reps: 3 }]);
    expect(reps("skipped ivm rechter front delt", 0)).toEqual([]);
    expect(reps("122.5x1,112.5x8,6,102.5x", 112.5)).toEqual([{ kg: 122.5, reps: 1 }, { kg: 112.5, reps: 8 }, { kg: 112.5, reps: 6 }]); // a weight with no reps is not a set
    expect(reps("", 0)).toEqual([]);
  });
  it("leaves the weight undefined when the row had none and the token gives none", () => {
    expect(reps("65x5,5,10,10,75x5", undefined)).toEqual([{ kg: 65, reps: 5 }, { kg: 65, reps: 5 }, { kg: 65, reps: 10 }, { kg: 65, reps: 10 }, { kg: 75, reps: 5 }]);
    expect(reps("1,3,3,3", undefined)[0]).toEqual({ kg: undefined, reps: 1 });
  });
});

describe("parseRir", () => {
  it("reads a stated RIR and the lower bound of a range", () => {
    expect(parseRir("2 RIR")).toBe(2);
    expect(parseRir("0--1 RIR")).toBe(0);
    expect(parseRir("0-1 RIR")).toBe(0);
  });
  it("falls back to the notes, else undefined for a bare rep target", () => {
    expect(parseRir("5", "last reps ~1 RIR")).toBe(1);
    expect(parseRir("5", "last rep 1-2 RIR")).toBe(1);
    expect(parseRir("5", "last set felt heavy")).toBeUndefined();
    expect(parseRir("1+1 MYO rep match")).toBeUndefined();
  });
});

describe("findGrids and parseBlockLog on a synthetic sheet", () => {
  const D = (s: string) => s;
  const sheet: Cell[][] = [
    ["Full Body A", "weight", null, null, "rep target", "sets", null, D("12/08/2025 - 1"), null, null, null, "Full Body B", null, null, "weight", null, "rep target", "sets", null, D("17/08/2025 - 1")],
    ["Slow Chinups (palms in)", 15, null, null, "2 RIR", 3, "7,4,4", 0.8, null, null, null, "Bow Bar Bench", null, null, 85, null, "2 RIR", 3, "10,9,~5?", "Bar: 18 safeties"],
    [null, null, null, null, null, null, null, "Morning weight", null, null, null, "Pullups", null, null, 0, null, "5", 3, "5,5,5", null],
    ["Full Body A", "weight", null, null, "rep target", "sets", null, D("24/08/2025 - 1")],
    ["Pullups", 10, null, null, "1 RIR", 3, "10,6,5", 0.9],
  ];
  it("finds both grids, with the label as the leftmost non-empty cell near 'weight'", () => {
    const grids = findGrids(sheet);
    expect(grids.map((g) => [g.label, g.L, g.date])).toEqual([["Full Body A", 0, "2025-08-12"], ["Full Body B", 11, "2025-08-17"], ["Full Body A", 0, "2025-08-24"]]);
  });
  it("attributes each exercise row to the latest grid above it in its own column", () => {
    const entries = parseBlockLog(sheet);
    expect(entries.map((e) => [e.date, e.exercise, e.rowKg, e.rir, e.sets.length])).toEqual([
      ["2025-08-12", "Slow Chinups (palms in)", 15, 2, 3],
      ["2025-08-17", "Bow Bar Bench", 85, 2, 3],
      ["2025-08-17", "Pullups", 0, undefined, 3],
      ["2025-08-24", "Pullups", 10, 1, 3],
    ]);
    expect(entries[1]!.lift.slug).toBe("buffalo-bench");
    expect(entries[1]!.sets[2]).toEqual({ kg: 85, reps: 5, uncertain: true });
    expect(entries[2]!.lift.family).toBe("pull");
  });
  it("ignores note lines sitting in a name column", () => {
    expect(parseBlockLog(sheet).some((e) => /morning weight/i.test(e.exercise))).toBe(false);
  });
});

describe("the real weekly log", () => {
  const path = `${process.env["WORKOUT_SAMPLES_DIR"] ?? ""}/block2025.xlsx`; // personal; see strength.test.ts
  it("yields the bench and pull-up progression on distinct dates with real weights", () => {
    if (!process.env["WORKOUT_SAMPLES_DIR"]) return;
    let buf: Buffer; try { buf = readFileSync(path); } catch { return; }
    const entries = parseBlockLog(readWorkbook(buf).get("Sheet1")!);
    const bench = entries.filter((e) => e.lift.slug === "buffalo-bench");
    expect(bench.length).toBeGreaterThan(30);
    expect(new Set(bench.map((e) => e.date)).size).toBe(bench.length);        // one session per date
    const last = bench[bench.length - 1]!;
    expect(last.date).toBe("2026-10-06");
    expect(last.rowKg).toBe(102.5);
    expect(last.sets).toEqual([{ kg: 102.5, reps: 5 }, { kg: 102.5, reps: 5 }, { kg: 102.5, reps: 5 }]);
    const pulls = entries.filter((e) => e.lift.family === "pull" && !/assisted/i.test(e.exercise));
    expect(pulls.length).toBeGreaterThan(30);
    expect(pulls.find((e) => e.date === "2026-10-03")!.rowKg).toBe(16.25);
  });
});
