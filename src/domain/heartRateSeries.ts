import type { HeartRateSample } from "./heartRateZones.js";

/**
 * Heart rate over the course of one workout, for the chart in the history page's detail view.
 *
 * Stored downsampled — a second-by-second chest-strap stream of a two-hour ride is 7,200
 * readings, far more than a chart a few hundred pixels wide can show — in fixed time steps
 * from the workout's start, each step the mean of the readings inside it. Kept in its own
 * table (`heartrate`), never on the workout row: the row is read thousands at a time by every
 * list and summary, the series only when one workout is opened.
 */

/** Never more steps than this: about one per horizontal pixel of the detail chart. */
export const MAX_POINTS = 720;
/** Step sizes tried in order; the first that fits the workout in {@link MAX_POINTS} wins. */
export const STEP_CHOICES = [5, 10, 15, 20, 30, 60, 120, 300] as const;
/**
 * A step with no reading of its own carries the last reading forward for this long. Apple
 * Watch samples every few seconds in a workout, not every five, so without it a 5 s series
 * would be mostly holes; past it the gap is a dropout and the line breaks.
 */
export const CARRY_SECONDS = 60;

export interface HeartRateSeries {
  stepSeconds: number;
  /** Mean bpm per step from the workout's start, null where nothing was recorded. */
  bpm: Array<number | null>;
}

export function stepFor(durationSeconds: number): number {
  return STEP_CHOICES.find((s) => Math.ceil(durationSeconds / s) <= MAX_POINTS) ?? STEP_CHOICES[STEP_CHOICES.length - 1]!;
}

/**
 * The series for the samples inside [from, to] (epoch ms), or undefined when the recording
 * is too thin to be one — the same bar as the zone histogram: ten readings, one per two minutes.
 */
export function buildSeries(samples: HeartRateSample[], from: number, to: number): HeartRateSeries | undefined {
  if (!(to > from)) return undefined;
  const inside = samples
    .filter((s) => s.at >= from && s.at <= to && Number.isFinite(s.bpm) && s.bpm >= 20 && s.bpm <= 250)
    .sort((a, b) => a.at - b.at);
  const minutes = Math.max(1, (to - from) / 60_000);
  if (inside.length < 10 || inside.length / minutes < 0.5) return undefined;

  const step = stepFor((to - from) / 1000);
  const count = Math.max(1, Math.ceil((to - from) / 1000 / step));
  const sums = new Array<number>(count).fill(0), ns = new Array<number>(count).fill(0);
  for (const s of inside) {
    const i = Math.min(count - 1, Math.floor((s.at - from) / 1000 / step));
    sums[i]! += s.bpm; ns[i]! += 1;
  }
  const bpm: Array<number | null> = [];
  let last: { value: number; at: number } | undefined;
  for (let i = 0; i < count; i++) {
    if (ns[i]! > 0) {
      const value = Math.round(sums[i]! / ns[i]!);
      bpm.push(value);
      last = { value, at: i };
    } else if (last && (i - last.at) * step <= CARRY_SECONDS) {
      bpm.push(last.value);
    } else {
      bpm.push(null);
    }
  }
  return { stepSeconds: step, bpm };
}

/** `"<step>:<bpm>,<bpm>,,<bpm>"` — an empty slot is a gap. A string column; Table Storage has no arrays. */
export function encodeSeries(s: HeartRateSeries): string {
  return `${s.stepSeconds}:${s.bpm.map((v) => (v === null ? "" : String(v))).join(",")}`;
}

export function decodeSeries(raw: string | undefined): HeartRateSeries | undefined {
  if (!raw) return undefined;
  const match = /^(\d+):([\d,]*)$/.exec(raw);
  if (!match) return undefined;
  const stepSeconds = Number(match[1]);
  if (!(stepSeconds > 0)) return undefined;
  const bpm = match[2]!.split(",").map((v) => (v === "" ? null : Number(v)));
  if (bpm.some((v) => v !== null && !Number.isFinite(v))) return undefined;
  return { stepSeconds, bpm };
}

/** What the `heartrate` table holds per workout. */
export interface HeartRateSeriesRecord {
  workoutId: string;
  startedAt: string;
  /** {@link encodeSeries} output. */
  series: string;
}
