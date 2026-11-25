import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { decodeSeries } from "../domain/heartRateSeries.js";
import { isWorkoutId, parseTagUpdate, TagError } from "../domain/tags.js";
import { isAuthorised } from "../http/auth.js";
import { BodyParseError, readJsonBody } from "../http/jsonBody.js";
import { badRequest, json, ok, serverError, unauthorised } from "../http/responses.js";
import { getHeartRateSeriesRepository, getTagRepository } from "./shared.js";

/**
 * What the history page fetches beside `/api/workouts`:
 *
 * `GET  /api/workouts/heartrate?id=&startedAt=`  heart rate over one workout, 404 when none was stored
 * `GET  /api/workouts/tags`                      every workout's tags, `{ tags: { <id>: [...] } }`
 * `POST /api/workouts/tags`                      `{ id, startedAt, tags }` replaces one workout's tags
 */

export async function workoutHeartRate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  const params = new URL(request.url).searchParams;
  const id = params.get("id"), startedAt = params.get("startedAt");
  if (!isWorkoutId(id)) return badRequest("'id' must be a workout id");
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) return badRequest("'startedAt' must be an ISO date");
  try {
    const record = await (await getHeartRateSeriesRepository()).get(new Date(startedAt).toISOString(), id);
    const series = decodeSeries(record?.series);
    if (!record || !series) return json(404, { error: "No heart-rate stream stored for this workout" });
    return { ...ok({ id, startedAt: record.startedAt, ...series }), headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=3600" } };
  } catch (error) {
    context.error("Failed to read heart-rate series", error);
    return serverError("Failed to read heart-rate series");
  }
}

export async function listTags(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  try {
    const all = await (await getTagRepository()).list();
    return ok({ tags: Object.fromEntries(all.map((t) => [t.workoutId, t.tags])) });
  } catch (error) {
    context.error("Failed to list tags", error);
    return serverError("Failed to list tags");
  }
}

export async function saveTags(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  let update;
  try {
    update = parseTagUpdate(await readJsonBody(request));
  } catch (error) {
    if (error instanceof TagError || error instanceof BodyParseError) return badRequest(error.message);
    throw error;
  }
  try {
    await (await getTagRepository()).set({ ...update, updatedAt: new Date().toISOString() });
    return ok({ id: update.workoutId, tags: update.tags });
  } catch (error) {
    context.error("Failed to save tags", error);
    return serverError("Could not save the tags. Please try again.");
  }
}

app.http("workoutHeartRate", { route: "api/workouts/heartrate", methods: ["GET"], authLevel: "anonymous", handler: workoutHeartRate });
app.http("listTags", { route: "api/workouts/tags", methods: ["GET"], authLevel: "anonymous", handler: listTags });
app.http("saveTags", { route: "api/workouts/tags", methods: ["POST"], authLevel: "anonymous", handler: saveTags });
