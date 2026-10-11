/**
 * Reading a JSON body posted by Apple Shortcuts.
 *
 * Shortcuts is inconsistent about how it sends a body: a dictionary goes out as
 * `application/json`, but a *file* — which is what an app's "export" action usually hands
 * you — may arrive as `application/octet-stream`, as `text/plain`, or wrapped in
 * `multipart/form-data`. None of that is visible or debuggable from a phone, so the server
 * accepts all of them rather than returning a 400 the user cannot diagnose.
 */

export class BodyParseError extends Error {
  override readonly name = "BodyParseError";
  constructor(
    message: string,
    /** A bounded excerpt of what actually arrived, so a phone-side mistake is diagnosable. */
    readonly received: string,
  ) {
    super(message);
  }
}

const EXCERPT = 200;

export async function readJsonBody(request: {
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) throw new BodyParseError("Request body is empty", "");

  const candidates = [raw, ...multipartParts(raw, request.headers.get("content-type"))];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      /* try the next candidate */
    }
  }

  throw new BodyParseError("Request body is not valid JSON", raw.slice(0, EXCERPT));
}

/**
 * Pulls the parts out of a multipart body. Shortcuts uses this when a File is attached
 * rather than raw text; the JSON is one of the parts, after its own headers.
 */
function multipartParts(raw: string, contentType: string | null): string[] {
  if (!contentType?.toLowerCase().includes("multipart/")) return [];
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) return [];

  return raw
    .split(`--${marker.trim()}`)
    // A part is headers, a blank line, then the body.
    .map((part) => {
      const split = part.indexOf("\r\n\r\n");
      return split === -1 ? "" : part.slice(split + 4);
    })
    .filter(Boolean);
}
