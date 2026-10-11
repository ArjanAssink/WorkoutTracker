import { z } from "zod";
import type { WorkoutInput } from "../domain/workout.js";
import { normaliseActivityType } from "../domain/activityType.js";
import { parseQuantity, toKcal, toMeters, toSeconds } from "./units.js";

/**
 * The JSON an Apple Shortcut posts when a workout ends. Shortcuts is loose about types —
 * a Health quantity dragged into a dictionary can arrive as a number or as the string
 * "412 kcal" — so every measurement accepts either and is normalised below.
 *
 * Only the activity type and start time are genuinely required; a watch that drops its
 * heart-rate sensor or a pool swim with no distance should still be recorded.
 */
const quantity = z.union([z.number(), z.string()]).optional();

export const shortcutPayloadSchema = z
  .object({
    activityType: z.string().min(1),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1).optional(),
    duration: quantity,
    distance: quantity,
    activeEnergy: quantity,
    totalEnergy: quantity,
    averageHeartRate: quantity,
    minHeartRate: quantity,
    maxHeartRate: quantity,
    sourceName: z.string().optional(),
    notes: z.string().optional(),
    source: z.enum(["shortcut", "manual"]).optional(),
  })
  // Shortcuts' own key names, accepted as aliases so the user can drag Health variables
  // straight into a dictionary without renaming every field.
  .transform((raw) => raw);

export type ShortcutPayload = z.infer<typeof shortcutPayloadSchema>;

/** Alternative key spellings Shortcuts produces, mapped onto our canonical keys. */
const KEY_ALIASES: Record<string, string> = {
  type: "activityType",
  workouttype: "activityType",
  activity: "activityType",
  start: "startedAt",
  startdate: "startedAt",
  starttime: "startedAt",
  end: "endedAt",
  enddate: "endedAt",
  endtime: "endedAt",
  totaldistance: "distance",
  activeenergyburned: "activeEnergy",
  activecalories: "activeEnergy",
  totalenergyburned: "totalEnergy",
  totalcalories: "totalEnergy",
  calories: "activeEnergy",
  avgheartrate: "averageHeartRate",
  averagehr: "averageHeartRate",
  heartrate: "averageHeartRate",
  maxhr: "maxHeartRate",
  maximumheartrate: "maxHeartRate",
  minhr: "minHeartRate",
  minimumheartrate: "minHeartRate",
  device: "sourceName",
  source: "sourceName",
  note: "notes",
};

/** Rewrites alias keys onto canonical ones, case- and separator-insensitively. */
export function canonicaliseKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === "") continue;
    const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const canonical = KEY_ALIASES[flat] ?? key;
    // An explicitly-provided canonical key always beats an alias for the same field.
    if (out[canonical] === undefined || key === canonical) out[canonical] = value;
  }
  return out;
}

export class PayloadError extends Error {
  override readonly name = "PayloadError";
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Turns a raw Shortcut body into a {@link WorkoutInput}.
 *
 * Duration is taken from the explicit `duration` field when present and otherwise derived
 * from the start/end span — Shortcuts' Duration variable excludes paused time, which is the
 * number we actually want, so it wins when both are available.
 */
export function parseShortcutPayload(body: unknown): WorkoutInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PayloadError("Request body must be a JSON object");
  }

  const parsed = shortcutPayloadSchema.safeParse(canonicaliseKeys(body as Record<string, unknown>));
  if (!parsed.success) {
    throw new PayloadError(
      "Invalid workout payload",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const raw = parsed.data;

  const startedAt = parseAppleDate(raw.startedAt);
  if (!startedAt) throw new PayloadError(`Could not parse startedAt: ${raw.startedAt}`);

  const endedAt = raw.endedAt ? parseAppleDate(raw.endedAt) : undefined;
  if (raw.endedAt && !endedAt) throw new PayloadError(`Could not parse endedAt: ${raw.endedAt}`);

  const explicitDuration = parseQuantity(raw.duration, toSeconds, "s");
  const spanSeconds = endedAt ? (endedAt.getTime() - startedAt.getTime()) / 1000 : undefined;
  const durationSeconds = explicitDuration ?? spanSeconds;
  if (durationSeconds === undefined) {
    throw new PayloadError("Provide either endedAt or duration so the length is known");
  }

  const resolvedEnd = endedAt ?? new Date(startedAt.getTime() + durationSeconds * 1000);

  return {
    activityType: normaliseActivityType(raw.activityType),
    startedAt: startedAt.toISOString(),
    endedAt: resolvedEnd.toISOString(),
    durationSeconds: Math.round(durationSeconds),
    source: raw.source ?? "shortcut",
    ...optional("distanceMeters", parseQuantity(raw.distance, toMeters, "m")),
    ...optional("activeEnergyKcal", parseQuantity(raw.activeEnergy, toKcal, "kcal")),
    ...optional("totalEnergyKcal", parseQuantity(raw.totalEnergy, toKcal, "kcal")),
    ...optional("averageHeartRate", parseQuantity(raw.averageHeartRate, (v) => v, "bpm")),
    ...optional("minHeartRate", parseQuantity(raw.minHeartRate, (v) => v, "bpm")),
    ...optional("maxHeartRate", parseQuantity(raw.maxHeartRate, (v) => v, "bpm")),
    ...optional("sourceName", raw.sourceName),
    ...optional("notes", raw.notes),
  };
}

/** `exactOptionalPropertyTypes` means we must omit absent keys rather than set them undefined. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Accepts ISO-8601 as well as Apple's export format ("2026-03-14 07:21:03 +0100"), which
 * `Date` parses inconsistently across engines because of the space separator.
 */
export function parseAppleDate(raw: string): Date | undefined {
  const trimmed = raw.trim();
  const appleFormat = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}:?\d{2}|Z)?$/.exec(trimmed);
  if (appleFormat) {
    const [, date, time, zone] = appleFormat;
    // No zone at all means the device's local time; treat it as UTC rather than guessing.
    const offset = !zone || zone === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const candidate = new Date(`${date}T${time}${offset}`);
    if (!Number.isNaN(candidate.getTime())) return candidate;
  }
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? undefined : fallback;
}
