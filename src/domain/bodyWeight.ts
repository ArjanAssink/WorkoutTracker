/**
 * Body weight: one reading per calendar day.
 *
 * Scales report several readings a day and Apple keeps them all; a chart wants one. The
 * first reading of the day wins — the morning weigh-in is the conventional measurement,
 * and averaging a morning value with a post-dinner one produces a number nobody stepped on
 * a scale to see.
 */

export type BodyWeightSource = "health-export" | "health-auto-export" | "manual";

export interface BodyWeight {
  /** Calendar day of the reading, `YYYY-MM-DD`, in the local time the reading was taken. */
  date: string;
  kg: number;
  /** Time of the reading that won the day, ISO UTC. */
  measuredAt: string;
  source: BodyWeightSource;
  sourceName?: string;
  recordedAt: string;
}

/** A raw reading before daily reduction. */
export interface WeightReading {
  /** As given by the source — Apple's `2026-10-01 07:12:03 +0200` or ISO. */
  at: string;
  kg: number;
  sourceName?: string;
}

const KG_PER: Record<string, number> = { kg: 1, kilogram: 1, kilograms: 1, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237, g: 0.001, st: 6.35029318 };

export function toKg(value: number, unit: string | undefined): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const factor = KG_PER[(unit ?? "kg").trim().toLowerCase()];
  return factor === undefined ? undefined : value * factor;
}

/** Sanity bounds: outside these the reading is a scale glitch or a unit mix-up. */
export const MIN_KG = 20;
export const MAX_KG = 400;

/**
 * The local calendar day of a timestamp. Apple writes local time with an offset, so the
 * leading `YYYY-MM-DD` *is* the local day; a bare ISO instant falls back to its UTC day.
 */
export function localDay(at: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}/.exec(at.trim());
  if (m) return m[1];
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Reduces readings to one per day — the earliest — dropping anything implausible. */
export function dailyWeights(
  readings: Iterable<WeightReading>,
  source: BodyWeightSource,
  now: Date = new Date(),
): BodyWeight[] {
  const byDay = new Map<string, { reading: WeightReading; instant: number }>();
  for (const r of readings) {
    if (!Number.isFinite(r.kg) || r.kg < MIN_KG || r.kg > MAX_KG) continue;
    const day = localDay(r.at);
    const instant = parseInstant(r.at);
    if (!day || instant === undefined) continue;
    const existing = byDay.get(day);
    if (!existing || instant < existing.instant) byDay.set(day, { reading: r, instant });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { reading, instant }]) => ({
      date,
      kg: Math.round(reading.kg * 10) / 10,
      measuredAt: new Date(instant).toISOString(),
      source,
      ...(reading.sourceName ? { sourceName: reading.sourceName } : {}),
      recordedAt: now.toISOString(),
    }));
}

function parseInstant(at: string): number | undefined {
  // Apple's "2026-10-01 07:12:03 +0200" is not reliably Date-parseable; normalise it.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})?$/.exec(at.trim());
  const t = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? "00"}`) : Date.parse(at);
  return Number.isNaN(t) ? undefined : t;
}
