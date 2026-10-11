import type { AthleteProfile } from "../domain/effort.js";
import { DEFAULT_PROFILE } from "../domain/effort.js";
import { DEFAULT_GOALS, parseGoalTargets, type GoalSpec } from "../domain/goals.js";

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
  goals: GoalSpec;
  /** Telegram delivery for the weekly summary. Both unset disables it. */
  telegram: { botToken: string; chatId: string } | undefined;
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
 */
export function loadGoals(env: NodeJS.ProcessEnv = process.env): GoalSpec {
  return {
    targets: parseGoalTargets(env["WEEKLY_GOALS"]),
    goodWeekSessions: num("GOOD_WEEK_SESSIONS", env, DEFAULT_GOALS.goodWeekSessions),
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
    telegram:
      env["TELEGRAM_BOT_TOKEN"] && env["TELEGRAM_CHAT_ID"]
        ? { botToken: env["TELEGRAM_BOT_TOKEN"], chatId: env["TELEGRAM_CHAT_ID"] }
        : undefined,
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
