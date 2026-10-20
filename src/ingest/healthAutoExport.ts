import { z } from "zod";
import { normaliseActivityType } from "../domain/activityType.js";
import { toKg, type WeightReading } from "../domain/bodyWeight.js";
import type { WorkoutInput } from "../domain/workout.js";
import { parseAppleDate } from "./shortcutPayload.js";
import type { NightSummary, RecoveryMetric, RecoverySample } from "../domain/recovery.js";
import { toKcal, toMeters } from "./units.js";

/**
 * Health Auto Export (healthyapps.dev) posts batches of workouts to a REST endpoint on a
 * schedule. It is the practical way to get workouts out of Apple Health automatically:
 * the Health app does not surface workouts to Shortcuts at all, so no native automation
 * can read a workout's type, distance or heart rate.
 *
 * Its shape differs from the Shortcut payload in two ways — measurements are
 * `{ qty, units }` objects rather than scalars or unit-suffixed strings, and a request
 * carries many workouts rather than one.
 *
 * The parser is deliberately lenient about the envelope and about unknown fields. The app
 * has shipped more than one export version, adds fields over time, and this code cannot be
 * tested against the real thing from here, so anything unrecognised is ignored rather than
 * being allowed to reject a whole batch.
 */

/**
 * Only identity and timing are validated by the schema. Every measurement is `unknown` and
 * interpreted defensively below.
 *
 * This is deliberate. The first real export from the app rejected all nineteen workouts
 * because `activeEnergy` arrived as a per-sample array rather than a `{ qty, units }`
 * object — a strict schema turned one unexpected enrichment field into total data loss.
 * A workout's type and duration are the point; energy and heart rate are extras, and an
 * extra that cannot be read must never cost the row.
 */
const workoutSchema = z
  .object({
    name: z.string().min(1),
    start: z.string().min(1),
    end: z.string().optional(),
    duration: z.number().optional(),
    // `.optional()` is load-bearing: in Zod 4 a bare `z.unknown()` is NOT optional and
    // requires the key to be present, which rejects every workout missing any one of these.
    distance: z.unknown().optional(),
    // v2 calls it activeEnergyBurned; v1 called it activeEnergy.
    activeEnergyBurned: z.unknown().optional(),
    activeEnergy: z.unknown().optional(),
    totalEnergyBurned: z.unknown().optional(),
    totalEnergy: z.unknown().optional(),
    avgHeartRate: z.unknown().optional(),
    minHeartRate: z.unknown().optional(),
    maxHeartRate: z.unknown().optional(),
    heartRate: z.unknown().optional(),
  })
  .passthrough();

/**
 * Envelopes seen in the wild: `{ data: { workouts: [...] } }` is what the app sends, but
 * accept a bare `{ workouts: [...] }` and a plain array too so a hand-rolled test post or
 * a future version does not 400.
 */
export function extractWorkoutArray(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  if (typeof body !== "object" || body === null) return undefined;
  const root = body as Record<string, unknown>;
  const data = root["data"];
  if (typeof data === "object" && data !== null) {
    const nested = (data as Record<string, unknown>)["workouts"];
    if (Array.isArray(nested)) return nested;
  }
  if (Array.isArray(root["workouts"])) return root["workouts"];
  // A Shortcut iterating workouts may post them one at a time, unwrapped.
  if (typeof root["name"] === "string" && typeof root["start"] === "string") return [root];
  return undefined;
}

/**
 * Weight readings from `data.metrics`, which the workout parser ignores. The app names the
 * metric `weight_body_mass`; match loosely so a rename does not silently drop it.
 */
export function extractWeightReadings(body: unknown): WeightReading[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as Record<string, unknown>)["data"];
  const metrics = (typeof data === "object" && data !== null ? (data as Record<string, unknown>)["metrics"] : undefined);
  if (!Array.isArray(metrics)) return [];
  const out: WeightReading[] = [];
  for (const metric of metrics) {
    if (typeof metric !== "object" || metric === null) continue;
    const m = metric as Record<string, unknown>;
    const name = String(m["name"] ?? "").toLowerCase();
    if (!/weight|body_?mass/.test(name) || /lean|fat|bone/.test(name)) continue;
    const units = typeof m["units"] === "string" ? m["units"] : "kg";
    for (const point of Array.isArray(m["data"]) ? m["data"] : []) {
      if (typeof point !== "object" || point === null) continue;
      const p = point as Record<string, unknown>;
      const kg = typeof p["qty"] === "number" ? toKg(p["qty"], units) : undefined;
      if (kg !== undefined && typeof p["date"] === "string") out.push({ at: p["date"], kg, sourceName: "Health Auto Export" });
    }
  }
  return out;
}

/**
 * Recovery metrics from `data.metrics`. Health Auto Export names them `sleep_analysis`
 * (one entry per night, hours, with start/end), `resting_heart_rate`, `heart_rate_variability`,
 * `respiratory_rate`, `blood_oxygen_saturation`, `apple_sleeping_wrist_temperature` and
 * `time_in_daylight`; matched loosely, read defensively, unknown names ignored.
 */
export function extractRecovery(body: unknown): { samples: RecoverySample[]; nights: NightSummary[] } {
  const samples: RecoverySample[] = [], nights: NightSummary[] = [];
  if (typeof body !== "object" || body === null) return { samples, nights };
  const data = (body as Record<string, unknown>)["data"];
  const metrics = (typeof data === "object" && data !== null ? (data as Record<string, unknown>)["metrics"] : undefined);
  if (!Array.isArray(metrics)) return { samples, nights };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const QUANTITIES: Array<[RegExp, RecoveryMetric]> = [
    [/resting_?heart_?rate/, "restingHeartRate"], [/heart_?rate_?variability|hrv/, "hrv"], [/respiratory/, "respiratoryRate"],
    [/oxygen|spo2/, "spo2"], [/wrist_?temp/, "wristTemperature"], [/breathing_?disturb/, "breathingDisturbances"], [/daylight/, "daylight"], [/^step_?count$|^steps$/, "steps"],
  ];
  for (const metric of metrics) {
    if (typeof metric !== "object" || metric === null) continue;
    const m = metric as Record<string, unknown>;
    const name = String(m["name"] ?? "").toLowerCase();
    const points = Array.isArray(m["data"]) ? m["data"] : [];
    // "sleep_analysis" is the night; "apple_sleeping_wrist_temperature" is not, despite the word.
    if (/^sleep_analysis$|^sleep$/.test(name)) {
      for (const point of points) {
        if (typeof point !== "object" || point === null) continue;
        const p = point as Record<string, unknown>;
        const end = str(p["sleepEnd"]) ?? str(p["inBedEnd"]) ?? str(p["date"]);
        if (!end) continue;
        const hours = (k: string) => num(p[k]);
        // `asleep` is the *unspecified* stage — zero on a watch that records stages — and
        // `totalSleep` the stage total; take whichever is larger, never `asleep` alone.
        const staged = (hours("core") ?? 0) + (hours("deep") ?? 0) + (hours("rem") ?? 0);
        const asleepHours = Math.max(hours("totalSleep") ?? 0, (hours("asleep") ?? 0) + staged);
        nights.push(strip({
          end, start: str(p["sleepStart"]) ?? str(p["inBedStart"]),
          inBedHours: hours("inBed"), asleepHours: asleepHours > 0 ? asleepHours : undefined, coreHours: hours("core"),
          deepHours: hours("deep"), remHours: hours("rem"), awakeHours: hours("awake"), sourceName: str(p["source"]) ?? "Health Auto Export",
        }) as NightSummary);
      }
      continue;
    }
    const kind = QUANTITIES.find(([re]) => re.test(name))?.[1];
    if (!kind) continue;
    for (const point of points) {
      if (typeof point !== "object" || point === null) continue;
      const p = point as Record<string, unknown>;
      const value = num(p["qty"]) ?? num(p["avg"]) ?? num(p["value"]);
      const at = str(p["date"]);
      if (value === undefined || !at) continue;
      samples.push({ metric: kind, start: at, end: str(p["end"]) ?? at, value, sourceName: "Health Auto Export" });
    }
  }
  return { samples, nights };
}

function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface BatchResult {
  workouts: WorkoutInput[];
  /** One entry per workout that could not be parsed, with why. */
  skipped: Array<{ index: number; reason: string }>;
}

/**
 * Parses a batch, collecting failures rather than throwing.
 *
 * A single malformed workout must not cost the other several hundred in the same request:
 * the app would simply retry the identical payload and fail identically forever.
 */
export function parseHealthAutoExportBatch(body: unknown): BatchResult {
  const raw = extractWorkoutArray(body);
  if (!raw) {
    throw new HealthAutoExportError(
      "Expected a workouts array — send { data: { workouts: [...] } }, and make sure the automation exports Workouts",
    );
  }

  const workouts: WorkoutInput[] = [];
  const skipped: BatchResult["skipped"] = [];

  raw.forEach((entry, index) => {
    try {
      workouts.push(parseOne(entry));
    } catch (error) {
      skipped.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  return { workouts, skipped };
}

export class HealthAutoExportError extends Error {
  override readonly name = "HealthAutoExportError";
}

function parseOne(entry: unknown): WorkoutInput {
  const parsed = workoutSchema.safeParse(entry);
  if (!parsed.success) {
    throw new HealthAutoExportError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const w = parsed.data;

  const startedAt = parseAppleDate(w.start);
  if (!startedAt) throw new HealthAutoExportError(`Unparseable start: ${w.start}`);

  const endedAt = w.end ? parseAppleDate(w.end) : undefined;
  if (w.end && !endedAt) throw new HealthAutoExportError(`Unparseable end: ${w.end}`);

  const spanSeconds = endedAt ? (endedAt.getTime() - startedAt.getTime()) / 1000 : undefined;
  const durationSeconds = resolveDuration(w.duration, spanSeconds);
  if (durationSeconds === undefined) {
    throw new HealthAutoExportError("Workout has neither an end time nor a duration");
  }

  const activeEnergy = measure(w.activeEnergyBurned ?? w.activeEnergy, toKcal, "kcal", "sum");
  const totalEnergy = measure(w.totalEnergyBurned ?? w.totalEnergy, toKcal, "kcal", "sum");

  return {
    activityType: normaliseActivityType(w.name),
    startedAt: startedAt.toISOString(),
    endedAt: (endedAt ?? new Date(startedAt.getTime() + durationSeconds * 1000)).toISOString(),
    durationSeconds: Math.round(durationSeconds),
    source: "health-export",
    sourceName: "Health Auto Export",
    ...set("distanceMeters", measure(w.distance, toMeters, "m", "sum")),
    ...set("activeEnergyKcal", activeEnergy),
    ...set("totalEnergyKcal", totalEnergy),
    ...set("averageHeartRate", round(measure(w.avgHeartRate ?? w.heartRate, (v) => v, "bpm", "avg"))),
    ...set("minHeartRate", round(measure(w.minHeartRate ?? w.heartRate, (v) => v, "bpm", "min"))),
    ...set("maxHeartRate", round(measure(w.maxHeartRate ?? w.heartRate, (v) => v, "bpm", "max"))),
  };
}

/**
 * The app has reported `duration` in both seconds and minutes across its versions, and the
 * value alone is ambiguous — 45 could be either. The start/end span is unambiguous, so when
 * both are present the reading closer to the span wins. Duration is preferred over the span
 * itself because it excludes paused time.
 */
export function resolveDuration(raw: number | undefined, spanSeconds: number | undefined): number | undefined {
  if (raw === undefined) return spanSeconds;
  if (raw <= 0) return spanSeconds;
  if (spanSeconds === undefined) return raw; // Nothing to compare against; assume seconds.
  return Math.abs(raw * 60 - spanSeconds) < Math.abs(raw - spanSeconds) ? raw * 60 : raw;
}

/** How to collapse a series of samples into the single number the domain stores. */
type Reduce = "sum" | "avg" | "min" | "max";

/**
 * Reads a measurement that may be a scalar, a `{ qty, units }` object, or an array of
 * per-sample readings — the app emits all three depending on the field, the export version,
 * and whether granular data is switched on.
 *
 * Cumulative quantities (energy, distance) sum across samples; heart rate averages or takes
 * the maximum. Returns undefined for anything unreadable, so one odd field is dropped rather
 * than discarding the workout.
 */
function measure(
  value: unknown,
  convert: (qty: number, units: string) => number,
  defaultUnits: string,
  reduce: Reduce,
): number | undefined {
  const samples = readSamples(value, reduce);
  if (samples.length === 0) return undefined;

  const units = samples.find((s) => s.units)?.units ?? defaultUnits;
  const values = samples.map((s) => s.qty);
  const collapsed =
    reduce === "sum"
      ? values.reduce((a, b) => a + b, 0)
      : reduce === "max"
        ? Math.max(...values)
        : reduce === "min"
          ? Math.min(...values)
          : values.reduce((a, b) => a + b, 0) / values.length;

  try {
    return convert(collapsed, units);
  } catch {
    // An unrecognised unit loses that one measurement, not the whole workout.
    return undefined;
  }
}

interface Sample {
  qty: number;
  units: string | undefined;
}

/** Flattens whatever shape arrived into comparable samples. */
function readSamples(value: unknown, reduce: Reduce): Sample[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "number") return Number.isFinite(value) ? [{ qty: value, units: undefined }] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => readSamples(entry, reduce));
  if (typeof value !== "object") return [];

  const o = value as Record<string, unknown>;
  const units = typeof o["units"] === "string" ? o["units"] : undefined;

  // Heart-rate samples carry Avg/Min/Max rather than a single qty; pick the one that
  // matches what the caller is reducing towards.
  const preferred =
    reduce === "max" ? ["Max", "max", "maximum", "qty"]
    : reduce === "min" ? ["Min", "min", "minimum", "qty"]
    : reduce === "avg" ? ["Avg", "avg", "average", "qty"]
    : ["qty"];
  for (const key of preferred) {
    const candidate = o[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return [{ qty: candidate, units }];
  }
  return [];
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}

function set<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
