import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpRequest, InvocationContext } from "@azure/functions";
import { DEFAULT_GOALS } from "../src/domain/goals.js";
import { parseWeekAnnotation } from "../src/domain/weekAnnotation.js";
const store = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn(), datedRange: vi.fn(), listAll: vi.fn(), get: vi.fn(), sentKeys: vi.fn() }));
vi.mock("../src/functions/shared.js", () => ({ getSettingsRepository: async () => store, getRepository: async () => store, getMilestoneRepository: async () => store }));
vi.mock("../src/config/index.js", () => ({ config: () => ({ ingestApiKey: "test-key", goalSchedule: DEFAULT_GOALS }) }));
import { saveWeekAnnotation } from "../src/functions/weekAnnotation.js";
import { buildSummary } from "../src/functions/notifyWeekly.js";
import { buildCheckIn, evaluateMilestones } from "../src/functions/notifyMilestones.js";
import { getWeekly } from "../src/functions/getWeekly.js";
const context = new InvocationContext();
function request(body: unknown, key = "test-key") {
  return new HttpRequest({ method: "POST", url: "http://localhost/api/weekly/annotation", headers: { "x-api-key": key, "content-type": "application/json" }, body: { string: JSON.stringify(body) } });
}
beforeEach(() => { vi.clearAllMocks(); store.set.mockResolvedValue(undefined); store.delete.mockResolvedValue(undefined); store.datedRange.mockResolvedValue({}); store.listAll.mockResolvedValue([]); store.get.mockResolvedValue(undefined); store.sentKeys.mockResolvedValue(new Set()); });
describe("week annotations", () => {
  it("accepts custom text and trims whitespace", () => {
    expect(parseWeekAnnotation({ weekStart: "2026-10-12", label: " Deload ", note: " Planned break " })).toEqual({ weekStart: "2026-10-12", annotation: { label: "Deload", note: "Planned break" } });
  });
  it.each(["2026-10-13", "2026-02-30", "not-a-date"])("rejects invalid week %s", (weekStart) => {
    expect(() => parseWeekAnnotation({ weekStart, label: "Rest week" })).toThrow();
  });
  it("rejects oversized text and invalid types", () => {
    for (const label of ["x".repeat(61), 42, null]) expect(() => parseWeekAnnotation({ weekStart: "2026-10-12", label })).toThrow();
    expect(() => parseWeekAnnotation({ weekStart: "2026-10-12", label: "Rest", note: "x".repeat(501) })).toThrow();
  });
  it("requires authentication before writing", async () => {
    expect((await saveWeekAnnotation(request({ weekStart: "2026-10-12", label: "Rest" }, "wrong"), context)).status).toBe(401);
    expect(store.set).not.toHaveBeenCalled();
  });
  it("saves one week without overwriting other settings", async () => {
    const result = await saveWeekAnnotation(request({ weekStart: "2026-10-12", label: "Vacation" }), context);
    expect(result.status).toBe(200); expect(store.set).toHaveBeenCalledWith("week.annotation.2026-10-12", { label: "Vacation", note: "" });
  });
  it("removes a label with an empty value", async () => {
    expect((await saveWeekAnnotation(request({ weekStart: "2026-10-12", label: "" }), context)).status).toBe(200);
    expect(store.delete).toHaveBeenCalledWith("week.annotation.2026-10-12");
  });
  it("reports storage failures instead of claiming a save", async () => {
    store.set.mockRejectedValueOnce(new Error("offline"));
    expect((await saveWeekAnnotation(request({ weekStart: "2026-10-12", label: "Rest" }), context)).status).toBe(500);
  });
  it("returns annotations for empty weeks without changing goal results", async () => {
    const get = () => getWeekly(new HttpRequest({ method: "GET", url: "http://localhost/api/weekly?weeks=4&until=2026-10-18", headers: { "x-api-key": "test-key" } }), context);
    const before = (await get()).jsonBody as { weeks: Array<Record<string, unknown>> };
    store.datedRange.mockResolvedValueOnce({ "2026-10-12": { label: "Rest week", note: "Planned" } });
    const after = (await get()).jsonBody as typeof before;
    expect(after.weeks.find((w) => w.weekStart === "2026-10-12")?.annotation).toEqual({ label: "Rest week", note: "Planned" });
    expect(after.weeks.map(({ annotation, recovery, ...week }) => week)).toEqual(before.weeks.map(({ recovery, ...week }) => week));
  });
});


it("loads a full year of rest labels while keeping the summary on the last complete week", async () => {
  const summary = await buildSummary(new Date("2026-03-16T10:00:00Z"));
  expect(summary.weekStart).toBe("2026-03-09");
  expect(summary.text).toContain("52 completed weeks checked");
  const [prefix, start, end] = store.datedRange.mock.calls[0]!;
  expect(prefix).toBe("week.annotation.");
  expect((Date.parse(end) - Date.parse(start)) / 86400000).toBe(53 * 7);
});


it("uses the current week's saved rest label in check-ins", async () => {
  store.get.mockResolvedValue({ label: "Rest week", note: "Planned break" });
  const result = await buildCheckIn(new Date("2026-03-12T17:00:00Z"));
  expect(store.get).toHaveBeenCalledWith("week.annotation.2026-03-09");
  expect(result.text).toContain("recovery check-in");
  expect(result.text).not.toMatch(/more for a good week|For a perfect week/);
});

it("pauses milestone pushes on rest weeks without discarding sent history", async () => {
  store.get.mockResolvedValue({ label: "Rest week", note: "" });
  store.sentKeys.mockResolvedValue(new Set(["good"]));
  const result = await evaluateMilestones([{ startedAt: "2026-03-12T10:00:00Z" } as never], new Date("2026-03-12T17:00:00Z"));
  expect(result.due).toEqual([]); expect(result.toMark).toEqual([]); expect(result.alreadySent).toEqual(["good"]);
  expect(store.listAll).not.toHaveBeenCalled();
});

it("adds current rest-week context to Monday's previous-week summary", async () => {
  store.datedRange.mockResolvedValueOnce({ "2026-03-16": { label: "Rest week", note: "" } });
  const summary = await buildSummary(new Date("2026-03-16T10:00:00Z"));
  expect(summary.weekStart).toBe("2026-03-09");
  expect(summary.text).toContain("This week: rest / recovery");
  expect(summary.text).toContain("No catch-up sessions needed");
});
