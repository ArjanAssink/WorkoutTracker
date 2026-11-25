import { weekOutlook, weekPace } from "../src/domain/weekPace.js";
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
import { displayName, normaliseActivityType } from "../src/domain/activityType.js";
import { DEFAULT_PROFILE, trailingMaxHeartRate } from "../src/domain/effort.js";
import { scoreWithReference } from "../src/domain/scoring.js";
import { summarise, type Granularity } from "../src/domain/summary.js";
import { buildHistogram, encodeHistogram, presentWorkout, zoneModel } from "../src/domain/heartRateZones.js";
import { buildWorkout, type Workout, type WorkoutInput } from "../src/domain/workout.js";
import { buildSeries, decodeSeries, encodeSeries } from "../src/domain/heartRateSeries.js";
import { parseTagUpdate } from "../src/domain/tags.js";
import { resolveRange } from "../src/http/dateRange.js";
import { DEFAULT_GOALS, reviewWeeks, TYPICAL_WINDOW_WEEKS } from "../src/domain/goals.js";
import { resolveWindow } from "../src/functions/getWeekly.js";

import { assets, getAppVersion } from "../src/functions/appAssets.js";
import { weekRecovery } from "../src/domain/weekRecovery.js";
import { parseWeekAnnotation, type WeekAnnotation } from "../src/domain/weekAnnotation.js";
import { composeWeeklySummary } from "../src/domain/weeklySummary.js";
import { composeCheckIn } from "../src/domain/milestones.js";
import { notificationId, presentNotification, titleOf, NOTIFICATION_LINKS, type AppNotification, type NotificationKind } from "../src/domain/notifications.js";

// Preview labels are deliberately temporary; the Function API persists real labels.
const annotations = new Map<string, WeekAnnotation>();
const tags = new Map<string, string[]>();
/** Heart rate over each synthetic workout, by id — the preview's `heartrate` table. */
const SERIES = new Map<string, string>();
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
              // A sample every 5 s: a warm-up ramp, then the working average with intervals on top.
              const t0 = startedAt.getTime(), n = Math.floor((minutes * 60) / 5);
              const stream = Array.from({ length: n }, (_, i) => ({
                at: t0 + i * 5000,
                bpm: Math.min(i / 60, 1) * avg + (1 - Math.min(i / 60, 1)) * 95 + 14 * Math.sin(i / 40) + (random() - 0.5) * 8,
              }));
              const histogram = buildHistogram(stream, t0, t0 + minutes * 60_000);
              const series = buildSeries(stream, t0, t0 + minutes * 60_000);
              return { ...(histogram ? { heartRateHistogram: encodeHistogram(histogram) } : {}), ...(series ? { heartRateSeries: encodeSeries(series) } : {}), averageHeartRate: avg, minHeartRate: avg - Math.round(25 + random() * 20), maxHeartRate: avg + Math.round(15 + random() * 25) };
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
    const built = buildWorkout(input, (w) => scoreWithReference(w, DEFAULT_PROFILE, observed));
    if (input.heartRateSeries) SERIES.set(built.id, input.heartRateSeries);
    workouts.push(built);
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

/** What the notifications table would hold: the real composers over the synthetic weeks, plus a failure. */
const NOTIFICATIONS = (() => {
  const out: AppNotification[] = [];
  const add = (kind: NotificationKind, html: string, at: Date, failed = false) => out.push({
    id: notificationId(at, Math.floor(at.getTime() / 1000 % 1e8).toString(16)), kind, title: titleOf(html), html, createdAt: at.toISOString(), link: NOTIFICATION_LINKS[kind],
    deliveries: [failed
      ? { channel: "telegram", status: "failed", at: at.toISOString(), error: "Telegram responded 400: Bad Request: can't parse entities" }
      : { channel: "telegram", status: "sent", at: at.toISOString() }],
  });
  for (let back = 6; back >= 0; back--) {
    const monday = resolveWindow(null, 1, new Date(Date.now() - back * 7 * 86_400_000)).to!;
    const { from, to } = resolveWindow(null, 12, new Date(monday.getTime() + 3600_000));
    const leadIn = new Date(from!.getTime() - TYPICAL_WINDOW_WEEKS * 7 * 86_400_000);
    const inWindow = ALL.filter((w) => { const t = new Date(w.startedAt); return t >= leadIn && t < to; });
    const report = reviewWeeks(inWindow, DEFAULT_GOALS, from!, to, { leadInWeeks: TYPICAL_WINDOW_WEEKS });
    add("weekly", composeWeeklySummary(report), new Date(monday.getTime() + 9 * 3600_000), back === 4);
    const thursday = new Date(monday.getTime() + (3 * 24 + 17) * 3600_000);
    if (thursday.getTime() < Date.now()) {
      const weekReport = reviewWeeks(ALL.filter((w) => w.startedAt < thursday.toISOString()), DEFAULT_GOALS, monday, new Date(monday.getTime() + 7 * 86_400_000));
      const text = weekReport.current && composeCheckIn(weekReport.current, DEFAULT_GOALS, thursday, "Europe/Amsterdam");
      if (text) add("checkin", text, thursday);
    }
    if (back === 2) add("milestones", "🏆 <b>Good week secured</b>\nFive sessions by Friday — anything else is extra.", new Date(monday.getTime() + (4 * 24 + 8) * 3600_000));
  }
  add("stale", "📵 <b>No data for 3 days</b> from:\n• the <b>workout export</b> — last seen Sat 21 Nov, 08:12, 3 days ago\nThe automation has probably stopped running.", new Date(Date.now() - 2 * 86_400_000));
  return out.sort((a, b) => a.id.localeCompare(b.id));
})();

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);

  const send = (status: number, body: string | Uint8Array, type: string) => {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    response.end(body);
  };
  const json = (status: number, body: unknown) => send(status, JSON.stringify(body), "application/json");

  const appAsset = url.pathname.match(/^\/api\/app-assets\/([^/]+)$/)?.[1];
  if (appAsset && Object.hasOwn(assets, appAsset)) {
    if (appAsset === "app-version.json") return json(200, { version: await getAppVersion() });
    return send(200, await readFile(new URL(`../../public/app-assets/${appAsset}`, import.meta.url)), assets[appAsset]!);
  }

  if (url.pathname === "/" || url.pathname === "/api/dashboard") {
    return send(200, await readFile(PAGE, "utf8"), "text/html; charset=utf-8");
  }
  if (url.pathname === "/api/inbox") {
    return send(200, await readFile(new URL("../../public/notifications.html", import.meta.url), "utf8"), "text/html; charset=utf-8");
  }
  if (url.pathname === "/api/history") {
    return send(200, await readFile(new URL("../../public/workouts.html", import.meta.url), "utf8"), "text/html; charset=utf-8");
  }

  if (request.headers["x-api-key"] !== KEY) return json(401, { error: "Invalid or missing API key" });

  if (url.pathname === "/api/weekly/annotation" && request.method === "POST") {
    try {
      let body = "";
      for await (const chunk of request) { body += chunk.toString(); if (body.length > 16000) return json(413, { error: "Annotation too large" }); }
      const parsed = parseWeekAnnotation(JSON.parse(body));
      if (parsed.annotation) annotations.set(parsed.weekStart, parsed.annotation); else annotations.delete(parsed.weekStart);
      return json(200, parsed);
    } catch (error) { return json(400, { error: error instanceof Error ? error.message : "Invalid annotation" }); }
  }

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
    const report = reviewWeeks(inWindow, DEFAULT_GOALS, from, to, { leadInWeeks: TYPICAL_WINDOW_WEEKS });
    return json(200, { ...report, weeks: report.weeks.map((week) => { const pace = weekPace(ALL, week, new Date(), annotations.get(week.weekStart), DEFAULT_GOALS.excludeFromCount), outlook = weekOutlook(week, pace); return { ...week, recovery: weekRecovery(week, annotations.get(week.weekStart), new Date()), pace, ...(outlook ? { outlook } : {}), ...(annotations.has(week.weekStart) ? { annotation: annotations.get(week.weekStart) } : {}) }; }) });
  }
  if (url.pathname === "/api/summary") {
    const granularity = (url.searchParams.get("granularity") ?? "week") as Granularity;
    const observed = trailingMaxHeartRate(ALL, range.to);
    return json(200, {
      ...summarise(inRange, granularity, range.from, range.to, DEFAULT_PROFILE),
      profile: { restingHeartRate: 60, maxHeartRate: 185 },
      referenceMaxHeartRate: { bpm: observed ?? 185, observed: observed !== undefined },
      heartRateZoneModel: zoneModel(DEFAULT_PROFILE.restingHeartRate, observed ?? DEFAULT_PROFILE.maxHeartRate),
    });
  }
  if (url.pathname === "/api/notifications") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100), after = url.searchParams.get("after");
    const rows = NOTIFICATIONS.filter((n) => !after || n.id > after).slice(0, limit + 1);
    const page = rows.slice(0, limit);
    return json(200, { notifications: page.map(presentNotification), ...(rows.length > limit ? { next: page[page.length - 1]!.id } : {}) });
  }
  if (url.pathname === "/api/workouts/heartrate") {
    const id = url.searchParams.get("id") ?? "";
    const w = ALL.find((x) => x.id === id);
    const series = decodeSeries(SERIES.get(id));
    if (!w || !series) return json(404, { error: "No heart-rate stream stored for this workout" });
    return json(200, { id, startedAt: w.startedAt, ...series });
  }
  if (url.pathname === "/api/workouts/tags" && request.method === "POST") {
    try {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const update = parseTagUpdate(JSON.parse(body));
      if (update.tags.length) tags.set(update.workoutId, update.tags); else tags.delete(update.workoutId);
      return json(200, { id: update.workoutId, tags: update.tags });
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : "Invalid tags" });
    }
  }
  if (url.pathname === "/api/workouts/tags") return json(200, { tags: Object.fromEntries(tags) });
  if (url.pathname === "/api/workouts") {
    return json(200, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      count: inRange.length,
      truncated: false,
      workouts: inRange.map((w) => ({ ...presentWorkout(w, DEFAULT_PROFILE.restingHeartRate, DEFAULT_PROFILE.maxHeartRate), label: displayName(w.activityType) })),
    });
  }
  return json(404, { error: "Not found" });
}).listen(PORT, () => {
  console.log(`Preview on http://localhost:${PORT}/api/dashboard   (API key: ${KEY})`);
  console.log(`${ALL.length} synthetic workouts generated`);
});
