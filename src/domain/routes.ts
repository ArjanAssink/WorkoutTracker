/**
 * Routes: the GPS track of a walk, ride, run or hike, reduced to something a map can draw.
 *
 * A watch records a point a second; a year of walking is millions of them. Each track is
 * simplified (Douglas–Peucker, a few metres) and stored as an encoded polyline — a few
 * kilobytes per workout, so the whole history is one small response.
 *
 * "Home" is wherever most routes *start*, not where they go: a ride from the front door
 * that ends sixty kilometres away is a home ride, and a walk in a city abroad is not.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteRecord {
  /** The workout's derived id; one route per workout. */
  workoutId: string;
  startedAt: string;
  activityType: string;
  /** Google polyline encoding of the simplified track, 5-decimal precision. */
  polyline: string;
  pointCount: number;
  /** Points in the original track, before simplification. */
  rawPointCount: number;
  distanceMeters: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
  source: string;
  recordedAt: string;
}

export const SIMPLIFY_TOLERANCE_METRES = 12;
/** Starting within this of the home point makes a route a home route. */
export const HOME_RADIUS_KM = 15;
/** Away routes whose starts are within this of each other are one place. */
export const PLACE_RADIUS_KM = 40;
const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Douglas–Peucker on a track, tolerance in metres. Iterative, not recursive: a long ride
 * has tens of thousands of points and the recursion depth would be the track length in
 * the worst case.
 */
export function simplifyTrack(points: LatLon[], toleranceMetres = SIMPLIFY_TOLERANCE_METRES): LatLon[] {
  if (points.length < 3) return points.slice();
  const lat0 = points.reduce((n, p) => n + p.lat, 0) / points.length;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 110_540;
  const xs = points.map((p) => p.lon * kx), ys = points.map((p) => p.lat * ky);
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const tol2 = toleranceMetres * toleranceMetres;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = xs[a]!, ay = ys[a]!, dx = xs[b]! - ax, dy = ys[b]! - ay, len2 = dx * dx + dy * dy;
    let best = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = xs[i]! - ax, py = ys[i]! - ay;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx, ey = py - t * dy, d2 = ex * ex + ey * ey;
      if (d2 > best) { best = d2; idx = i; }
    }
    if (best > tol2 && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

export function trackDistanceMeters(points: LatLon[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineMeters(points[i - 1]!, points[i]!);
  return d;
}

// ---------------------------------------------------------------------------
// Polyline encoding — the Google algorithm, so any map library can read it
// ---------------------------------------------------------------------------

export function encodePolyline(points: LatLon[], precision = 5): string {
  const factor = 10 ** precision;
  let out = "", lastLat = 0, lastLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * factor), lon = Math.round(p.lon * factor);
    out += enc(lat - lastLat) + enc(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return out;
}

export function decodePolyline(encoded: string, precision = 5): LatLon[] {
  const factor = 10 ** precision;
  const out: LatLon[] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => { let result = 0, shift = 0, b: number; do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20); return result & 1 ? ~(result >> 1) : result >> 1; };
  while (i < encoded.length) { lat += next(); lon += next(); out.push({ lat: lat / factor, lon: lon / factor }); }
  return out;
}

// ---------------------------------------------------------------------------
// Building a record, and the home/away split
// ---------------------------------------------------------------------------

export interface PrivacyZone extends LatLon {
  radiusMeters: number;
}

export function buildRouteRecord(
  workout: { id: string; startedAt: string; activityType: string },
  track: LatLon[],
  source: string,
  now: Date = new Date(),
  privacy?: PrivacyZone,
): RouteRecord | undefined {
  const kept = privacy ? track.filter((p) => haversineMeters(p, privacy) > privacy.radiusMeters) : track;
  if (kept.length < 2) return undefined;
  const simplified = simplifyTrack(kept);
  const first = simplified[0]!, last = simplified[simplified.length - 1]!;
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
  return {
    workoutId: workout.id, startedAt: workout.startedAt, activityType: workout.activityType,
    polyline: encodePolyline(simplified), pointCount: simplified.length, rawPointCount: track.length,
    distanceMeters: Math.round(trackDistanceMeters(kept)),
    startLat: r5(first.lat), startLon: r5(first.lon), endLat: r5(last.lat), endLon: r5(last.lon),
    minLat: r5(Math.min(...simplified.map((p) => p.lat))), minLon: r5(Math.min(...simplified.map((p) => p.lon))),
    maxLat: r5(Math.max(...simplified.map((p) => p.lat))), maxLon: r5(Math.max(...simplified.map((p) => p.lon))),
    source, recordedAt: now.toISOString(),
  };
}

/**
 * Where routes start most often: starts are binned on a ~1 km grid, the fullest bin wins,
 * and home is the mean of the starts in it. Undefined with nothing to go on.
 */
export function homeOf(routes: Array<{ startLat: number; startLon: number }>): LatLon | undefined {
  if (routes.length === 0) return undefined;
  const bins = new Map<string, { lat: number; lon: number; n: number }>();
  for (const r of routes) {
    const key = `${Math.round(r.startLat * 100)}|${Math.round(r.startLon * 100 * Math.cos((r.startLat * Math.PI) / 180))}`;
    const b = bins.get(key) ?? { lat: 0, lon: 0, n: 0 };
    b.lat += r.startLat; b.lon += r.startLon; b.n += 1; bins.set(key, b);
  }
  const best = [...bins.values()].reduce((a, b) => (b.n > a.n ? b : a));
  return { lat: best.lat / best.n, lon: best.lon / best.n };
}

export interface Place {
  centre: LatLon;
  routes: RouteRecord[];
}

/** Home routes start near home; the rest are grouped into places by where they start. */
export function splitHomeAway(routes: RouteRecord[], home: LatLon, homeRadiusKm = HOME_RADIUS_KM, placeRadiusKm = PLACE_RADIUS_KM): { home: RouteRecord[]; away: Place[] } {
  const homeRoutes: RouteRecord[] = [], places: Place[] = [];
  for (const r of routes) {
    const start = { lat: r.startLat, lon: r.startLon };
    if (haversineMeters(start, home) <= homeRadiusKm * 1000) { homeRoutes.push(r); continue; }
    let place = places.find((p) => haversineMeters(start, p.centre) <= placeRadiusKm * 1000);
    if (!place) { place = { centre: start, routes: [] }; places.push(place); }
    place.routes.push(r);
    // Keep the centre at the mean of its starts so a place settles where its routes are.
    const n = place.routes.length;
    place.centre = { lat: place.centre.lat + (start.lat - place.centre.lat) / n, lon: place.centre.lon + (start.lon - place.centre.lon) / n };
  }
  places.sort((a, b) => b.routes.length - a.routes.length);
  return { home: homeRoutes, away: places };
}
