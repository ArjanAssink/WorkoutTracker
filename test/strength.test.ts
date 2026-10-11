import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyseBlockLift, cleanLiftName, dots, estimate1Rm, fitPersonalCurve, personal, relativeStrength, repsToFailure, resolveLift, topSet, wendler,
} from "../src/domain/strength.js";
import { readWorkbook } from "../src/ingest/xlsx.js";

describe("lift names", () => {
  it("strips list numbers and TM suffixes", () => {
    expect(cleanLiftName("2. RB incline Bench TM")).toBe("RB incline Bench");
    expect(cleanLiftName("  OHP TM ")).toBe("OHP");
  });
  it("maps the spreadsheet's names onto lifts, specific before general", () => {
    const cases: Array<[string, string]> = [
      ["Straight Bar Back Squat", "squat"], ["Safety Squat Bar Back Squat", "ssb-squat"], ["Parallel SSB Squat TM", "ssb-squat"],
      ["Deep SSB red banded squat", "ssb-squat-deep-banded"], ["Deep SSB Squat TM", "ssb-squat-deep"], ["Deep SSB Handle Up TM", "ssb-squat-deep-handles-up"],
      ["Straight Bar Bench", "bench"], ["Bench", "bench"], ["Bow Bar Bench TM", "buffalo-bench"], ["Buffalo Bar Bench", "buffalo-bench"],
      ["Close Grip Bench", "close-grip-bench"], ["Close Grip Bow Bench TM", "close-grip-buffalo-bench"],
      ["Deadlift", "deadlift"], ["RDL TM", "rdl"], ["SG RDL TM", "sg-rdl"], ["SSB Good Morning TM", "ssb-good-morning"],
      ["OHP", "ohp"], ["Overhead Press", "ohp"], ["DB OHP TM", "db-ohp"], ["3. Incline DB Press TM", "incline-db-press"],
      ["Belt Squat TM", "belt-squat"], ["BG Split Squat TM", "bulgarian-split-squat"], ["T-Bar Row TM", "t-bar-row"], ["One Arm Landmine Row TM", "landmine-row"],
      ["Heel Raised Upright SSB", "ssb-squat-upright"], ["Feet flat A2G Upright SSB", "ssb-squat-upright"], ["Rear Foot 2. Elevated Split Squats SSB", "bulgarian-split-squat"],
      ["Pullups", "pull-up"], ["Palms out Chin Ups", "chin-up"], ["Slow Chinups (palms facing towards)", "chin-up"], ["Weight assisted Pullups", "assisted-pull-up"],
    ];
    for (const [raw, slug] of cases) expect(resolveLift(raw).slug, raw).toBe(slug);
  });
  it("keeps an unknown lift distinct under 'other'", () => {
    const lift = resolveLift("Zercher Carry TM");
    expect(lift).toEqual({ slug: "zercher-carry", label: "Zercher Carry", family: "other" });
  });
});

describe("one-rep-max estimation", () => {
  it("reproduces the sheet's Wendler numbers", () => {
    expect(wendler(40, 14)).toBeCloseTo(58.648, 2);
    expect(wendler(97.5, 5)).toBeCloseTo(113.734, 2);
    expect(wendler(120, 1)).toBe(120);
  });

  // The lifter's actual bench rep-max board: a flatter curve than Epley's.
  const bench = [{ reps: 1, kg: 120 }, { reps: 2, kg: 117.5 }, { reps: 3, kg: 110 }, { reps: 10, kg: 102.5 }, { reps: 11, kg: 100 }, { reps: 14, kg: 97.5 }, { reps: 15, kg: 90 }];

  it("fits a personal curve that lands a 14-rep set near the real single, where Wendler overshoots by a fifth", () => {
    const curve = fitPersonalCurve(bench)!;
    expect(curve.k).toBeLessThan(0.0333);
    expect(personal(97.5, 14, curve)).toBeGreaterThan(115);
    expect(personal(97.5, 14, curve)).toBeLessThan(126);
    expect(wendler(97.5, 14)).toBeGreaterThan(140);
  });

  it("anchors on a logged single when there is one", () => {
    expect(fitPersonalCurve(bench)!.anchorReps).toBe(1);
  });

  it("stands in with Wendler for the anchor when no single is logged", () => {
    const curve = fitPersonalCurve([{ reps: 3, kg: 110 }, { reps: 10, kg: 102.5 }, { reps: 14, kg: 97.5 }])!;
    expect(curve.anchorReps).toBe(3);
    expect(curve.k).toBeGreaterThan(0);
  });

  it("refuses to fit on too few points", () => {
    expect(fitPersonalCurve([{ reps: 1, kg: 120 }, { reps: 5, kg: 100 }])).toBeUndefined();
  });

  it("says which estimator produced a number and flags high-rep extrapolation", () => {
    expect(estimate1Rm(100, 5, undefined)).toMatchObject({ estimator: "wendler", lowConfidence: false });
    expect(estimate1Rm(100, 13, fitPersonalCurve(bench))).toMatchObject({ estimator: "personal", lowConfidence: true });
  });
});

describe("a session's top set", () => {
  it("reads reps in reserve as reps not done, within reason", () => {
    expect(repsToFailure(5, 2)).toBe(7);
    expect(repsToFailure(5, undefined)).toBe(5);
    expect(repsToFailure(5, 9)).toBe(10);
  });
  it("picks the set implying the highest 1RM, not the heaviest or the most reps", () => {
    const top = topSet([{ kg: 100, reps: 1 }, { kg: 95, reps: 10 }, { kg: 95, reps: 8 }], undefined, undefined)!;
    expect(top.set).toEqual({ kg: 95, reps: 10 });
    expect(top.e1rm).toBeCloseTo(wendler(95, 10), 1);
  });
  it("carries the RIR into the estimate — 102.5×5 at 2 RIR reads as a 7", () => {
    const top = topSet([{ kg: 102.5, reps: 5 }, { kg: 102.5, reps: 5 }, { kg: 102.5, reps: 5 }], 2, undefined)!;
    expect(top.reps).toBe(7);
    expect(top.e1rm).toBeCloseTo(wendler(102.5, 7), 1);
  });
  it("ignores myo-rep match sets and sets without a load", () => {
    expect(topSet([{ kg: 12, reps: 14 }, { kg: 12, reps: 30, myo: true }], undefined, undefined)!.set.reps).toBe(14);
    expect(topSet([{ kg: undefined, reps: 5 }, { kg: 0, reps: 8 }], undefined, undefined)).toBeUndefined();
  });
});

describe("bodyweight normalisation", () => {
  it("computes the ratio and the allometric form", () => {
    const r = relativeStrength(150, 85);
    expect(r.ratio).toBeCloseTo(1.765, 3);
    expect(r.allometric).toBeCloseTo(150 / Math.pow(85, 2 / 3), 6);
  });
  it("matches the published DOTS reference — 100 kg at 85 kg bodyweight ≈ 66.6", () => {
    expect(dots(100, 85)).toBeCloseTo(66.6, 0);
  });
  it("rewards the lighter lifter for the same lift", () => {
    expect(dots(150, 75)).toBeGreaterThan(dots(150, 95));
  });
});

describe("block progression", () => {
  const lift = resolveLift("OHP TM");
  it("calls a rising training max progressing and measures the change", () => {
    const s = analyseBlockLift(lift, [57, 55.9, 55.9, 56.1, 56.4, 57, 57.6, 58.7, 60.8, 62.6])!;
    expect(s.verdict).toBe("progressing");
    expect(s.changePct).toBeCloseTo((62.6 / 57 - 1) * 100, 3);
    expect(s.weeksSinceIncrease).toBe(0);
  });
  it("calls a flat run holding and counts weeks since the last increase", () => {
    const s = analyseBlockLift(lift, [100, 100.5, 101, 101, 101, 101, 101])!;
    expect(s.verdict).toBe("holding");
    expect(s.weeksSinceIncrease).toBe(4);
  });
  it("skips untrained weeks rather than reading them as zero", () => {
    const s = analyseBlockLift(lift, [100, null, null, 104, null, 108])!;
    expect(s.verdict).toBe("progressing");
    expect(s.firstKg).toBe(100); expect(s.lastKg).toBe(108);
  });
  it("needs two trained weeks to say anything", () => {
    expect(analyseBlockLift(lift, [100, null])).toBeUndefined();
  });
});

describe("xlsx reader", () => {
  // Real workbooks are personal; point WORKOUT_SAMPLES_DIR at a folder holding them to run this.
  const path = `${process.env["WORKOUT_SAMPLES_DIR"] ?? ""}/lifts.xlsx`;
  it("reads the real workbook: sheets, dates, shared strings, numbers, error cells", () => {
    let buf: Buffer;
    if (!process.env["WORKOUT_SAMPLES_DIR"]) return;
    try { buf = readFileSync(path); } catch { return; }
    const sheets = readWorkbook(buf);
    expect([...sheets.keys()]).toEqual(["PRs over time", "Sheet1", "rep PRs"]);
    const pr = sheets.get("PRs over time")!;
    expect(pr[2]![0]).toBe("2013-03-06");          // date-styled number → ISO date
    expect(pr[2]![1]).toBe("Greyskull LP");        // shared string
    expect(pr[2]![3]).toBe(14);                     // number
    expect(pr[2]![5]).toBeCloseTo(58.648, 3);
    expect(pr.some((r) => r.includes(null))).toBe(true); // #N/A cells come back null
  });
});
