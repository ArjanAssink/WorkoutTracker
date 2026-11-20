export interface WeekAnnotation { label: string; note: string }

/** A blank label removes an annotation. Weeks are keyed by their ISO Monday. */
export function parseWeekAnnotation(body: unknown): { weekStart: string; annotation: WeekAnnotation | null } {
  if (!body || typeof body !== "object") throw new Error("Send a weekStart, label, and optional note.");
  const { weekStart, label, note = "" } = body as Record<string, unknown>;
  if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error("weekStart must be a Monday in YYYY-MM-DD format.");
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== weekStart || date.getUTCDay() !== 1) throw new Error("weekStart must be a valid Monday.");
  if (typeof label !== "string" || typeof note !== "string") throw new Error("Label and note must be text.");
  if (label.trim().length > 60 || note.trim().length > 500) throw new Error("Use at most 60 characters for the label and 500 for the note.");
  return { weekStart, annotation: label.trim() ? { label: label.trim(), note: note.trim() } : null };
}
