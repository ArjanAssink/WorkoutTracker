import type { BodyWeight } from "./bodyWeight.js";
import type { RecoveryDay } from "./recovery.js";
import type { Workout } from "./workout.js";
import { displayName } from "./activityType.js";

/**
 * Patterns between training, sleep, resting heart rate, HRV and weight, computed from
 * whatever is stored — not a fixed list of findings. Every number carries its n, and the
 * readings (the sentences) are produced by thresholds over those numbers, so a pattern
 * that stops holding stops being claimed.
 *
 * Three habits keep this honest. Walks are kept apart from training sessions (the watch
 * auto-detects walks, and in some years there were twenty a week). Weekly correlations
 * are taken on deviations from the surrounding quarter, because weight, resting HR and
 * walking all drift over the years and would otherwise correlate through the calendar
 * alone. And "rest day" is reported with its caveat: nobody trains on the days they are
 * ill, so a quiet day's poor morning is as likely cause as effect.
 */

export const TRAINING_TYPES = new Set(["strength", "functionalstrength", "martialarts", "taichi", "cycling", "running", "hiking", "swimming", "rowing", "yoga", "paddlesports", "crosstraining"]);
const LATE_HOUR = 20;
const MIN_GROUP = 15;

interface Day {
  date: string;
  dow: number;
  asleep?: number;
  deep?: number;
  wake?: number;
  bed?: number;
  rhr?: number;
  hrv?: number;
  kg?: number;
  steps?: number;
  sessions: number;
  trainingSessions: number;
  trainingMinutes: number;
  walkMinutes: number;
  effort: number;
  types: Set<string>;
  latestEndHour?: number;
}

export interface Stat { mean: number; n: number }
export interface MorningRow { label: string; n: number; rhr?: Stat; hrv?: Stat; sleepHours?: Stat; deepHours?: Stat; wakeUps?: Stat; bedtimeMinutes?: Stat }
export interface Corr { r: number; n: number }

export interface Patterns {
  span: { from: string; to: string; days: number; workouts: number };
  /** Next-morning means by what the day held. */
  byDayType: MorningRow[];
  byActivity: MorningRow[];
  lateVsEarly: { late: MorningRow; early: MorningRow };
  sleepToRhr: { shortNight: Stat; longNight: Stat; weeklyR: Corr; dayR: Corr };
  loadToRhr: { sameWeek: Record<string, Corr>; nextWeek: Record<string, Corr> };
  weekday: MorningRow[];
  years: Array<{ year: string; rhr?: number; hrv?: number; sleepHours?: number; deepHours?: number; kg?: number; steps?: number; trainingMinutesPerWeek?: number; walkMinutesPerWeek?: number; sessionsPerWeek?: number }>;
  months: Array<{ month: number; rhr?: number; hrv?: number; sleepHours?: number; kg?: number }>;
  weightWithinYear: Array<{ year: string; weeks: number; kgRhr: Corr; trainingKg: Corr; walkingKg: Corr }>;
  /** Steps — all movement, not just logged workouts — against the rest. */
  steps?: {
    days: number;
    median: number;
    byYear: Array<{ year: string; median: number; days: number }>;
    /** Next morning after a low / typical / high step day (tertiles of the person's own distribution). */
    nextMorning: MorningRow[];
    /** Mean steps on days with a training session vs without. */
    onTrainingDays: Stat; onRestDays: Stat;
    /** Weekly, trend removed: steps against the others; and lagged to next week. */
    sameWeek: Record<string, Corr>; nextWeek: Record<string, Corr>;
    weightWithinYear: Array<{ year: string; weeks: number; r: number }>;
  };
  /** Sleep against the sun, at the home latitude: month by month and as slopes. */
  daylight: {
    latitude: number;
    months: Array<{ month: number; dayLengthHours: number; sunriseMinutes: number; sunsetMinutes: number; sleepHours?: number; bedtimeMinutes?: number; wakeMinutes?: number; sleepN: number }>;
    sleepVsDayLength: Corr;
    /** Minutes of wake-time change per minute of sunrise change (1 = tracks the sun, 0 = the alarm clock). */
    wakeVsSunrise: { slope: number; r: number; n: number };
    bedtimeVsSunset: { slope: number; r: number; n: number };
  };
  readings: string[];
}

/**
 * Sunrise, sunset and day length for a date at a latitude/longitude — the standard
 * declination formula, within a few minutes of the almanac, which is all a monthly mean
 * needs. Minutes after local midnight in `timeZone`.
 */
export function sunTimes(date: string, lat: number, lon: number, timeZone: string): { dayLengthHours: number; sunriseMinutes: number; sunsetMinutes: number } {
  const d = new Date(`${date}T12:00:00Z`);
  const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  const decl = (23.44 * Math.PI / 180) * Math.sin(((2 * Math.PI) / 365) * (doy - 81));
  const phi = (lat * Math.PI) / 180;
  // Zenith 90.833°: the sun's upper limb plus refraction, as the almanacs define sunrise.
  const zenith = (90.833 * Math.PI) / 180;
  const cosH = Math.max(-1, Math.min(1, (Math.cos(zenith) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl))));
  const H = (Math.acos(cosH) * 180) / Math.PI; // degrees
  const dayLengthHours = (2 * H) / 15;
  // Equation of time, minutes — keeps noon honest to within a minute or two across the year.
  const b = ((2 * Math.PI) / 365) * (doy - 81);
  const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const noonUtcMinutes = 12 * 60 - lon * 4 - eot;
  const offset = tzOffsetMinutes(d, timeZone);
  const noon = noonUtcMinutes + offset;
  return { dayLengthHours: Math.round(dayLengthHours * 100) / 100, sunriseMinutes: Math.round(noon - H * 4), sunsetMinutes: Math.round(noon + H * 4) };
}

function tzOffsetMinutes(d: Date, timeZone: string): number {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(s);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

function slope(xs: Array<number | undefined>, ys: Array<number | undefined>): { slope: number; r: number; n: number } {
  const pts: Array<[number, number]> = []; for (let i = 0; i < Math.min(xs.length, ys.length); i++) if (xs[i] !== undefined && ys[i] !== undefined) pts.push([xs[i]!, ys[i]!]);
  const n = pts.length; if (n < 8) return { slope: 0, r: 0, n };
  const mx = avg(pts.map((p) => p[0])), my = avg(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0; for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return { slope: sxx ? Math.round((sxy / sxx) * 1000) / 1000 : 0, r: pearson(xs, ys).r, n };
}

export function analysePatterns(days: RecoveryDay[], workouts: Workout[], weights: BodyWeight[], timeZone = "Europe/Amsterdam", home: { lat: number; lon: number } = { lat: 52.2, lon: 4.5 }): Patterns | undefined {
  if (days.length < 60) return undefined;
  const rec = new Map(days.map((d) => [d.date, d]));
  const kg = new Map(weights.map((w) => [w.date, w.kg]));
  const byDay = new Map<string, Workout[]>();
  const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone });
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const w of workouts) { const k = dayFmt.format(new Date(w.startedAt)); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(w); }
  const dates = [...rec.keys()].sort();
  const first = dates[0]!, last = dates[dates.length - 1]!;
  const rows: Day[] = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10); const r = rec.get(date); const wl = byDay.get(date) ?? [];
    const types = new Set(wl.map((w) => w.activityType));
    rows.push({
      date, dow: (new Date(t).getUTCDay() + 6) % 7,
      ...opt("asleep", r?.sleepAsleepSeconds === undefined ? undefined : r.sleepAsleepSeconds / 3600), ...opt("deep", r?.sleepDeepSeconds === undefined ? undefined : r.sleepDeepSeconds / 3600),
      ...opt("wake", r?.sleepAwakenings), ...opt("bed", r?.bedtimeMinutes), ...opt("rhr", r?.restingHeartRate), ...opt("hrv", r?.hrv), ...opt("kg", kg.get(date)), ...opt("steps", r?.steps),
      sessions: wl.length, trainingSessions: wl.filter((w) => TRAINING_TYPES.has(w.activityType)).length,
      trainingMinutes: wl.filter((w) => TRAINING_TYPES.has(w.activityType)).reduce((n, w) => n + w.durationSeconds / 60, 0),
      walkMinutes: wl.filter((w) => w.activityType === "walking").reduce((n, w) => n + w.durationSeconds / 60, 0),
      effort: wl.reduce((n, w) => n + w.effort, 0), types,
      ...opt("latestEndHour", endHour(wl, hourFmt)),
    });
  }
  const next = (i: number, key: keyof Day): number | undefined => (rows[i + 1]?.[key] as number | undefined);
  const morning = (label: string, idx: number[]): MorningRow => ({
    label, n: idx.length,
    ...opt("rhr", stat(idx.map((i) => next(i, "rhr")))), ...opt("hrv", stat(idx.map((i) => next(i, "hrv")))), ...opt("sleepHours", stat(idx.map((i) => next(i, "asleep")))),
    ...opt("deepHours", stat(idx.map((i) => next(i, "deep")))), ...opt("wakeUps", stat(idx.map((i) => next(i, "wake")))), ...opt("bedtimeMinutes", stat(idx.map((i) => next(i, "bed")))),
  });
  const all = rows.map((_, i) => i);
  const byDayType = [
    morning("Nothing at all", all.filter((i) => rows[i]!.sessions === 0)),
    morning("Walks only", all.filter((i) => rows[i]!.sessions > 0 && rows[i]!.trainingSessions === 0)),
    morning("One training session", all.filter((i) => rows[i]!.trainingSessions === 1)),
    morning("Two or more", all.filter((i) => rows[i]!.trainingSessions >= 2)),
    morning("Training ≥ 90 min", all.filter((i) => rows[i]!.trainingMinutes >= 90)),
  ].filter((m) => m.n >= MIN_GROUP);
  const activities = [...new Set(workouts.map((w) => w.activityType))];
  const byActivity = activities.map((a) => morning(displayName(a), all.filter((i) => rows[i]!.types.has(a)))).filter((m) => m.n >= MIN_GROUP).sort((a, b) => b.n - a.n);
  const lateVsEarly = { late: morning("Ended after 20:00", all.filter((i) => (rows[i]!.latestEndHour ?? -1) >= LATE_HOUR)), early: morning("Ended before 18:00", all.filter((i) => rows[i]!.latestEndHour !== undefined && rows[i]!.latestEndHour < 18)) };

  // Day-level deviations from the surrounding month, so a short night is short *for that time*.
  const dev = (key: keyof Day, half = 14): Array<number | undefined> => rows.map((r, i) => { const v = r[key] as number | undefined; if (v === undefined) return undefined; const win = rows.slice(Math.max(0, i - half), i + half + 1).map((x) => x[key] as number | undefined).filter((x): x is number => x !== undefined); return win.length >= 10 ? v - avg(win) : undefined; });
  const dSleep = dev("asleep"), dRhr = dev("rhr"), dTrain = dev("trainingMinutes"), dSteps = dev("steps");
  const shortNight = stat(rows.map((_, i) => (dSleep[i] !== undefined && dSleep[i]! <= -1 ? dRhr[i] : undefined)));
  const longNight = stat(rows.map((_, i) => (dSleep[i] !== undefined && dSleep[i]! >= 1 ? dRhr[i] : undefined)));

  // Weeks, training only, deviation from the surrounding quarter.
  const weeks = new Map<string, Day[]>();
  for (const r of rows) { const d = new Date(`${r.date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const k = d.toISOString().slice(0, 10); (weeks.get(k) ?? weeks.set(k, []).get(k)!).push(r); }
  const W = [...weeks.entries()].filter(([, xs]) => xs.length === 7).map(([week, xs]) => ({
    week, tsessions: xs.reduce((n, x) => n + x.trainingSessions, 0), tmins: xs.reduce((n, x) => n + x.trainingMinutes, 0), walk: xs.reduce((n, x) => n + x.walkMinutes, 0), effort: xs.reduce((n, x) => n + x.effort, 0),
    rhr: avgOpt(xs.map((x) => x.rhr)), hrv: avgOpt(xs.map((x) => x.hrv)), asleep: avgOpt(xs.map((x) => x.asleep)), kg: avgOpt(xs.map((x) => x.kg)), steps: avgOpt(xs.map((x) => x.steps)),
  }));
  type WK = keyof (typeof W)[number];
  const wdev = (key: WK, half = 6): Array<number | undefined> => W.map((w, i) => { const v = w[key] as number | undefined; if (v === undefined) return undefined; const win = W.slice(Math.max(0, i - half), i + half + 1).map((x) => x[key] as number | undefined).filter((x): x is number => x !== undefined); return win.length >= 5 ? v - avg(win) : undefined; });
  const D = Object.fromEntries((["tsessions", "tmins", "walk", "effort", "rhr", "hrv", "asleep", "kg", "steps"] as WK[]).map((k) => [k, wdev(k)])) as Record<string, Array<number | undefined>>;
  const sameWeek: Record<string, Corr> = {}, nextWeek: Record<string, Corr> = {};
  for (const k of ["tsessions", "tmins", "effort", "walk"]) { sameWeek[k] = pearson(D[k]!, D["rhr"]!); nextWeek[k] = pearson(D[k]!.slice(0, -1), D["rhr"]!.slice(1)); }
  const sleepToRhr = { shortNight: shortNight ?? { mean: 0, n: 0 }, longNight: longNight ?? { mean: 0, n: 0 }, weeklyR: pearson(D["asleep"]!, D["rhr"]!), dayR: pearson(dSleep, dRhr) };
  const sameWeekHrv = pearson(D["tsessions"]!, D["hrv"]!), nextWeekHrv = pearson(D["tsessions"]!.slice(0, -1), D["hrv"]!.slice(1));
  const trainToRhrNext = pearson(dTrain.slice(0, -1), dRhr.slice(1));

  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name, dow) => morning(name, all.filter((i) => rows[i]!.dow === dow)));
  // Years with a heart-rate or sleep figure; the in-bed-only years before the watch add nothing here.
  const yearsSet = [...new Set(rows.filter((r) => r.rhr !== undefined || r.asleep !== undefined).map((r) => r.date.slice(0, 4)))];
  const years: Patterns["years"] = yearsSet.map((year) => { const xs = rows.filter((r) => r.date.startsWith(year)); const wk = W.filter((w) => w.week.startsWith(year)); return strip<Patterns["years"][number]>({
    year, rhr: medOpt(xs.map((x) => x.rhr)), hrv: medOpt(xs.map((x) => x.hrv)), sleepHours: medOpt(xs.map((x) => x.asleep)), deepHours: medOpt(xs.map((x) => x.deep)), kg: medOpt(xs.map((x) => x.kg)), steps: medOpt(xs.map((x) => x.steps)),
    trainingMinutesPerWeek: wk.length ? med(wk.map((w) => w.tmins)) : undefined, walkMinutesPerWeek: wk.length ? med(wk.map((w) => w.walk)) : undefined, sessionsPerWeek: wk.length ? med(wk.map((w) => w.tsessions)) : undefined,
  }); });
  const months: Patterns["months"] = Array.from({ length: 12 }, (_, m) => { const xs = rows.filter((r) => Number(r.date.slice(5, 7)) === m + 1); return strip<Patterns["months"][number]>({ month: m + 1, rhr: avgOpt(xs.map((x) => x.rhr)), hrv: avgOpt(xs.map((x) => x.hrv)), sleepHours: avgOpt(xs.map((x) => x.asleep)), kg: avgOpt(xs.map((x) => x.kg)) }); });
  const weightWithinYear = yearsSet.map((year) => { const wk = W.filter((w) => w.week.startsWith(year)); return { year, weeks: wk.length, kgRhr: pearson(wk.map((w) => w.kg), wk.map((w) => w.rhr)), trainingKg: pearson(wk.map((w) => w.tmins), wk.map((w) => w.kg)), walkingKg: pearson(wk.map((w) => w.walk), wk.map((w) => w.kg)) }; }).filter((y) => y.weeks >= 12);

  // Steps: the whole day's movement, workouts or not.
  // Tertiles and the next-morning groups use the watch era only (days that carry a heart
  // rate or a night): the phone-only years before it count fewer steps and have no mornings.
  const allStepDays = rows.filter((r) => r.steps !== undefined);
  const stepDays = allStepDays.filter((r) => r.rhr !== undefined || r.asleep !== undefined);
  let steps: Patterns["steps"];
  if (stepDays.length >= 120) {
    const sorted = stepDays.map((r) => r.steps!).sort((a, b) => a - b);
    const t1 = sorted[Math.floor(sorted.length / 3)]!, t2 = sorted[Math.floor((2 * sorted.length) / 3)]!;
    const stepIdx = (f: (s: number) => boolean) => all.filter((i) => rows[i]!.steps !== undefined && (rows[i]!.rhr !== undefined || rows[i]!.asleep !== undefined) && f(rows[i]!.steps!));
    steps = {
      days: stepDays.length, median: med(sorted),
      byYear: [...new Set(allStepDays.map((r) => r.date.slice(0, 4)))].sort().map((year) => { const v = allStepDays.filter((r) => r.date.startsWith(year)).map((r) => r.steps!); return { year, median: v.length ? med(v) : 0, days: v.length }; }).filter((y) => y.days >= 30),
      nextMorning: [morning(`Low day (< ${Math.round(t1).toLocaleString()} steps)`, stepIdx((s) => s < t1)), morning("Typical day", stepIdx((s) => s >= t1 && s < t2)), morning(`High day (≥ ${Math.round(t2).toLocaleString()} steps)`, stepIdx((s) => s >= t2))],
      onTrainingDays: stat(stepDays.filter((r) => r.trainingSessions > 0).map((r) => r.steps)) ?? { mean: 0, n: 0 }, onRestDays: stat(stepDays.filter((r) => r.sessions === 0).map((r) => r.steps)) ?? { mean: 0, n: 0 },
      sameWeek: { rhr: pearson(D["steps"]!, D["rhr"]!), hrv: pearson(D["steps"]!, D["hrv"]!), asleep: pearson(D["steps"]!, D["asleep"]!), kg: pearson(D["steps"]!, D["kg"]!), tmins: pearson(D["steps"]!, D["tmins"]!) },
      nextWeek: { rhr: pearson(D["steps"]!.slice(0, -1), D["rhr"]!.slice(1)), hrv: pearson(D["steps"]!.slice(0, -1), D["hrv"]!.slice(1)), asleep: pearson(D["steps"]!.slice(0, -1), D["asleep"]!.slice(1)), kg: pearson(D["steps"]!.slice(0, -1), D["kg"]!.slice(1)) },
      weightWithinYear: yearsSet.map((year) => { const wk = W.filter((w) => w.week.startsWith(year)); return { year, weeks: wk.length, r: pearson(wk.map((w) => w.steps), wk.map((w) => w.kg)).r }; }).filter((y) => y.weeks >= 12),
    };
  }
  const stepsToRhrNext = pearson(dSteps.slice(0, -1), dRhr.slice(1)), stepsToSleep = pearson(dSteps.slice(0, -1), dSleep.slice(1));

  // Sleep against the sun.
  const sun = rows.map((r) => sunTimes(r.date, home.lat, home.lon, timeZone));
  const daylightMonths: Patterns["daylight"]["months"] = Array.from({ length: 12 }, (_, m) => {
    const idx = rows.map((r, i) => (Number(r.date.slice(5, 7)) === m + 1 ? i : -1)).filter((i) => i >= 0);
    const sleeps = idx.map((i) => rows[i]!.asleep).filter((x): x is number => x !== undefined);
    return strip<Patterns["daylight"]["months"][number]>({
      month: m + 1, dayLengthHours: Math.round(avg(idx.map((i) => sun[i]!.dayLengthHours)) * 100) / 100, sunriseMinutes: Math.round(avg(idx.map((i) => sun[i]!.sunriseMinutes))), sunsetMinutes: Math.round(avg(idx.map((i) => sun[i]!.sunsetMinutes))),
      sleepHours: avgOpt(idx.map((i) => rows[i]!.asleep)), bedtimeMinutes: avgOpt(idx.map((i) => rows[i]!.bed)), wakeMinutes: avgOpt(idx.map((i) => (rec.get(rows[i]!.date)?.wakeMinutes))), sleepN: sleeps.length,
    });
  });
  const wakeOf = rows.map((r) => rec.get(r.date)?.wakeMinutes);
  const daylight: Patterns["daylight"] = {
    latitude: home.lat, months: daylightMonths,
    sleepVsDayLength: pearson(sun.map((x) => x.dayLengthHours), rows.map((r) => r.asleep)),
    wakeVsSunrise: slope(sun.map((x) => x.sunriseMinutes), wakeOf),
    bedtimeVsSunset: slope(sun.map((x) => x.sunsetMinutes), rows.map((r) => r.bed)),
  };

  // --- readings: sentences the numbers earn ---------------------------------------
  const readings: string[] = [];
  const h = (x: number) => `${Math.floor(x)}h ${String(Math.round((x % 1) * 60)).padStart(2, "0")}m`;
  const clock = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
  const overallSleep = stat(rows.map((_, i) => next(i, "asleep")));
  const trainedActs = byActivity.filter((a) => a.n >= 30 && a.sleepHours);
  if (overallSleep && trainedActs.length) {
    const worst = trainedActs.reduce((a, b) => (a.sleepHours!.mean < b.sleepHours!.mean ? a : b));
    const diffMin = Math.round((overallSleep.mean - worst.sleepHours!.mean) * 60);
    if (diffMin >= 20) readings.push(`${worst.label} nights are the short nights: ${h(worst.sleepHours!.mean)} of sleep after a ${worst.label} day against ${h(overallSleep.mean)} overall (${diffMin} min less, n=${worst.n})${worst.bedtimeMinutes ? `, bedtime ${clock(worst.bedtimeMinutes.mean)}` : ""}${worst.rhr ? `, resting HR next morning ${worst.rhr.mean.toFixed(1)}` : ""}.`);
    const best = trainedActs.reduce((a, b) => (a.sleepHours!.mean > b.sleepHours!.mean ? a : b));
    if (best !== worst && (best.sleepHours!.mean - overallSleep.mean) * 60 >= 5) readings.push(`${best.label} days are followed by the best nights: ${h(best.sleepHours!.mean)}${best.wakeUps ? `, ${best.wakeUps.mean.toFixed(1)} wake-ups` : ""} (n=${best.n}).`);
  }
  if (lateVsEarly.late.sleepHours && lateVsEarly.early.sleepHours && lateVsEarly.late.n >= 30) {
    const d = Math.round((lateVsEarly.early.sleepHours.mean - lateVsEarly.late.sleepHours.mean) * 60);
    if (Math.abs(d) >= 15) readings.push(`A session ending after 20:00 ${d > 0 ? "costs" : "adds"} about ${Math.abs(d)} minutes of sleep that night (${h(lateVsEarly.late.sleepHours.mean)} vs ${h(lateVsEarly.early.sleepHours.mean)} when the day's training ended before 18:00; n=${lateVsEarly.late.n}/${lateVsEarly.early.n})${lateVsEarly.late.wakeUps && lateVsEarly.early.wakeUps && lateVsEarly.late.wakeUps.mean < lateVsEarly.early.wakeUps.mean - 0.3 ? " — shorter, not worse: fewer wake-ups" : ""}.`);
  }
  if (sleepToRhr.shortNight.n >= 30 && sleepToRhr.longNight.n >= 30 && sleepToRhr.longNight.mean < sleepToRhr.shortNight.mean - 0.5) {
    readings.push(`Sleep moves resting heart rate: after a night an hour or more shorter than usual the next morning sits ${signed(sleepToRhr.shortNight.mean)} bpm against the running baseline; after an hour longer, ${signed(sleepToRhr.longNight.mean)} (n=${sleepToRhr.shortNight.n}/${sleepToRhr.longNight.n}). Weeks with more sleep have lower resting HR (r ${sleepToRhr.weeklyR.r.toFixed(2)}).`);
  }
  const sw = sameWeek["tmins"]!, nw = nextWeek["tmins"]!;
  if (sw.n >= 40 && sw.r >= 0.1 && nw.r <= -0.1) readings.push(`Training raises resting HR in the same week (r ${sw.r.toFixed(2)}) and lowers it the week after (r ${nw.r.toFixed(2)}) — the fitness response, with its one-week lag${nextWeekHrv.r >= 0.1 ? `; HRV rises the week after too (r ${nextWeekHrv.r.toFixed(2)})` : ""}.`);
  else if (nw.n >= 40 && nw.r <= -0.1) readings.push(`Heavier training weeks are followed by lower resting HR the week after (r ${nw.r.toFixed(2)}).`);
  const walk = sameWeek["walk"]!;
  if (walk.n >= 40 && walk.r <= -0.1) readings.push(`Walking is the one thing that lowers resting HR in the same week (r ${walk.r.toFixed(2)}): it costs nothing to recover from.`);
  const nothing = byDayType.find((m) => m.label === "Nothing at all"), two = byDayType.find((m) => m.label === "Two or more");
  if (nothing?.rhr && two?.rhr && nothing.rhr.mean >= two.rhr.mean + 0.5 && nothing.hrv && two.hrv && nothing.hrv.mean <= two.hrv.mean - 2) {
    readings.push(`A day with nothing at all is followed by a worse morning than a double session (resting HR ${nothing.rhr.mean.toFixed(1)} vs ${two.rhr.mean.toFixed(1)}, HRV ${nothing.hrv.mean.toFixed(1)} vs ${two.hrv.mean.toFixed(1)}). Read that as cause as much as effect — nobody trains when ill or travelling — but a day off is not, by itself, a recovery signal here; sleep is.`);
  }
  const firstYear = years.find((y) => y.rhr !== undefined && rows.filter((r) => r.date.startsWith(y.year)).length >= 300), lastYear = [...years].reverse().find((y) => y.rhr !== undefined && rows.filter((r) => r.date.startsWith(y.year)).length >= 150);
  if (firstYear && lastYear && firstYear !== lastYear) {
    const parts: string[] = [];
    if (firstYear.rhr !== undefined && lastYear.rhr !== undefined && Math.abs(lastYear.rhr - firstYear.rhr) >= 1) parts.push(`resting HR ${firstYear.rhr} → ${lastYear.rhr}`);
    if (firstYear.kg !== undefined && lastYear.kg !== undefined && Math.abs(lastYear.kg - firstYear.kg) >= 1) parts.push(`weight ${firstYear.kg.toFixed(1)} → ${lastYear.kg.toFixed(1)} kg`);
    if (firstYear.sleepHours !== undefined && lastYear.sleepHours !== undefined && Math.abs(lastYear.sleepHours - firstYear.sleepHours) * 60 >= 10) parts.push(`sleep ${h(firstYear.sleepHours)} → ${h(lastYear.sleepHours)}`);
    if (firstYear.walkMinutesPerWeek !== undefined && lastYear.walkMinutesPerWeek !== undefined && Math.abs(lastYear.walkMinutesPerWeek - firstYear.walkMinutesPerWeek) >= 60) parts.push(`walking ${Math.round(firstYear.walkMinutesPerWeek)} → ${Math.round(lastYear.walkMinutesPerWeek)} min/week`);
    if (parts.length >= 2) readings.push(`The slow drift, ${firstYear.year} → ${lastYear.year} (medians): ${parts.join(", ")}. These move together through the calendar, which is why the weekly figures above are taken with the trend removed.`);
  }
  const recent = weightWithinYear.slice(-2).filter((y) => y.trainingKg.n >= 20 && y.trainingKg.r <= -0.3);
  if (recent.length === 2) readings.push(`Within ${recent.map((y) => y.year).join(" and ")}, weeks with more training are lighter weeks (r ${recent.map((y) => y.trainingKg.r.toFixed(2)).join(", ")}) — the volume-to-weight link holds inside a year, not just across them.`);
  const withRhr = months.filter((m) => m.rhr !== undefined);
  if (withRhr.length === 12) { const worstM = withRhr.reduce((a, b) => (a.rhr! > b.rhr! ? a : b)), bestM = withRhr.reduce((a, b) => (a.rhr! < b.rhr! ? a : b)); if (worstM.rhr! - bestM.rhr! >= 2) readings.push(`Season: resting HR runs highest in ${MONTHS[worstM.month - 1]} (${worstM.rhr!.toFixed(1)}) and lowest in ${MONTHS[bestM.month - 1]} (${bestM.rhr!.toFixed(1)}).`); }
  const wd = weekday.filter((d) => d.sleepHours && d.n >= 30);
  if (wd.length === 7) { const shortD = wd.reduce((a, b) => (a.sleepHours!.mean < b.sleepHours!.mean ? a : b)), longD = wd.reduce((a, b) => (a.sleepHours!.mean > b.sleepHours!.mean ? a : b)); if ((longD.sleepHours!.mean - shortD.sleepHours!.mean) * 60 >= 30) readings.push(`${shortD.label} night is the shortest of the week (${h(shortD.sleepHours!.mean)}${shortD.bedtimeMinutes ? `, bed ${clock(shortD.bedtimeMinutes.mean)}` : ""}); ${longD.label} night the longest (${h(longD.sleepHours!.mean)}).`); }
  if (steps) {
    const low = steps.nextMorning[0]!, high = steps.nextMorning[2]!;
    const bits: string[] = [];
    if (low.rhr && high.rhr && low.n >= 30 && Math.abs(high.rhr.mean - low.rhr.mean) >= 0.4) bits.push(`resting HR the next morning ${high.rhr.mean.toFixed(1)} after a high-step day vs ${low.rhr.mean.toFixed(1)} after a low one`);
    if (low.sleepHours && high.sleepHours && Math.abs(high.sleepHours.mean - low.sleepHours.mean) * 60 >= 8) bits.push(`sleep ${h(high.sleepHours.mean)} vs ${h(low.sleepHours.mean)}`);
    if (low.hrv && high.hrv && Math.abs(high.hrv.mean - low.hrv.mean) >= 1.5) bits.push(`HRV ${high.hrv.mean.toFixed(1)} vs ${low.hrv.mean.toFixed(1)}`);
    readings.push(`Steps: median ${Math.round(steps.median).toLocaleString()} a day over ${steps.days} watch-era days${steps.byYear.length > 1 ? ` (by year: ${steps.byYear.map((y) => `${y.year} ${Math.round(y.median / 100) / 10}k`).join(", ")})` : ""}; ${Math.round(steps.onTrainingDays.mean).toLocaleString()} on training days, ${Math.round(steps.onRestDays.mean).toLocaleString()} on days with nothing. ${bits.length ? `A high-step day (top third) vs a low one: ${bits.join("; ")}.` : "The next morning looks the same after a high-step day as after a low one."}`);
    const sk = steps.sameWeek["kg"]!, sr = steps.sameWeek["rhr"]!, sh = steps.sameWeek["hrv"]!, nk = steps.nextWeek["kg"]!, nr = steps.nextWeek["rhr"]!;
    const wk: string[] = [];
    if (sr.n >= 40 && Math.abs(sr.r) >= 0.1) wk.push(`resting HR ${sr.r < 0 ? "lower" : "higher"} the same week (r ${sr.r.toFixed(2)})${nr.n >= 40 && Math.abs(nr.r) >= 0.1 ? ` and ${nr.r < 0 ? "lower" : "higher"} the next (r ${nr.r.toFixed(2)})` : ""}`);
    if (sh.n >= 40 && Math.abs(sh.r) >= 0.1) wk.push(`HRV ${sh.r > 0 ? "higher" : "lower"} (r ${sh.r.toFixed(2)})`);
    if (sk.n >= 40 && Math.abs(sk.r) >= 0.1) wk.push(`weight ${sk.r < 0 ? "lower" : "higher"} (r ${sk.r.toFixed(2)})${nk.n >= 40 && Math.abs(nk.r) >= 0.1 ? `, and ${nk.r < 0 ? "lower" : "higher"} the week after (r ${nk.r.toFixed(2)})` : ""}`);
    const wy = steps.weightWithinYear.slice(-2).filter((y) => Math.abs(y.r) >= 0.25);
    if (wy.length) wk.push(`within ${wy.map((y) => y.year).join(" and ")}, step-heavy weeks are ${wy.every((y) => y.r < 0) ? "lighter" : "heavier"} weeks (r ${wy.map((y) => y.r.toFixed(2)).join(", ")})`);
    readings.push(wk.length ? `Step-heavy weeks (trend removed): ${wk.join("; ")}.` : `Week to week, steps show no link to resting HR, HRV, sleep or weight once the long-term drift is removed (|r| < 0.1).`);
    if (stepsToRhrNext.n >= 300 && Math.abs(stepsToRhrNext.r) < 0.1 && stepsToSleep.n >= 300 && Math.abs(stepsToSleep.r) < 0.1) readings.push(`A single day's steps do not move the next night or morning (r ${stepsToRhrNext.r.toFixed(2)} to resting HR, ${stepsToSleep.r.toFixed(2)} to sleep).`);
  }
  const dl = daylight.months.filter((m) => m.sleepHours !== undefined && m.sleepN >= 20);
  if (dl.length >= 10) {
    const longest = dl.reduce((a, b) => (a.dayLengthHours > b.dayLengthHours ? a : b)), shortest = dl.reduce((a, b) => (a.dayLengthHours < b.dayLengthHours ? a : b));
    const diff = Math.round((shortest.sleepHours! - longest.sleepHours!) * 60);
    const wk = daylight.wakeVsSunrise, bd = daylight.bedtimeVsSunset;
    const wakeTxt = wk.n >= 100 ? (Math.abs(wk.slope) < 0.1 ? "wake-up time does not follow the sunrise at all (the alarm wins)" : `wake-up time moves ${Math.round(Math.abs(wk.slope) * 60)} min for every hour the sunrise moves`) : "";
    const bedTxt = bd.n >= 100 ? (Math.abs(bd.slope) < 0.1 ? "bedtime ignores the sunset" : `bedtime moves ${Math.round(Math.abs(bd.slope) * 60)} min per hour of sunset`) : "";
    readings.push(`Daylight: in ${MONTHS[longest.month - 1]} (${longest.dayLengthHours.toFixed(1)} h of daylight) you sleep ${h(longest.sleepHours!)}, in ${MONTHS[shortest.month - 1]} (${shortest.dayLengthHours.toFixed(1)} h) ${h(shortest.sleepHours!)} — ${Math.abs(diff) >= 10 ? `${Math.abs(diff)} min ${diff > 0 ? "more in the dark months" : "more in the light months"}` : "no real seasonal swing"} (r ${daylight.sleepVsDayLength.r.toFixed(2)} across ${daylight.sleepVsDayLength.n} nights). ${[wakeTxt, bedTxt].filter(Boolean).join("; ")}.`);
  }
  if (trainToRhrNext.n >= 200 && Math.abs(trainToRhrNext.r) < 0.15 && readings.length) readings.push(`Day to day, a single session barely registers in the next morning (r ${trainToRhrNext.r.toFixed(2)}, n=${trainToRhrNext.n}); the effects here are weekly and nightly, not per workout.`);

  return {
    span: { from: first, to: last, days: rows.length, workouts: workouts.length },
    byDayType, byActivity, lateVsEarly, sleepToRhr, loadToRhr: { sameWeek, nextWeek }, weekday, years, months, weightWithinYear, daylight, ...(steps ? { steps } : {}), readings,
  };
}

function endHour(wl: Workout[], fmt: Intl.DateTimeFormat): number | undefined {
  const hours = wl.map((w) => Date.parse(w.endedAt)).filter(Number.isFinite).map((t) => Number(fmt.format(new Date(t))) % 24);
  return hours.length ? Math.max(...hours) : undefined;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
function avg(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function avgOpt(xs: Array<number | undefined>): number | undefined { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.round(avg(v) * 100) / 100 : undefined; }
function med(xs: number[]): number { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; }
function medOpt(xs: Array<number | undefined>): number | undefined { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.round(med(v) * 100) / 100 : undefined; }
function stat(xs: Array<number | undefined>): Stat | undefined { const v = xs.filter((x): x is number => x !== undefined); return v.length ? { mean: Math.round(avg(v) * 100) / 100, n: v.length } : undefined; }
export function pearson(xs: Array<number | undefined>, ys: Array<number | undefined>): Corr {
  const pts: Array<[number, number]> = []; for (let i = 0; i < Math.min(xs.length, ys.length); i++) if (xs[i] !== undefined && ys[i] !== undefined) pts.push([xs[i]!, ys[i]!]);
  const n = pts.length; if (n < 8) return { r: 0, n };
  const mx = avg(pts.map((p) => p[0])), my = avg(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return { r: sxx && syy ? Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000 : 0, n };
}
function opt<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> { return value === undefined ? {} : ({ [key]: value } as Record<K, V>); }
function strip<R>(o: object): R { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as R; }
