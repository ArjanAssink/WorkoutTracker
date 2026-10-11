import { describe, expect, it } from "vitest";
import { BodyParseError, readJsonBody } from "../src/http/jsonBody.js";

function request(body: string, contentType?: string) {
  return {
    text: async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType ?? null : null) },
  };
}

const PAYLOAD = '{"data":{"workouts":[{"name":"Running"}]}}';

describe("readJsonBody", () => {
  it("reads a normal JSON body", async () => {
    expect(await readJsonBody(request(PAYLOAD, "application/json"))).toEqual({
      data: { workouts: [{ name: "Running" }] },
    });
  });

  it("reads JSON sent with the wrong content type — Shortcuts sends files as octet-stream", async () => {
    expect(await readJsonBody(request(PAYLOAD, "application/octet-stream"))).toHaveProperty("data");
    expect(await readJsonBody(request(PAYLOAD, "text/plain"))).toHaveProperty("data");
    expect(await readJsonBody(request(PAYLOAD))).toHaveProperty("data");
  });

  it("tolerates surrounding whitespace and newlines", async () => {
    expect(await readJsonBody(request(`\n\n  ${PAYLOAD}\n`, "application/json"))).toHaveProperty("data");
  });

  it("unwraps a multipart/form-data file part", async () => {
    const b = "Boundary-ABC123";
    const body =
      `--${b}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="HealthData.json"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${PAYLOAD}\r\n` +
      `--${b}--\r\n`;
    expect(await readJsonBody(request(body, `multipart/form-data; boundary=${b}`))).toHaveProperty("data");
  });

  it("unwraps a quoted multipart boundary", async () => {
    const b = "x-y-z";
    const body = `--${b}\r\nContent-Type: application/json\r\n\r\n${PAYLOAD}\r\n--${b}--\r\n`;
    expect(await readJsonBody(request(body, `multipart/form-data; boundary="${b}"`))).toHaveProperty("data");
  });

  it("rejects an empty body", async () => {
    await expect(readJsonBody(request("", "application/json"))).rejects.toThrow(BodyParseError);
    await expect(readJsonBody(request("   "))).rejects.toThrow(BodyParseError);
  });

  it("carries a bounded excerpt of unparseable input, so a phone-side mistake is diagnosable", async () => {
    const junk = "x".repeat(1000);
    const error = await readJsonBody(request(junk)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BodyParseError);
    expect((error as BodyParseError).received).toHaveLength(200);
  });
});
