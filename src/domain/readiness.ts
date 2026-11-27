import { BASELINE_DAYS, rateDay, typicalNight, withBaselines, type Rating, type RecoveryDay } from "./recovery.js";
import type { Workout } from "./workout.js";

/**
 * Readiness: how recovered the body is, beside what has been asked of it — kept as two
 * numbers, the way Whoop keeps Recovery and Strain apart. HRV and resting heart rate already
 * react to hard training, so folding load into the recovery score would count it twice.
 * The verdict reads the pair; it never blends them into one score.
 *
 *   recovery  today's rating (`rateDay`) against the ratings of the 60 days before it —
 *             above / usual / below *your* usual, not a fixed cut-off
 *   load      acute:chronic workload ratio — 7-day vs 42-day exponentially weighted
 *             averages of daily effort (ATL / CTL) — fresh / balanced / building / spiking
 *
 * The thresholds are below, each with its reason; change them here and in the README
 * ("Readiness") together.
 */

// ---------------------------------------------------------------------------
// Training load
// ---------------------------------------------------------------------------

export const ACUTE_DAYS = 7;
export const CHRONIC_DAYS = 42;
/** How much history the EWMA needs before its seed of zero has decayed (≈ 0.5 % left). */
export const LOAD_LEAD_IN_DAYS = 180;
/** Days with workouts the chronic window must hold before a ratio means anything. */
const MIN_ACTIVE_DAYS = 10;

/**
 * ACWR bands (Gabbett 2016): under 0.8 the recent week is lighter than the body is used to,
 * 0.8–1.3 the "sweet spot", above 1.5 the spike that injury data clusters behind.
 */
export const LOAD_BANDS = { fresh: 0.8, building: 1.3, spiking: 1.5 } as const;

export type LoadBand = "fresh" | "balanced" | "building" | "spiking";

export interface TrainingLoad {
  /** Acute (7-day) EWMA of daily effort. */
  acute: number;
  /** Chronic (42-day) EWMA of daily effort. */
  chronic: number;
  ratio: number;
  band: LoadBand;
  /** Plain effort totals, for the sentence under the number. */
  last7Effort: number;
  typical7Effort: number;
}

/** One entry per calendar day from `from` to `to` inclusive, zero-filled. Days are the UTC date of the start, as elsewhere. */
export function dailyEffort(workouts: Workout[], from: string, to: string): Array<{ date: string; effort: number }> {
  const byDay = new Map<string, number>();
  for (const w of workouts) { const d = w.startedAt.slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + w.effort); }
  const out: Array<{ date: string; effort: number }> = [];
  for (let d = from; d <= to; d = shift(d, 1)) out.push({ date: d, effort: byDay.get(d) ?? 0 });
  return out;
}

export function loadBand(ratio: number): LoadBand {
  return ratio < LOAD_BANDS.fresh ? "fresh" : ratio <= LOAD_BANDS.building ? "balanced" : ratio <= LOAD_BANDS.spiking ? "building" : "spiking";
}

/** Load as of the end of `asOf` (today's sessions count). Undefined without six weeks of training to compare against. */
export function trainingLoad(workouts: Workout[], asOf: string): TrainingLoad | undefined {
  const days = dailyEffort(workouts, shift(asOf, -LOAD_LEAD_IN_DAYS + 1), asOf);
  const ka = 2 / (ACUTE_DAYS + 1), kc = 2 / (CHRONIC_DAYS + 1);
  let acute = 0, chronic = 0;
  for (const d of days) { acute += ka * (d.effort - acute); chronic += kc * (d.effort - chronic); }
  const chronicWindow = days.slice(-CHRONIC_DAYS);
  if (chronic <= 0 || chronicWindow.filter((d) => d.effort > 0).length < MIN_ACTIVE_DAYS) return undefined;
  const ratio = acute / chronic;
  const sum = (xs: Array<{ effort: number }>) => xs.reduce((n, d) => n + d.effort, 0);
  return {
    acute: round1(acute), chronic: round1(chronic), ratio: Math.round(ratio * 100) / 100, band: loadBand(ratio),
    last7Effort: Math.round(sum(days.slice(-7))),
    typical7Effort: Math.round((sum(chronicWindow) / CHRONIC_DAYS) * 7),
  };
}

// ---------------------------------------------------------------------------
// Recovery against its own history
// ---------------------------------------------------------------------------

export const RELATIVE_WINDOW_DAYS = 60;
const MIN_HISTORY = 14;
/** Half a standard deviation either side is "usual" — about the middle 40 % of your days. */
const Z_BAND = 0.5;
/** A flat history (sd ≈ 0) would turn a two-point wobble into "far above usual"; with this floor "usual" is never narrower than ±3 points. */
const MIN_SD = 6;
/** A rating older than this is not "today" any more; say so instead of pretending. */
export const STALE_AFTER_DAYS = 2;

export type RelativeBand = "above" | "usual" | "below";

export interface RecoveryStatus {
  date: string;
  rating: Rating;
  band?: RelativeBand;
  /** Mean and spread of the ratings it was compared with. */
  usual?: { mean: number; sd: number; days: number };
  z?: number;
  /** Whole days between the rated morning and `asOf`. */
  ageDays: number;
  stale: boolean;
  /** The last seven rated days up to and including this one, oldest first. */
  trend: Array<{ date: string; score: number }>;
}

/** `rated` is every day with a rating, any order. The latest on or before `asOf` is "now". */
export function recoveryStatus(rated: Array<{ date: string; rating: Rating }>, asOf: string): RecoveryStatus | undefined {
  const sorted = rated.filter((d) => d.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted.at(-1);
  if (!latest) return undefined;
  const from = shift(latest.date, -RELATIVE_WINDOW_DAYS);
  const history = sorted.filter((d) => d.date >= from && d.date < latest.date).map((d) => d.rating.score);
  const ageDays = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${latest.date}T00:00:00Z`)) / 86_400_000);
  const base: RecoveryStatus = {
    date: latest.date, rating: latest.rating, ageDays, stale: ageDays > STALE_AFTER_DAYS,
    trend: sorted.slice(-7).map((d) => ({ date: d.date, score: d.rating.score })),
  };
  if (history.length < MIN_HISTORY) return base;
  const mean = history.reduce((n, x) => n + x, 0) / history.length;
  const sd = Math.sqrt(history.reduce((n, x) => n + (x - mean) ** 2, 0) / (history.length - 1));
  const z = (latest.rating.score - mean) / Math.max(sd, MIN_SD);
  return {
    ...base,
    band: z >= Z_BAND ? "above" : z <= -Z_BAND ? "below" : "usual",
    usual: { mean: Math.round(mean), sd: round1(sd), days: history.length },
    z: Math.round(z * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type VerdictTone = "good" | "neutral" | "caution";

export interface Verdict {
  key: string;
  tone: VerdictTone;
  headline: string;
  /** The facts it rests on, one short clause each. */
  because: string[];
}

/** A component scoring under this is the illness tell (respiratory rate, wrist temperature). */
const ILLNESS_COMPONENT_SCORE = 50;

const LOAD_WORDS: Record<LoadBand, string> = {
  fresh: "lighter week than usual",
  balanced: "load in line with the last six weeks",
  building: "load building above the last six weeks",
  spiking: "load well above the last six weeks",
};
const RECOVERY_WORDS: Record<RelativeBand, string> = {
  above: "recovery above your usual",
  usual: "recovery about usual",
  below: "recovery below your usual",
};

/**
 * One rule per cell of recovery band × load band; either side may be missing (no nights,
 * or under six weeks of training) and the verdict then rests on the other alone. A stale
 * rating is not used — yesterday-but-two's night says nothing about today.
 */
export function readinessVerdict(recovery: RecoveryStatus | undefined, load: TrainingLoad | undefined): Verdict | undefined {
  const r = recovery && !recovery.stale ? recovery.band : undefined;
  const l = load?.band;
  const because = [...(r ? [RECOVERY_WORDS[r]] : []), ...(l ? [LOAD_WORDS[l]] : [])];

  const ill = recovery && !recovery.stale
    ? recovery.rating.components.filter((c) => (c.key === "resp" || c.key === "temp") && c.score < ILLNESS_COMPONENT_SCORE)
    : [];
  if (ill.length) {
    return { key: "illness", tone: "caution", headline: "Something may be brewing — keep it easy", because: [...ill.map((c) => `${c.label.toLowerCase()} up (${c.detail})`), ...because] };
  }

  const v = (key: string, tone: VerdictTone, headline: string): Verdict => ({ key, tone, headline, because });
  if (r === "below" && (l === "building" || l === "spiking")) return v("ease-off", "caution", "Ease off — under-recovered while load climbs");
  if (r === "below") return v("take-it-easy", "caution", "Take it easy — body signals are below your usual");
  if (l === "spiking") return v("hold-back", "caution", r ? "Hold back — load has spiked, even if you feel fine" : "Hold back — load has spiked");
  if (r === "above" && l === "building") return v("absorbing", "good", "Absorbing the load well — keep going");
  if (r === "above") return v("push", "good", "Good day to push");
  if (r === "usual" && l === "fresh") return v("room", "good", "Fresh — room for a harder session");
  if (r === "usual" && l === "building") return v("building", "neutral", "Building — keep an eye on recovery");
  if (r === "usual") return v("as-planned", "neutral", "Train as planned");
  // Load only: no rated night recently.
  if (l === "fresh") return v("room", "good", "Fresh — room for a harder session");
  if (l === "building") return v("building", "neutral", "Building — keep an eye on recovery");
  if (l === "balanced") return v("as-planned", "neutral", "Train as planned");
  return undefined;
}

export interface Readiness {
  asOf: string;
  recovery?: RecoveryStatus;
  load?: TrainingLoad;
  verdict?: Verdict;
}

/** The typical night is the quarter before `asOf`, as on the Recovery page with a range ending today. */
export const TYPICAL_DAYS = 90;

/** How far back the recovery rows must reach: the comparison window, its baselines, and the typical night. */
export const READINESS_LEAD_IN_DAYS = RELATIVE_WINDOW_DAYS + 7 + Math.max(BASELINE_DAYS, TYPICAL_DAYS);

/** Everything the dashboard's "Today" card shows, from rows reaching back {@link READINESS_LEAD_IN_DAYS} and workouts {@link LOAD_LEAD_IN_DAYS}. */
export function readiness(days: RecoveryDay[], workouts: Workout[], asOf: string): Readiness {
  const known = days.filter((d) => d.date <= asOf);
  const typical = typicalNight(known.filter((d) => d.date > shift(asOf, -TYPICAL_DAYS)));
  const rated = withBaselines(known).flatMap((d) => { const rating = rateDay(d, typical); return rating ? [{ date: d.date, rating }] : []; });
  const recovery = recoveryStatus(rated, asOf);
  const load = trainingLoad(workouts, asOf);
  const verdict = readinessVerdict(recovery, load);
  return { asOf, ...(recovery ? { recovery } : {}), ...(load ? { load } : {}), ...(verdict ? { verdict } : {}) };
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
