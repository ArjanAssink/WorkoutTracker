import { readFile } from "node:fs/promises";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import { BASELINE_DAYS, median, rateDay, rateWeek, weeklyRecovery, withBaselines, type Rating } from "../domain/recovery.js";
import { RangeError_, resolveRange } from "../http/dateRange.js";
import { isAuthorised } from "../http/auth.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { getRecoveryRepository, getRepository } from "./shared.js";

/**
 * `/api/recovery`          the Recovery page (sleep, resting HR, HRV against training load)
 * `/api/recovery/data`     what it reads: one row per day with baselines, the weekly join
 *                          with effort, and what a typical night looks like over the range
 */

const TYPICAL_DAYS = 90;

export async function recoveryData(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();
  let range;
  try {
    range = resolveRange(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof RangeError_) return badRequest(error.message);
    throw error;
  }
  try {
    const fromDate = range.from.toISOString().slice(0, 10), toDate = range.to.toISOString().slice(0, 10);
    // Baselines need the month before the range; the typical night needs a quarter.
    const leadIn = new Date(range.from.getTime() - Math.max(BASELINE_DAYS, TYPICAL_DAYS) * 86_400_000).toISOString().slice(0, 10);
    const [allDays, workouts] = await Promise.all([
      (await getRecoveryRepository()).list(leadIn, toDate),
      (await getRepository()).listAll({ from: range.from, to: range.to }),
    ]);
    const rated = withBaselines(allDays);
    const recent = allDays.filter((d) => d.date >= new Date(range.to.getTime() - TYPICAL_DAYS * 86_400_000).toISOString().slice(0, 10));
    const typical = {
      days: recent.length,
      asleepSeconds: med(recent.map((d) => d.sleepAsleepSeconds)),
      restingHeartRate: med(recent.map((d) => d.restingHeartRate)),
      hrv: med(recent.map((d) => d.hrv)),
      bedtimeMinutes: med(recent.map((d) => d.bedtimeMinutes)),
      wakeMinutes: med(recent.map((d) => d.wakeMinutes)),
      awakenings: med(recent.map((d) => d.sleepAwakenings)),
      respiratoryRate: med(recent.map((d) => d.respiratoryRate)),
    };
    // Ratings against the typical night of the range's end — "typical" is one quarter, not a moving target per day.
    const days = rated.filter((d) => d.date >= fromDate).map((d) => { const rating = rateDay(d, typical); return rating ? { ...d, rating } : d; });
    const weeks = weeklyRecovery(days, workouts, range.from, range.to).map((w) => {
      const end = new Date(Date.parse(`${w.weekStart}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const ratings = days.filter((d) => d.date >= w.weekStart && d.date < end).map((d) => (d as { rating?: Rating }).rating).filter((r): r is Rating => r !== undefined);
      const rating = rateWeek(ratings, w.bedtimeSdMinutes);
      return rating ? { ...w, rating } : w;
    });
    const latest = [...days].reverse().find((d) => (d as { rating?: Rating }).rating);
    const current = latest ? { date: latest.date, rating: (latest as { rating: Rating }).rating } : undefined;
    return ok({ from: range.from.toISOString(), to: range.to.toISOString(), days, weeks, typical, current });
  } catch (error) {
    context.error("Failed to build recovery data", error);
    return serverError("Failed to build recovery data");
  }
}

function med(values: Array<number | undefined>): number | undefined {
  const v = values.filter((x): x is number => x !== undefined);
  return v.length ? Math.round(median(v) * 10) / 10 : undefined;
}

const PAGE_PATH = new URL("../../../public/recovery.html", import.meta.url);
let pagePromise: Promise<string> | undefined;

export async function recoveryPage(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    pagePromise ??= readFile(PAGE_PATH, "utf8");
    return {
      status: 200,
      body: await pagePromise,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
    };
  } catch (error) {
    pagePromise = undefined;
    context.error("Could not read the recovery page", error);
    return { status: 500, body: "Recovery page is not available in this deployment." };
  }
}

app.http("recoveryPage", { route: "api/recovery", methods: ["GET"], authLevel: "anonymous", handler: recoveryPage });
app.http("recoveryData", { route: "api/recovery/data", methods: ["GET"], authLevel: "anonymous", handler: recoveryData });
