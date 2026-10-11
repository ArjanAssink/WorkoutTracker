import { activityColor, activityEmoji, displayName } from "./activityType.js";
import type { Workout } from "./workout.js";

/**
 * iCalendar (RFC 5545) rendering, so a calendar app can subscribe to your training history
 * and show each workout as an event.
 *
 * Pure string building with no I/O, which is the only reason this is testable — the format
 * is fiddly in ways that are invisible until a calendar client silently drops an event.
 */

export interface CalendarOptions {
  /** Shown as the calendar's name in the subscribing client. */
  name?: string;
  /** How often clients should re-fetch. Calendars poll on their own schedule regardless. */
  refreshMinutes?: number;
  /** Stable namespace for UIDs; keep it constant or clients will duplicate every event. */
  uidDomain?: string;
  /** Prefix each summary with the activity's glyph. On by default. */
  emoji?: boolean;
  now?: Date;
}

const DEFAULTS = {
  name: "Workouts",
  refreshMinutes: 60,
  uidDomain: "workout-tracker",
  emoji: true,
} as const;

export function renderCalendar(workouts: Workout[], options: CalendarOptions = {}): string {
  const { name, refreshMinutes, uidDomain, emoji } = { ...DEFAULTS, ...options };
  const stamp = formatUtc(options.now ?? new Date());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//workout-tracker//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-CALDESC:${escapeText("Workouts recorded in Apple Health")}`,
    // Both spellings: the X- form is what Apple and Google actually honour, the
    // standard REFRESH-INTERVAL is what RFC 7986 specifies.
    `X-PUBLISHED-TTL:PT${refreshMinutes}M`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshMinutes}M`,
  ];

  for (const workout of workouts) {
    lines.push(...renderEvent(workout, stamp, uidDomain, emoji));
  }

  lines.push("END:VCALENDAR");
  // RFC 5545 requires CRLF, and a trailing one after the final line.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function renderEvent(workout: Workout, stamp: string, uidDomain: string, emoji: boolean): string[] {
  const label = displayName(workout.activityType);
  const title = emoji ? `${activityEmoji(workout.activityType)} ${label}` : label;
  const parts = [title, formatDuration(workout.durationSeconds)];
  if (workout.distanceMeters) parts.push(formatDistance(workout.distanceMeters));

  return [
    "BEGIN:VEVENT",
    // Derived from the workout id, so a re-fetch updates the event in place rather than
    // creating a second copy of every workout.
    `UID:${workout.id}@${uidDomain}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${formatUtc(new Date(workout.startedAt))}`,
    `DTEND:${formatUtc(new Date(workout.endedAt))}`,
    `SUMMARY:${escapeText(parts.join(" · "))}`,
    `DESCRIPTION:${escapeText(describe(workout))}`,
    `CATEGORIES:${escapeText("Workout")},${escapeText(label)}`,
    // RFC 7986. Apple and Google ignore per-event colour on a subscribed feed and colour
    // by calendar instead; this is for the clients that do honour it.
    `COLOR:${activityColor(workout.activityType)}`,
    // A past workout should not make you look busy to anyone checking your availability.
    "TRANSP:TRANSPARENT",
    "X-MICROSOFT-CDO-BUSYSTATUS:FREE",
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ];
}

function describe(workout: Workout): string {
  const rows: string[] = [`Duration: ${formatDuration(workout.durationSeconds)}`];
  if (workout.distanceMeters) rows.push(`Distance: ${formatDistance(workout.distanceMeters)}`);
  if (workout.activeEnergyKcal) rows.push(`Active energy: ${Math.round(workout.activeEnergyKcal)} kcal`);
  if (workout.averageHeartRate) rows.push(`Avg heart rate: ${workout.averageHeartRate} bpm`);
  if (workout.maxHeartRate) rows.push(`Max heart rate: ${workout.maxHeartRate} bpm`);
  // Say which model produced the number, so an estimate never reads as a measurement.
  rows.push(
    `Effort: ${workout.effort}${workout.effortModel === "met-minutes" ? " (estimated — no heart rate)" : ""}`,
  );
  if (workout.sourceName) rows.push(`Source: ${workout.sourceName}`);
  if (workout.notes) rows.push(`Notes: ${workout.notes}`);
  return rows.join("\n");
}

/** `20260314T070000Z`. Calendar clients convert UTC to the viewer's local time. */
export function formatUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Backslash, semicolon, comma and newline are structural in RFC 5545 and must be escaped. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Folds a content line to 75 octets, continuing with CRLF + a single space.
 *
 * The limit is octets, not characters, and a fold must never split a multi-byte UTF-8
 * sequence — a workout named with an emoji or an accented character would otherwise emit
 * a broken byte pair that some clients reject and others render as a replacement glyph.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  // 75 for the first line; continuations spend one octet on the leading space.
  let limit = 75;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > limit) {
      out.push(current);
      current = "";
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += size;
  }
  if (current) out.push(current);

  return out.join("\r\n ");
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}
