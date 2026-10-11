import { describe, expect, it } from "vitest";
import { RangeError_, resolveRange } from "../src/http/dateRange.js";
import { monthsBetween, partitionKey, rowKey } from "../src/storage/workoutRepository.js";

const now = new Date("2026-04-01T12:00:00Z");
const params = (q: string) => new URLSearchParams(q);

describe("resolveRange", () => {
  it("defaults to the last 90 days", () => {
    const range = resolveRange(params(""), now);
    expect(range.to.toISOString()).toBe(now.toISOString());
    expect((range.to.getTime() - range.from.getTime()) / 86_400_000).toBe(90);
  });

  it("honours an explicit day count", () => {
    const range = resolveRange(params("days=7"), now);
    expect((range.to.getTime() - range.from.getTime()) / 86_400_000).toBe(7);
  });

  it("reads a bare date as UTC midnight", () => {
    expect(resolveRange(params("from=2026-01-01&to=2026-02-01"), now).from.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("lets 'from' win over 'days'", () => {
    const range = resolveRange(params("from=2026-03-01&days=7"), now);
    expect(range.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("rejects an inverted range", () => {
    expect(() => resolveRange(params("from=2026-04-01&to=2026-01-01"), now)).toThrow(RangeError_);
  });

  it("rejects a non-positive day count", () => {
    expect(() => resolveRange(params("days=0"), now)).toThrow(RangeError_);
    expect(() => resolveRange(params("days=-5"), now)).toThrow(RangeError_);
    expect(() => resolveRange(params("days=soon"), now)).toThrow(RangeError_);
  });

  it("rejects an unparseable date", () => {
    expect(() => resolveRange(params("from=yesterday"), now)).toThrow(RangeError_);
  });

  it("caps the span so one request cannot scan the whole table", () => {
    expect(() => resolveRange(params("days=99999"), now)).toThrow(RangeError_);
  });
});

describe("table keys", () => {
  it("partitions by owner and month", () => {
    expect(partitionKey("me", "2026-03-14T07:00:00.000Z")).toBe("me|2026-03");
  });

  it("builds RowKeys that sort chronologically", () => {
    const early = rowKey("2026-03-02T07:00:00.000Z", "aaa");
    const late = rowKey("2026-03-14T07:00:00.000Z", "aaa");
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("separates two workouts that started in the same second", () => {
    expect(rowKey("2026-03-14T07:00:00.000Z", "aaa")).not.toBe(rowKey("2026-03-14T07:00:00.000Z", "bbb"));
  });
});

describe("monthsBetween", () => {
  it("includes both endpoints", () => {
    expect(monthsBetween(new Date("2026-01-15T00:00:00Z"), new Date("2026-04-02T00:00:00Z"))).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
  });

  it("returns a single month when the range stays inside one", () => {
    expect(monthsBetween(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-31T00:00:00Z"))).toEqual(["2026-03"]);
  });

  it("crosses a year boundary", () => {
    expect(monthsBetween(new Date("2025-11-20T00:00:00Z"), new Date("2026-01-05T00:00:00Z"))).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });
});
