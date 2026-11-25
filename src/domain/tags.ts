/**
 * Free-form tags on a workout ("race", "sick", "with Sam", "new shoes"). Kept in their own
 * table keyed by workout id rather than on the row: every import Replace-upserts the workout
 * row, which would erase anything the person wrote on it.
 */

export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;

export class TagError extends Error {
  override readonly name = "TagError";
}

/**
 * Trimmed, inner whitespace collapsed, lower-cased so "Race" and "race" are one tag, duplicates
 * dropped in first-seen order. Throws {@link TagError} on anything too long or too many.
 */
export function normaliseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TagError("'tags' must be an array of strings");
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") throw new TagError("'tags' must be an array of strings");
    const tag = entry.trim().replace(/\s+/g, " ").toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new TagError(`A tag can be at most ${MAX_TAG_LENGTH} characters`);
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new TagError(`At most ${MAX_TAGS} tags per workout`);
  return out;
}

/** What the `tags` table holds per workout. */
export interface WorkoutTags {
  workoutId: string;
  startedAt: string;
  tags: string[];
  updatedAt: string;
}

const WORKOUT_ID = /^[0-9a-f]{32}$/;

/** The body of `POST /api/workouts/tags`: `{ id, startedAt, tags }`. */
export function parseTagUpdate(body: unknown): { workoutId: string; startedAt: string; tags: string[] } {
  if (typeof body !== "object" || body === null) throw new TagError("Expected a JSON object");
  const o = body as Record<string, unknown>;
  const id = o["id"];
  if (typeof id !== "string" || !WORKOUT_ID.test(id)) throw new TagError("'id' must be a workout id");
  const startedAt = o["startedAt"];
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) throw new TagError("'startedAt' must be an ISO date");
  return { workoutId: id, startedAt: new Date(startedAt).toISOString(), tags: normaliseTags(o["tags"]) };
}

/** Accepts the same ids as {@link parseTagUpdate}; for the series point read. */
export function isWorkoutId(value: unknown): value is string {
  return typeof value === "string" && WORKOUT_ID.test(value);
}
