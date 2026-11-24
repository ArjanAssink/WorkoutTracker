import { readFile } from "node:fs/promises";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

/**
 * `/api/history` — every workout, with the detail the dashboard's recent list has no room
 * for. A static shell like the other pages; the data comes from `/api/workouts`.
 */
const PAGE_PATH = new URL("../../../public/workouts.html", import.meta.url);
let pagePromise: Promise<string> | undefined;

export async function workoutsPage(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    pagePromise ??= readFile(PAGE_PATH, "utf8");
    return {
      status: 200,
      body: await pagePromise,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
    };
  } catch (error) {
    pagePromise = undefined;
    context.error("Could not read the workouts page", error);
    return { status: 500, body: "Workouts page is not available in this deployment." };
  }
}

app.http("workoutsPage", { route: "api/history", methods: ["GET"], authLevel: "anonymous", handler: workoutsPage });
