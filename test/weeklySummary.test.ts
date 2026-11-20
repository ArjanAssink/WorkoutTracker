import { describe, expect, it } from "vitest";
import { DEFAULT_GOALS, reviewWeeks } from "../src/domain/goals.js";
import { composeWeeklySummary, effortLine, escape, restContextLines } from "../src/domain/weeklySummary.js";
import type { Workout } from "../src/domain/workout.js";

let n = 0;
function w(startedAt: string, activityType: string, durationSeconds = 3600): Workout {
  return {
    id: `w${n++}`, activityType, startedAt, endedAt: startedAt, durationSeconds,
    effort: 50, effortModel: "trimp", source: "shortcut", recordedAt: startedAt,
  };
}
const from = new Date("2026-02-02T00:00:00Z");
const to = new Date("2026-03-16T00:00:00Z"); // current week: Mar 9–15

const perfect = [
  w("2026-03-09T07:00:00Z", "strength"), w("2026-03-11T07:00:00Z", "strength"), w("2026-03-13T07:00:00Z", "strength"),
  w("2026-03-10T19:00:00Z", "martialarts"), w("2026-03-12T19:00:00Z", "martialarts"),
  w("2026-03-14T10:00:00Z", "taichi"),
];
const compose = (ws: Workout[]) => composeWeeklySummary(reviewWeeks(ws, DEFAULT_GOALS, from, to));

describe("composeWeeklySummary", () => {
  it("leads with the week and the verdict", () => {
    expect(compose(perfect)).toMatch(/^🏆 <b>Week of 9–15 Mar — PERFECT<\/b>/);
  });

  it("uses the corrected activity names, not Apple's", () => {
    const text = compose(perfect);
    expect(text).toContain("BJJ");
    expect(text).toContain("Capoeira");
    expect(text).not.toMatch(/Tai Chi|Martial Arts/);
  });

  it("shows each target with dots and a count", () => {
    const text = compose(perfect);
    expect(text).toMatch(/Strength Training\s+●●● 3\/3 ✓/);
    expect(text).toMatch(/BJJ\s+●●\s+2\/2 ✓/);
    expect(text).toMatch(/Capoeira\s+●\s+1\/1 ✓/);
  });

  it("names what was missed on a very good week", () => {
    const veryGood = [...perfect.filter((x) => x.activityType !== "martialarts"), w("2026-03-10T19:00:00Z", "martialarts"), w("2026-03-12T07:00:00Z", "running")];
    const text = compose(veryGood);
    expect(text).toContain("⭐ <b>Week of 9–15 Mar — VERY GOOD</b>");
    expect(text).toContain("missed BJJ (1/2)");
    expect(text).toContain("<i>+ Running</i>");
  });

  it("tells a good week what very good would have taken", () => {
    const good = [w("2026-03-09T07:00:00Z", "strength"), ...["martialarts", "running", "cycling", "hiking"].map((a, i) => w(`2026-03-1${i}T19:00:00Z`, a))];
    const text = compose(good);
    expect(text).toContain("✅ <b>Week of 9–15 Mar — GOOD</b>");
    expect(text).toContain("Very good needed 1 more session and 2× Strength Training.");
  });

  it("says how far short a short week fell", () => {
    const text = compose(perfect.slice(0, 3)); // strength only
    expect(text).toContain("⚠️ <b>Week of 9–15 Mar — SHORT</b>");
    expect(text).toContain("Short by 2 sessions of a good week");
    expect(text).toContain("Missed BJJ (0/2), Capoeira (0/1)");
  });

  it("compares against the typical week when there is history", () => {
    const history = [...perfect, w("2026-03-02T07:00:00Z", "strength"), w("2026-02-23T07:00:00Z", "strength")];
    expect(compose(history)).toMatch(/6 sessions \(typical \d\)/);
  });

  it("shows surplus sessions beyond a target", () => {
    expect(compose([...perfect, w("2026-03-15T07:00:00Z", "strength")])).toMatch(/4\/3 \+1/);
  });

  it("renders the recent-weeks strip", () => {
    const text = compose(perfect);
    expect(text).toMatch(/Last \d weeks: <code>[·■▲ ]+<\/code>/);
    expect(text).toContain("1 perfect");
  });

  it("escapes HTML from activity names", () => {
    expect(escape("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("spans a month boundary in the week label", () => {
    const ws = perfect.map((x) => w(new Date(new Date(x.startedAt).getTime() + 21 * 86_400_000).toISOString(), x.activityType));
    const text = composeWeeklySummary(reviewWeeks(ws, DEFAULT_GOALS, from, new Date("2026-04-06T00:00:00Z")));
    expect(text).toContain("Week of 30 Mar – 5 Apr");
  });

  it("has something sensible to say with no completed week", () => {
    expect(composeWeeklySummary(reviewWeeks([], DEFAULT_GOALS, to, to))).toMatch(/No completed week/);
  });
});

describe("effortLine", () => {
  const wk = (effort: number, typicalEffort?: number) =>
    ({ effort, typicalEffort, effortRatio: typicalEffort ? effort / typicalEffort : undefined }) as never;

  it("is just the number without a baseline", () => {
    expect(effortLine(wk(312))).toBe("Effort 312");
  });
  it("calls a small difference in line", () => {
    expect(effortLine(wk(255, 250))).toBe("Effort 255 — in line with your typical week (250)");
  });
  it("names the direction and size of a moderate difference", () => {
    expect(effortLine(wk(300, 250))).toBe("Effort 300 — 20% above your typical week (250)");
    expect(effortLine(wk(200, 250))).toBe("Effort 200 — 20% below your typical week (250)");
  });
  it("calls out a hard or light week past 40%", () => {
    expect(effortLine(wk(400, 250))).toBe("Effort 400 — a hard week, 60% above your typical (250)");
    expect(effortLine(wk(100, 250))).toBe("Effort 100 — a light week, 60% below your typical (250)");
  });
});


describe("rest context", () => {
  const current = reviewWeeks(perfect, DEFAULT_GOALS, from, to).current!;
  const week = (weekStart: string, effort = 100, typicalEffort = 100) => ({ ...current, weekStart, effort, typicalEffort });
  it("reports weeks since a rest label separately from low recorded effort", () => {
    const weeks = [week("2026-02-23"), week("2026-03-02", 50), week("2026-03-09")];
    const lines = restContextLines(current, { weeks, annotations: { "2026-02-23": { label: "Rest week", note: "" } } });
    expect(lines[0]).toContain("Tagged rest: 2 weeks ago");
    expect(lines[1]).toContain("Lower effort: 1 week ago");
    expect(lines[1]).toContain("50% of typical");
  });
  it("recognises deload labels without assuming vacation is rest", () => {
    const weeks = [week("2026-02-23"), week("2026-03-02"), week("2026-03-09")];
    const lines = restContextLines(current, { weeks, annotations: { "2026-02-23": { label: " DELOAD week ", note: "" }, "2026-03-02": { label: "Vacation", note: "" } } });
    expect(lines[0]).toContain("2 weeks ago");
  });
  it("includes the reviewed week and uses the exact 60% threshold", () => {
    expect(restContextLines(current, { weeks: [week(current.weekStart, 60)], annotations: {} })[1]).toContain("the week just reviewed");
    expect(restContextLines(current, { weeks: [week(current.weekStart, 60.1)], annotations: {} })[1]).toContain("No lower-effort week");
  });
  it("ignores unfinished and future weeks", () => {
    const lines = restContextLines(current, { weeks: [week("2026-03-16", 0), week(current.weekStart)], annotations: { "2026-03-16": { label: "Rest week", note: "" } } });
    expect(lines[0]).toContain("No tagged rest week"); expect(lines[1]).toContain("No lower-effort week");
  });
  it("does not fabricate comparisons without a positive baseline", () => {
    const noBaseline = { ...current }; delete noBaseline.typicalEffort;
    expect(restContextLines(current, { weeks: [noBaseline, week("2026-03-02", 0, 0)], annotations: {} })[1]).toContain("not enough history");
  });
  it("counts zero recorded effort as light only when a baseline exists", () => {
    expect(restContextLines(current, { weeks: [week(current.weekStart, 0, 100)], annotations: {} })[1]).toContain("0% of typical");
  });
  it("can find a rest label older than the 12-week message window", () => {
    expect(restContextLines(current, { weeks: [week("2025-09-01"), current], annotations: { "2025-09-01": { label: "Rest", note: "" } } })[0]).toContain("27 weeks ago");
  });
  it("adds the context to the composed message without changing its review", () => {
    const report = reviewWeeks(perfect, DEFAULT_GOALS, from, to);
    const original = composeWeeklySummary(report);
    expect(composeWeeklySummary(report, { weeks: report.weeks, annotations: {} })).toContain(original);
    expect(composeWeeklySummary(report, { weeks: report.weeks, annotations: {} })).toContain("No tagged rest week");
  });
});


it("reviews tagged rest weeks without a shortfall message or target checklist", () => {
  const report = reviewWeeks(perfect.slice(0, 1), DEFAULT_GOALS, from, to);
  const text = composeWeeklySummary(report, { weeks: report.weeks, annotations: { "2026-03-09": { label: "Rest week", note: "Planned <break>" } } });
  expect(text).toContain("REST / RECOVERY"); expect(text).toContain("1 session");
  expect(text).toContain("Recovery was the focus"); expect(text).toContain("Planned &lt;break&gt;");
  expect(text).not.toMatch(/SHORT|Short by|Missed|Last .* weeks:|○/);
});
