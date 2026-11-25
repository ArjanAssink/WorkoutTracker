import { describe, expect, it } from "vitest";
import { MAX_TAGS, normaliseTags, parseTagUpdate, TagError } from "../src/domain/tags.js";

const id = "0123456789abcdef0123456789abcdef";

describe("normaliseTags", () => {
  it("trims, collapses whitespace, lower-cases and drops duplicates in first-seen order", () => {
    expect(normaliseTags(["  Race ", "new   shoes", "race", "", "New Shoes"])).toEqual(["race", "new shoes"]);
  });

  it("refuses too many, too long, or not strings", () => {
    expect(() => normaliseTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`))).toThrow(TagError);
    expect(() => normaliseTags(["x".repeat(33)])).toThrow(TagError);
    expect(() => normaliseTags([1])).toThrow(TagError);
    expect(() => normaliseTags("race")).toThrow(TagError);
  });
});

describe("parseTagUpdate", () => {
  it("reads id, start and tags", () => {
    expect(parseTagUpdate({ id, startedAt: "2026-03-14T07:00:00Z", tags: ["Race"] }))
      .toEqual({ workoutId: id, startedAt: "2026-03-14T07:00:00.000Z", tags: ["race"] });
  });

  it("accepts an empty list, which clears the tags", () => {
    expect(parseTagUpdate({ id, startedAt: "2026-03-14T07:00:00Z", tags: [] }).tags).toEqual([]);
  });

  it("rejects a malformed id or date", () => {
    expect(() => parseTagUpdate({ id: "nope", startedAt: "2026-03-14T07:00:00Z", tags: [] })).toThrow(TagError);
    expect(() => parseTagUpdate({ id, startedAt: "yesterday", tags: [] })).toThrow(TagError);
    expect(() => parseTagUpdate(null)).toThrow(TagError);
  });
});
