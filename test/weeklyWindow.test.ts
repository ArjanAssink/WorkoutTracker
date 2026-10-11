import { describe, expect, it } from "vitest";
import { resolveWindow } from "../src/functions/getWeekly.js";

// Monday 2026-10-12 at 10:00 — exactly when a Monday-morning summary would run.
const monday = new Date("2026-10-12T10:00:00Z");

describe("resolveWindow", () => {
  it("defaults to the last complete week, not the one that just started", () => {
    const { from, to } = resolveWindow(null, 1, monday);
    expect(from!.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("gives twelve aligned weeks by default", () => {
    const { from, to } = resolveWindow(null, 12, monday);
    expect((to.getTime() - from!.getTime()) / (7 * 86_400_000)).toBe(12);
    expect(from!.getUTCDay()).toBe(1); // Monday
  });

  it("includes the in-progress week with until=today", () => {
    const { to } = resolveWindow("today", 1, monday);
    expect(to.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });

  it("anchors on an explicit date's week", () => {
    const { from, to } = resolveWindow("2026-09-16", 1, monday); // a Wednesday
    expect(from!.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("behaves the same mid-week as on Monday", () => {
    const thursday = new Date("2026-10-15T15:00:00Z");
    expect(resolveWindow(null, 1, thursday).to.toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("rejects an unparseable date", () => {
    expect(resolveWindow("someday", 1, monday).from).toBeUndefined();
  });
});
