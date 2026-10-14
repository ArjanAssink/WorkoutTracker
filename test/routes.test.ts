import { describe, expect, it } from "vitest";
import {
  buildRouteRecord, decodePolyline, encodePolyline, haversineMeters, homeOf, simplifyTrack, splitHomeAway, trackDistanceMeters, type RouteRecord,
} from "../src/domain/routes.js";
import { parseGpxTrack } from "../src/ingest/gpx.js";

const HOME = { lat: 52.1744, lon: 4.4454 };
/** A straight line of `n` points heading due north from `from`, `step` metres apart. */
function line(from: { lat: number; lon: number }, n: number, step = 10): Array<{ lat: number; lon: number }> {
  return Array.from({ length: n }, (_, i) => ({ lat: from.lat + (i * step) / 110_540, lon: from.lon }));
}

describe("gpx", () => {
  it("reads points whichever way round the attributes are", () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lon="4.445388" lat="52.174409"><ele>8.8</ele><time>2024-04-09T17:24:48Z</time></trkpt>
      <trkpt lat="52.174398" lon="4.445405"><ele>8.8</ele></trkpt>
      <trkpt lon="999" lat="52.1"></trkpt>
    </trkseg></trk></gpx>`;
    expect(parseGpxTrack(gpx)).toEqual([{ lat: 52.174409, lon: 4.445388 }, { lat: 52.174398, lon: 4.445405 }]);
  });
});

describe("simplifyTrack", () => {
  it("collapses a straight line to its ends and keeps a real corner", () => {
    const straight = line(HOME, 200);
    expect(simplifyTrack(straight)).toHaveLength(2);
    const top = line(HOME, 100)[99]!;
    const corner = [...line(HOME, 100), ...Array.from({ length: 100 }, (_, i) => ({ lat: top.lat, lon: top.lon + (i * 10) / 68_000 }))]; // north, then east
    expect(simplifyTrack(corner)).toHaveLength(3);
  });
  it("keeps a wiggle larger than the tolerance", () => {
    const pts = line(HOME, 50);
    pts[25] = { lat: pts[25]!.lat, lon: pts[25]!.lon + 30 / 68_000 }; // a 30 m excursion sideways
    const kept = simplifyTrack(pts, 12);
    expect(kept).toContainEqual(pts[25]);        // the excursion survives…
    expect(kept.length).toBeLessThanOrEqual(5);  // …with at most its two neighbours, which the slanted chords now miss
    expect(simplifyTrack(pts, 50)).toHaveLength(2);
  });
});

describe("polyline", () => {
  it("round-trips to five decimals and matches Google's reference example", () => {
    const pts = [{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }, { lat: 43.252, lon: -126.453 }];
    expect(encodePolyline(pts)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
    const track = line(HOME, 30, 25);
    expect(decodePolyline(encodePolyline(track)).map((p) => [Math.round(p.lat * 1e5), Math.round(p.lon * 1e5)])).toEqual(track.map((p) => [Math.round(p.lat * 1e5), Math.round(p.lon * 1e5)]));
  });
});

describe("buildRouteRecord", () => {
  const workout = { id: "w1", startedAt: "2026-04-09T17:24:48Z", activityType: "walking" };
  it("stores the simplified track, its bounds, its ends and the distance of the full track", () => {
    const track = line(HOME, 300, 10); // ~3 km straight
    const r = buildRouteRecord(workout, track, "health-export")!;
    expect(r.pointCount).toBe(2);
    expect(r.rawPointCount).toBe(300);
    expect(r.distanceMeters).toBeGreaterThan(2950); expect(r.distanceMeters).toBeLessThan(3050);
    expect(r.startLat).toBeCloseTo(HOME.lat, 4);
    expect(r.maxLat).toBeGreaterThan(r.minLat);
    expect(decodePolyline(r.polyline)).toHaveLength(2);
  });
  it("drops the points inside a privacy zone, so the track starts a street away", () => {
    const track = line(HOME, 300, 10);
    const r = buildRouteRecord(workout, track, "health-export", new Date(), { ...HOME, radiusMeters: 200 })!;
    expect(haversineMeters({ lat: r.startLat, lon: r.startLon }, HOME)).toBeGreaterThan(200);
    expect(buildRouteRecord(workout, line(HOME, 10, 10), "health-export", new Date(), { ...HOME, radiusMeters: 500 })).toBeUndefined();
  });
});

describe("home and away", () => {
  const rec = (start: { lat: number; lon: number }, id: string): RouteRecord => ({
    workoutId: id, startedAt: "2026-01-01T00:00:00Z", activityType: "walking", polyline: "", pointCount: 2, rawPointCount: 2, distanceMeters: 1000,
    startLat: start.lat, startLon: start.lon, endLat: start.lat, endLon: start.lon, minLat: start.lat, minLon: start.lon, maxLat: start.lat, maxLon: start.lon, source: "t", recordedAt: "t",
  });
  const lisbon = { lat: 38.72, lon: -9.14 }, porto = { lat: 41.15, lon: -8.61 }, oslo = { lat: 59.91, lon: 10.75 };
  const routes = [
    ...Array.from({ length: 20 }, (_, i) => rec({ lat: HOME.lat + i * 0.0005, lon: HOME.lon }, `h${i}`)),
    rec({ lat: HOME.lat + 0.09, lon: HOME.lon }, "h-10km-out"),
    rec(lisbon, "l1"), rec({ lat: lisbon.lat + 0.05, lon: lisbon.lon }, "l2"), rec(porto, "p1"), rec(oslo, "o1"),
  ];
  it("finds home where most routes start", () => {
    const home = homeOf(routes)!;
    expect(haversineMeters(home, HOME)).toBeLessThan(1000);
  });
  it("splits by start point: a route starting 10 km out is still home; the rest group into places", () => {
    const { home, away } = splitHomeAway(routes, HOME);
    expect(home).toHaveLength(21);
    expect(away.map((p) => p.routes.length)).toEqual([2, 1, 1]); // Lisbon (two starts 5 km apart), Porto, Oslo — Porto is 270 km from Lisbon
    expect(haversineMeters(away[0]!.centre, lisbon)).toBeLessThan(5000);
  });
  it("measures distance", () => {
    expect(trackDistanceMeters([HOME, { lat: HOME.lat + 0.01, lon: HOME.lon }])).toBeCloseTo(1112, -1);
  });
});
