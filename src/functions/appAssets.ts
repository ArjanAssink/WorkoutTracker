import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";

export const assets: Record<string, string> = {
  "startup-v1-750x1334.png": "image/png",
  "startup-v1-1125x2436.png": "image/png",
  "startup-v1-1170x2532.png": "image/png",
  "startup-v1-1179x2556.png": "image/png",
  "startup-v1-1206x2622.png": "image/png",
  "startup-v1-828x1792.png": "image/png",
  "startup-v1-1242x2688.png": "image/png",
  "startup-v1-1284x2778.png": "image/png",
  "startup-v1-1290x2796.png": "image/png",
  "startup-v1-1320x2868.png": "image/png",
  "app-shell.js": "text/javascript; charset=utf-8",
  "notifications.js": "text/javascript; charset=utf-8",
  "app-version.json": "application/json; charset=utf-8",
  "manifest.webmanifest": "application/manifest+json; charset=utf-8",
  "icon-v1-192.png": "image/png",
  "icon-v1-512.png": "image/png",
  "icon-v1-maskable.png": "image/png",
  "apple-touch-icon-v1.png": "image/png",
  "favicon-v1.png": "image/png",
};

let versionPromise: Promise<string> | undefined;
export function getAppVersion(): Promise<string> {
  versionPromise ??= Promise.all(["index.html", "strength.html", "recovery.html", "map.html", "workouts.html", "app-assets/app-shell.js", "app-assets/notifications.js", "app-assets/manifest.webmanifest"].map((name) => readFile(new URL(`../../../public/${name}`, import.meta.url))))
    .then((files) => { const hash = createHash("sha256"); for (const file of files) hash.update(file); return hash.digest("hex").slice(0, 20); });
  return versionPromise;
}

/** Public branding only: a fixed allowlist prevents arbitrary file reads. */
export async function appAssets(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const asset = request.params["asset"] ?? "";
  const type = Object.hasOwn(assets, asset) ? assets[asset] : undefined;
  if (!type) return { status: 404, body: "Not found" };
  try {
    if (asset === "app-version.json") return { status: 200, jsonBody: { version: await getAppVersion() }, headers: { "cache-control": "no-store", "content-type": type, "x-content-type-options": "nosniff" } };
    const body = await readFile(new URL(`../../../public/app-assets/${asset}`, import.meta.url));
    return {
      status: 200,
      body: new Uint8Array(body),
      headers: {
        "content-type": type,
        "cache-control": ["manifest.webmanifest", "app-shell.js"].includes(asset) ? "no-cache" : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    };
  } catch (error) {
    context.error("Could not read app branding asset", error);
    return { status: 500, body: "App asset is not available in this deployment." };
  }
}

app.http("appAssets", { route: "api/app-assets/{asset}", methods: ["GET"], authLevel: "anonymous", handler: appAssets });
