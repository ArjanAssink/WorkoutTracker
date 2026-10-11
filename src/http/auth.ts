import { timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "@azure/functions";

/**
 * A single shared secret, sent by the Shortcut as `x-api-key`. Apple Shortcuts cannot do an
 * OAuth flow unattended, so a long random key in a header is the realistic option; it is
 * compared in constant time and never logged.
 */
export function isAuthorised(request: HttpRequest, expectedKey: string): boolean {
  const presented = request.headers.get("x-api-key") ?? bearerToken(request);
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expectedKey, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(request: HttpRequest): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
