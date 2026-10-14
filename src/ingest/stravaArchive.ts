import type { LatLon, PrivacyZone } from "../domain/routes.js";
import type { StravaActivity } from "../domain/strava.js";
import { parseCsv } from "./csv.js";

/**
 * Strava's data archive (Settings → My Account → Request Your Archive): `activities.csv`
 * with one row per activity, `media.csv` with captions, `reactions.csv` with every kudos,
 * and the photos themselves under `media/`. No API, no subscription.
 *
 * Dates in the CSV are UTC written the American way — "Sep 27, 2026, 7:03:56 AM" —
 * verified against the same workout's Apple Health timestamp.
 */

export interface ArchiveActivity {
  activity: StravaActivity;
  /** `media/…jpg` paths inside the archive. */
  media: string[];
  gear?: string;
  /** `activities/123.gpx` or `.fit.gz` inside the archive. */
  filename?: string;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "Sep 27, 2026, 7:03:56 AM" → ISO (UTC). */
export function parseArchiveDate(raw: string): string | undefined {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(raw.trim());
  if (!m) { const t = Date.parse(raw); return Number.isNaN(t) ? undefined : new Date(t).toISOString(); }
  const month = MONTHS[m[1]!]; if (month === undefined) return undefined;
  let hour = Number(m[4]) % 12; if (m[7] === "PM") hour += 12;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5]), Number(m[6]))).toISOString();
}

/** Strava's CSV type names → its API sport types, which the domain already maps. */
const TYPES: Record<string, string> = { "Weight Training": "WeightTraining", "Trail Run": "TrailRun", "Virtual Ride": "VirtualRide", "E-Bike Ride": "EBikeRide", "Mountain Bike Ride": "MountainBikeRide", "Gravel Ride": "GravelRide", "Stand Up Paddling": "StandUpPaddling", "Alpine Ski": "AlpineSki", "Nordic Ski": "NordicSki", "Ice Skate": "IceSkate", "Inline Skate": "InlineSkate", "Rock Climbing": "RockClimbing", "Table Tennis": "TableTennis" };

const num = (v: string | undefined): number | undefined => { if (v === undefined || v.trim() === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };

export function parseArchiveActivities(activitiesCsv: string, reactionsCsv = ""): ArchiveActivity[] {
  const kudos = new Map<string, number>();
  for (const r of parseCsv(reactionsCsv)) if (r["Reaction Type"] === "Kudos" && r["Parent Type"] === "Activity") kudos.set(r["Parent ID"] ?? "", (kudos.get(r["Parent ID"] ?? "") ?? 0) + 1);
  const out: ArchiveActivity[] = [];
  for (const r of parseCsv(activitiesCsv)) {
    const id = Number(r["Activity ID"]); const start = parseArchiveDate(r["Activity Date"] ?? "");
    if (!Number.isFinite(id) || !start) continue;
    const type = r["Activity Type"] ?? "";
    const media = (r["Media"] ?? "").split("|").map((m) => m.trim()).filter((m) => m.startsWith("media/"));
    // The second "Distance"/"Elapsed Time" columns are the precise ones (metres, seconds); the first are display values.
    const distance = num(r["Distance 2"]) ?? (num(r["Distance"]) === undefined ? undefined : num(r["Distance"])! * 1000);
    const activity = strip({
      id, name: r["Activity Name"] ?? "", sport_type: TYPES[type] ?? type.replace(/\s+/g, ""), start_date: start,
      elapsed_time: num(r["Elapsed Time 2"]) ?? num(r["Elapsed Time"]), moving_time: num(r["Moving Time"]), distance,
      total_elevation_gain: num(r["Elevation Gain"]), average_heartrate: num(r["Average Heart Rate"]), max_heartrate: num(r["Max Heart Rate 2"]) ?? num(r["Max Heart Rate"]),
      suffer_score: num(r["Relative Effort 2"]) ?? num(r["Relative Effort"]), kudos_count: kudos.get(String(id)), total_photo_count: media.length,
      gear_id: r["Activity Gear"] || undefined, description: r["Activity Description"] || undefined,
      weather_condition: r["Weather Condition"] || undefined, temperature_c: num(r["Weather Temperature"]), training_load: num(r["Training Load"]), perceived_exertion: num(r["Perceived Exertion"]),
    }) as StravaActivity;
    out.push(strip({ activity, media, gear: r["Activity Gear"] || undefined, filename: r["Filename"] || undefined }) as ArchiveActivity);
  }
  return out.sort((a, b) => a.activity.start_date.localeCompare(b.activity.start_date));
}

export function parseMediaCaptions(mediaCsv: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of parseCsv(mediaCsv)) if (r["Media Filename"] && r["Media Caption"]) out.set(r["Media Filename"], r["Media Caption"]);
  return out;
}

/** Strava's privacy zone, "0.80 kilometers" around "lat, lon" — reusable as the route privacy zone. */
export function parsePrivacyZone(privacyCsv: string): PrivacyZone | undefined {
  for (const r of parseCsv(privacyCsv)) {
    const m = /(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(r["Latitude & Longitude"] ?? "");
    const km = Number(/([\d.]+)/.exec(r["Radius"] ?? "")?.[1]);
    if (m && Number.isFinite(km)) return { lat: Number(m[1]), lon: Number(m[2]), radiusMeters: km * 1000 };
  }
  return undefined;
}

export const archiveCentre = (z: PrivacyZone): LatLon => ({ lat: z.lat, lon: z.lon });

function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
