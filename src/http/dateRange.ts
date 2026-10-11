import type { DateRange } from "../storage/workoutRepository.js";

export class RangeError_ extends Error {
  override readonly name = "RangeError";
}

const DAY_MS = 86_400_000;

/**
 * Upper bound on one request's span. It exists to bound work — a range is a scan over one
 * partition per month — not to express anything about the data. Twenty years is 240 small
 * partition queries, which a personal app can afford; the previous five-year cap quietly
 * became what the dashboard's "All" meant, and hid five years of weight readings.
 */
export const MAX_RANGE_DAYS = 20 * 365;

/**
 * Resolves a query range from `from`/`to`/`days` parameters.
 *
 * Defaults to the last 90 days, which is the window most "how much have I been training?"
 * questions actually mean, and caps the span so a single request cannot scan a decade of
 * partitions.
 */
export function resolveRange(
  params: URLSearchParams,
  now: Date = new Date(),
  maxDays = MAX_RANGE_DAYS,
): DateRange {
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const daysParam = params.get("days");

  const to = toParam ? parseDate(toParam, "to") : now;

  let from: Date;
  if (fromParam) {
    from = parseDate(fromParam, "from");
  } else {
    const days = daysParam === null ? 90 : Number(daysParam);
    if (!Number.isFinite(days) || days <= 0) {
      throw new RangeError_(`'days' must be a positive number, got: ${daysParam}`);
    }
    from = new Date(to.getTime() - days * DAY_MS);
  }

  if (from >= to) throw new RangeError_("'from' must be before 'to'");
  if ((to.getTime() - from.getTime()) / DAY_MS > maxDays) {
    throw new RangeError_(`Range exceeds the ${maxDays}-day maximum`);
  }
  return { from, to };
}

/** Accepts a full ISO instant or a bare `YYYY-MM-DD`, which is read as UTC midnight. */
function parseDate(raw: string, field: string): Date {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError_(`'${field}' is not a valid date: ${raw}`);
  return date;
}
