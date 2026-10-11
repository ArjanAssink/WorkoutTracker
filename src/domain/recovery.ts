import { localDay } from "./bodyWeight.js";
import { startOfIsoWeek } from "./summary.js";
import type { Workout } from "./workout.js";

/**
 * Recovery: sleep, resting heart rate, heart-rate variability and the other overnight
 * signals the watch records, reduced to one row per day.
 *
 * The day of a night's sleep is the morning it ended on — "last night" on the 11th is the
 * row dated the 11th — and the overnight measurements (respiratory rate, wrist temperature,
 * breathing disturbances) file under the same morning. Daytime readings (resting heart
 * rate, HRV, SpO₂, daylight) file under the calendar day they were taken.
 */

export type RecoverySource = "health-export" | "health-auto-export";

export type SleepStage = "inBed" | "asleep" | "core" | "deep" | "rem" | "awake";

export type RecoveryMetric =
  | "sleep" | "restingHeartRate" | "hrv" | "respiratoryRate" | "spo2"
  | "wristTemperature" | "breathingDisturbances" | "daylight";

/** A raw record as the sources give it; `stage` only for sleep. */
export interface RecoverySample {
  metric: RecoveryMetric;
  /** As given — Apple's `2026-10-08 02:02:21 +0200` or ISO. */
  start: string;
  end: string;
  value: number;
  stage?: SleepStage;
  sourceName?: string;
}

/** A night already summarised by the source (Health Auto Export does this). Hours. */
export interface NightSummary {
  /** Any instant on the morning the night ended. */
  end: string;
  start?: string;
  inBedHours?: number;
  asleepHours?: number;
  coreHours?: number;
  deepHours?: number;
  remHours?: number;
  awakeHours?: number;
  sourceName?: string;
}

export interface RecoveryDay {
  date: string;
  sleepInBedSeconds?: number;
  sleepAsleepSeconds?: number;
  sleepCoreSeconds?: number;
  sleepDeepSeconds?: number;
  sleepRemSeconds?: number;
  sleepAwakeSeconds?: number;
  /** Awake segments between falling asleep and the final wake-up. */
  sleepAwakenings?: number;
  /** First asleep, ISO UTC. */
  sleepStart?: string;
  sleepEnd?: string;
  /** Local wall-clock minutes after midnight; bedtime past midnight is 24h + minutes so a median works. */
  bedtimeMinutes?: number;
  wakeMinutes?: number;
  /** Deep and REM were measured, not just in-bed time. */
  sleepStaged?: boolean;
  sleepSourceName?: string;
  restingHeartRate?: number;
  hrv?: number;
  hrvSamples?: number;
  respiratoryRate?: number;
  spo2?: number;
  wristTemperature?: number;
  breathingDisturbances?: number;
  daylightMinutes?: number;
  source: RecoverySource;
  recordedAt: string;
}

/** A sleep that starts after this local hour belongs to the next morning. */
const NIGHT_SHIFT_HOURS = 9;
const MIN_NIGHT_SECONDS = 30 * 60;
const MIN_AWAKENING_SECONDS = 60;

/** The morning a sleep segment belongs to: its start shifted forward nine hours, by wall clock. */
export function nightOf(at: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(at.trim());
  if (!m) return localDay(at);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) + NIGHT_SHIFT_HOURS, Number(m[5]));
  return new Date(wall).toISOString().slice(0, 10);
}

/** Minutes after local midnight, from the wall clock in the string; bedtimes before 18:00 count as after midnight. */
function wallMinutes(at: string, evening: boolean): number | undefined {
  const m = /[ T](\d{2}):(\d{2})/.exec(at.trim());
  if (!m) return undefined;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return evening && minutes < 18 * 60 ? minutes + 24 * 60 : minutes;
}

export function parseInstant(at: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})?$/.exec(at.trim());
  const t = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? "00"}`) : Date.parse(at);
  return Number.isNaN(t) ? undefined : t;
}

interface NightBuild {
  bySource: Map<string, RecoverySample[]>;
}

/**
 * One row per day from raw samples and/or pre-summarised nights. Where two sources cover
 * the same night — the watch with stages and the phone with in-bed time — the one with
 * stages wins outright; summing both would count every hour twice.
 */
export function dailyRecovery(
  input: { samples?: Iterable<RecoverySample>; nights?: Iterable<NightSummary> },
  source: RecoverySource,
  now: Date = new Date(),
): RecoveryDay[] {
  const days = new Map<string, Partial<RecoveryDay>>();
  const day = (date: string): Partial<RecoveryDay> => days.get(date) ?? days.set(date, {}).get(date)!;
  const nights = new Map<string, NightBuild>();
  const means = new Map<string, { sum: number; n: number }>();
  const mean = (key: string, value: number) => { const m = means.get(key) ?? { sum: 0, n: 0 }; m.sum += value; m.n += 1; means.set(key, m); };

  for (const s of input.samples ?? []) {
    if (!Number.isFinite(s.value)) continue;
    switch (s.metric) {
      case "sleep": {
        const key = nightOf(s.start);
        if (!key || !s.stage) break;
        const night = nights.get(key) ?? nights.set(key, { bySource: new Map() }).get(key)!;
        const src = s.sourceName ?? "";
        (night.bySource.get(src) ?? night.bySource.set(src, []).get(src)!).push(s);
        break;
      }
      case "restingHeartRate": { const d = localDay(s.start); if (d && s.value > 20 && s.value < 150) day(d).restingHeartRate = Math.round(s.value); break; }
      case "hrv": { const d = localDay(s.start); if (d && s.value > 0 && s.value < 400) mean(`hrv|${d}`, s.value); break; }
      case "respiratoryRate": { const d = nightOf(s.start); if (d && s.value > 4 && s.value < 40) mean(`resp|${d}`, s.value); break; }
      case "spo2": { const d = localDay(s.start); const pct = s.value <= 1 ? s.value * 100 : s.value; if (d && pct > 50 && pct <= 100) mean(`spo2|${d}`, pct); break; }
      case "wristTemperature": { const d = nightOf(s.start); if (d && s.value > 30 && s.value < 42) day(d).wristTemperature = Math.round(s.value * 100) / 100; break; }
      case "breathingDisturbances": { const d = nightOf(s.start); if (d && s.value >= 0) day(d).breathingDisturbances = Math.round(s.value * 10) / 10; break; }
      case "daylight": { const d = localDay(s.start); if (d && s.value >= 0) day(d).daylightMinutes = (day(d).daylightMinutes ?? 0) + s.value; break; }
    }
  }

  for (const [key, m] of means) {
    const [metric, date] = key.split("|") as [string, string];
    const v = m.sum / m.n;
    if (metric === "hrv") { day(date).hrv = Math.round(v * 10) / 10; day(date).hrvSamples = m.n; }
    else if (metric === "resp") day(date).respiratoryRate = Math.round(v * 10) / 10;
    else if (metric === "spo2") day(date).spo2 = Math.round(v * 10) / 10;
  }

  for (const [date, night] of nights) {
    const summary = summariseNight(night);
    if (summary) Object.assign(day(date), summary);
  }

  for (const n of input.nights ?? []) {
    const date = localDay(n.end);
    if (!date) continue;
    const asleep = n.asleepHours ?? ((n.coreHours ?? 0) + (n.deepHours ?? 0) + (n.remHours ?? 0));
    if (!(asleep * 3600 >= MIN_NIGHT_SECONDS)) continue;
    const d = day(date);
    const sec = (h: number | undefined) => (h === undefined ? undefined : Math.round(h * 3600));
    Object.assign(d, strip({
      sleepAsleepSeconds: Math.round(asleep * 3600), sleepInBedSeconds: sec(n.inBedHours), sleepCoreSeconds: sec(n.coreHours),
      sleepDeepSeconds: sec(n.deepHours), sleepRemSeconds: sec(n.remHours), sleepAwakeSeconds: sec(n.awakeHours),
      sleepStaged: (n.deepHours ?? 0) + (n.remHours ?? 0) > 0,
      sleepStart: n.start ? iso(n.start) : undefined, sleepEnd: iso(n.end),
      bedtimeMinutes: n.start ? wallMinutes(n.start, true) : undefined, wakeMinutes: wallMinutes(n.end, false),
      sleepSourceName: n.sourceName,
    }));
  }

  return [...days.entries()]
    .filter(([, d]) => Object.keys(d).length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, ...d, source, recordedAt: now.toISOString() }) as RecoveryDay);
}

function summariseNight(night: NightBuild): Partial<RecoveryDay> | undefined {
  // Prefer the source with stage detail; among those, the one that saw the most sleep.
  let best: { samples: RecoverySample[]; staged: boolean; asleep: number } | undefined;
  for (const samples of night.bySource.values()) {
    const staged = samples.some((s) => s.stage === "deep" || s.stage === "rem" || s.stage === "core");
    const asleep = samples.filter((s) => s.stage !== "inBed" && s.stage !== "awake").reduce((n, s) => n + seconds(s), 0);
    if (!best || (staged && !best.staged) || (staged === best.staged && asleep > best.asleep)) best = { samples, staged, asleep };
  }
  if (!best) return undefined;
  const by = (stage: SleepStage) => best!.samples.filter((s) => s.stage === stage).reduce((n, s) => n + seconds(s), 0);
  const asleepSegments = best.samples.filter((s) => s.stage !== "inBed" && s.stage !== "awake").sort((a, b) => (parseInstant(a.start) ?? 0) - (parseInstant(b.start) ?? 0));
  const asleep = best.asleep;
  const inBedSegments = best.samples.filter((s) => s.stage === "inBed").sort((a, b) => (parseInstant(a.start) ?? 0) - (parseInstant(b.start) ?? 0));
  if (asleepSegments.length === 0) {
    // Only in-bed time (the pre-watch years): a span, not a measurement of sleep.
    const inBed = by("inBed");
    if (inBed < MIN_NIGHT_SECONDS) return undefined;
    const first = inBedSegments[0]!, last = inBedSegments[inBedSegments.length - 1]!;
    return strip({
      sleepInBedSeconds: Math.round(inBed), sleepStaged: false, sleepSourceName: first.sourceName,
      sleepStart: iso(first.start), sleepEnd: iso(last.end),
      bedtimeMinutes: wallMinutes(first.start, true), wakeMinutes: wallMinutes(last.end, false),
    });
  }
  if (asleep < MIN_NIGHT_SECONDS) return undefined;
  const first = asleepSegments[0]!, last = asleepSegments[asleepSegments.length - 1]!;
  const firstT = parseInstant(first.start) ?? 0, lastT = parseInstant(last.end) ?? 0;
  const awakenings = best.samples.filter((s) => s.stage === "awake" && seconds(s) >= MIN_AWAKENING_SECONDS && (parseInstant(s.start) ?? 0) > firstT && (parseInstant(s.end) ?? 0) < lastT).length;
  const inBed = by("inBed");
  return strip({
    sleepAsleepSeconds: Math.round(asleep),
    sleepInBedSeconds: Math.round(inBed > 0 ? inBed : (lastT - firstT) / 1000),
    sleepCoreSeconds: best.staged ? Math.round(by("core")) : undefined,
    sleepDeepSeconds: best.staged ? Math.round(by("deep")) : undefined,
    sleepRemSeconds: best.staged ? Math.round(by("rem")) : undefined,
    sleepAwakeSeconds: Math.round(by("awake")),
    sleepAwakenings: awakenings,
    sleepStart: new Date(firstT).toISOString(), sleepEnd: new Date(lastT).toISOString(),
    bedtimeMinutes: wallMinutes(first.start, true), wakeMinutes: wallMinutes(last.end, false),
    sleepStaged: best.staged,
    sleepSourceName: first.sourceName,
  });
}

function seconds(s: RecoverySample): number {
  const a = parseInstant(s.start), b = parseInstant(s.end);
  return a === undefined || b === undefined || b <= a ? 0 : (b - a) / 1000;
}

function iso(at: string): string | undefined {
  const t = parseInstant(at);
  return t === undefined ? undefined : new Date(t).toISOString();
}

/** Drops undefined values so optional fields are absent rather than present-and-undefined. */
function strip<R = Partial<RecoveryDay>>(o: object): R {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as R;
}

// ---------------------------------------------------------------------------
// Reading it back: baselines and the weekly join with training load
// ---------------------------------------------------------------------------

export const BASELINE_DAYS = 28;

export interface RecoveryDayView extends RecoveryDay {
  /** Median of the previous 28 days with a value, so a day can be read as above or below its own normal. */
  restingHeartRateBaseline?: number;
  hrvBaseline?: number;
  wristTemperatureBaseline?: number;
}

export function withBaselines(days: RecoveryDay[], window = BASELINE_DAYS): RecoveryDayView[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const base = (i: number, pick: (d: RecoveryDay) => number | undefined): number | undefined => {
    const from = shiftDate(sorted[i]!.date, -window);
    const values: number[] = [];
    for (let j = i - 1; j >= 0 && sorted[j]!.date >= from; j--) { const v = pick(sorted[j]!); if (v !== undefined) values.push(v); }
    return values.length >= 7 ? Math.round(median(values) * 10) / 10 : undefined;
  };
  return sorted.map((d, i) => strip<RecoveryDayView>({
    ...d,
    restingHeartRateBaseline: base(i, (x) => x.restingHeartRate),
    hrvBaseline: base(i, (x) => x.hrv),
    wristTemperatureBaseline: base(i, (x) => x.wristTemperature),
  }));
}

export interface WeekRecovery {
  weekStart: string;
  sessions: number;
  effort: number;
  nights: number;
  asleepSeconds?: number;
  deepPct?: number;
  remPct?: number;
  awakenings?: number;
  /** Circular standard deviation of bedtime, minutes — the consistency figure. */
  bedtimeSdMinutes?: number;
  bedtimeMinutes?: number;
  restingHeartRate?: number;
  hrv?: number;
}

/** Each ISO week from `from` to `to`: training load from the workouts beside how the nights went. */
export function weeklyRecovery(days: RecoveryDay[], workouts: Workout[], from: Date, to: Date): WeekRecovery[] {
  const weeks = new Map<string, { days: RecoveryDay[]; sessions: number; effort: number }>();
  for (const c = startOfIsoWeek(from); c < to; c.setUTCDate(c.getUTCDate() + 7)) weeks.set(c.toISOString().slice(0, 10), { days: [], sessions: 0, effort: 0 });
  const keyOf = (date: string) => startOfIsoWeek(new Date(`${date}T12:00:00Z`)).toISOString().slice(0, 10);
  for (const d of days) weeks.get(keyOf(d.date))?.days.push(d);
  for (const w of workouts) { const k = weeks.get(keyOf(w.startedAt.slice(0, 10))); if (k) { k.sessions += 1; k.effort += w.effort; } }
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, w]) => {
    const nights = w.days.filter((d) => d.sleepAsleepSeconds !== undefined);
    const avg = (pick: (d: RecoveryDay) => number | undefined): number | undefined => {
      const v = w.days.map(pick).filter((x): x is number => x !== undefined);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
    };
    const asleep = avg((d) => d.sleepAsleepSeconds);
    const staged = nights.filter((d) => d.sleepStaged);
    const pct = (pick: (d: RecoveryDay) => number | undefined) => {
      if (!staged.length) return undefined;
      const num = staged.reduce((n, d) => n + (pick(d) ?? 0), 0), den = staged.reduce((n, d) => n + (d.sleepAsleepSeconds ?? 0), 0);
      return den ? Math.round((num / den) * 1000) / 10 : undefined;
    };
    const bed = w.days.map((d) => d.bedtimeMinutes).filter((x): x is number => x !== undefined);
    return strip<WeekRecovery>({
      weekStart, sessions: w.sessions, effort: Math.round(w.effort * 10) / 10, nights: nights.length,
      asleepSeconds: asleep === undefined ? undefined : Math.round(asleep),
      deepPct: pct((d) => d.sleepDeepSeconds), remPct: pct((d) => d.sleepRemSeconds),
      awakenings: round1(avg((d) => d.sleepAwakenings)),
      bedtimeSdMinutes: bed.length >= 3 ? Math.round(circularSd(bed)) : undefined,
      bedtimeMinutes: bed.length ? Math.round(median(bed)) : undefined,
      restingHeartRate: round1(avg((d) => d.restingHeartRate)), hrv: round1(avg((d) => d.hrv)),
    });
  });
}

/** Standard deviation of times of day, treating 23:50 and 00:10 as twenty minutes apart. */
export function circularSd(minutes: number[]): number {
  if (minutes.length < 2) return 0;
  const toAngle = (m: number) => ((m % 1440) / 1440) * 2 * Math.PI;
  const c = minutes.reduce((s, m) => s + Math.cos(toAngle(m)), 0) / minutes.length;
  const s = minutes.reduce((t, m) => t + Math.sin(toAngle(m)), 0) / minutes.length;
  const r = Math.min(1, Math.hypot(c, s));
  if (r === 0) return 720;
  return (Math.sqrt(-2 * Math.log(r)) / (2 * Math.PI)) * 1440;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const round1 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);

// ---------------------------------------------------------------------------
// The recovery rating
// ---------------------------------------------------------------------------

/**
 * A 0–100 rating from the day's signals, each scored against the lifter's own normal and
 * weighted; a component without data drops out and the rest are renormalised, so a night
 * without an HRV reading is still rated, just on less. The breakdown is part of the result
 * because a number alone invites arguing with it.
 *
 *   sleep duration   vs the 90-day typical night   100 at typical, 0 at half of it
 *   HRV              vs the 28-day baseline         100 at baseline, 0 at −40%
 *   resting HR       vs the 28-day baseline         100 at baseline, 0 at +10 bpm
 *   wake-ups         vs the typical count           −12 per extra wake-up
 *   respiratory rate vs the typical                 −25 per breath/min above (illness tell)
 *   wrist temperature vs the 28-day baseline        −40 per +0.5 °C (same)
 *
 * Better-than-baseline never scores above 100: being well rested is the ceiling, not a bonus.
 */
export type RatingLabel = "recovered" | "okay" | "under-recovered" | "run down";

export interface RatingComponent {
  key: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface Rating {
  score: number;
  label: RatingLabel;
  components: RatingComponent[];
}

export interface TypicalNight {
  asleepSeconds?: number | undefined;
  awakenings?: number | undefined;
  respiratoryRate?: number | undefined;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function ratingLabel(score: number): RatingLabel {
  return score >= 80 ? "recovered" : score >= 65 ? "okay" : score >= 50 ? "under-recovered" : "run down";
}

export function rateDay(day: RecoveryDayView, typical: TypicalNight): Rating | undefined {
  const parts: RatingComponent[] = [];
  if (day.sleepAsleepSeconds !== undefined && typical.asleepSeconds) {
    const ratio = day.sleepAsleepSeconds / typical.asleepSeconds;
    const diff = Math.round((day.sleepAsleepSeconds - typical.asleepSeconds) / 60);
    parts.push({ key: "sleep", label: "Sleep", score: clamp(((ratio - 0.5) / 0.5) * 100), weight: 30, detail: `${diff >= 0 ? "+" : "−"}${Math.abs(diff)} min vs typical` });
  }
  if (day.hrv !== undefined && day.hrvBaseline) {
    const pct = ((day.hrv - day.hrvBaseline) / day.hrvBaseline) * 100;
    parts.push({ key: "hrv", label: "HRV", score: clamp(100 + pct * 2.5), weight: 25, detail: `${pct >= 0 ? "+" : ""}${Math.round(pct)}% vs baseline` });
  }
  if (day.restingHeartRate !== undefined && day.restingHeartRateBaseline !== undefined) {
    const delta = day.restingHeartRate - day.restingHeartRateBaseline;
    parts.push({ key: "rhr", label: "Resting HR", score: clamp(100 - delta * 10), weight: 25, detail: `${delta > 0 ? "+" : ""}${Math.round(delta * 10) / 10} bpm vs baseline` });
  }
  if (day.sleepAwakenings !== undefined && typical.awakenings !== undefined) {
    const extra = day.sleepAwakenings - typical.awakenings;
    parts.push({ key: "wakeups", label: "Wake-ups", score: clamp(100 - extra * 12), weight: 10, detail: `${day.sleepAwakenings} vs typical ${typical.awakenings}` });
  }
  if (day.respiratoryRate !== undefined && typical.respiratoryRate !== undefined) {
    const above = day.respiratoryRate - typical.respiratoryRate;
    parts.push({ key: "resp", label: "Respiratory rate", score: clamp(100 - above * 25), weight: 5, detail: `${above >= 0 ? "+" : ""}${Math.round(above * 10) / 10}/min vs typical` });
  }
  if (day.wristTemperature !== undefined && day.wristTemperatureBaseline !== undefined) {
    const above = day.wristTemperature - day.wristTemperatureBaseline;
    parts.push({ key: "temp", label: "Wrist temperature", score: clamp(100 - above * 80), weight: 5, detail: `${above >= 0 ? "+" : ""}${Math.round(above * 100) / 100} °C vs baseline` });
  }
  // Sleep plus at least one heart signal, or there is no rating — a bare wake-up count is not recovery.
  if (!parts.some((p) => p.key === "sleep") || !parts.some((p) => p.key === "hrv" || p.key === "rhr")) return undefined;
  return combine(parts);
}

/**
 * The week: the mean of its daily ratings, with bedtime consistency as a seventh component —
 * a regular week recovers better than the same hours slept at random times.
 */
export function rateWeek(ratings: Rating[], bedtimeSdMinutes: number | undefined): Rating | undefined {
  if (ratings.length < 3) return undefined;
  const keys = [...new Set(ratings.flatMap((r) => r.components.map((c) => c.key)))];
  const parts: RatingComponent[] = keys.map((key) => {
    const cs = ratings.flatMap((r) => r.components.filter((c) => c.key === key));
    return { key, label: cs[0]!.label, score: Math.round(cs.reduce((n, c) => n + c.score, 0) / cs.length), weight: cs[0]!.weight, detail: `${cs.length} day${cs.length === 1 ? "" : "s"}` };
  });
  if (bedtimeSdMinutes !== undefined) {
    parts.push({ key: "consistency", label: "Bedtime consistency", score: clamp(100 - Math.max(0, bedtimeSdMinutes - 30) * (100 / 90)), weight: 15, detail: `±${bedtimeSdMinutes} min` });
  }
  return combine(parts);
}

function combine(parts: RatingComponent[]): Rating {
  const weight = parts.reduce((n, p) => n + p.weight, 0);
  const score = Math.round(parts.reduce((n, p) => n + p.score * p.weight, 0) / weight);
  return { score, label: ratingLabel(score), components: parts.map((p) => ({ ...p, score: Math.round(p.score) })) };
}
