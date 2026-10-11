import { describe, expect, it } from "vitest";
import { bucketKey, enumeratePeriods, startOfIsoWeek, summarise } from "../src/domain/summary.js";
import type { Workout } from "../src/domain/workout.js";

let counter = 0;
function workout(startedAt: string, overrides: Partial<Workout> = {}): Workout {
  return {
    id: `w${counter++}`,
    activityType: "running",
    startedAt,
    endedAt: startedAt,
    durationSeconds: 1800,
    effort: 50,
    effortModel: "trimp",
    source: "shortcut",
    recordedAt: startedAt,
    ...overrides,
  };
}

const from = new Date("2026-01-01T00:00:00Z");
const to = new Date("2026-04-01T00:00:00Z");

describe("startOfIsoWeek", () => {
  it("returns Monday for a mid-week date", () => {
    // 2026-03-14 is a Saturday.
    expect(startOfIsoWeek(new Date("2026-03-14T12:00:00Z")).toISOString().slice(0, 10)).toBe("2026-03-09");
  });

  it("treats Sunday as the end of its week, not the start of the next", () => {
    expect(startOfIsoWeek(new Date("2026-03-15T12:00:00Z")).toISOString().slice(0, 10)).toBe("2026-03-09");
  });

  it("is idempotent on a Monday", () => {
    const monday = new Date("2026-03-09T00:00:00Z");
    expect(startOfIsoWeek(monday).toISOString()).toBe(monday.toISOString());
  });
});

describe("bucketKey", () => {
  const date = new Date("2026-03-14T12:00:00Z");
  it("formats each granularity", () => {
    expect(bucketKey(date, "day")).toBe("2026-03-14");
    expect(bucketKey(date, "week")).toBe("2026-03-09");
    expect(bucketKey(date, "month")).toBe("2026-03");
    expect(bucketKey(date, "year")).toBe("2026");
  });
});

describe("summarise", () => {
  it("returns zeroed buckets, not an empty series, when nothing was logged", () => {
    const summary = summarise([], "week", from, to);
    expect(summary.totals.workouts).toBe(0);
    expect(summary.longestStreakDays).toBe(0);
    // The range still happened; it was just all rest. A chart needs the empty weeks.
    expect(summary.buckets.length).toBeGreaterThan(0);
    expect(summary.buckets.every((b) => b.workouts === 0 && b.effort === 0)).toBe(true);
  });

  it("totals duration, distance, energy and effort", () => {
    const summary = summarise(
      [
        workout("2026-03-02T07:00:00Z", { distanceMeters: 8000, activeEnergyKcal: 500, effort: 60 }),
        workout("2026-03-03T07:00:00Z", { distanceMeters: 5000, activeEnergyKcal: 300, effort: 40 }),
      ],
      "week",
      from,
      to,
    );
    expect(summary.totals.workouts).toBe(2);
    expect(summary.totals.durationSeconds).toBe(3600);
    expect(summary.totals.distanceMeters).toBe(13000);
    expect(summary.totals.activeEnergyKcal).toBe(800);
    expect(summary.totals.effort).toBe(100);
  });

  it("groups two workouts in the same ISO week into one bucket", () => {
    const summary = summarise(
      [workout("2026-03-09T07:00:00Z"), workout("2026-03-15T20:00:00Z")],
      "week",
      from,
      to,
    );
    const week = summary.buckets.filter((b) => b.workouts > 0);
    expect(week).toHaveLength(1);
    expect(week[0]!.period).toBe("2026-03-09");
    expect(week[0]!.workouts).toBe(2);
  });

  it("emits a bucket for every period in the range, including rest periods", () => {
    const summary = summarise([workout("2026-03-10T07:00:00Z")], "month", from, to);
    // Jan, Feb, Mar — March has the workout, the other two are real zeroes.
    expect(summary.buckets.map((b) => b.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(summary.buckets.map((b) => b.workouts)).toEqual([0, 0, 1]);
  });

  it("keeps the series dense so an average over buckets is per period, not per active period", () => {
    // Two workouts in a 3-month range: the mean must be 1/3 per month, not 1 per month.
    const summary = summarise(
      [workout("2026-01-05T07:00:00Z"), workout("2026-03-10T07:00:00Z")],
      "month",
      from,
      to,
    );
    const mean = summary.buckets.reduce((s, b) => s + b.workouts, 0) / summary.buckets.length;
    expect(mean).toBeCloseTo(2 / 3, 6);
  });

  it("still counts a workout that falls outside the enumerated range", () => {
    const summary = summarise([workout("2025-12-20T07:00:00Z")], "month", from, to);
    expect(summary.totals.workouts).toBe(1);
    expect(summary.buckets.find((b) => b.period === "2025-12")?.workouts).toBe(1);
  });

  it("counts active days, not workouts, so a double session is still one day", () => {
    const summary = summarise(
      [workout("2026-03-10T07:00:00Z"), workout("2026-03-10T19:00:00Z")],
      "week",
      from,
      to,
    );
    expect(summary.totals.workouts).toBe(2);
    expect(summary.totals.activeDays).toBe(1);
    expect(summary.buckets.find((b) => b.period === "2026-03-09")!.activeDays).toBe(1);
  });

  it("returns buckets in chronological order regardless of input order", () => {
    const summary = summarise(
      [workout("2026-03-10T07:00:00Z"), workout("2026-01-05T07:00:00Z"), workout("2026-02-02T07:00:00Z")],
      "month",
      from,
      to,
    );
    expect(summary.buckets.map((b) => b.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("breaks down by activity, most-trained first", () => {
    const summary = summarise(
      [
        workout("2026-03-02T07:00:00Z", { activityType: "running", durationSeconds: 1800 }),
        workout("2026-03-03T07:00:00Z", { activityType: "cycling", durationSeconds: 5400 }),
        workout("2026-03-04T07:00:00Z", { activityType: "running", durationSeconds: 1800 }),
      ],
      "week",
      from,
      to,
    );
    expect(summary.byActivity.map((a) => a.activityType)).toEqual(["cycling", "running"]);
    expect(summary.byActivity[1]!.workouts).toBe(2);
    expect(summary.byActivity[0]!.label).toBe("Cycling");
  });

  it("finds the longest run of consecutive days", () => {
    const summary = summarise(
      [
        workout("2026-03-01T07:00:00Z"),
        workout("2026-03-02T07:00:00Z"),
        workout("2026-03-03T07:00:00Z"),
        workout("2026-03-06T07:00:00Z"),
      ],
      "week",
      from,
      to,
    );
    expect(summary.longestStreakDays).toBe(3);
  });

  it("reports a streak of one when no two days adjoin", () => {
    const summary = summarise([workout("2026-03-01T07:00:00Z"), workout("2026-03-05T07:00:00Z")], "week", from, to);
    expect(summary.longestStreakDays).toBe(1);
  });

  it("spans a month boundary when counting a streak", () => {
    const summary = summarise(
      [workout("2026-01-31T07:00:00Z"), workout("2026-02-01T07:00:00Z"), workout("2026-02-02T07:00:00Z")],
      "month",
      from,
      to,
    );
    expect(summary.longestStreakDays).toBe(3);
  });

  it("treats a missing distance as zero rather than NaN", () => {
    const summary = summarise([workout("2026-03-02T07:00:00Z")], "week", from, to);
    expect(summary.totals.distanceMeters).toBe(0);
  });
});

describe("enumeratePeriods", () => {
  it("covers each day in the range, excluding the exclusive end", () => {
    const days = enumeratePeriods(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-04T00:00:00Z"), "day");
    expect(days).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("starts from the ISO week containing a mid-week 'from'", () => {
    // 2026-03-11 is a Wednesday; its week begins Monday the 9th.
    const weeks = enumeratePeriods(new Date("2026-03-11T00:00:00Z"), new Date("2026-03-25T00:00:00Z"), "week");
    expect(weeks).toEqual(["2026-03-09", "2026-03-16", "2026-03-23"]);
  });

  it("crosses a year boundary by month", () => {
    const months = enumeratePeriods(new Date("2025-11-20T00:00:00Z"), new Date("2026-02-01T00:00:00Z"), "month");
    expect(months).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("steps across a leap day without repeating or skipping", () => {
    const days = enumeratePeriods(new Date("2028-02-27T00:00:00Z"), new Date("2028-03-02T00:00:00Z"), "day");
    expect(days).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("returns nothing for an inverted or empty range rather than looping", () => {
    expect(enumeratePeriods(new Date("2026-03-04T00:00:00Z"), new Date("2026-03-01T00:00:00Z"), "day")).toEqual([]);
    expect(enumeratePeriods(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"), "day")).toEqual([]);
  });

  it("yields a year per calendar year", () => {
    expect(enumeratePeriods(new Date("2024-06-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"), "year"))
      .toEqual(["2024", "2025", "2026"]);
  });
});

describe("per-bucket activity breakdown", () => {
  it("splits a period by activity", () => {
    const summary = summarise(
      [
        workout("2026-03-10T07:00:00Z", { activityType: "strength", durationSeconds: 3600, effort: 60 }),
        workout("2026-03-10T19:00:00Z", { activityType: "running", durationSeconds: 1800, effort: 40 }),
        workout("2026-03-12T07:00:00Z", { activityType: "strength", durationSeconds: 1800, effort: 30 }),
      ],
      "month",
      from,
      to,
    );
    const march = summary.buckets.find((b) => b.period === "2026-03")!;
    expect(Object.keys(march.byActivity).sort()).toEqual(["running", "strength"]);
    expect(march.byActivity["strength"]!.workouts).toBe(2);
    expect(march.byActivity["strength"]!.durationSeconds).toBe(5400);
    expect(march.byActivity["running"]!.workouts).toBe(1);
  });

  it("keeps the split consistent with the bucket total — a stack must sum to its bar", () => {
    const summary = summarise(
      [
        workout("2026-02-02T07:00:00Z", { activityType: "cycling", durationSeconds: 3600, effort: 70 }),
        workout("2026-02-03T07:00:00Z", { activityType: "yoga", durationSeconds: 1800, effort: 12 }),
        workout("2026-02-04T07:00:00Z", { activityType: "cycling", durationSeconds: 900, effort: 18 }),
      ],
      "month",
      from,
      to,
    );
    for (const bucket of summary.buckets) {
      const parts = Object.values(bucket.byActivity);
      expect(parts.reduce((s, p) => s + p.workouts, 0)).toBe(bucket.workouts);
      expect(parts.reduce((s, p) => s + p.durationSeconds, 0)).toBe(bucket.durationSeconds);
      expect(parts.reduce((s, p) => s + p.effort, 0)).toBeCloseTo(bucket.effort, 5);
    }
  });

  it("gives an empty split for a rest period rather than omitting the key", () => {
    const summary = summarise([workout("2026-03-10T07:00:00Z")], "month", from, to);
    const january = summary.buckets.find((b) => b.period === "2026-01")!;
    expect(january.byActivity).toEqual({});
  });

  it("agrees with the top-level byActivity totals", () => {
    const summary = summarise(
      [
        workout("2026-01-05T07:00:00Z", { activityType: "running", durationSeconds: 1800 }),
        workout("2026-02-05T07:00:00Z", { activityType: "running", durationSeconds: 2400 }),
        workout("2026-03-05T07:00:00Z", { activityType: "strength", durationSeconds: 3600 }),
      ],
      "month",
      from,
      to,
    );
    for (const activity of summary.byActivity) {
      const summed = summary.buckets.reduce(
        (total, b) => total + (b.byActivity[activity.activityType]?.durationSeconds ?? 0),
        0,
      );
      expect(summed, activity.activityType).toBe(activity.durationSeconds);
    }
  });
});

describe("peak heart rate", () => {
  it("picks the highest max in the range and says which workout it was", () => {
    const summary = summarise(
      [
        workout("2026-02-02T07:00:00Z", { activityType: "running", maxHeartRate: 171 }),
        workout("2026-03-05T07:00:00Z", { activityType: "martialarts", maxHeartRate: 183 }),
        workout("2026-03-09T07:00:00Z", { activityType: "cycling", maxHeartRate: 160 }),
      ],
      "month", from, to,
    );
    expect(summary.peakHeartRate).toMatchObject({ bpm: 183, activityType: "martialarts", label: "BJJ", startedAt: "2026-03-05T07:00:00Z" });
  });

  it("ignores workouts with no recorded max", () => {
    const summary = summarise([workout("2026-03-05T07:00:00Z"), workout("2026-03-06T07:00:00Z", { maxHeartRate: 150 })], "month", from, to);
    expect(summary.peakHeartRate!.bpm).toBe(150);
  });

  it("is null when nothing recorded a max", () => {
    expect(summarise([workout("2026-03-05T07:00:00Z")], "month", from, to).peakHeartRate).toBeNull();
  });
});
