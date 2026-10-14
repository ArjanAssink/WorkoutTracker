import { buildRouteRecord, decodePolyline, type RouteRecord } from "./routes.js";
import type { Workout } from "./workout.js";

/**
 * Strava's side of a workout. Apple Health already has the session; Strava adds the name
 * you gave it, the photos, kudos, its own "relative effort", the gear and — for anything
 * recorded on the phone — a polyline, which fills the Routes page between exports.
 */

export interface StravaActivity {
  id: number;
  name: string;
  sport_type?: string;
  type?: string;
  start_date: string;
  elapsed_time?: number;
  moving_time?: number;
  distance?: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  kudos_count?: number;
  comment_count?: number;
  achievement_count?: number;
  pr_count?: number;
  total_photo_count?: number;
  gear_id?: string;
  device_name?: string;
  description?: string;
  map?: { summary_polyline?: string };
  /** Archive-only extras. */
  weather_condition?: string;
  temperature_c?: number;
  training_load?: number;
  perceived_exertion?: number;
}

export interface StravaPhoto {
  unique_id: string;
  activity_id?: number;
  urls?: Record<string, string>;
  sizes?: Record<string, [number, number]>;
  caption?: string;
  created_at?: string;
  source?: number;
}

export interface StravaActivityRecord {
  stravaId: number;
  startedAt: string;
  name: string;
  sportType: string;
  activityType: string;
  /** The Apple Health workout this is the same session as, when one starts within a few minutes. */
  workoutId?: string;
  elapsedSeconds?: number;
  movingSeconds?: number;
  distanceMeters?: number;
  elevationGainMeters?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  relativeEffort?: number;
  kudos?: number;
  comments?: number;
  achievements?: number;
  prs?: number;
  photoCount?: number;
  gearId?: string;
  deviceName?: string;
  description?: string;
  /** From the archive's CSV: Strava's weather snapshot and its own load figures. */
  weatherCondition?: string;
  temperatureC?: number;
  trainingLoad?: number;
  perceivedExertion?: number;
  hasPolyline: boolean;
  recordedAt: string;
}

export interface StravaPhotoRecord {
  uniqueId: string;
  stravaId: number;
  workoutId?: string;
  takenAt: string;
  url: string;
  width?: number;
  height?: number;
  caption?: string;
  activityName: string;
  activityType: string;
  recordedAt: string;
}

/** Strava sport types → this app's activity slugs (Apple's names, lower-cased). */
const SPORT: Record<string, string> = {
  Run: "running", TrailRun: "running", VirtualRun: "running", Walk: "walking", Hike: "hiking",
  Ride: "cycling", VirtualRide: "cycling", MountainBikeRide: "cycling", GravelRide: "cycling", EBikeRide: "cycling", EMountainBikeRide: "cycling", Handcycle: "cycling",
  Swim: "swimming", WeightTraining: "strength", Workout: "other", Crossfit: "crosstraining", Yoga: "yoga", Pilates: "pilates",
  Rowing: "rowing", Kayaking: "paddlesports", Canoeing: "paddlesports", StandUpPaddling: "paddlesports", Surfing: "surfingsports",
  Soccer: "soccer", Tennis: "tennis", Golf: "golf", Elliptical: "elliptical", StairStepper: "stairclimbing", Skateboard: "skatingsports",
  AlpineSki: "downhillskiing", NordicSki: "crosscountryskiing", Snowboard: "snowboarding", IceSkate: "skatingsports", InlineSkate: "skatingsports",
  RockClimbing: "climbing", Badminton: "badminton", TableTennis: "tabletennis", Squash: "squash", Pickleball: "pickleball", Sail: "sailing",
};

export function activityTypeOf(a: StravaActivity): string {
  const sport = a.sport_type ?? a.type ?? "";
  return SPORT[sport] ?? sport.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "other";
}

export const MATCH_WINDOW_MS = 5 * 60_000;

/** The Apple Health workout that is the same session: nearest start within five minutes, same broad type when possible. */
export function matchWorkout(a: StravaActivity, workouts: Workout[]): Workout | undefined {
  const t = Date.parse(a.start_date);
  const slug = activityTypeOf(a);
  const near = workouts.filter((w) => Math.abs(Date.parse(w.startedAt) - t) <= MATCH_WINDOW_MS).sort((x, y) => Math.abs(Date.parse(x.startedAt) - t) - Math.abs(Date.parse(y.startedAt) - t));
  return near.find((w) => w.activityType === slug) ?? near[0];
}

export function toActivityRecord(a: StravaActivity, workout: Workout | undefined, now: Date = new Date()): StravaActivityRecord {
  const r = (n: number | undefined) => (n === undefined ? undefined : Math.round(n));
  return strip({
    stravaId: a.id, startedAt: new Date(a.start_date).toISOString(), name: a.name ?? "", sportType: a.sport_type ?? a.type ?? "", activityType: activityTypeOf(a),
    workoutId: workout?.id,
    elapsedSeconds: a.elapsed_time, movingSeconds: a.moving_time, distanceMeters: r(a.distance), elevationGainMeters: r(a.total_elevation_gain),
    averageHeartRate: r(a.average_heartrate), maxHeartRate: r(a.max_heartrate), relativeEffort: a.suffer_score,
    kudos: a.kudos_count, comments: a.comment_count, achievements: a.achievement_count, prs: a.pr_count, photoCount: a.total_photo_count,
    gearId: a.gear_id, deviceName: a.device_name, description: a.description?.slice(0, 2000),
    weatherCondition: a.weather_condition, temperatureC: a.temperature_c, trainingLoad: a.training_load, perceivedExertion: a.perceived_exertion,
    hasPolyline: Boolean(a.map?.summary_polyline),
    recordedAt: now.toISOString(),
  }) as StravaActivityRecord;
}

/** Drops undefined values so optional fields are absent rather than present-and-undefined. */
function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function toPhotoRecords(a: StravaActivity, photos: StravaPhoto[], workout: Workout | undefined, now: Date = new Date()): StravaPhotoRecord[] {
  const out: StravaPhotoRecord[] = [];
  for (const p of photos) {
    const sizes = Object.keys(p.urls ?? {}).map(Number).filter(Number.isFinite).sort((x, y) => y - x);
    const best = sizes[0];
    const url = best === undefined ? undefined : p.urls?.[String(best)];
    if (!url || !p.unique_id) continue;
    const dims = best === undefined ? undefined : p.sizes?.[String(best)];
    out.push(strip({
      uniqueId: p.unique_id, stravaId: a.id, workoutId: workout?.id,
      takenAt: new Date(p.created_at ?? a.start_date).toISOString(), url,
      width: dims?.[0], height: dims?.[1], caption: p.caption ? p.caption.slice(0, 500) : undefined,
      activityName: a.name ?? "", activityType: activityTypeOf(a), recordedAt: now.toISOString(),
    }) as StravaPhotoRecord);
  }
  return out;
}

/** A Strava summary polyline as a route, for workouts the export has not covered yet. */
export function routeFromStrava(a: StravaActivity, workout: Workout, now: Date = new Date()): RouteRecord | undefined {
  const encoded = a.map?.summary_polyline;
  if (!encoded) return undefined;
  const track = decodePolyline(encoded);
  return buildRouteRecord({ id: workout.id, startedAt: workout.startedAt, activityType: workout.activityType }, track, "strava", now);
}
