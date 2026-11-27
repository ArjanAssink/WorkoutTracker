import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { parseComparisonFrom } from "../domain/goals.js";
import { isAuthorised } from "../http/auth.js";
import { readJsonBody } from "../http/jsonBody.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { getSettingsRepository } from "./shared.js";

const KEY = "weekly.comparisonFrom";

/** The first day a "typical week" may draw on, or undefined for no limit. */
export async function readComparisonFrom(): Promise<string | undefined> {
  const value = await (await getSettingsRepository()).get<string>(KEY);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/**
 * `GET|POST /api/weekly/comparison` — `{ from: "YYYY-MM-DD" | null }`.
 * Weeks from `from` on compare only with weeks from `from` on (see `ReviewOptions.comparisonFrom`).
 */
export async function weeklyComparison(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  try {
    if (request.method === "GET") return ok({ from: (await readComparisonFrom()) ?? null });
    let from: string | null;
    try { from = parseComparisonFrom(await readJsonBody(request)); }
    catch (error) { return badRequest(error instanceof Error ? error.message : "Invalid comparison date"); }
    const repository = await getSettingsRepository();
    if (from) await repository.set(KEY, from); else await repository.delete(KEY);
    return ok({ from });
  } catch (error) {
    context.error("Failed to read or save the comparison start", error);
    return serverError("Could not save the comparison start.");
  }
}

app.http("weeklyComparison", { route: "api/weekly/comparison", methods: ["GET", "POST"], authLevel: "anonymous", handler: weeklyComparison });
