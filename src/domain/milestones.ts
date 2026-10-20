import { displayName } from "./activityType.js";
import { MAX_HR_WINDOW_DAYS, trailingMaxHeartRate, type AthleteProfile } from "./effort.js";
import type { GoalSpec, WeekReview } from "./goals.js";
import { escape } from "./weeklySummary.js";
import type { Workout } from "./workout.js";

/**
 * Things worth a message the moment they happen, rather than on Monday.
 *
 * A milestone is detected against the week in progress and identified by a key, so the
 * caller can remember what was already announced and never say it twice: the Health Auto
 * Export automation re-posts the same seven days every morning. Detection is pure; what
 * to send and when is the caller's business.
 */

export interface Milestone {
  /** Stable within a week: `good`, `perfect`, `streak:4`, `max-hr:197`, `longest:martialarts`. */
  key: string;
  /** Telegram HTML. */
  text: string;
  /** Keys this one supersedes — a perfect week is also a good one, and says so itself. */
  implies?: string[];
}

export interface MilestoneContext {
  spec: GoalSpec;
  profile: AthleteProfile;
  /** Every week evaluated, oldest first; the last one is the week in progress. */
  weeks: WeekReview[];
  /** Consecutive good-or-perfect weeks ending at the week in progress. */
  streakWeeks: number;
  /** Everything stored in the lookback window, the week in progress included. */
  history: Workout[];
  /** The workouts that just arrived — the only ones that can set a personal record. */
  arrived: Workout[];
  timeZone: string;
}

export const STREAK_MILESTONES = [4, 8, 12, 26, 52];
const MIN_WEEKS_FOR_RECORDS = 12;
const MIN_SESSIONS_FOR_LONGEST = 5;
/**
 * A "longest session" has to be clearly longer, not merely longer: for a class-based
 * activity the recorded length is mostly when the strap went on and came off (arriving
 * early adds twenty minutes of nothing), so the same neighbourhood is not a record.
 */
const LONGEST_MARGIN_FRACTION = 0.15;
const LONGEST_MARGIN_SECONDS = 15 * 60;
/** A new peak this far above the configured max is a strap glitch, not a record. */
const MAX_PLAUSIBLE_ABOVE_FALLBACK = 25;

export function detectMilestones(ctx: MilestoneContext): Milestone[] {
  const week = ctx.weeks[ctx.weeks.length - 1];
  if (!week) return [];
  const out: Milestone[] = [];
  const thisWeek = ctx.history.filter((w) => w.startedAt >= `${week.weekStart}T00:00:00`);
  const latestDay = weekdayOf(thisWeek.map((w) => w.startedAt).sort().pop(), ctx.timeZone);
  const by = latestDay ? ` by ${latestDay}` : "";
  const missing = week.targets.filter((t) => !t.met);
  const toGo = missing.map((t) => `${t.sessions - t.actual}× ${escape(t.label)}`).join(", ");
  const streak = ctx.streakWeeks > 1 ? ` That makes ${ctx.streakWeeks} good weeks in a row.` : "";

  const floors = ctx.spec.veryGoodWeekMinimums.filter((m) => (week.sessionsByActivity[m.activityType] ?? 0) < m.sessions).map((m) => `${m.sessions - (week.sessionsByActivity[m.activityType] ?? 0)}× ${escape(displayName(m.activityType))}`);
  const moreForVeryGood = Math.max(0, ctx.spec.veryGoodWeekSessions - week.totalSessions);
  if (week.verdict === "perfect") {
    out.push({
      key: "perfect",
      implies: ["verygood", "good", "volume", ...ctx.spec.targets.map((t) => `target:${t.activityType}`)],
      text: `🏆 <b>Perfect week</b> — every target hit${by}, ${week.totalSessions} sessions.${streak}`,
    });
  } else if (week.verdict === "verygood") {
    out.push({
      key: "verygood",
      implies: ["good", "volume"],
      text: `⭐ <b>Very good week</b> — ${week.totalSessions} sessions${by}, minimums met.${streak} Still open for a perfect one: ${toGo}.`,
    });
  } else if (week.verdict === "good") {
    const toVeryGood = [moreForVeryGood ? `${moreForVeryGood} more session${moreForVeryGood === 1 ? "" : "s"}` : "", ...floors].filter(Boolean).join(" and ");
    out.push({
      key: "good",
      text: `✅ <b>Good week</b> — ${week.totalSessions} sessions${by}.${streak} Very good needs ${toVeryGood}; perfect still needs ${toGo}.`,
    });
    // Enough sessions for a very good week, just not its shape.
    if (!moreForVeryGood && floors.length) {
      out.push({
        key: "volume",
        text: `🧩 ${week.totalSessions} sessions — enough for a very good week, just not its shape: ${floors.join(", ")} missing.`,
      });
    }
  }

  // Each target ticked off is its own checkpoint — the third strength session is news on
  // Wednesday, not only once the week as a whole is perfect.
  if (week.verdict !== "perfect") {
    for (const t of week.targets.filter((x) => x.met)) {
      const rest = missing.filter((m) => m !== t).map((m) => `${m.sessions - m.actual}× ${escape(m.label)}`).join(", ");
      out.push({
        key: `target:${t.activityType}`,
        text: `☑️ <b>${escape(t.label)} ${t.actual}/${t.sessions}</b> — target done for the week${by}.${rest ? ` Still open: ${rest}.` : ""}`,
      });
    }
  }

  if (week.verdict !== "short" && STREAK_MILESTONES.includes(ctx.streakWeeks)) {
    out.push({ key: `streak:${ctx.streakWeeks}`, text: `🔥 <b>${ctx.streakWeeks} good weeks in a row.</b>` });
  }

  // Records compare against the completed weeks before this one — a year of them at most,
  // and never fewer than a quarter of trained ones (the range is dense: empty weeks are
  // rows too), or every early week is a "record".
  const prior = ctx.weeks.slice(0, -1).filter((w) => w.totalSessions > 0);
  if (prior.length >= MIN_WEEKS_FOR_RECORDS) {
    const high = prior.reduce((b, w) => (w.effort > b.effort ? w : b));
    if (week.effort > high.effort && high.effort > 0) {
      out.push({
        key: "effort-high",
        text: `🔺 Hardest week in a year already: effort ${Math.round(week.effort)}, previous high ${Math.round(high.effort)} (week of ${dateLabel(high.weekStart)}).`,
      });
    }
  }

  const arrivedIds = new Set(ctx.arrived.map((w) => w.id));
  const before = ctx.history.filter((w) => !arrivedIds.has(w.id));
  for (const w of [...ctx.arrived].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (w.maxHeartRate) {
      const previous = trailingMaxHeartRate(before, new Date(w.startedAt), MAX_HR_WINDOW_DAYS);
      if (previous !== undefined && w.maxHeartRate > previous && w.maxHeartRate <= ctx.profile.maxHeartRate + MAX_PLAUSIBLE_ABOVE_FALLBACK) {
        out.push({
          key: `max-hr:${w.maxHeartRate}`,
          text: `❤️‍🔥 New max heart rate: <b>${w.maxHeartRate} bpm</b> (${escape(displayName(w.activityType))}, ${weekdayOf(w.startedAt, ctx.timeZone)}) — previous ${previous} in the past year.`,
        });
      }
    }
    if (ctx.spec.targets.some((t) => t.activityType === w.activityType)) {
      const same = before.filter((p) => p.activityType === w.activityType);
      const longest = Math.max(0, ...same.map((p) => p.durationSeconds));
      const clearlyLonger = w.durationSeconds >= longest * (1 + LONGEST_MARGIN_FRACTION) && w.durationSeconds - longest >= LONGEST_MARGIN_SECONDS;
      if (same.length >= MIN_SESSIONS_FOR_LONGEST && clearlyLonger) {
        out.push({
          key: `longest:${w.activityType}`,
          text: `⏱ Longest ${escape(displayName(w.activityType))} in a year by a margin: ${duration(w.durationSeconds)} (previous ${duration(longest)}, +${duration(w.durationSeconds - longest)}).`,
        });
      }
    }
  }

  return out;
}

/**
 * The mid-week check-in: where the week stands and what Sunday still needs. Nothing to say
 * once the week is already perfect — the milestone message has covered it.
 */
export function composeCheckIn(week: WeekReview, spec: GoalSpec, now: Date, timeZone: string, typicalSessions?: number): string | undefined {
  if (week.verdict === "perfect") return undefined;
  const today = weekdayOf(now.toISOString(), timeZone) ?? "today";
  const daysLeft = 7 - ((new Date(now).getUTCDay() + 6) % 7) - 1; // after today, through Sunday
  const missing = week.targets.filter((t) => !t.met);
  const forPerfect = missing.map((t) => `${t.sessions - t.actual}× ${escape(t.label)}`).join(", ");
  const lines: string[] = [];

  lines.push(`📍 <b>${today} check-in — week of ${weekLabel(week.weekStart)}</b>`);
  const gap = spec.goodWeekSessions - week.totalSessions, gapVery = spec.veryGoodWeekSessions - week.totalSessions;
  const floors = spec.veryGoodWeekMinimums.filter((m) => (week.sessionsByActivity[m.activityType] ?? 0) < m.sessions).map((m) => `${m.sessions - (week.sessionsByActivity[m.activityType] ?? 0)}× ${escape(displayName(m.activityType))}`);
  const standing = week.verdict === "verygood" ? " — very good week locked in."
    : gap > 0 ? ` — ${gap} more for a good week, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`
    : ` — good week locked in; very good needs ${[gapVery > 0 ? `${gapVery} more` : "", ...floors].filter(Boolean).join(" and ") || "nothing more"}.`;
  lines.push(
    `${week.totalSessions} session${week.totalSessions === 1 ? "" : "s"} so far` +
      (typicalSessions !== undefined ? ` (a typical week ends on ${typicalSessions})` : "") + standing,
  );
  const width = Math.max(...week.targets.map((t) => t.label.length));
  const rows = week.targets.map((t) => {
    const dots = "●".repeat(Math.min(t.actual, t.sessions)) + "○".repeat(Math.max(0, t.sessions - t.actual));
    const extra = t.actual > t.sessions ? ` +${t.actual - t.sessions}` : "";
    return `${t.label.padEnd(width)}  ${dots.padEnd(3)} ${t.actual}/${t.sessions}${extra}${t.met ? " ✓" : ""}`;
  });
  lines.push(`<code>${escape(rows.join("\n"))}</code>`);
  // Whether that fits in the days left is the lifter's call — two sessions in a day happen.
  lines.push(`For a perfect week: ${forPerfect} to go.`);
  return lines.join("\n");
}

function weekdayOf(iso: string | undefined, timeZone: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone }).format(d);
}

function dateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function weekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return `${dateLabel(weekStart)} – ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
}

function duration(seconds: number): string {
  const total = Math.round(seconds / 60), h = Math.floor(total / 60), m = total % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}
