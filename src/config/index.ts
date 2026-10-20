import type { AthleteProfile } from "../domain/effort.js";
import { DEFAULT_PROFILE } from "../domain/effort.js";
import { DEFAULT_GOALS, parseGoalTargets, type GoalPeriod, type GoalSchedule, type GoalSpec } from "../domain/goals.js";

export interface AppConfig extends TableTarget {
  /** Shared secret the Shortcut sends in `x-api-key`. */
  ingestApiKey: string;
  /**
   * Read-only token for the calendar feed, passed in the query string because calendar
   * clients cannot send custom headers. Separate from {@link ingestApiKey} on purpose: a
   * subscription URL ends up stored in a calendar app and synced between devices, so
   * leaking it must not grant write access. Unset disables the feed entirely.
   */
  calendarToken: string | undefined;
  profile: AthleteProfile;
  /** The current goals. */
  goals: GoalSpec;
  /** Every period, oldest first, ending with the current goals; weeks are judged by the one in force. */
  goalSchedule: GoalSchedule;
  /** Telegram delivery for the weekly summary. Both unset disables it. */
  telegram: { botToken: string; chatId: string } | undefined;
  /** Strava API application; tokens themselves live in the settings table once connected. */
  strava: { clientId: string; clientSecret: string } | undefined;
  /** Where this app is reachable, for OAuth callbacks. */
  publicUrl: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new ConfigError(`Missing required setting: ${name}`);
  return value;
}

function num(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new ConfigError(`Setting ${name} is not a number: ${raw}`);
  return parsed;
}

/** Where workout rows live. Everything that reads or writes the table needs this. */
export interface TableTarget {
  storageConnectionString: string;
  tableName: string;
  userId: string;
}

/**
 * The athlete profile. Every field has a documented default, so this never throws —
 * a caller that only needs to score workouts should not have to configure storage.
 */
export function loadAthleteProfile(env: NodeJS.ProcessEnv = process.env): AthleteProfile {
  return {
    restingHeartRate: num("ATHLETE_RESTING_HR", env, DEFAULT_PROFILE.restingHeartRate),
    maxHeartRate: num("ATHLETE_MAX_HR", env, DEFAULT_PROFILE.maxHeartRate),
    weightKg: num("ATHLETE_WEIGHT_KG", env, DEFAULT_PROFILE.weightKg),
    trimpFactor: num("ATHLETE_TRIMP_FACTOR", env, DEFAULT_PROFILE.trimpFactor),
  };
}

/**
 * Storage coordinates alone. Split out from {@link loadConfig} so the import CLI — which
 * has no HTTP surface — does not have to supply an API key it never uses, and so a
 * `--dry-run` can skip this entirely rather than demanding credentials to write nothing.
 */
export function loadTableTarget(env: NodeJS.ProcessEnv = process.env): TableTarget {
  return {
    storageConnectionString: env["WORKOUTS_STORAGE"] ?? required("AzureWebJobsStorage", env),
    tableName: env["WORKOUTS_TABLE"] ?? "workouts",
    userId: env["WORKOUTS_USER_ID"] ?? "me",
  };
}

/**
 * Weekly goals, editable as app settings so they can change without a deploy:
 *   WEEKLY_GOALS=strength:3,martialarts:2,taichi:1
 *   GOOD_WEEK_SESSIONS=5
 *   VERY_GOOD_WEEK_SESSIONS=6
 *   VERY_GOOD_WEEK_MIN=strength:2
 *   WEEKLY_GOALS_FROM=2026-04-27            when the current goals began (default: always)
 *   WEEKLY_GOALS_HISTORY=[{"from":"2022-02-07","targets":"strength:3","good":4,"veryGood":5,"veryGoodMin":"strength:2"}, …]
 * Earlier weeks are judged by the history period in force; before the first period, by the first.
 */
export function loadGoalSchedule(env: NodeJS.ProcessEnv = process.env): GoalSchedule {
  const current: GoalPeriod = { ...loadGoals(env), from: env["WEEKLY_GOALS_FROM"]?.trim() || "2000-01-01" };
  const periods: GoalPeriod[] = [];
  const raw = env["WEEKLY_GOALS_HISTORY"]?.trim();
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ConfigError("WEEKLY_GOALS_HISTORY is not valid JSON"); }
    if (!Array.isArray(parsed)) throw new ConfigError("WEEKLY_GOALS_HISTORY must be a JSON array");
    for (const p of parsed as Array<Record<string, unknown>>) {
      const from = typeof p["from"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p["from"]) ? p["from"] : undefined;
      if (!from) throw new ConfigError("Each WEEKLY_GOALS_HISTORY period needs a from: YYYY-MM-DD");
      const targetsRaw = typeof p["targets"] === "string" ? p["targets"] : "";
      periods.push({
        from,
        targets: targetsRaw.trim() ? parseGoalTargets(targetsRaw) : [],
        goodWeekSessions: typeof p["good"] === "number" ? p["good"] : current.goodWeekSessions,
        veryGoodWeekSessions: typeof p["veryGood"] === "number" ? p["veryGood"] : current.veryGoodWeekSessions,
        veryGoodWeekMinimums: typeof p["veryGoodMin"] === "string" ? (p["veryGoodMin"].trim() ? parseGoalTargets(p["veryGoodMin"]) : []) : current.veryGoodWeekMinimums,
      });
    }
  }
  periods.push(current);
  return { periods: periods.sort((a, b) => a.from.localeCompare(b.from)) };
}

export function loadGoals(env: NodeJS.ProcessEnv = process.env): GoalSpec {
  return {
    targets: parseGoalTargets(env["WEEKLY_GOALS"]),
    goodWeekSessions: num("GOOD_WEEK_SESSIONS", env, DEFAULT_GOALS.goodWeekSessions),
    veryGoodWeekSessions: num("VERY_GOOD_WEEK_SESSIONS", env, DEFAULT_GOALS.veryGoodWeekSessions),
    veryGoodWeekMinimums: env["VERY_GOOD_WEEK_MIN"]?.trim() ? parseGoalTargets(env["VERY_GOOD_WEEK_MIN"]) : DEFAULT_GOALS.veryGoodWeekMinimums,
  };
}

/** The full contract the Function App needs: storage, the shared secret, and the profile. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    ...loadTableTarget(env),
    ingestApiKey: required("INGEST_API_KEY", env),
    calendarToken: env["CALENDAR_TOKEN"] || undefined,
    profile: loadAthleteProfile(env),
    goals: loadGoals(env),
    goalSchedule: loadGoalSchedule(env),
    telegram:
      env["TELEGRAM_BOT_TOKEN"] && env["TELEGRAM_CHAT_ID"]
        ? { botToken: env["TELEGRAM_BOT_TOKEN"], chatId: env["TELEGRAM_CHAT_ID"] }
        : undefined,
    strava:
      env["STRAVA_CLIENT_ID"] && env["STRAVA_CLIENT_SECRET"]
        ? { clientId: env["STRAVA_CLIENT_ID"], clientSecret: env["STRAVA_CLIENT_SECRET"] }
        : undefined,
    publicUrl: env["PUBLIC_URL"] || undefined,
  };
}

/** Memoised so each function invocation does not re-read and re-validate the environment. */
let cached: AppConfig | undefined;

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test seam — drops the memoised config so a test can swap the environment. */
export function resetConfig(): void {
  cached = undefined;
}
