import { describe, expect, it } from "vitest";
import { notificationId, plainText, presentNotification, titleOf, toSpans } from "../src/domain/notifications.js";

describe("toSpans", () => {
  it("turns Telegram's HTML subset into styled runs", () => {
    expect(toSpans("🏆 <b>Perfect week</b>\nAll <i>three</i> targets.")).toEqual([
      { text: "🏆 " },
      { text: "Perfect week", bold: true },
      { text: "\nAll " },
      { text: "three", italic: true },
      { text: " targets." },
    ]);
  });

  it("decodes entities the composers escaped", () => {
    expect(plainText(toSpans("Run &amp; Ride &lt;3 &#x1F3C3; &#39;x&#39;"))).toBe("Run & Ride <3 🏃 'x'");
  });

  it("keeps a code block's line breaks", () => {
    expect(toSpans("<code>Run   2/2\nBJJ   1/2</code>")).toEqual([{ text: "Run   2/2\nBJJ   1/2", code: true }]);
  });

  it("nests styles and keeps only http(s) links", () => {
    expect(toSpans('<b>a <i>b</i></b> <a href="https://example.com/?a=1&amp;b=2">c</a> <a href="javascript:alert(1)">d</a>')).toEqual([
      { text: "a ", bold: true },
      { text: "b", bold: true, italic: true },
      { text: " " },
      { text: "c", href: "https://example.com/?a=1&b=2" },
      { text: " d" },
    ]);
  });

  it("drops unknown tags but keeps their text, and survives unbalanced markup", () => {
    expect(plainText(toSpans("<tg-spoiler>hidden</tg-spoiler> <b>open"))).toBe("hidden open");
    expect(toSpans("x</b>y")).toEqual([{ text: "xy" }]);
  });
});

describe("titleOf", () => {
  it("is the first non-empty line, as plain text", () => {
    expect(titleOf("\n📊 <b>Week of 16 Nov</b>: good week\nmore")).toBe("📊 Week of 16 Nov: good week");
  });

  it("is bounded", () => {
    expect(titleOf("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("notificationId", () => {
  it("sorts newest first as a string", () => {
    const older = notificationId(new Date("2026-11-23T09:00:00Z"), "a");
    const newer = notificationId(new Date("2026-11-24T09:00:00Z"), "a");
    expect(newer < older).toBe(true);
    expect(older).toMatch(/^\d{13}-a$/);
  });
});

describe("presentNotification", () => {
  it("adds spans and plain text beside the stored HTML", () => {
    const out = presentNotification({ id: "1", kind: "checkin", title: "t", html: "<b>Hi</b> there", createdAt: "2026-11-26T17:00:00Z", link: "/api/dashboard", deliveries: [] });
    expect(out.spans).toEqual([{ text: "Hi", bold: true }, { text: " there" }]);
    expect(out.text).toBe("Hi there");
  });
});
