import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import sax from "sax";
import type { WorkoutInput } from "../domain/workout.js";
import { normaliseActivityType, relabelActivity } from "../domain/activityType.js";
import { parseAppleDate } from "./shortcutPayload.js";
import { toKg, type WeightReading } from "../domain/bodyWeight.js";
import { toKcal, toMeters, toSeconds } from "./units.js";

/**
 * Apple's Health export is a single `export.xml` that routinely runs to hundreds of megabytes,
 * the overwhelming majority of it `<Record>` elements for individual heart-rate samples. It is
 * far too large to buffer, so this is a streaming SAX parse that keeps only `<Workout>`
 * elements and discards everything else as it goes.
 */

/** Statistics from a parse run, so an import can report what it skipped and why. */
export interface ParseStats {
  workoutsSeen: number;
  workoutsParsed: number;
  skipped: Array<{ reason: string; attributes: Record<string, string> }>;
}

/**
 * Loose heart-rate samples, kept so a workout that arrives without its own statistics can
 * be given an average, minimum and maximum from the samples inside its time span.
 *
 * Third-party apps (Polar Flow, Strava) write the workout and the heart-rate stream as two
 * separate things; Apple attaches `WorkoutStatistics` only to workouts it recorded itself.
 * Sixty-six BJJ sessions with a second-by-second chest-strap recording were scoring as
 * "no heart rate" because of that. Apple writes every `<Record>` before any `<Workout>`,
 * so by the time a workout is seen the index is complete. A million samples is ~16 MB.
 */
class HeartRateIndex {
  private times: number[] = [];
  private values: number[] = [];
  private sorted = true;

  add(at: string, value: number): void {
    const t = parseAppleDate(at)?.getTime();
    if (t === undefined || !Number.isFinite(value) || value <= 0) return;
    if (this.times.length && t < this.times[this.times.length - 1]!) this.sorted = false;
    this.times.push(t);
    this.values.push(value);
  }

  get size(): number {
    return this.times.length;
  }

  /** Average, min and max inside [from, to], or undefined when too thin to trust. */
  summarise(from: number, to: number): { average: number; min: number; max: number; samples: number } | undefined {
    if (!this.sorted) this.sort();
    let lo = 0, hi = this.times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.times[mid]! < from) lo = mid + 1; else hi = mid; }
    let n = 0, sum = 0, min = Infinity, max = -Infinity;
    for (let i = lo; i < this.times.length && this.times[i]! <= to; i++) {
      const v = this.values[i]!;
      n++; sum += v; if (v < min) min = v; if (v > max) max = v;
    }
    // A handful of readings across an hour is a watch glance, not a recording of the
    // session: require at least one sample per two minutes, and at least ten overall.
    const minutes = Math.max(1, (to - from) / 60_000);
    if (n < 10 || n / minutes < 0.5) return undefined;
    return { average: sum / n, min, max, samples: n };
  }

  private sort(): void {
    const order = this.times.map((_, i) => i).sort((a, b) => this.times[a]! - this.times[b]!);
    this.times = order.map((i) => this.times[i]!);
    this.values = order.map((i) => this.values[i]!);
    this.sorted = true;
  }
}

/** Modern exports nest the totals; older ones put them on the Workout element itself. */
const STATISTIC_TYPES = {
  HKQuantityTypeIdentifierActiveEnergyBurned: "activeEnergy",
  HKQuantityTypeIdentifierBasalEnergyBurned: "basalEnergy",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "distance",
  HKQuantityTypeIdentifierDistanceCycling: "distance",
  HKQuantityTypeIdentifierDistanceSwimming: "distance",
  HKQuantityTypeIdentifierHeartRate: "heartRate",
} as const;

interface PendingWorkout {
  attributes: Record<string, string>;
  // Explicitly `| undefined` rather than optional: statistics are assigned as they stream in,
  // and under `exactOptionalPropertyTypes` an optional property cannot be set to undefined.
  activeEnergyKcal: number | undefined;
  basalEnergyKcal: number | undefined;
  distanceMeters: number | undefined;
  averageHeartRate: number | undefined;
  minHeartRate: number | undefined;
  maxHeartRate: number | undefined;
}

function newPending(attributes: Record<string, string>): PendingWorkout {
  return {
    attributes,
    activeEnergyKcal: undefined,
    basalEnergyKcal: undefined,
    distanceMeters: undefined,
    averageHeartRate: undefined,
    minHeartRate: undefined,
    maxHeartRate: undefined,
  };
}

/**
 * Streams workouts out of an Apple Health export.
 *
 * Yields as it parses rather than returning an array, so a 500 MB export can be imported with
 * flat memory use. Unparseable workouts are collected into `stats` instead of aborting the
 * run — one malformed row from a third-party app should not cost you the other ten thousand.
 */
export interface ParseHooks {
  /**
   * Called for each body-mass `<Record>` as it streams past. A side channel rather than a
   * second generator: the file is hundreds of megabytes, and a second pass just to pick
   * out a few hundred weigh-ins would double the import time.
   */
  onBodyMass?: (reading: WeightReading) => void;
}

export async function* parseHealthExport(
  input: Readable | string,
  stats: ParseStats = { workoutsSeen: 0, workoutsParsed: 0, skipped: [] },
  hooks: ParseHooks = {},
): AsyncGenerator<WorkoutInput, ParseStats> {
  const stream = typeof input === "string" ? createReadStream(input, { encoding: "utf8" }) : input;
  const parser = sax.parser(true, { trim: true, lowercase: false });

  // SAX is push-based and the consumer of this generator is pull-based, so completed workouts
  // queue here between `stream` chunks and are drained after each one.
  const ready: WorkoutInput[] = [];
  const heartRate = new HeartRateIndex();
  let pending: PendingWorkout | undefined;
  let failure: Error | undefined;

  parser.onerror = (err) => {
    failure = err;
    parser.resume();
  };

  parser.onopentag = (tag) => {
    const attributes = (tag.attributes ?? {}) as Record<string, string>;
    if (tag.name === "Record" && attributes["type"] === "HKQuantityTypeIdentifierHeartRate") {
      const at = attributes["startDate"];
      if (at) heartRate.add(at, Number(attributes["value"]));
      return;
    }
    if (tag.name === "Record" && attributes["type"] === "HKQuantityTypeIdentifierBodyMass" && hooks.onBodyMass) {
      const kg = toKg(Number(attributes["value"]), attributes["unit"]);
      const at = attributes["startDate"];
      if (kg !== undefined && at) {
        hooks.onBodyMass({ at, kg, ...(attributes["sourceName"] ? { sourceName: attributes["sourceName"] } : {}) });
      }
      return;
    }
    if (tag.name === "Workout") {
      stats.workoutsSeen += 1;
      pending = newPending(attributes);
      return;
    }
    if (!pending) return;
    if (tag.name === "WorkoutStatistics") applyStatistic(pending, attributes, stats);
  };

  parser.onclosetag = (name) => {
    if (name !== "Workout" || !pending) return;
    const current = pending;
    pending = undefined;
    try {
      const workout = toWorkoutInput(current, heartRate);
      stats.workoutsParsed += 1;
      ready.push(workout);
    } catch (error) {
      stats.skipped.push({
        reason: error instanceof Error ? error.message : String(error),
        attributes: current.attributes,
      });
    }
  };

  // `<Workout>` elements are self-closing in Apple's export, which sax reports as an
  // open immediately followed by a close, so the handlers above cover both shapes.
  for await (const chunk of stream) {
    parser.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    if (failure) throw failure;
    while (ready.length > 0) yield ready.shift()!;
  }
  parser.close();
  if (failure) throw failure;
  while (ready.length > 0) yield ready.shift()!;

  return stats;
}

function applyStatistic(
  pending: PendingWorkout,
  attributes: Record<string, string>,
  stats: ParseStats,
): void {
  const kind = STATISTIC_TYPES[attributes["type"] as keyof typeof STATISTIC_TYPES];
  if (!kind) return;
  const unit = attributes["unit"] ?? "";
  try {
    switch (kind) {
      case "activeEnergy":
        pending.activeEnergyKcal = sum(pending.activeEnergyKcal, number(attributes["sum"], toKcal, unit));
        break;
      case "basalEnergy":
        pending.basalEnergyKcal = sum(pending.basalEnergyKcal, number(attributes["sum"], toKcal, unit));
        break;
      case "distance":
        // Multi-sport workouts report one distance statistic per discipline; they add up.
        pending.distanceMeters = sum(pending.distanceMeters, number(attributes["sum"], toMeters, unit));
        break;
      case "heartRate":
        pending.averageHeartRate = number(attributes["average"], (v) => v, unit);
        pending.minHeartRate = number(attributes["minimum"], (v) => v, unit);
        pending.maxHeartRate = number(attributes["maximum"], (v) => v, unit);
        break;
    }
  } catch {
    // An unrecognised unit on one statistic should not discard the whole workout.
    stats.skipped.push({ reason: `Unparseable ${kind} statistic`, attributes });
  }
}

function sum(existing: number | undefined, addition: number | undefined): number | undefined {
  if (addition === undefined) return existing;
  return (existing ?? 0) + addition;
}

function number(
  raw: string | undefined,
  convert: (value: number, unit: string) => number,
  unit: string,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return convert(value, unit);
}

function toWorkoutInput(pending: PendingWorkout, heartRate?: HeartRateIndex): WorkoutInput {
  const a = pending.attributes;

  const startRaw = a["startDate"];
  if (!startRaw) throw new Error("Workout has no startDate");
  const startedAt = parseAppleDate(startRaw);
  if (!startedAt) throw new Error(`Unparseable startDate: ${startRaw}`);

  const endRaw = a["endDate"];
  const endedAt = endRaw ? parseAppleDate(endRaw) : undefined;

  const durationSeconds = resolveDuration(a, startedAt, endedAt);
  if (durationSeconds === undefined) throw new Error("Workout has neither duration nor endDate");

  // The workout's own statistics win; loose samples fill in only when there are none.
  if (pending.averageHeartRate === undefined && heartRate && heartRate.size > 0) {
    const resolvedEnd = endedAt ?? new Date(startedAt.getTime() + durationSeconds * 1000);
    const joined = heartRate.summarise(startedAt.getTime(), resolvedEnd.getTime());
    if (joined) {
      pending.averageHeartRate = joined.average;
      pending.minHeartRate = joined.min;
      pending.maxHeartRate = joined.max;
    }
  }

  const activeEnergy =
    pending.activeEnergyKcal ?? legacy(a, "totalEnergyBurned", "totalEnergyBurnedUnit", toKcal);
  const distance = pending.distanceMeters ?? legacy(a, "totalDistance", "totalDistanceUnit", toMeters);
  const totalEnergy =
    activeEnergy === undefined && pending.basalEnergyKcal === undefined
      ? undefined
      : (activeEnergy ?? 0) + (pending.basalEnergyKcal ?? 0);

  return {
    activityType: relabelActivity(normaliseActivityType(a["workoutActivityType"]), {
      sourceName: a["sourceName"],
      durationSeconds,
    }),
    startedAt: startedAt.toISOString(),
    endedAt: (endedAt ?? new Date(startedAt.getTime() + durationSeconds * 1000)).toISOString(),
    durationSeconds: Math.round(durationSeconds),
    source: "health-export",
    ...present("distanceMeters", distance),
    ...present("activeEnergyKcal", activeEnergy),
    ...present("totalEnergyKcal", totalEnergy),
    ...present("averageHeartRate", round(pending.averageHeartRate)),
    ...present("minHeartRate", round(pending.minHeartRate)),
    ...present("maxHeartRate", round(pending.maxHeartRate)),
    ...present("sourceName", a["sourceName"]),
  };
}

function resolveDuration(
  a: Record<string, string>,
  startedAt: Date,
  endedAt: Date | undefined,
): number | undefined {
  const raw = a["duration"];
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value)) {
      // The unit attribute is usually "min", but it is not guaranteed to be present.
      try {
        return toSeconds(value, a["durationUnit"] ?? "min");
      } catch {
        /* fall through to the start/end span */
      }
    }
  }
  if (endedAt) return (endedAt.getTime() - startedAt.getTime()) / 1000;
  return undefined;
}

function legacy(
  a: Record<string, string>,
  valueKey: string,
  unitKey: string,
  convert: (value: number, unit: string) => number,
): number | undefined {
  const raw = a[valueKey];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value === 0) return undefined;
  try {
    return convert(value, a[unitKey] ?? "");
  } catch {
    return undefined;
  }
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}

function present<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
