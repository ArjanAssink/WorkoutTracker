import { describe, expect, it } from "vitest";
import { DEFAULT_GOALS, median, parseGoalTargets, reviewWeeks } from "../src/domain/goals.js";
import type { Workout } from "../src/domain/workout.js";

let n = 0;
function w(startedAt: string, activityType: string, extra: Partial<Workout> = {}): Workout {
  return {
    id: `w${n++}`, activityType, startedAt, endedAt: startedAt, durationSeconds: 3600,
    effort: 50, effortModel: "trimp", source: "shortcut", recordedAt: startedAt, ...extra,
  };
}

// 2026-03-02 is a Monday. The "current" week under review is Mar 9–15.
const from = new Date("2026-02-02T00:00:00Z");
const to = new Date("2026-03-16T00:00:00Z");

/** Shifts a workout back by whole weeks — real date arithmetic, not string surgery. */
function weeksEarlier(workout: Workout, weeks: number): Workout {
  const shifted = new Date(new Date(workout.startedAt).getTime() - weeks * 7 * 86_400_000).toISOString();
  return w(shifted, workout.activityType);
}

const perfectWeek = [
  w("2026-03-09T07:00:00Z", "strength"), w("2026-03-11T07:00:00Z", "strength"), w("2026-03-13T07:00:00Z", "strength"),
  w("2026-03-10T19:00:00Z", "martialarts"), w("2026-03-12T19:00:00Z", "martialarts"),
  w("2026-03-14T10:00:00Z", "taichi"),
];

describe("parseGoalTargets", () => {
  it("parses the compact setting format", () => {
    expect(parseGoalTargets("strength:3,martialarts:2,taichi:1")).toEqual(DEFAULT_GOALS.targets);
  });

  it("tolerates whitespace and skips malformed entries", () => {
    expect(parseGoalTargets(" running : 2 , nonsense , swimming:x ")).toEqual([{ activityType: "running", sessions: 2 }]);
  });

  it("falls back to the defaults rather than zeroing out on garbage", () => {
    expect(parseGoalTargets("")).toEqual(DEFAULT_GOALS.targets);
    expect(parseGoalTargets(undefined)).toEqual(DEFAULT_GOALS.targets);
    expect(parseGoalTargets("::,,")).toEqual(DEFAULT_GOALS.targets);
  });
});

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("reviewWeeks — verdicts", () => {
  it("calls a week perfect when every target is met", () => {
    const report = reviewWeeks(perfectWeek, DEFAULT_GOALS, from, to);
    expect(report.current!.verdict).toBe("perfect");
    expect(report.current!.targets.every((t) => t.met)).toBe(true);
    expect(report.current!.totalSessions).toBe(6);
  });

  it("calls a week very good when a missed target is covered by a substitute and the floors hold", () => {
    // Only one BJJ, but a run makes it six sessions with three strength — very good, not perfect.
    const week = [...perfectWeek.filter((x) => x.activityType !== "martialarts"),
      w("2026-03-10T19:00:00Z", "martialarts"), w("2026-03-12T07:00:00Z", "running")];
    const report = reviewWeeks(week, DEFAULT_GOALS, from, to);
    expect(report.current!.verdict).toBe("verygood");
    expect(report.current!.targets.find((t) => t.activityType === "martialarts")!.met).toBe(false);
    expect(report.current!.otherSessions).toBe(1);
  });

  it("calls five sessions of any mix good, and six without two strength sessions merely good", () => {
    const five = [w("2026-03-09T07:00:00Z", "strength"), ...["martialarts", "running", "cycling", "hiking"].map((a, i) => w(`2026-03-1${i}T19:00:00Z`, a))];
    expect(reviewWeeks(five, DEFAULT_GOALS, from, to).current!.verdict).toBe("good");
    const six = [...five, w("2026-03-14T10:00:00Z", "swimming")];
    expect(reviewWeeks(six, DEFAULT_GOALS, from, to).current!.verdict).toBe("good"); // one strength only
    expect(reviewWeeks([...six, w("2026-03-15T07:00:00Z", "strength")], DEFAULT_GOALS, from, to).current!.verdict).toBe("verygood");
  });

  it("calls a week short when the total falls below the good-week bar", () => {
    const report = reviewWeeks(perfectWeek.slice(0, 4), DEFAULT_GOALS, from, to);
    expect(report.current!.verdict).toBe("short");
    expect(report.current!.totalSessions).toBe(4);
  });

  it("does not let extra sessions of one activity satisfy another's target", () => {
    // Six strength sessions is a good week by count, but BJJ and Capoeira were still skipped.
    const week = Array.from({ length: 6 }, (_, i) =>
      w(new Date(Date.UTC(2026, 2, 9 + i, 7)).toISOString(), "strength"));
    const report = reviewWeeks(week, DEFAULT_GOALS, from, to);
    expect(report.current!.verdict).toBe("verygood"); // six sessions, the strength floor met — but never perfect
    expect(report.current!.verdict).not.toBe("perfect");
    expect(report.current!.otherSessions).toBe(3); // beyond the strength target of 3
  });

  it("is perfect, not merely good, when targets are met with sessions to spare", () => {
    const report = reviewWeeks([...perfectWeek, w("2026-03-15T08:00:00Z", "running")], DEFAULT_GOALS, from, to);
    expect(report.current!.verdict).toBe("perfect");
    expect(report.current!.otherSessions).toBe(1);
  });

  it("emits every week in the range, including empty ones as short", () => {
    const report = reviewWeeks(perfectWeek, DEFAULT_GOALS, from, to);
    expect(report.weeks.map((x) => x.weekStart)).toEqual([
      "2026-02-02", "2026-02-09", "2026-02-16", "2026-02-23", "2026-03-02", "2026-03-09",
    ]);
    expect(report.weeks.slice(0, 5).every((x) => x.verdict === "short" && x.totalSessions === 0)).toBe(true);
  });

  it("assigns a Sunday workout to the week that started the previous Monday", () => {
    const report = reviewWeeks([w("2026-03-15T20:00:00Z", "taichi")], DEFAULT_GOALS, from, to);
    expect(report.current!.weekStart).toBe("2026-03-09");
    expect(report.current!.targets.find((t) => t.activityType === "taichi")!.actual).toBe(1);
  });
});

describe("reviewWeeks — baseline and streak", () => {
  const threeGoodWeeks = [...perfectWeek, ...perfectWeek.map((x) => weeksEarlier(x, 1))];

  it("computes the baseline from prior weeks only, never the current one", () => {
    const report = reviewWeeks(perfectWeek, DEFAULT_GOALS, from, to);
    expect(report.baseline!.weeks).toBe(5);
    expect(report.baseline!.medianSessions).toBe(0); // all prior weeks empty
  });

  it("uses a median so one outlier week does not skew the typical week", () => {
    const workouts = [
      ...perfectWeek,
      // Four quiet prior weeks and one enormous one.
      w("2026-02-03T07:00:00Z", "strength"), w("2026-02-10T07:00:00Z", "strength"),
      w("2026-02-17T07:00:00Z", "strength"), w("2026-02-24T07:00:00Z", "strength"),
      ...Array.from({ length: 12 }, (_, i) => w(`2026-03-0${2 + (i % 6)}T0${i % 9}:00:00Z`, "running")),
    ];
    const report = reviewWeeks(workouts, DEFAULT_GOALS, from, to);
    expect(report.baseline!.medianSessions).toBe(1);
  });

  it("counts consecutive good-or-perfect weeks ending now", () => {
    const report = reviewWeeks(threeGoodWeeks, DEFAULT_GOALS, from, to);
    expect(report.streakWeeks).toBe(2);
  });

  it("breaks the streak on a short week", () => {
    // Perfect two weeks ago and now, nothing in between.
    const withGap = [...perfectWeek, ...perfectWeek.map((x) => weeksEarlier(x, 2))];
    const report = reviewWeeks(withGap, DEFAULT_GOALS, from, to);
    expect(report.streakWeeks).toBe(1);
  });

  it("has no baseline when there is no history", () => {
    const report = reviewWeeks(perfectWeek, DEFAULT_GOALS, new Date("2026-03-09T00:00:00Z"), to);
    expect(report.baseline).toBeUndefined();
  });
});

describe("effort against the typical week", () => {
  const base = new Date("2026-01-05T00:00:00Z"); // a Monday
  const weekOf = (n: number, effort: number) =>
    w(new Date(base.getTime() + n * 7 * 86_400_000 + 7 * 3_600_000).toISOString(), "strength", { effort });
  const wide = new Date("2026-01-05T00:00:00Z");
  const end = new Date("2026-04-06T00:00:00Z"); // 13 weeks

  it("needs at least four prior weeks before it will call anything typical", () => {
    const report = reviewWeeks([weekOf(0, 100), weekOf(1, 100), weekOf(2, 100), weekOf(3, 100)], DEFAULT_GOALS, wide, end);
    expect(report.weeks[3]!.typicalEffort).toBeUndefined();
    expect(report.weeks[4]!.typicalEffort).toBe(100);
  });

  it("compares each week to the median of the twelve before it, not the whole window", () => {
    const workouts = [...Array.from({ length: 12 }, (_, i) => weekOf(i, 100)), weekOf(12, 150)];
    const report = reviewWeeks(workouts, DEFAULT_GOALS, wide, end);
    const last = report.weeks[12]!;
    expect(last.typicalEffort).toBe(100);
    expect(last.effortRatio).toBe(1.5);
  });

  it("uses a median, so one monster week does not move the baseline", () => {
    const workouts = [...Array.from({ length: 11 }, (_, i) => weekOf(i, 100)), weekOf(11, 900), weekOf(12, 100)];
    const report = reviewWeeks(workouts, DEFAULT_GOALS, wide, end);
    expect(report.weeks[12]!.typicalEffort).toBe(100);
    expect(report.weeks[12]!.effortRatio).toBe(1);
  });

  it("gives an empty week a ratio of zero against a real baseline", () => {
    const workouts = Array.from({ length: 12 }, (_, i) => weekOf(i, 100));
    const report = reviewWeeks(workouts, DEFAULT_GOALS, wide, end);
    expect(report.weeks[12]!.effortRatio).toBe(0);
  });
});

describe("lead-in weeks", () => {
  const monday = (n: number) => new Date(Date.UTC(2026, 0, 5) + n * 7 * 86_400_000);
  const weekOf = (n: number, effort: number) => w(new Date(monday(n).getTime() + 7 * 3_600_000).toISOString(), "strength", { effort });
  // Twelve lead-in weeks at 100, then four visible weeks at 150.
  const workouts = [...Array.from({ length: 12 }, (_, i) => weekOf(i, 100)), ...Array.from({ length: 4 }, (_, i) => weekOf(12 + i, 150))];
  const from = monday(12), to = monday(16);

  it("gives the very first visible week a typical, from weeks it does not return", () => {
    const report = reviewWeeks(workouts, DEFAULT_GOALS, from, to, { leadInWeeks: 12 });
    expect(report.weeks).toHaveLength(4);
    expect(report.weeks[0]!.weekStart).toBe("2026-03-30");
    expect(report.weeks[0]!.typicalEffort).toBe(100);
    expect(report.weeks[0]!.effortRatio).toBe(1.5);
  });

  it("without lead-in rows, the same first week has nothing to compare against", () => {
    // What a caller fetching only [from, to) would supply.
    const visibleOnly = workouts.filter((x) => new Date(x.startedAt) >= from);
    const report = reviewWeeks(visibleOnly, DEFAULT_GOALS, from, to);
    expect(report.weeks[0]!.typicalEffort).toBeUndefined();
  });

  it("returns only the requested window even when earlier rows are supplied", () => {
    const report = reviewWeeks(workouts, DEFAULT_GOALS, from, to);
    expect(report.weeks.map((x) => x.weekStart)[0]).toBe("2026-03-30");
    expect(report.weeks).toHaveLength(4);
  });

  it("keeps baseline and streak over the visible window only", () => {
    const withLead = reviewWeeks(workouts, DEFAULT_GOALS, from, to, { leadInWeeks: 12 });
    const without = reviewWeeks(workouts, DEFAULT_GOALS, from, to);
    expect(withLead.baseline).toEqual(without.baseline);
    expect(withLead.streakWeeks).toBe(without.streakWeeks);
    expect(withLead.current!.weekStart).toBe(without.current!.weekStart);
  });

  it("does not fabricate a typical when the lead-in has no data", () => {
    const sparse = Array.from({ length: 4 }, (_, i) => weekOf(12 + i, 150));
    const report = reviewWeeks(sparse, DEFAULT_GOALS, from, to, { leadInWeeks: 12 });
    // Lead-in weeks exist but are all zero: a real baseline of 0 → ratio undefined.
    expect(report.weeks[0]!.typicalEffort).toBe(0);
    expect(report.weeks[0]!.effortRatio).toBeUndefined();
  });
});

describe("goals in force at the time", () => {
  const schedule = {
    periods: [
      { from: "2022-02-07", targets: [{ activityType: "strength", sessions: 3 }], goodWeekSessions: 4, veryGoodWeekSessions: 5, veryGoodWeekMinimums: [{ activityType: "strength", sessions: 2 }] },
      { from: "2026-03-09", ...DEFAULT_GOALS },
    ],
  };
  it("judges a week by the period it falls in, and the week before the first period by the first", () => {
    const strengthOnly = [w("2026-03-02T07:00:00Z", "strength"), w("2026-03-04T07:00:00Z", "strength"), w("2026-03-06T07:00:00Z", "strength")];
    const earlier = reviewWeeks(strengthOnly, schedule, new Date("2026-03-02T00:00:00Z"), new Date("2026-03-09T00:00:00Z"));
    expect(earlier.current!.verdict).toBe("perfect"); // three strength sessions was every target in force then
    expect(earlier.current!.targets.map((t) => t.activityType)).toEqual(["strength"]);
    expect(earlier.current!.goodWeekSessions).toBe(4);
    const later = reviewWeeks(strengthOnly.map((x) => ({ ...x, startedAt: x.startedAt.replace("2026-03-0", "2026-03-1") })), schedule, new Date("2026-03-09T00:00:00Z"), new Date("2026-03-16T00:00:00Z"));
    expect(later.current!.verdict).toBe("short"); // the current goals want BJJ and Capoeira too
    expect(later.spec.targets).toHaveLength(3);
    const before = reviewWeeks([], schedule, new Date("2021-06-07T00:00:00Z"), new Date("2021-06-14T00:00:00Z"));
    expect(before.current!.goodWeekSessions).toBe(4);
  });
  it("leaves excluded activities out of the totals, so a week of auto-detected walks is not good by count", () => {
    const walksOnly = { targets: [{ activityType: "strength", sessions: 3 }], goodWeekSessions: 4, veryGoodWeekSessions: 5, veryGoodWeekMinimums: [], excludeFromCount: ["walking"] };
    const week = [...Array.from({ length: 20 }, (_, i) => w(`2026-03-${String(9 + (i % 7)).padStart(2, "0")}T${String(8 + Math.floor(i / 7)).padStart(2, "0")}:00:00Z`, "walking")), w("2026-03-10T19:00:00Z", "strength")];
    const report = reviewWeeks(week, walksOnly, from, to);
    expect(report.current!.totalSessions).toBe(1);
    expect(report.current!.verdict).toBe("short");
  });

  it("never calls a week with no targets perfect", () => {
    const none = { targets: [], goodWeekSessions: 3, veryGoodWeekSessions: 5, veryGoodWeekMinimums: [] };
    const report = reviewWeeks([w("2026-03-09T07:00:00Z", "walking"), w("2026-03-10T07:00:00Z", "walking"), w("2026-03-11T07:00:00Z", "cycling")], none, from, to);
    expect(report.current!.verdict).toBe("good");
  });
});
