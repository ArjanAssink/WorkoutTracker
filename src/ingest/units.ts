/**
 * Apple reports the same quantity in different units depending on locale, device and export
 * path: distance in km, mi, m or yd; energy in kcal or kJ; duration in min or s. Everything
 * is funnelled through here so the domain only ever sees metres, kilocalories and seconds.
 */

const DISTANCE_TO_METERS: Record<string, number> = {
  m: 1,
  meter: 1,
  meters: 1,
  km: 1000,
  kilometer: 1000,
  kilometers: 1000,
  mi: 1609.344,
  mile: 1609.344,
  miles: 1609.344,
  ft: 0.3048,
  feet: 0.3048,
  yd: 0.9144,
  yard: 0.9144,
  yards: 0.9144,
};

const ENERGY_TO_KCAL: Record<string, number> = {
  kcal: 1,
  cal: 1, // Apple writes dietary Calories as "Cal"/"cal"; both mean kcal here.
  calorie: 1,
  calories: 1,
  kj: 0.239006,
  kilojoule: 0.239006,
  kilojoules: 0.239006,
};

const DURATION_TO_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  hours: 3600,
};

export class UnitError extends Error {
  override readonly name = "UnitError";
}

function convert(table: Record<string, number>, kind: string, value: number, unit: string): number {
  const factor = table[unit.trim().toLowerCase()];
  if (factor === undefined) throw new UnitError(`Unrecognised ${kind} unit: ${unit}`);
  return value * factor;
}

export const toMeters = (value: number, unit: string): number =>
  convert(DISTANCE_TO_METERS, "distance", value, unit);

export const toKcal = (value: number, unit: string): number =>
  convert(ENERGY_TO_KCAL, "energy", value, unit);

export const toSeconds = (value: number, unit: string): number =>
  convert(DURATION_TO_SECONDS, "duration", value, unit);

/**
 * Parses the "12.4 km" / "350 kcal" shape that Shortcuts produces when a Health quantity is
 * coerced to text. Returns undefined for blank input so callers can treat it as "not recorded".
 */
export function parseQuantity(
  raw: string | number | undefined | null,
  convertTo: (value: number, unit: string) => number,
  defaultUnit: string,
): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? convertTo(raw, defaultUnit) : undefined;
  }
  const match = /^\s*(-?[\d.,]+)\s*([A-Za-z/]*)\s*$/.exec(raw);
  if (!match) return undefined;
  // Shortcuts may emit a locale decimal comma ("12,4 km").
  const value = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  return convertTo(value, match[2] || defaultUnit);
}
