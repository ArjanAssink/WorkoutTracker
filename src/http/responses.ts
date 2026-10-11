import type { HttpResponseInit } from "@azure/functions";

export function json(status: number, body: unknown): HttpResponseInit {
  return {
    status,
    jsonBody: body,
    headers: { "content-type": "application/json; charset=utf-8" },
  };
}

export const ok = (body: unknown): HttpResponseInit => json(200, body);
export const created = (body: unknown): HttpResponseInit => json(201, body);

export const badRequest = (message: string, details?: string[]): HttpResponseInit =>
  json(400, details?.length ? { error: message, details } : { error: message });

export const unauthorised = (): HttpResponseInit => json(401, { error: "Invalid or missing API key" });

export const serverError = (message: string): HttpResponseInit => json(500, { error: message });
