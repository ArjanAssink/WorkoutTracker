import { describe, expect, it } from "vitest";
import { DEFAULT_GOALS, reviewWeeks } from "../src/domain/goals.js";
import { composeWeeklySummary, effortLine, escape } from "../src/domain/weeklySummary.js";
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

  it("names what was missed on a good week", () => {
    const good = [...perfect.filter((x) => x.activityType !== "martialarts"), w("2026-03-10T19:00:00Z", "martialarts"), w("2026-03-12T07:00:00Z", "running")];
    const text = compose(good);
    expect(text).toContain("✅ <b>Week of 9–15 Mar — GOOD</b>");
    expect(text).toContain("missed BJJ (1/2)");
    expect(text).toContain("<i>+ Running</i>");
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
