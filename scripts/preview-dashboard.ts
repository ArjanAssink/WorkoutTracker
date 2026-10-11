/**
 * Serves the dashboard against synthetic data, with no Azure account and no Functions
 * host, so the page can be developed and reviewed in isolation.
 *
 * It routes through the real `summarise`, `scoreEffort` and `buildWorkout`, so what you
 * see is the actual aggregation — only the rows are invented.
 *
 *   npm run preview        # then open http://localhost:7099/api/dashboard
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { normaliseActivityType } from "../src/domain/activityType.js";
import { DEFAULT_PROFILE, trailingMaxHeartRate } from "../src/domain/effort.js";
import { scoreWithReference } from "../src/domain/scoring.js";
import { summarise, type Granularity } from "../src/domain/summary.js";
import { buildWorkout, type Workout, type WorkoutInput } from "../src/domain/workout.js";
import { resolveRange } from "../src/http/dateRange.js";
import { DEFAULT_GOALS, reviewWeeks, TYPICAL_WINDOW_WEEKS } from "../src/domain/goals.js";
import { resolveWindow } from "../src/functions/getWeekly.js";

const PORT = Number(process.env["PREVIEW_PORT"] ?? 7099);
const KEY = "preview";
const PAGE = new URL("../../public/index.html", import.meta.url);

/** A deterministic PRNG, so a reviewed layout is the same layout on the next run. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly a year of plausible training: a weekly rhythm, rest days, and a holiday gap. */
function generate(): Workout[] {
  const random = mulberry32(20260314);
  const plan = [
    { type: "running", minutes: [35, 70], hr: [140, 165], km: [6, 14] },
    { type: "strength", minutes: [40, 60], hr: [105, 125], km: null },
    { type: "cycling", minutes: [60, 140], hr: [125, 150], km: [25, 60] },
    { type: "swimming", minutes: [30, 50], hr: [120, 140], km: [1.2, 2.5] },
    { type: "yoga", minutes: [25, 45], hr: null, km: null },
    { type: "hiit", minutes: [20, 35], hr: [150, 172], km: null },
  ] as const;

  const workouts: Workout[] = [];
  const inputs: WorkoutInput[] = [];
  const today = new Date();
  const span = 330;

  for (let back = span; back >= 0; back--) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
    const weekday = day.getUTCDay();

    // A two-week gap, so the streak and active-day numbers have something real to show.
    if (back > 120 && back < 134) continue;
    // Rest more often at weekends than midweek.
    const restChance = weekday === 0 ? 0.65 : weekday === 6 ? 0.4 : 0.3;
    if (random() < restChance) continue;

    const sessions = random() < 0.12 ? 2 : 1;
    for (let s = 0; s < sessions; s++) {
      const choice = plan[Math.floor(random() * plan.length)]!;
      const minutes = choice.minutes[0] + random() * (choice.minutes[1] - choice.minutes[0]);
      const startHour = s === 0 ? 6 + Math.floor(random() * 4) : 17 + Math.floor(random() * 3);
      const startedAt = new Date(day.getTime() + startHour * 3600_000 + Math.floor(random() * 50) * 60_000);

      const input: WorkoutInput = {
        activityType: choice.type,
        startedAt: startedAt.toISOString(),
        endedAt: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
        durationSeconds: Math.round(minutes * 60),
        source: "shortcut",
        sourceName: "Preview Watch",
        ...(choice.hr
          ? (() => {
              const avg = Math.round(choice.hr[0] + random() * (choice.hr[1] - choice.hr[0]));
              return { averageHeartRate: avg, minHeartRate: avg - Math.round(25 + random() * 20), maxHeartRate: avg + Math.round(15 + random() * 25) };
            })()
          : {}),
        ...(choice.km ? { distanceMeters: Math.round((choice.km[0] + random() * (choice.km[1] - choice.km[0])) * 1000) } : {}),
        activeEnergyKcal: Math.round(minutes * (6 + random() * 5)),
      };
      inputs.push(input);
    }
  }
  // Score in date order against the peaks seen so far, exactly as the import does.
  inputs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const observations = inputs.map((w) => ({ startedAt: w.startedAt, maxHeartRate: w.maxHeartRate }));
  for (const input of inputs) {
    const observed = trailingMaxHeartRate(observations, new Date(input.startedAt));
    workouts.push(buildWorkout(input, (w) => scoreWithReference(w, DEFAULT_PROFILE, observed)));
  }
  return workouts;
}

const ALL = generate();

/** A slow downward drift with daily noise and a few skipped days. */
const WEIGHTS = (() => {
  const random = mulberry32(7);
  const out: { date: string; kg: number; measuredAt: string; source: "health-export"; recordedAt: string }[] = [];
  const today = new Date();
  for (let back = 330; back >= 0; back--) {
    if (random() < 0.2) continue;
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
    const kg = Math.round((84 - (330 - back) * 0.009 + (random() - 0.5) * 1.6) * 10) / 10;
    const date = d.toISOString().slice(0, 10);
    out.push({ date, kg, measuredAt: `${date}T06:30:00.000Z`, source: "health-export", recordedAt: date });
  }
  return out;
})();

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);

  const send = (status: number, body: string, type: string) => {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    response.end(body);
  };
  const json = (status: number, body: unknown) => send(status, JSON.stringify(body), "application/json");

  if (url.pathname === "/" || url.pathname === "/api/dashboard") {
    return send(200, await readFile(PAGE, "utf8"), "text/html; charset=utf-8");
  }

  if (request.headers["x-api-key"] !== KEY) return json(401, { error: "Invalid or missing API key" });

  const range = resolveRange(url.searchParams);
  // Honour activityType exactly as the real endpoints do — a harness that silently drops a
  // filter reports success for a broken dashboard.
  const activity = url.searchParams.get("activityType");
  const inRange = ALL.filter((w) => {
    const at = new Date(w.startedAt);
    if (at < range.from || at >= range.to) return false;
    return !activity || w.activityType === normaliseActivityType(activity);
  });

  if (url.pathname === "/api/bodyweight") {
    const r = resolveRange(url.searchParams);
    const a = r.from.toISOString().slice(0, 10), b = r.to.toISOString().slice(0, 10);
    const weights = WEIGHTS.filter((w) => w.date >= a && w.date <= b);
    return json(200, { from: r.from.toISOString(), to: r.to.toISOString(), count: weights.length, weights });
  }
  if (url.pathname === "/api/weekly") {
    const weeks = Number(url.searchParams.get("weeks") ?? 12);
    const { from, to } = resolveWindow(url.searchParams.get("until"), weeks, new Date());
    if (!from) return json(400, { error: "'until' is not a valid date" });
    const leadIn = new Date(from.getTime() - TYPICAL_WINDOW_WEEKS * 7 * 86_400_000);
    const inWindow = ALL.filter((w) => { const at = new Date(w.startedAt); return at >= leadIn && at < to; });
    return json(200, reviewWeeks(inWindow, DEFAULT_GOALS, from, to, { leadInWeeks: TYPICAL_WINDOW_WEEKS }));
  }
  if (url.pathname === "/api/summary") {
    const granularity = (url.searchParams.get("granularity") ?? "week") as Granularity;
    const observed = trailingMaxHeartRate(ALL, range.to);
    return json(200, {
      ...summarise(inRange, granularity, range.from, range.to),
      profile: { restingHeartRate: 60, maxHeartRate: 185 },
      referenceMaxHeartRate: { bpm: observed ?? 185, observed: observed !== undefined },
    });
  }
  if (url.pathname === "/api/workouts") {
    return json(200, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      count: inRange.length,
      truncated: false,
      workouts: inRange,
    });
  }
  return json(404, { error: "Not found" });
}).listen(PORT, () => {
  console.log(`Preview on http://localhost:${PORT}/api/dashboard   (API key: ${KEY})`);
  console.log(`${ALL.length} synthetic workouts generated`);
});
