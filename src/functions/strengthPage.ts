import { readFile } from "node:fs/promises";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

/** `/api/strength` — the Strength page, served the same way as the dashboard. */
const PAGE_PATH = new URL("../../../public/strength.html", import.meta.url);
let pagePromise: Promise<string> | undefined;

export async function strengthPage(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    pagePromise ??= readFile(PAGE_PATH, "utf8");
    return {
      status: 200,
      body: await pagePromise,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
    };
  } catch (error) {
    pagePromise = undefined;
    context.error("Could not read the strength page", error);
    return { status: 500, body: "Strength page is not available in this deployment." };
  }
}

app.http("strengthPage", { route: "api/strength", methods: ["GET"], authLevel: "anonymous", handler: strengthPage });
