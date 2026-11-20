import { displayName } from "./activityType.js";
import type { WeeklyReport, WeekReview } from "./goals.js";
import { isRestWeekLabel, isLowerEffortWeek } from "./weekRecovery.js";
import type { WeekAnnotation } from "./weekAnnotation.js";

/**
 * The Monday-morning message: what last week was, how it compares to a typical week, and
 * where it landed against the goals. Pure text assembly, so it can be tested and so the
 * same words go to every channel.
 *
 * Output is Telegram HTML (a small tag subset: <b>, <i>, <code>). Anything from the data
 * — activity names — is escaped before it goes in.
 */

const VERDICT = {
  perfect: { word: "PERFECT", emoji: "🏆" },
  verygood: { word: "VERY GOOD", emoji: "⭐" },
  good: { word: "GOOD", emoji: "✅" },
  short: { word: "SHORT", emoji: "⚠️" },
} as const;

export interface RestHistory {
  weeks: WeekReview[];
  annotations: Record<string, WeekAnnotation>;
}

/** Shared wording for a deliberate recovery week, without normal-goal pressure. */
export function restWeekFocus(annotation: WeekAnnotation, reviewed = false): string[] {
  return [
    `Marked as <b>${escape(annotation.label)}</b>. ${reviewed ? "Recovery was the focus; normal session targets were not the aim for that week." : "Recovery is the focus; normal session targets are not the aim this week."} No catch-up sessions needed.`,
    ...(annotation.note ? [`Your note: <i>${escape(annotation.note)}</i>`] : []),
  ];
}

export function composeWeeklySummary(report: WeeklyReport, restHistory?: RestHistory): string {
  const week = report.current;
  if (!week) return "No completed week to report on yet.";

  const annotation = restHistory?.annotations[week.weekStart];
  const restWeek = isRestWeekLabel(annotation);
  const verdict = VERDICT[week.verdict];
  const base = restWeek ? undefined : report.baseline;
  const lines: string[] = [];

  lines.push(restWeek ? `😴 <b>Week of ${weekLabel(week)} — REST / RECOVERY</b>` : `${verdict.emoji} <b>Week of ${weekLabel(week)} — ${verdict.word}</b>`);
  lines.push("");

  // Headline numbers, each against the typical week when there is one.
  lines.push(
    [
      `${week.totalSessions} session${week.totalSessions === 1 ? "" : "s"}${compare(week.totalSessions, base?.medianSessions)}`,
      `${duration(week.durationSeconds)}${compare(week.durationSeconds, base?.medianDurationSeconds, duration)}`,
      `${week.activeDays} active day${week.activeDays === 1 ? "" : "s"}`,
    ].join(" · "),
  );
  lines.push(effortLine(week));
  lines.push("");

  if (restWeek && annotation) {
    lines.push(...restWeekFocus(annotation, true));
  } else {
    // One line per target, aligned in a code block so the dots line up.
    const width = Math.max(...week.targets.map((t) => t.label.length));
    const rows = week.targets.map((t) => {
      const dots = "●".repeat(Math.min(t.actual, t.sessions)) + "○".repeat(Math.max(0, t.sessions - t.actual));
      const extra = t.actual > t.sessions ? ` +${t.actual - t.sessions}` : "";
      const mark = t.met ? " ✓" : "";
      return `${t.label.padEnd(width)}  ${dots.padEnd(3)} ${t.actual}/${t.sessions}${extra}${mark}`;
    });
    lines.push(`<code>${escape(rows.join("\n"))}</code>`);

    const others = otherSessions(week);
    if (others) lines.push(`<i>+ ${escape(others)}</i>`);
    lines.push("");

    lines.push(verdictLine(week, report));

  }

  // The run of recent weeks, oldest first, so the trend is visible at a glance.
  const history = report.weeks.slice(-8);
  if (!restWeek && history.length > 1) {
    const glyphs = history.map((w) => (w.verdict === "perfect" ? "▲" : w.verdict === "verygood" ? "◆" : w.verdict === "good" ? "■" : "·")).join(" ");
    const good = history.filter((w) => w.verdict !== "short").length;
    const perfect = history.filter((w) => w.verdict === "perfect").length;
    lines.push(
      `Last ${history.length} weeks: <code>${glyphs}</code>  ${good} good, ${perfect} perfect` +
        (report.streakWeeks > 1 ? ` · ${report.streakWeeks}-week streak` : ""),
    );
  }

  if (restHistory) lines.push("", ...restContextLines(week, restHistory));
  return lines.join("\n");
}

/** Relative to the reviewed week, never the wall clock or an unfinished week. */
export function restContextLines(current: WeekReview, history: RestHistory): string[] {
  const weeks = history.weeks.filter((w) => w.weekStart <= current.weekStart).slice().sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  if (!weeks.length) return ["Rest context: no completed weeks available."];
  const rest = weeks.find((w) => isRestWeekLabel(history.annotations[w.weekStart]));
  const comparable = weeks.filter((w) => w.typicalEffort !== undefined && w.typicalEffort > 0);
  const light = comparable.find(isLowerEffortWeek);
  const when = (w: WeekReview) => {
    const ago = Math.round((Date.parse(`${current.weekStart}T00:00:00Z`) - Date.parse(`${w.weekStart}T00:00:00Z`)) / (7 * 86400000));
    return ago === 0 ? "the week just reviewed" : `${ago} week${ago === 1 ? "" : "s"} ago`;
  };
  return [
    rest ? `🛌 Tagged rest: ${when(rest)} (week of ${weekLabel(rest)}; ${escape(history.annotations[rest.weekStart]!.label)}).`
      : `🛌 No tagged rest week in the ${weeks.length} completed weeks checked.`,
    light ? `Lower effort: ${when(light)} (week of ${weekLabel(light)}; ${Math.round(light.effort / light.typicalEffort! * 100)}% of typical).`
      : comparable.length ? `No lower-effort week found among ${comparable.length} weeks with a baseline.` : "Lower effort: not enough history for a baseline.",
    "<i>Lower effort = at least 40% below the preceding 12-week median of recorded effort.</i>",
    "<i>Planning guide: consider a lighter/recovery week every 4–8 weeks of sustained hard training. This is a starting point, not a fixed rule; adjust to fatigue and recovery.</i>",
  ];
}

/** "Effort 312 — 30% above your typical week (240)". The number alone means little. */
export function effortLine(week: WeekReview): string {
  const effort = Math.round(week.effort);
  if (week.typicalEffort === undefined || week.effortRatio === undefined) return `Effort ${effort}`;
  const pct = Math.round((week.effortRatio - 1) * 100);
  const typical = Math.round(week.typicalEffort);
  if (Math.abs(pct) < 10) return `Effort ${effort} — in line with your typical week (${typical})`;
  const word = pct >= 40 ? "a hard week" : pct > 0 ? "above" : pct <= -40 ? "a light week" : "below";
  const rel = pct > 0 ? `${pct}% above` : `${-pct}% below`;
  return pct >= 40 || pct <= -40
    ? `Effort ${effort} — ${word}, ${rel} your typical (${typical})`
    : `Effort ${effort} — ${rel} your typical week (${typical})`;
}

function verdictLine(week: WeekReview, report: WeeklyReport): string {
  const missed = week.targets.filter((t) => !t.met);
  switch (week.verdict) {
    case "perfect":
      return "Every target hit. That is the week you were aiming for.";
    case "verygood":
      return (
        `Very good week — ${week.veryGoodWeekSessions}+ sessions with the minimums met, but missed ` +
        missed.map((t) => `${escape(t.label)} (${t.actual}/${t.sessions})`).join(", ") +
        "."
      );
    case "good": {
      const floors = week.veryGoodWeekMinimums.filter((m) => (week.sessionsByActivity[m.activityType] ?? 0) < m.sessions).map((m) => `${m.sessions}× ${escape(displayName(m.activityType))}`);
      const gap = week.veryGoodWeekSessions - week.totalSessions;
      const toVeryGood = [gap > 0 ? `${gap} more session${gap === 1 ? "" : "s"}` : "", ...floors].filter(Boolean).join(" and ");
      return (
        `Good week — ${week.goodWeekSessions}+ sessions, but missed ` +
        missed.map((t) => `${escape(t.label)} (${t.actual}/${t.sessions})`).join(", ") +
        `.${toVeryGood ? ` Very good needed ${toVeryGood}.` : ""}`
      );
    }
    case "short": {
      const gap = week.goodWeekSessions - week.totalSessions;
      return `Short by ${gap} session${gap === 1 ? "" : "s"} of a good week. Missed ` +
        missed.map((t) => `${escape(t.label)} (${t.actual}/${t.sessions})`).join(", ") + ".";
    }
  }
}

/** "walking ×2, running" for sessions that were not part of any target. */
function otherSessions(week: WeekReview): string | undefined {
  const targeted = new Set(week.targets.map((t) => t.activityType));
  const parts = Object.entries(week.sessionsByActivity)
    .filter(([slug]) => !targeted.has(slug))
    .sort(([, a], [, b]) => b - a)
    .map(([slug, n]) => `${displayName(slug)}${n > 1 ? ` ×${n}` : ""}`);
  return parts.length ? parts.join(", ") : undefined;
}

function compare(value: number, typical: number | undefined, fmt: (n: number) => string = String): string {
  if (typical === undefined) return "";
  if (value === typical) return " (typical)";
  return ` (typical ${fmt(typical)})`;
}

function weekLabel(week: WeekReview): string {
  const start = new Date(`${week.weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const fmt = (d: Date, withMonth: boolean) =>
    d.toLocaleDateString("en-GB", { day: "numeric", ...(withMonth ? { month: "short" } : {}), timeZone: "UTC" });
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${fmt(start, false)}–${fmt(end, true)}`
    : `${fmt(start, true)} – ${fmt(end, true)}`;
}

function duration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Telegram HTML needs only these three escaped. */
export function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
