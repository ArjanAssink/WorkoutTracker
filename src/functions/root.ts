import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";

/**
 * `/` redirects to the dashboard.
 *
 * The Functions host serves its own landing page at the root unless a function claims it,
 * and a function can only claim it when `host.json` sets `routePrefix` to "" — which is why
 * every other route in this folder carries `api/` explicitly.
 *
 * The route is `{path?}` — root or a single segment — not a `{*path}` catch-all. A catch-all
 * was observed beating `api/notify/weekly` in the host's route resolution (the one function
 * registered with two methods), returning 404 for a route that was correctly indexed. Every
 * real route has at least two segments, so an optional single segment cannot collide with
 * any of them; a stray single-segment path still gets a 404 here, deeper ones from the host.
 */
export async function root(request: HttpRequest): Promise<HttpResponseInit> {
  const url = new URL(request.url);
  if (url.pathname !== "/" && url.pathname !== "") {
    return { status: 404, body: "Not found" };
  }
  // Keep the query string: the dashboard accepts ?key= and strips it itself.
  return {
    status: 302,
    headers: { location: `/api/dashboard${url.search}`, "cache-control": "no-store" },
  };
}

app.http("root", {
  route: "{path?}",
  methods: ["GET", "HEAD"],
  authLevel: "anonymous",
  handler: root,
});
