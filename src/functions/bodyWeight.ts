import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { dailyWeights, toKg } from "../domain/bodyWeight.js";
import { RangeError_, resolveRange } from "../http/dateRange.js";
import { isAuthorised } from "../http/auth.js";
import { badRequest, created, ok, serverError, unauthorised } from "../http/responses.js";
import { BodyParseError, readJsonBody } from "../http/jsonBody.js";
import { getBodyWeightRepository } from "./shared.js";

/**
 * `GET  /api/bodyweight?days=|from=&to=`   one reading per day, oldest first
 * `POST /api/bodyweight { date|at, kg|weight }`   a manual reading
 */
export async function bodyWeight(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();

  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      if (error instanceof BodyParseError) return badRequest(error.message);
      throw error;
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const at = typeof b["at"] === "string" ? b["at"] : typeof b["date"] === "string" ? `${b["date"]}T07:00:00Z` : undefined;
    const raw = b["kg"] ?? b["weight"];
    const kg = typeof raw === "number" ? toKg(raw, "kg") : typeof raw === "string" ? parseWeight(raw) : undefined;
    if (!at || kg === undefined) return badRequest("Provide 'date' (YYYY-MM-DD) or 'at', and 'kg' (or 'weight' like \"80.2 kg\")");

    const [entry] = dailyWeights([{ at, kg, sourceName: "Manual" }], "manual");
    if (!entry) return badRequest("Reading is outside the plausible range or the date is invalid");
    try {
      await (await getBodyWeightRepository()).upsert(entry);
      return created(entry);
    } catch (error) {
      context.error("Failed to store body weight", error);
      return serverError("Failed to store body weight");
    }
  }

  const params = new URL(request.url).searchParams;
  let range;
  try {
    range = resolveRange(params);
  } catch (error) {
    if (error instanceof RangeError_) return badRequest(error.message);
    throw error;
  }
  try {
    const repository = await getBodyWeightRepository();
    const entries = await repository.list(range.from.toISOString().slice(0, 10), range.to.toISOString().slice(0, 10));
    return ok({ from: range.from.toISOString(), to: range.to.toISOString(), count: entries.length, weights: entries });
  } catch (error) {
    context.error("Failed to list body weight", error);
    return serverError("Failed to list body weight");
  }
}

function parseWeight(text: string): number | undefined {
  const m = /^\s*([\d.,]+)\s*([A-Za-z]*)\s*$/.exec(text);
  if (!m) return undefined;
  return toKg(Number(m[1]!.replace(",", ".")), m[2] || "kg");
}

app.http("bodyWeight", {
  route: "api/bodyweight",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: bodyWeight,
});
