/**
 * Time in heart-rate zones.
 *
 * A workout row stores a per-bpm histogram — seconds spent at each whole bpm — rather than
 * seconds per zone. Zones depend on resting HR and on the max-HR reference, and both move
 * (the reference is observed over a trailing year and gets rescored). A histogram lets the
 * zones be resolved at read time against whatever reference the row is scored with, so a
 * change to the zone model or the ceiling never needs the 500 MB export again.
 *
 * Zones are Karvonen: fractions of heart-rate reserve, the same reserve TRIMP uses, so a
 * "zone 4" minute and the effort score agree about what hard means.
 */

/** Lower bound of each zone as a fraction of heart-rate reserve. Zone 1 takes everything below 60%. */
export const ZONE_FLOORS = [0, 0.6, 0.7, 0.8, 0.9] as const;
export const ZONE_COUNT = ZONE_FLOORS.length;

/**
 * A sample stands for the time until the next one, but no longer than this. Apple Watch
 * samples every few seconds in a workout and a chest strap every second; a gap longer than
 * two minutes is a dropout, and smearing one reading across it would invent the time.
 */
export const MAX_SAMPLE_GAP_SECONDS = 120;

export interface HeartRateSample {
  /** Epoch milliseconds. */
  at: number;
  bpm: number;
}

/** Seconds at each whole bpm, starting at {@link from}. */
export interface HeartRateHistogram {
  from: number;
  seconds: number[];
}

/**
 * The bar a sample stream must clear before it stands for a session: ten readings, and one
 * per two minutes. The export's `HeartRateIndex` applies the same rule, so a watch glance
 * during a class never becomes its average.
 */
export function isThickEnough(samples: number, from: number, to: number): boolean {
  return samples >= 10 && samples / Math.max(1, (to - from) / 60_000) >= 0.5;
}

/**
 * Average, minimum and maximum of the samples inside [from, to] (epoch ms), or undefined
 * when too thin to trust. For workouts whose recorder wrote no statistics — a Polar strap
 * saves the session to Health with its heart rate as loose samples beside it.
 */
export function summariseSamples(samples: HeartRateSample[], from: number, to: number): { average: number; min: number; max: number } | undefined {
  const inside = samples.filter((s) => s.at >= from && s.at <= to && Number.isFinite(s.bpm) && s.bpm >= 20 && s.bpm <= 250);
  if (!isThickEnough(inside.length, from, to)) return undefined;
  let sum = 0, min = Infinity, max = -Infinity;
  for (const { bpm } of inside) { sum += bpm; if (bpm < min) min = bpm; if (bpm > max) max = bpm; }
  return { average: sum / inside.length, min, max };
}

/**
 * Builds the histogram for the samples inside [from, to] (epoch ms), or undefined when the
 * recording is too thin to be a recording — the same bar the export parser applies before
 * trusting loose samples for an average: ten readings, and one per two minutes.
 */
export function buildHistogram(samples: HeartRateSample[], from: number, to: number): HeartRateHistogram | undefined {
  const inside = samples
    .filter((s) => s.at >= from && s.at <= to && Number.isFinite(s.bpm) && s.bpm >= 20 && s.bpm <= 250)
    .sort((a, b) => a.at - b.at);
  if (!isThickEnough(inside.length, from, to)) return undefined;

  const bins = new Map<number, number>();
  for (let i = 0; i < inside.length; i++) {
    const s = inside[i]!;
    const until = i + 1 < inside.length ? inside[i + 1]!.at : to;
    const covered = Math.min(MAX_SAMPLE_GAP_SECONDS, Math.max(0, (until - s.at) / 1000));
    if (covered === 0) continue;
    const bpm = Math.round(s.bpm);
    bins.set(bpm, (bins.get(bpm) ?? 0) + covered);
  }
  if (bins.size === 0) return undefined;
  const lo = Math.min(...bins.keys());
  const hi = Math.max(...bins.keys());
  const seconds = Array.from({ length: hi - lo + 1 }, (_, i) => Math.round(bins.get(lo + i) ?? 0));
  if (seconds.every((s) => s === 0)) return undefined;
  return { from: lo, seconds };
}

/** `"<from bpm>:<s>,<s>,…"` — a string column, since Table Storage has no arrays. */
export function encodeHistogram(h: HeartRateHistogram): string {
  return `${h.from}:${h.seconds.join(",")}`;
}

export function decodeHistogram(raw: string | undefined): HeartRateHistogram | undefined {
  if (!raw) return undefined;
  const match = /^(\d+):([\d,]+)$/.exec(raw);
  if (!match) return undefined;
  const seconds = match[2]!.split(",").map(Number);
  if (seconds.some((s) => !Number.isFinite(s))) return undefined;
  return { from: Number(match[1]), seconds };
}

/** Zone index (0-based) for a bpm against a resting and maximum heart rate. */
export function zoneOf(bpm: number, restingHeartRate: number, maxHeartRate: number): number {
  const reserve = maxHeartRate - restingHeartRate;
  if (reserve <= 0) return 0;
  const fraction = (bpm - restingHeartRate) / reserve;
  let zone = 0;
  for (let z = 0; z < ZONE_COUNT; z++) if (fraction >= ZONE_FLOORS[z]!) zone = z;
  return zone;
}

/** Seconds per zone, always {@link ZONE_COUNT} long. */
export function zoneSeconds(h: HeartRateHistogram, restingHeartRate: number, maxHeartRate: number): number[] {
  const out = new Array<number>(ZONE_COUNT).fill(0);
  h.seconds.forEach((s, i) => {
    if (s > 0) out[zoneOf(h.from + i, restingHeartRate, maxHeartRate)]! += s;
  });
  return out;
}

/** The bpm at which each zone starts, for labelling — zone 1 starts at resting. */
export function zoneBounds(restingHeartRate: number, maxHeartRate: number): number[] {
  return ZONE_FLOORS.map((f) => Math.round(restingHeartRate + f * (maxHeartRate - restingHeartRate)));
}

/**
 * Zones for a stored workout: against the max it was scored with, else the fallback. Undefined
 * when the row carries no histogram (no sample stream reached it — a Shortcut post, Strava).
 */
export function workoutZones(
  workout: { heartRateHistogram?: string | undefined; maxHeartRateReference?: number | undefined },
  restingHeartRate: number,
  fallbackMaxHeartRate: number,
): number[] | undefined {
  const h = decodeHistogram(workout.heartRateHistogram);
  if (!h) return undefined;
  return zoneSeconds(h, restingHeartRate, workout.maxHeartRateReference ?? fallbackMaxHeartRate);
}

/** A workout as the API returns it: the histogram swapped for seconds per zone and the bpm floors they were cut at. */
export function presentWorkout<W extends { heartRateHistogram?: string | undefined; maxHeartRateReference?: number | undefined }>(
  workout: W,
  restingHeartRate: number,
  fallbackMaxHeartRate: number,
): Omit<W, "heartRateHistogram"> & { heartRateZones?: number[]; heartRateZoneBpm?: number[] } {
  const { heartRateHistogram: _histogram, ...rest } = workout;
  const zones = workoutZones(workout, restingHeartRate, fallbackMaxHeartRate);
  if (!zones) return rest;
  // The bpm each zone started at for this workout — its own reference, not today's.
  const bpm = zoneBounds(restingHeartRate, workout.maxHeartRateReference ?? fallbackMaxHeartRate);
  return { ...rest, heartRateZones: zones, heartRateZoneBpm: bpm };
}

/** What the dashboard needs to label the zones: the reserve floors and, at one max, their bpm. */
export function zoneModel(restingHeartRate: number, maxHeartRate: number): { reserveFloors: readonly number[]; bpmFloors: number[] } {
  return { reserveFloors: ZONE_FLOORS, bpmFloors: zoneBounds(restingHeartRate, maxHeartRate) };
}
