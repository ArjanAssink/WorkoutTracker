import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../src/domain/effort.js";
import { DEFAULT_GOALS, reviewWeeks } from "../src/domain/goals.js";
import { composeCheckIn, detectMilestones, type MilestoneContext } from "../src/domain/milestones.js";
import type { Workout } from "../src/domain/workout.js";

let n = 0;
function w(startedAt: string, activityType: string, extra: Partial<Workout> = {}): Workout {
  return {
    id: `w${n++}`, activityType, startedAt, endedAt: startedAt, durationSeconds: 3600,
    effort: 50, effortModel: "trimp", source: "shortcut", recordedAt: startedAt, ...extra,
  };
}

// The week in progress is Mon 9 – Sun 15 March 2026; "now" is Thursday evening.
const WEEK_START = new Date("2026-03-09T00:00:00Z");
const WEEK_END = new Date("2026-03-16T00:00:00Z");
const TZ = "Europe/Amsterdam";

/** A year of prior weeks, each a plain good week (5 sessions, effort 250), unless overridden. */
function priorWeeks(count: number, make = (monday: Date): Workout[] => [
  w(new Date(monday.getTime() + 0 * 86_400_000).toISOString(), "strength"),
  w(new Date(monday.getTime() + 1 * 86_400_000).toISOString(), "martialarts"),
  w(new Date(monday.getTime() + 2 * 86_400_000).toISOString(), "strength"),
  w(new Date(monday.getTime() + 3 * 86_400_000).toISOString(), "martialarts"),
  w(new Date(monday.getTime() + 4 * 86_400_000).toISOString(), "strength"),
]): Workout[] {
  const out: Workout[] = [];
  for (let i = 1; i <= count; i++) out.push(...make(new Date(WEEK_START.getTime() - i * 7 * 86_400_000)));
  return out;
}

function context(thisWeek: Workout[], before: Workout[], arrived = thisWeek): MilestoneContext {
  const history = [...before, ...thisWeek];
  const from = new Date(WEEK_START.getTime() - 52 * 7 * 86_400_000);
  const report = reviewWeeks(history, DEFAULT_GOALS, from, WEEK_END);
  return { spec: DEFAULT_GOALS, profile: DEFAULT_PROFILE, weeks: report.weeks, streakWeeks: report.streakWeeks, history, arrived, timeZone: TZ };
}
const keys = (ctx: MilestoneContext) => detectMilestones(ctx).map((m) => m.key);

describe("detectMilestones", () => {
  const perfect = [
    w("2026-03-09T07:00:00Z", "strength"), w("2026-03-11T07:00:00Z", "strength"), w("2026-03-13T07:00:00Z", "strength"),
    w("2026-03-10T19:00:00Z", "martialarts"), w("2026-03-12T19:00:00Z", "martialarts"), w("2026-03-14T10:00:00Z", "taichi"),
  ];

  it("says nothing about a week that is still short of every target", () => {
    expect(keys(context(perfect.slice(0, 2), []))).toEqual([]);
  });

  it("ticks off each target as it is met, saying what is still open", () => {
    const ms = detectMilestones(context(perfect.slice(0, 3), [])); // three strength sessions, nothing else
    expect(ms.map((m) => m.key)).toEqual(["target:strength"]);
    expect(ms[0]!.text).toContain("Strength Training 3/3");
    expect(ms[0]!.text).toContain("Still open: 2× BJJ, 1× Capoeira.");
  });

  it("a perfect week implies every target checkpoint, so none is repeated", () => {
    const [m] = detectMilestones(context(perfect, []));
    expect(m!.implies).toEqual(expect.arrayContaining(["target:strength", "target:martialarts", "target:taichi"]));
    expect(keys(context(perfect, []))).not.toContain("target:strength");
  });

  it("announces a good week and what a perfect one still needs", () => {
    const five = perfect.filter((x) => x.activityType !== "taichi");
    const ms = detectMilestones(context(five, []));
    expect(ms.map((m) => m.key)).toEqual(["good", "target:strength", "target:martialarts"]);
    const m = ms[0];
    expect(m!.key).toBe("good");
    expect(m!.text).toContain("5 sessions by Friday");
    expect(m!.text).toContain("1× Capoeira");
  });

  it("a perfect week supersedes good, and names the day it was sealed", () => {
    const [m] = detectMilestones(context(perfect, []));
    expect(m!.key).toBe("perfect");
    expect(m!.implies).toContain("good");
    expect(m!.text).toContain("by Saturday");
  });

  it("calls six sessions with the strength floor met a very good week, and says what perfect still needs", () => {
    const six = [...perfect.filter((x) => x.activityType !== "taichi"), w("2026-03-14T10:00:00Z", "running")];
    const ms = detectMilestones(context(six, []));
    expect(ms.map((m) => m.key)).toEqual(["verygood", "target:strength", "target:martialarts"]);
    expect(ms[0]!.implies).toEqual(expect.arrayContaining(["good", "volume"]));
    expect(ms[0]!.text).toContain("1× Capoeira");
  });

  it("calls six sessions without the strength floor good, and names the missing shape", () => {
    const six = [w("2026-03-09T07:00:00Z", "strength"), ...["martialarts", "martialarts", "running", "cycling", "hiking"].map((a, i) => w(`2026-03-1${i}T19:00:00Z`, a))];
    const ks = keys(context(six, []));
    expect(ks).toContain("good");
    expect(ks).toContain("volume");
    expect(detectMilestones(context(six, [])).find((m) => m.key === "volume")!.text).toContain("1× Strength Training missing");
  });

  it("marks streak milestones only at the listed lengths", () => {
    expect(keys(context(perfect, priorWeeks(3)))).toContain("streak:4");
    expect(keys(context(perfect, priorWeeks(4)))).not.toContain("streak:5");
    expect(keys(context(perfect, priorWeeks(7)))).toContain("streak:8");
  });

  it("calls the hardest week in a year, but only with a quarter of history behind it", () => {
    const hard = perfect.map((x) => ({ ...x, effort: 80 })); // 480 vs 250 typical
    expect(keys(context(hard, priorWeeks(12)))).toContain("effort-high");
    expect(keys(context(hard, priorWeeks(11)))).not.toContain("effort-high");
    const easy = perfect.map((x) => ({ ...x, effort: 40 })); // 240 < 250
    expect(keys(context(easy, priorWeeks(12)))).not.toContain("effort-high");
  });

  it("flags a new max heart rate from the workouts that just arrived, within plausibility", () => {
    const before = priorWeeks(2).map((x, i) => ({ ...x, maxHeartRate: i === 0 ? 190 : 170 }));
    const record = w("2026-03-10T19:00:00Z", "martialarts", { maxHeartRate: 194 });
    const glitch = w("2026-03-12T19:00:00Z", "martialarts", { maxHeartRate: 240 });
    const ks = keys(context([record, glitch], before, [record, glitch]));
    expect(ks).toContain("max-hr:194");
    expect(ks).not.toContain("max-hr:240");
    expect(detectMilestones(context([record], before, [record])).find((m) => m.key === "max-hr:194")!.text).toContain("previous 190");
  });

  it("does not credit a record to a workout that was already stored", () => {
    const before = priorWeeks(2).map((x) => ({ ...x, maxHeartRate: 170 }));
    const record = w("2026-03-10T19:00:00Z", "martialarts", { maxHeartRate: 194 });
    expect(keys(context([record], before, []))).not.toContain("max-hr:194");
  });

  it("flags the longest session of a target activity after enough history", () => {
    const long = w("2026-03-10T19:00:00Z", "martialarts", { durationSeconds: 7200 });
    expect(keys(context([long], priorWeeks(3), [long]))).toContain("longest:martialarts"); // 6 prior BJJ sessions
    expect(keys(context([long], priorWeeks(2), [long]))).not.toContain("longest:martialarts"); // only 4
    const run = w("2026-03-10T19:00:00Z", "running", { durationSeconds: 7200 });
    expect(keys(context([run], priorWeeks(3), [run]))).not.toContain("longest:running"); // not a target
  });
});

describe("composeCheckIn", () => {
  const thursday = new Date("2026-03-12T17:00:00Z");
  const review = (thisWeek: Workout[]) => reviewWeeks(thisWeek, DEFAULT_GOALS, WEEK_START, WEEK_END).current!;

  it("says what a good and a perfect week still need, and how many days are left", () => {
    const text = composeCheckIn(review([w("2026-03-09T07:00:00Z", "strength"), w("2026-03-10T19:00:00Z", "martialarts")]), DEFAULT_GOALS, thursday, TZ, 5)!;
    expect(text).toContain("Thursday check-in");
    expect(text).toContain("2 sessions so far (a typical week ends on 5) — 3 more for a good week, 3 days left.");
    expect(text).toContain("For a perfect week: 2× Strength Training, 1× BJJ, 1× Capoeira to go.");
  });

  it("tells a good-but-not-perfect week what is missing", () => {
    const five = ["strength", "strength", "strength", "martialarts", "martialarts"].map((a, i) => w(`2026-03-${String(9 + i).padStart(2, "0")}T07:00:00Z`, a));
    const text = composeCheckIn(review(five), DEFAULT_GOALS, thursday, TZ)!;
    expect(text).toContain("good week locked in");
    const surplus = composeCheckIn(review([...five, w("2026-03-14T07:00:00Z", "taichi"), w("2026-03-15T07:00:00Z", "taichi")]), DEFAULT_GOALS, thursday, TZ);
    expect(surplus).toBeUndefined(); // that is a perfect week
    expect(text).toContain("1× Capoeira to go");
  });

  it("counts the days left after today, through Sunday", () => {
    const text = composeCheckIn(review([]), DEFAULT_GOALS, new Date("2026-03-14T17:00:00Z"), TZ)!; // Saturday
    expect(text).toContain("5 more for a good week, 1 day left");
  });

  it("has nothing to say once the week is perfect", () => {
    const perfect = ["strength", "strength", "strength", "martialarts", "martialarts", "taichi"].map((a, i) => w(`2026-03-${String(9 + i).padStart(2, "0")}T07:00:00Z`, a));
    expect(composeCheckIn(review(perfect), DEFAULT_GOALS, thursday, TZ)).toBeUndefined();
  });
});
