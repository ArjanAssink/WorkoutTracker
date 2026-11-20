import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { parseWeekAnnotation } from "../domain/weekAnnotation.js";
import { isAuthorised } from "../http/auth.js";
import { readJsonBody } from "../http/jsonBody.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { getSettingsRepository } from "./shared.js";

export async function saveWeekAnnotation(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  let parsed;
  try { parsed = parseWeekAnnotation(await readJsonBody(request)); }
  catch (error) { return badRequest(error instanceof Error ? error.message : "Invalid week annotation"); }
  try {
    const repository = await getSettingsRepository();
    const key = `week.annotation.${parsed.weekStart}`;
    if (parsed.annotation) await repository.set(key, parsed.annotation);
    else await repository.delete(key);
    return ok(parsed);
  } catch (error) {
    context.error("Failed to save week annotation", error);
    return serverError("Could not save this week's label. Please try again.");
  }
}

app.http("saveWeekAnnotation", { route: "api/weekly/annotation", methods: ["POST"], authLevel: "anonymous", handler: saveWeekAnnotation });
