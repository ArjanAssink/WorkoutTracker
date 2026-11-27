import type { WeightReading } from "../domain/bodyWeight.js";
import type { RecoverySample } from "../domain/recovery.js";
import { toBodyMassReading, toRecoverySample } from "./healthExport.js";

/**
 * Health records sent by the native iOS app, in export.xml's own shape:
 * `{ type, startDate, endDate, value, unit, sourceName }`, strings throughout, the
 * `HKQuantityTypeIdentifier…` / `HKCategoryValueSleepAnalysis…` names and the export's units.
 * They go through the export parser's own converters, so a night, a step count or a weight
 * comes out exactly as the monthly import would make it.
 *
 * The app re-sends whole days: `data.recordsWindow.from` is a local noon, and every record
 * since then is in the batch. Only days strictly *after* that date are complete — the
 * first day lacks its morning, and the night ending on it lacks its evening — so callers
 * write only `date > afterDay`. Without the window a partial day would overwrite a full one.
 */
export interface NativeRecords {
  recovery: RecoverySample[];
  weights: WeightReading[];
  /** Write only days after this one (YYYY-MM-DD). Undefined when the body has no records. */
  afterDay: string | undefined;
  /** How many records arrived, readable or not — for the response. */
  received: number;
}

export function extractNativeRecords(body: unknown): NativeRecords {
  const empty: NativeRecords = { recovery: [], weights: [], afterDay: undefined, received: 0 };
  if (typeof body !== "object" || body === null) return empty;
  const data = (body as Record<string, unknown>)["data"];
  if (typeof data !== "object" || data === null) return empty;
  const d = data as Record<string, unknown>;
  const records = d["records"];
  if (!Array.isArray(records)) return empty;

  const window = d["recordsWindow"];
  const from = typeof window === "object" && window !== null ? (window as Record<string, unknown>)["from"] : undefined;
  // The date as written, in the phone's own offset: "2026-11-24 12:00:00 +0100" → 2026-11-24.
  const afterDay = typeof from === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(from)?.[1] : undefined;
  // No window means no way to tell complete days from partial ones: write nothing.
  if (!afterDay) return { ...empty, received: records.length };

  const recovery: RecoverySample[] = [];
  const weights: WeightReading[] = [];
  for (const raw of records) {
    if (typeof raw !== "object" || raw === null) continue;
    const a: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") a[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) a[k] = String(v);
    }
    if (a["type"] === "HKQuantityTypeIdentifierBodyMass") {
      const reading = toBodyMassReading(a);
      if (reading) weights.push(reading);
      continue;
    }
    const sample = toRecoverySample(a);
    if (sample) recovery.push(sample);
  }
  return { recovery, weights, afterDay, received: records.length };
}
