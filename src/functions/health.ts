import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { ok } from "../http/responses.js";

/** Unauthenticated liveness probe — handy for confirming a deploy landed. */
export async function health(_request: HttpRequest): Promise<HttpResponseInit> {
  return ok({ status: "ok", time: new Date().toISOString() });
}

app.http("health", {
  route: "api/health",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: health,
});
