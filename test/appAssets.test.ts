import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequest, InvocationContext } from "@azure/functions";
import { readFileSync } from "node:fs";
const read = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: read }));
import { appAssets } from "../src/functions/appAssets.js";
const request = (asset: string) => new HttpRequest({ method: "GET", url: `http://localhost/api/app-assets/${asset}`, params: { asset } });
beforeEach(() => { read.mockReset(); read.mockResolvedValue(Buffer.from("asset")); });
describe("app branding assets", () => {
  it.each(["../host.json", "constructor", "toString", "unknown.png"])("rejects non-asset %s without reading a file", async (asset) => {
    expect((await appAssets(request(asset), new InvocationContext())).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it("serves icons publicly as PNG with safe content headers", async () => {
    const response = await appAssets(request("icon-v1-512.png"), new InvocationContext());
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ "content-type": "image/png", "x-content-type-options": "nosniff" });
    expect(response.body).toBeInstanceOf(Uint8Array);
  });
  it("revalidates the manifest instead of permanently caching its metadata", async () => {
    const response = await appAssets(request("manifest.webmanifest"), new InvocationContext());
    expect(response.headers).toMatchObject({ "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" });
  });
  it("reports missing deployment files as an error", async () => {
    read.mockRejectedValueOnce(new Error("missing"));
    expect((await appAssets(request("icon-v1-512.png"), new InvocationContext())).status).toBe(500);
  });
  it("supplies real icon dimensions and keeps launch URLs free of credentials", () => {
    const manifest = JSON.parse(readFileSync(new URL("../public/app-assets/manifest.webmanifest", import.meta.url), "utf8"));
    expect(manifest.start_url).toBe("/api/dashboard");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      const bytes = readFileSync(new URL(`../public/app-assets/${icon.src.split("/").pop()}`, import.meta.url));
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });
});

it("revalidates the update script and never caches the deployment version", async () => {
  const script = await appAssets(request("app-shell.js"), new InvocationContext());
  expect(script.headers).toMatchObject({ "cache-control": "no-cache", "content-type": "text/javascript; charset=utf-8" });
  const version = await appAssets(request("app-version.json"), new InvocationContext());
  expect(version.headers).toMatchObject({ "cache-control": "no-store" });
  expect((version.jsonBody as { version: string }).version).toMatch(/^[a-f0-9]{20}$/);
});
