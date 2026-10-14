import { describe, expect, it } from "vitest";
import { encodePolyline } from "../src/domain/routes.js";
import { activityTypeOf, matchWorkout, routeFromStrava, toActivityRecord, toPhotoRecords, type StravaActivity } from "../src/domain/strava.js";
import type { Workout } from "../src/domain/workout.js";

const w = (id: string, startedAt: string, activityType: string): Workout => ({ id, activityType, startedAt, endedAt: startedAt, durationSeconds: 3600, effort: 50, effortModel: "trimp", source: "health-export", recordedAt: startedAt });
const ride: StravaActivity = { id: 42, name: "Evening spin", sport_type: "GravelRide", start_date: "2026-10-10T17:02:10Z", distance: 31234.5, moving_time: 4200, total_elevation_gain: 88.4, average_heartrate: 141.2, suffer_score: 61, kudos_count: 7, total_photo_count: 2, gear_id: "b123", device_name: "Apple Watch" };

describe("Strava activities", () => {
  it("maps sport types onto the app's slugs, with a sane fallback", () => {
    expect(activityTypeOf(ride)).toBe("cycling");
    expect(activityTypeOf({ ...ride, sport_type: "TrailRun" })).toBe("running");
    expect(activityTypeOf({ ...ride, sport_type: undefined, type: "Walk" })).toBe("walking");
    expect(activityTypeOf({ ...ride, sport_type: "Pickleball" })).toBe("pickleball");
    expect(activityTypeOf({ ...ride, sport_type: "SomethingNew" })).toBe("somethingnew");
  });

  it("matches the Apple Health workout that started within five minutes, preferring the same type", () => {
    const workouts = [w("walk", "2026-10-10T17:01:00Z", "walking"), w("ride", "2026-10-10T17:03:30Z", "cycling"), w("far", "2026-10-10T18:00:00Z", "cycling")];
    expect(matchWorkout(ride, workouts)?.id).toBe("ride");
    expect(matchWorkout({ ...ride, start_date: "2026-10-10T12:00:00Z" }, workouts)).toBeUndefined();
    expect(matchWorkout({ ...ride, sport_type: "Yoga" }, workouts)?.id).toBe("walk"); // nothing of its type nearby: nearest start
  });

  it("keeps what Strava adds and nothing undefined", () => {
    const r = toActivityRecord(ride, w("ride", "2026-10-10T17:03:30Z", "cycling"), new Date("2026-10-11T00:00:00Z"));
    expect(r).toMatchObject({ stravaId: 42, workoutId: "ride", activityType: "cycling", sportType: "GravelRide", distanceMeters: 31235, elevationGainMeters: 88, averageHeartRate: 141, relativeEffort: 61, kudos: 7, photoCount: 2, gearId: "b123", hasPolyline: false });
    expect(Object.values(r).every((v) => v !== undefined)).toBe(true);
    expect("maxHeartRate" in r).toBe(false);
  });

  it("takes the largest size of each photo and links it to the workout", () => {
    const photos = toPhotoRecords(ride, [
      { unique_id: "p1", urls: { "600": "https://x/p1-600.jpg", "1024": "https://x/p1-1024.jpg" }, sizes: { "1024": [1024, 768] }, created_at: "2026-10-10T17:40:00Z", caption: "Dunes" },
      { unique_id: "p2", urls: {} },
    ], w("ride", "2026-10-10T17:03:30Z", "cycling"));
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ uniqueId: "p1", stravaId: 42, workoutId: "ride", url: "https://x/p1-1024.jpg", width: 1024, height: 768, caption: "Dunes", activityName: "Evening spin", takenAt: "2026-10-10T17:40:00.000Z" });
  });

  it("turns a summary polyline into a route for the matched workout", () => {
    const encoded = encodePolyline([{ lat: 52.17, lon: 4.44 }, { lat: 52.18, lon: 4.45 }, { lat: 52.19, lon: 4.47 }]);
    const route = routeFromStrava({ ...ride, map: { summary_polyline: encoded } }, w("ride", "2026-10-10T17:03:30Z", "cycling"))!;
    expect(route.workoutId).toBe("ride");
    expect(route.source).toBe("strava");
    expect(route.pointCount).toBe(3);
    expect(route.distanceMeters).toBeGreaterThan(2000);
    expect(routeFromStrava(ride, w("ride", "2026-10-10T17:03:30Z", "cycling"))).toBeUndefined();
  });
});
