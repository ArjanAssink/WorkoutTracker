import { readFile } from "node:fs/promises";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

/**
 * Serves the single-page dashboard.
 *
 * Deliberately unauthenticated: the page is a static shell containing no workout data.
 * It prompts for the API key in the browser and calls the authenticated JSON endpoints
 * with it, so the secret never has to live in a query string or a cookie.
 *
 * Serving it from the Function App rather than a separate Static Web App keeps the whole
 * deployment to one resource — and the page is same-origin with the API, so there is no
 * CORS configuration to get wrong.
 */

// Resolved from the module URL: dist/src/functions/ -> the package root.
const PAGE_PATH = new URL("../../../public/index.html", import.meta.url);

/** Read once per process; the page is immutable for the lifetime of a deployment. */
let pagePromise: Promise<string> | undefined;

function loadPage(): Promise<string> {
  pagePromise ??= readFile(PAGE_PATH, "utf8");
  return pagePromise;
}

export async function dashboard(
  _request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    return {
      status: 200,
      body: await loadPage(),
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The page is served from the deployment package and changes only on deploy,
        // but it is small enough that revalidating beats serving a stale shell.
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    };
  } catch (error) {
    // A failed read means the package was built without public/ — worth saying plainly.
    pagePromise = undefined;
    context.error("Could not read the dashboard page", error);
    return { status: 500, body: "Dashboard page is not available in this deployment." };
  }
}

app.http("dashboard", {
  route: "api/dashboard",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: dashboard,
});
