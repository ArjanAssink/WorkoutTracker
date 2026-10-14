import type { LatLon } from "../domain/routes.js";

/**
 * Apple's workout-route GPX: one `<trk>`, thousands of `<trkpt lon=".." lat="..">`. A
 * regular expression is enough — the attribute order varies between files, nothing else
 * does — and it is an order of magnitude faster than a DOM for a 400 KB file.
 */
const POINT = /<trkpt\s+(?:lon="(-?[\d.]+)"\s+lat="(-?[\d.]+)"|lat="(-?[\d.]+)"\s+lon="(-?[\d.]+)")/g;

export function parseGpxTrack(gpx: string): LatLon[] {
  const out: LatLon[] = [];
  for (const m of gpx.matchAll(POINT)) {
    const lon = Number(m[1] ?? m[4]), lat = Number(m[2] ?? m[3]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push({ lat, lon });
  }
  return out;
}
