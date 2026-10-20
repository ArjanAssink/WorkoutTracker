import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { analysePatterns, type Patterns } from "../domain/patterns.js";
import { homeOf } from "../domain/routes.js";
import { isAuthorised } from "../http/auth.js";
import { ok, serverError, unauthorised } from "../http/responses.js";
import { getBodyWeightRepository, getRecoveryRepository, getRepository, getRouteRepository } from "./shared.js";

/**
 * `GET /api/recovery/patterns` — the whole history analysed: training against sleep,
 * resting HR, HRV, weight and daylight. Everything in storage is read, so the result is
 * kept for a day — the data barely moves — and dropped the moment a push writes
 * something, so the next read recomputes. `?fresh` forces it (the sync script does that).
 */
const CACHE_MS = 24 * 60 * 60_000;
let cache: { at: number; value: Patterns | undefined } | undefined;

/** Called by the write paths: a new workout, batch or weigh-in makes the cached analysis stale. */
export function invalidatePatterns(): void {
  cache = undefined;
}

export async function patternsHttp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS || new URL(request.url).searchParams.has("fresh")) {
      const to = new Date(Date.now() + 86_400_000);
      const days = await (await getRecoveryRepository()).list("2000-01-01", to.toISOString().slice(0, 10));
      const first = days[0]?.date ?? "2000-01-01";
      const [workouts, weights, routes] = await Promise.all([
        (await getRepository()).listAll({ from: new Date(`${first}T00:00:00Z`), to }),
        (await getBodyWeightRepository()).list(first, to.toISOString().slice(0, 10)),
        (await getRouteRepository()).list(new Date("2000-01-01T00:00:00Z"), to),
      ]);
      const home = homeOf(routes) ?? { lat: 52.2, lon: 4.5 };
      cache = { at: Date.now(), value: analysePatterns(days, workouts, weights, "Europe/Amsterdam", home) };
    }
    return ok({ computedAt: new Date(cache.at).toISOString(), patterns: cache.value ?? null });
  } catch (error) {
    context.error("Failed to analyse patterns", error);
    return serverError("Failed to analyse patterns");
  }
}

app.http("recoveryPatterns", { route: "api/recovery/patterns", methods: ["GET"], authLevel: "anonymous", handler: patternsHttp });
