import { describe, expect, it } from "vitest";
import { escapeText, foldLine, formatUtc, renderCalendar } from "../src/domain/calendar.js";
import { activityColor, activityEmoji } from "../src/domain/activityType.js";
import type { Workout } from "../src/domain/workout.js";

const workout: Workout = {
  id: "abc123",
  activityType: "running",
  startedAt: "2026-03-14T07:00:00.000Z",
  endedAt: "2026-03-14T07:45:30.000Z",
  durationSeconds: 2730,
  distanceMeters: 8200,
  activeEnergyKcal: 512,
  averageHeartRate: 148,
  maxHeartRate: 176,
  effort: 79.2,
  effortModel: "trimp",
  source: "health-export",
  sourceName: "Apple Watch",
  recordedAt: "2026-03-14T08:00:00.000Z",
};

const render = (ws: Workout[]) => renderCalendar(ws, { now: new Date("2026-03-15T12:00:00Z") });
/** Unfold before asserting on content: folding may split a value mid-word. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("formatUtc", () => {
  it("emits the compact UTC form calendars expect", () => {
    expect(formatUtc(new Date("2026-03-14T07:00:00.000Z"))).toBe("20260314T070000Z");
  });
});

describe("escapeText", () => {
  it("escapes the characters that are structural in RFC 5545", () => {
    expect(escapeText("a,b;c\\d")).toBe("a\\,b\;c\\\\d");
  });

  it("turns real newlines into the literal escape", () => {
    expect(escapeText("one\ntwo")).toBe("one\\ntwo");
    expect(escapeText("one\r\ntwo")).toBe("one\\ntwo");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeText("Running 8.2 km")).toBe("Running 8.2 km");
  });
});

describe("foldLine", () => {
  it("leaves a short line untouched", () => {
    expect(foldLine("SUMMARY:Running")).toBe("SUMMARY:Running");
  });

  it("folds at 75 octets, continuing with a single space", () => {
    const folded = foldLine("DESCRIPTION:" + "x".repeat(200));
    for (const segment of folded.split("\r\n")) {
      expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(75);
    }
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
  });

  it("round-trips: unfolding restores the original", () => {
    const original = "DESCRIPTION:" + "abcde ".repeat(40);
    expect(foldLine(original).replace(/\r\n /g, "")).toBe(original);
  });

  it("never splits a multi-byte character across a fold", () => {
    // Each emoji is 4 octets; a naive character-count fold would break one in half.
    const folded = foldLine("SUMMARY:" + "🏃".repeat(40));
    for (const segment of folded.split("\r\n")) {
      const bytes = new TextEncoder().encode(segment);
      expect(bytes.length).toBeLessThanOrEqual(75);
      // A broken sequence would not survive a decode/encode round trip.
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBeTypeOf("string");
    }
    expect(folded.replace(/\r\n /g, "")).toBe("SUMMARY:" + "🏃".repeat(40));
  });
});

describe("renderCalendar", () => {
  it("produces a well-formed, correctly terminated calendar", () => {
    const ics = render([workout]);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    // Every line must be CRLF-terminated, not bare LF.
    expect(ics.split("\r\n").join("")).not.toContain("\n");
  });

  it("is valid with no workouts at all", () => {
    const ics = render([]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("pairs every BEGIN with an END", () => {
    const ics = render([workout, { ...workout, id: "def456" }]);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(2);
  });

  it("uses the workout's derived id for the UID, so a refetch updates in place", () => {
    expect(unfold(render([workout]))).toContain("UID:abc123@workout-tracker");
  });

  it("sets start and end from the workout", () => {
    const ics = unfold(render([workout]));
    expect(ics).toContain("DTSTART:20260314T070000Z");
    expect(ics).toContain("DTEND:20260314T074530Z");
  });

  it("summarises the workout readably", () => {
    expect(unfold(render([workout]))).toContain("SUMMARY:🏃 Running · 46m · 8.2 km");
  });

  it("omits distance from the summary when there is none", () => {
    const strength = { ...workout, activityType: "strength", distanceMeters: undefined };
    expect(unfold(render([strength]))).toContain("SUMMARY:🏋️ Strength Training · 46m");
  });

  it("marks events free so a past workout does not block availability", () => {
    const ics = render([workout]);
    expect(ics).toContain("TRANSP:TRANSPARENT");
    expect(ics).toContain("X-MICROSOFT-CDO-BUSYSTATUS:FREE");
  });

  it("puts the detail in the description, with newlines escaped", () => {
    const ics = unfold(render([workout]));
    expect(ics).toContain("Distance: 8.2 km");
    expect(ics).toContain("Avg heart rate: 148 bpm");
    expect(ics).toMatch(/DESCRIPTION:[^\r\n]*\\n/);
  });

  it("flags an estimated effort rather than letting it read as measured", () => {
    const estimated = { ...workout, effortModel: "met-minutes" as const, averageHeartRate: undefined };
    expect(unfold(render([estimated]))).toContain("estimated — no heart rate");
    expect(unfold(render([workout]))).not.toContain("estimated");
  });

  it("escapes a source name containing a comma", () => {
    const ics = unfold(render([{ ...workout, sourceName: "Watch, Series 9" }]));
    expect(ics).toContain("Watch\\, Series 9");
  });

  it("tells clients how often to refresh, in both spellings", () => {
    const ics = render([workout]);
    expect(ics).toContain("X-PUBLISHED-TTL:PT60M");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT60M");
  });

  it("names the calendar", () => {
    expect(renderCalendar([], { name: "Training" })).toContain("X-WR-CALNAME:Training");
  });
});

describe("emoji and colour", () => {
  it("prefixes the summary with the activity's glyph by default", () => {
    expect(unfold(render([workout]))).toMatch(/SUMMARY:🏃 Running/);
  });

  it("can be turned off", () => {
    const ics = unfold(renderCalendar([workout], { emoji: false, now: new Date("2026-03-15T12:00:00Z") }));
    expect(ics).toContain("SUMMARY:Running ·");
    expect(ics).not.toContain("🏃");
  });

  it("uses the personal override's glyph, not the Apple activity's", () => {
    const capoeira = { ...workout, activityType: "taichi" };
    expect(unfold(render([capoeira]))).toContain("SUMMARY:🤸 Capoeira");
    const bjj = { ...workout, activityType: "martialarts" };
    expect(unfold(render([bjj]))).toContain("SUMMARY:🥋 BJJ");
  });

  it("emits an RFC 7986 COLOR per event", () => {
    expect(render([workout])).toContain("COLOR:dodgerblue");
  });

  it("still folds correctly once a multi-byte glyph is in the summary", () => {
    // A long activity name plus an emoji is exactly where octet-vs-character folding breaks.
    const long = { ...workout, activityType: "underwaterdiving", sourceName: "Apple Watch Ultra 2" };
    const ics = render([long]);
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(ics)).toContain("🤿 Underwater Diving");
  });

  it("gives every known activity a distinct-enough glyph and a colour", () => {
    for (const slug of ["running", "cycling", "swimming", "strength", "taichi", "martialarts", "mystery"]) {
      expect(activityEmoji(slug), slug).toBeTruthy();
      expect(activityColor(slug), slug).toBeTruthy();
    }
    // An unknown activity falls back rather than rendering empty.
    expect(activityEmoji("mystery")).toBe(activityEmoji("other"));
  });
});
