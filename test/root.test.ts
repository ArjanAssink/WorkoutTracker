import { describe, expect, it } from "vitest";
import { root } from "../src/functions/root.js";

const req = (url: string) => ({ url }) as Parameters<typeof root>[0];

describe("root redirect", () => {
  it("sends / to the dashboard", async () => {
    const res = await root(req("https://workouts.example.com/"));
    expect(res.status).toBe(302);
    expect(res.headers).toMatchObject({ location: "/api/dashboard" });
  });

  it("carries the query string through, so ?key= keeps working", async () => {
    const res = await root(req("https://workouts.example.com/?key=abc"));
    expect(res.headers).toMatchObject({ location: "/api/dashboard?key=abc" });
  });

  it("does not sweep unknown paths into the redirect", async () => {
    expect((await root(req("https://workouts.example.com/nope"))).status).toBe(404);
    expect((await root(req("https://workouts.example.com/api/unknown"))).status).toBe(404);
  });
});
