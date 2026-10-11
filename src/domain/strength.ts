/**
 * Strength tracking: lifts, one-rep-max estimation, bodyweight normalisation, and
 * progression within a training block.
 *
 * Pure, like the rest of the domain. The one modelling opinion here that matters: a
 * generic rep→1RM formula assumes a textbook fatigue profile, and this lifter's own
 * rep-max board shows a flatter one (a 10RM at 85% of the 1RM where Epley assumes 75%).
 * So the estimate used for comparison is fitted to the lifter's own data per lift, and
 * every estimate says which model produced it.
 */

// ---------------------------------------------------------------------------
// Lifts and families
// ---------------------------------------------------------------------------

export type LiftFamily = "squat" | "bench" | "deadlift" | "press" | "pull" | "row" | "other";

export interface Lift {
  slug: string;
  label: string;
  family: LiftFamily;
}

/**
 * Name → lift, in order; the first match wins, so put the more specific pattern first.
 * Names come from spreadsheets written by hand over twelve years — "Bow Bar" and
 * "Buffalo Bar" are the same bar, exercise rows carry "TM" suffixes and list numbers.
 */
const LIFT_RULES: Array<[RegExp, Lift]> = [
  [/deep.*ssb.*(band|red)/i, { slug: "ssb-squat-deep-banded", label: "Deep SSB squat (banded)", family: "squat" }],
  [/deep.*ssb.*handle/i, { slug: "ssb-squat-deep-handles-up", label: "Deep SSB squat (handles up)", family: "squat" }],
  [/deep.*ssb/i, { slug: "ssb-squat-deep", label: "Deep SSB squat", family: "squat" }],
  [/parallel.*ssb|ssb.*parallel/i, { slug: "ssb-squat", label: "SSB squat", family: "squat" }],
  [/safety squat bar|\bssb\b.*squat/i, { slug: "ssb-squat", label: "SSB squat", family: "squat" }],
  [/ssb.*good ?morning/i, { slug: "ssb-good-morning", label: "SSB good morning", family: "deadlift" }],
  [/upright ssb|ssb.*upright/i, { slug: "ssb-squat-upright", label: "Upright SSB squat", family: "squat" }],
  [/belt squat/i, { slug: "belt-squat", label: "Belt squat", family: "squat" }],
  [/\bbg\b.*split|bulgarian|rear.?foot.*(elevated|split)/i, { slug: "bulgarian-split-squat", label: "Bulgarian split squat", family: "squat" }],
  [/straight bar.*squat|^squat$|back squat/i, { slug: "squat", label: "Back squat", family: "squat" }],
  [/close ?grip.*(bow|buffalo)/i, { slug: "close-grip-buffalo-bench", label: "Close-grip buffalo bar bench", family: "bench" }],
  [/close ?grip/i, { slug: "close-grip-bench", label: "Close-grip bench", family: "bench" }],
  [/bow bar|buffalo/i, { slug: "buffalo-bench", label: "Buffalo bar bench", family: "bench" }],
  [/\brb\b.*incline/i, { slug: "rb-incline-bench", label: "RB incline bench", family: "bench" }],
  [/incline.*db|db.*incline/i, { slug: "incline-db-press", label: "Incline DB press", family: "bench" }],
  [/straight bar.*bench|^bench$|bench press/i, { slug: "bench", label: "Bench press", family: "bench" }],
  [/\bsg\b.*rdl|snatch.*grip.*rdl/i, { slug: "sg-rdl", label: "Snatch-grip RDL", family: "deadlift" }],
  [/\brdl\b|romanian/i, { slug: "rdl", label: "Romanian deadlift", family: "deadlift" }],
  [/deadlift/i, { slug: "deadlift", label: "Deadlift", family: "deadlift" }],
  [/db.*ohp|dumbbell.*(ohp|overhead)/i, { slug: "db-ohp", label: "DB overhead press", family: "press" }],
  [/\bohp\b|overhead press/i, { slug: "ohp", label: "Overhead press", family: "press" }],
  // Pull-ups: the logged weight is *added* load; 0 is bodyweight. Assisted stays separate —
  // its number is assistance, not load, and has no place on a strength chart.
  [/assist.*(pull|chin)/i, { slug: "assisted-pull-up", label: "Assisted pull-up", family: "pull" }],
  [/chin.?ups?/i, { slug: "chin-up", label: "Chin-up", family: "pull" }],
  [/pull.?ups?/i, { slug: "pull-up", label: "Pull-up", family: "pull" }],
  [/t-?bar row/i, { slug: "t-bar-row", label: "T-bar row", family: "row" }],
  [/landmine row/i, { slug: "landmine-row", label: "One-arm landmine row", family: "row" }],
];

/** Strips the decoration a hand-written exercise row carries: list numbers, "TM", spacing. */
export function cleanLiftName(raw: string): string {
  return raw.replace(/^\s*\d+\.\s*/, "").replace(/\s*\bTM\b\s*$/i, "").replace(/\s+/g, " ").trim();
}

export function resolveLift(raw: string): Lift {
  const name = cleanLiftName(raw);
  for (const [pattern, lift] of LIFT_RULES) if (pattern.test(name)) return lift;
  // Unknown lifts stay distinct rather than vanishing into "other", same as activities.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
  return { slug, label: name || "Unknown", family: "other" };
}

// ---------------------------------------------------------------------------
// One-rep-max estimation
// ---------------------------------------------------------------------------

export type Estimator = "wendler" | "personal";

/** Wendler's `w × reps × 0.0333 + w`, which is Epley (`w × (1 + reps/30)`) to 0.1%. */
export function wendler(kg: number, reps: number): number {
  return reps <= 1 ? kg : kg * (1 + 0.0333 * reps);
}

/**
 * A per-lift fatigue curve of the same shape as Epley — `1RM = w × (1 + k × reps)` — with
 * `k` fitted to the lifter's own rep maxes instead of the textbook 0.0333.
 *
 * Fitting needs an anchor. A logged single is the anchor when there is one; otherwise the
 * lowest-rep entry, taken through Wendler, stands in. Each other point then implies a `k`,
 * and the median of those is the curve — a median because a stale rep max or one great
 * day should not bend the whole curve.
 */
export interface PersonalCurve {
  k: number;
  anchorKg: number;
  anchorReps: number;
  points: number;
}

export const MIN_POINTS_FOR_CURVE = 3;

export function fitPersonalCurve(repMaxes: Array<{ reps: number; kg: number }>): PersonalCurve | undefined {
  const pts = repMaxes.filter((p) => p.reps >= 1 && p.kg > 0).sort((a, b) => a.reps - b.reps);
  if (pts.length < MIN_POINTS_FOR_CURVE) return undefined;
  const anchor = pts[0]!;
  const oneRm = anchor.reps === 1 ? anchor.kg : wendler(anchor.kg, anchor.reps);
  const ks = pts
    .filter((p) => p.reps > anchor.reps)
    .map((p) => (oneRm / p.kg - 1) / p.reps)
    .filter((k) => Number.isFinite(k) && k > 0);
  if (ks.length < MIN_POINTS_FOR_CURVE - 1) return undefined;
  return { k: median(ks), anchorKg: anchor.kg, anchorReps: anchor.reps, points: pts.length };
}

export function personal(kg: number, reps: number, curve: PersonalCurve): number {
  return reps <= 1 ? kg : kg * (1 + curve.k * reps);
}

export interface Estimate {
  e1rm: number;
  estimator: Estimator;
  /** Rep counts past ten are extrapolation for any formula; say so. */
  lowConfidence: boolean;
}

export function estimate1Rm(kg: number, reps: number, curve: PersonalCurve | undefined): Estimate {
  const value = curve ? personal(kg, reps, curve) : wendler(kg, reps);
  return { e1rm: Math.round(value * 10) / 10, estimator: curve ? "personal" : "wendler", lowConfidence: reps > 10 };
}

/**
 * A set stopped with reps in reserve is read as the set it would have been at failure:
 * 5 reps at 2 RIR estimates like a 7. The log states RIR for working sets, so that is how
 * a block's sets become comparable with the to-failure PRs — flagged, because an RIR is a
 * judgement call and the estimate inherits it.
 */
export function repsToFailure(reps: number, rir: number | undefined): number {
  return reps + Math.max(0, Math.min(rir ?? 0, 5));
}

/**
 * The set of a session that implies the highest 1RM. Bodyweight lifts hand in the load
 * they were done with (bodyweight plus whatever hung from the belt); the caller decides
 * what to show. Myo-rep match sets are not top sets, and a set without a load cannot be.
 */
export function topSet<T extends { kg: number | undefined; reps: number; myo?: boolean }>(
  sets: T[], rir: number | undefined, curve: PersonalCurve | undefined,
): { set: T; e1rm: number; estimator: Estimator; reps: number } | undefined {
  let best: { set: T; e1rm: number; estimator: Estimator; reps: number } | undefined;
  for (const set of sets) {
    if (set.myo || set.kg === undefined || set.kg <= 0 || set.reps <= 0) continue;
    const reps = repsToFailure(set.reps, rir);
    const est = estimate1Rm(set.kg, reps, curve);
    if (!best || est.e1rm > best.e1rm) best = { set, e1rm: est.e1rm, estimator: est.estimator, reps };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Bodyweight normalisation
// ---------------------------------------------------------------------------

/** Plain ratio, and the allometric form that exercise physiology prefers for comparing sizes. */
export function relativeStrength(kg: number, bodyweightKg: number): { ratio: number; allometric: number } {
  return { ratio: kg / bodyweightKg, allometric: kg / Math.pow(bodyweightKg, 2 / 3) };
}

/**
 * DOTS (2019), the bodyweight-normalised score powerlifting currently uses. Applied here to
 * a single lift rather than a total, which is fine for tracking one person over time —
 * the coefficient depends only on bodyweight. Coefficients are the published male set;
 * a 100 kg lift at 85 kg bodyweight scores ≈66.6, which matches the reference tables.
 */
const DOTS_MALE = [-307.75076, 24.0900756, -0.1918759221, 0.0007391293, -0.000001093];
const DOTS_FEMALE = [-57.96288, 13.6175032, -0.1126655495, 0.0005158568, -0.0000010706];

export function dots(kg: number, bodyweightKg: number, sex: "male" | "female" = "male"): number {
  const c = sex === "male" ? DOTS_MALE : DOTS_FEMALE;
  const bw = Math.min(Math.max(bodyweightKg, 40), 210);
  const denominator = c[0]! + c[1]! * bw + c[2]! * bw ** 2 + c[3]! * bw ** 3 + c[4]! * bw ** 4;
  return (kg * 500) / denominator;
}

// ---------------------------------------------------------------------------
// Block progression
// ---------------------------------------------------------------------------

export interface BlockLiftSeries {
  lift: Lift;
  /** Training max per week, in order; `null` where the week was not trained. */
  tmByWeek: Array<number | null>;
  firstKg: number;
  lastKg: number;
  changePct: number;
  /** Change over the last `window` trained weeks, as a fraction per week. */
  recentSlopePerWeek: number;
  /** Trained weeks since the training max last rose. */
  weeksSinceIncrease: number;
  verdict: "progressing" | "holding" | "regressing";
}

export const PLATEAU_WEEKS = 3;

export function analyseBlockLift(lift: Lift, tmByWeek: Array<number | null>, window = 4): BlockLiftSeries | undefined {
  const trained = tmByWeek.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => typeof x.v === "number" && x.v > 0);
  if (trained.length < 2) return undefined;
  const first = trained[0]!.v, last = trained[trained.length - 1]!.v;

  const recent = trained.slice(-window);
  const slope = recent.length >= 2 ? (recent[recent.length - 1]!.v / recent[0]!.v - 1) / (recent.length - 1) : 0;

  let since = 0;
  for (let j = trained.length - 1; j > 0; j--) {
    if (trained[j]!.v > trained[j - 1]!.v) break;
    since++;
  }

  const verdict = slope > 0.002 ? "progressing" : slope < -0.002 ? "regressing" : "holding";
  // Training maxes come from spreadsheet formulas (101.505…); two decimals is what a
  // person would write, and it keeps 114.24000000000001 out of a table.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { lift, tmByWeek: tmByWeek.map((v) => (v === null ? null : r2(v))), firstKg: r2(first), lastKg: r2(last), changePct: (last / first - 1) * 100, recentSlopePerWeek: slope, weeksSinceIncrease: since, verdict };
}

// ---------------------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
