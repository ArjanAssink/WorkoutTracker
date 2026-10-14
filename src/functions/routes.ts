import { readFile } from "node:fs/promises";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { homeOf, splitHomeAway } from "../domain/routes.js";
import { isAuthorised } from "../http/auth.js";
import { ok, serverError, unauthorised } from "../http/responses.js";
import { getRouteRepository } from "./shared.js";

/**
 * `/api/map`           the route map page
 * `/api/routes/data`   every stored route (a few kilobytes each, so the whole history is
 *                      one response), with home and the away places worked out server-side
 *                      so the page and any other reader agree on what "home" is
 */

export async function routesData(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  try {
    const all = await (await getRouteRepository()).list(new Date("2000-01-01T00:00:00Z"), new Date(Date.now() + 86_400_000));
    const home = homeOf(all);
    const split = home ? splitHomeAway(all, home) : { home: [], away: [] };
    const placeOf = new Map<string, number>();
    split.away.forEach((p, i) => p.routes.forEach((r) => placeOf.set(r.workoutId, i)));
    return ok({
      count: all.length,
      home: home ? { lat: Math.round(home.lat * 1e4) / 1e4, lon: Math.round(home.lon * 1e4) / 1e4 } : null,
      places: split.away.map((p, i) => ({ index: i, centre: { lat: Math.round(p.centre.lat * 1e4) / 1e4, lon: Math.round(p.centre.lon * 1e4) / 1e4 }, routes: p.routes.length, first: p.routes[0]!.startedAt.slice(0, 10), last: p.routes[p.routes.length - 1]!.startedAt.slice(0, 10) })),
      routes: all.map((r) => ({
        id: r.workoutId, startedAt: r.startedAt, activityType: r.activityType, polyline: r.polyline, distanceMeters: r.distanceMeters, points: r.pointCount,
        start: { lat: r.startLat, lon: r.startLon }, bounds: { minLat: r.minLat, minLon: r.minLon, maxLat: r.maxLat, maxLon: r.maxLon },
        place: placeOf.get(r.workoutId) ?? null,
      })),
    });
  } catch (error) {
    context.error("Failed to list routes", error);
    return serverError("Failed to list routes");
  }
}

const PAGE_PATH = new URL("../../../public/map.html", import.meta.url);
let pagePromise: Promise<string> | undefined;

export async function mapPage(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    pagePromise ??= readFile(PAGE_PATH, "utf8");
    return {
      status: 200,
      body: await pagePromise,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
    };
  } catch (error) {
    pagePromise = undefined;
    context.error("Could not read the map page", error);
    return { status: 500, body: "Map page is not available in this deployment." };
  }
}

app.http("mapPage", { route: "api/map", methods: ["GET"], authLevel: "anonymous", handler: mapPage });
app.http("routesData", { route: "api/routes/data", methods: ["GET"], authLevel: "anonymous", handler: routesData });
