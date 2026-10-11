import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import {
  analyseBlockLift, dots, estimate1Rm, fitPersonalCurve, relativeStrength, topSet, wendler,
  type BlockLiftSeries, type Lift, type PersonalCurve,
} from "../domain/strength.js";
import type { LoggedSet } from "../ingest/blockLog.js";
import { isAuthorised } from "../http/auth.js";
import { ok, serverError, unauthorised } from "../http/responses.js";
import { liftOf, type PrRecord } from "../storage/liftRepository.js";
import { getBodyWeightRepository, getLiftRepository } from "./shared.js";

/**
 * `GET /api/lifts` — everything the Strength page needs in one response:
 *
 *   prs      per lift, the dated top sets with every estimate attached — Wendler, the
 *            personal curve where the rep-max board supports one, bodyweight from the
 *            weight table, and the relative and DOTS forms. Two sources feed it: the PR
 *            log's to-failure sets, and the weekly block log, where each session's top set
 *            is derived from the sets as written and carries its RIR
 *   repMax   the rep-max board per lift with its fitted curve
 *   blocks   each training block's week-by-week training maxes, analysed
 *
 * A few hundred rows in total; computing it all per request is cheaper than caching.
 */

const BODYWEIGHT_WINDOW_DAYS = 10;

export interface PrPoint {
  date: string;
  reps: number;
  kg: number;
  program?: string;
  bodyweightKg?: number;
  bodyweightSource?: "weight-table" | "sheet";
  e1rm: number;
  e1rmWendler: number;
  estimator: "wendler" | "personal";
  lowConfidence: boolean;
  relative?: number;
  allometric?: number;
  dots?: number;
  /** Block-log points only. */
  source?: "block-log";
  session?: string;
  rir?: number;
  /** Stopped short of failure: the estimate reads the set as `reps + rir`. */
  submax?: boolean;
  /** Bodyweight lifts: `kg` is the added load and `e1rm` the estimated added-load single; this is what the bar actually held. */
  loadKg?: number;
}

export async function getLifts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const settings = config();
  if (!isAuthorised(request, settings.ingestApiKey)) return unauthorised();

  try {
    const lifts = await getLiftRepository();
    const [prs, repMaxes, tms, sets] = await Promise.all([lifts.prs(), lifts.repMaxes(), lifts.trainingMaxes(), lifts.sets()]);

    // --- rep-max board and the per-lift personal curves ------------------------
    const board = new Map<string, { lift: Lift; asOf: string; points: Array<{ reps: number; kg: number }> }>();
    for (const r of repMaxes) {
      const entry = board.get(r.lift) ?? { lift: liftOf(r), asOf: r.asOf, points: [] };
      entry.points.push({ reps: r.reps, kg: r.kg });
      board.set(r.lift, entry);
    }
    const curves = new Map<string, PersonalCurve>();
    for (const [slug, entry] of board) {
      const curve = fitPersonalCurve(entry.points);
      if (curve) curves.set(slug, curve);
    }
    const repMax = [...board.values()].map((entry) => {
      const curve = curves.get(entry.lift.slug);
      const points = entry.points
        .sort((a, b) => a.reps - b.reps)
        .map((p) => ({ ...p, e1rmWendler: round1(wendler(p.kg, p.reps)), ...(curve ? { e1rmPersonal: round1(curve ? estimate1Rm(p.kg, p.reps, curve).e1rm : 0) } : {}) }));
      const best = points.reduce((b, p) => ((p.e1rmPersonal ?? p.e1rmWendler) > (b.e1rmPersonal ?? b.e1rmWendler) ? p : b), points[0]!);
      return { lift: entry.lift, asOf: entry.asOf, points, curve: curve ?? null, best: { reps: best.reps, kg: best.kg, e1rm: best.e1rmPersonal ?? best.e1rmWendler } };
    });

    // --- PR log with bodyweight joined -------------------------------------------
    const dated = [...prs.map((r) => r.date), ...sets.map((r) => r.date)].sort();
    const weights = dated.length
      ? await (await getBodyWeightRepository()).list(shiftDays(dated[0]!, -BODYWEIGHT_WINDOW_DAYS), shiftDays(dated[dated.length - 1]!, BODYWEIGHT_WINDOW_DAYS))
      : [];
    const weightDates = weights.map((w) => Date.parse(`${w.date}T00:00:00Z`));
    const nearestWeight = (date: string): number | undefined => {
      const t = Date.parse(`${date}T00:00:00Z`);
      let best: number | undefined, bestGap = Infinity;
      for (let i = 0; i < weights.length; i++) {
        const gap = Math.abs(weightDates[i]! - t);
        if (gap < bestGap) { bestGap = gap; best = weights[i]!.kg; }
      }
      return bestGap <= BODYWEIGHT_WINDOW_DAYS * 86_400_000 ? best : undefined;
    };

    const byLift = new Map<string, { lift: Lift; points: PrPoint[] }>();
    for (const r of prs as PrRecord[]) {
      const curve = curves.get(r.lift);
      const est = estimate1Rm(r.kg, r.reps, curve);
      const fromTable = nearestWeight(r.date);
      const bw = fromTable ?? r.bodyweightKg;
      const point: PrPoint = {
        date: r.date, reps: r.reps, kg: r.kg,
        ...(r.program ? { program: r.program } : {}),
        ...(bw ? { bodyweightKg: round1(bw), bodyweightSource: fromTable ? "weight-table" : "sheet" } : {}),
        e1rm: est.e1rm, e1rmWendler: round1(wendler(r.kg, r.reps)), estimator: est.estimator, lowConfidence: est.lowConfidence,
      };
      if (bw) {
        const rel = relativeStrength(est.e1rm, bw);
        point.relative = Math.round(rel.ratio * 1000) / 1000;
        point.allometric = Math.round(rel.allometric * 100) / 100;
        point.dots = round1(dots(est.e1rm, bw));
      }
      const entry = byLift.get(r.lift) ?? { lift: liftOf(r), points: [] };
      entry.points.push(point);
      byLift.set(r.lift, entry);
    }

    // --- the weekly log: one point per session and lift, from its top set ---------------
    // A bodyweight lift is estimated on bodyweight plus the added load, then shown as the
    // added load — "16 kg × 5" is how a weighted pull-up is thought about, and a 1RM of
    // "+25 kg" reads the same way. Without a weigh-in nearby there is nothing to estimate.
    const bySession = new Map<string, { record: typeof sets[number]; point: PrPoint }>();
    for (const r of sets) {
      if (r.lift === "assisted-pull-up") continue; // its number is assistance, not load
      if (r.family === "other") continue;           // accessories are stored, not charted: eighty series would bury the lifts
      const bodyweight = r.family === "pull";
      const bw = nearestWeight(r.date);
      if (bodyweight && !bw) continue;
      let logged: LoggedSet[];
      try { logged = JSON.parse(r.sets) as LoggedSet[]; } catch { continue; }
      const loaded = logged.map((x) => ({ ...x, kg: x.kg === "bw" ? 0 : x.kg })).map((x) => ({ ...x, kg: x.kg === undefined ? undefined : bodyweight ? x.kg + bw! : x.kg }));
      const top = topSet(loaded, r.rir, curves.get(r.lift));
      if (!top) continue;
      const added = bodyweight ? top.set.kg! - bw! : top.set.kg!;
      const e1rm = bodyweight ? round1(top.e1rm - bw!) : top.e1rm;
      const e1rmWendler = bodyweight ? round1(wendler(top.set.kg!, top.reps) - bw!) : round1(wendler(top.set.kg!, top.reps));
      const point: PrPoint = {
        date: r.date, reps: top.set.reps, kg: round2(added), program: r.program, session: r.session, source: "block-log",
        ...(bw ? { bodyweightKg: round1(bw), bodyweightSource: "weight-table" } : {}),
        ...(r.rir !== undefined ? { rir: r.rir } : {}),
        ...(r.rir ? { submax: true } : {}),
        ...(bodyweight ? { loadKg: round1(top.set.kg!) } : {}),
        e1rm, e1rmWendler, estimator: top.estimator, lowConfidence: top.reps > 10,
      };
      if (bw) {
        // Relative forms on what was actually lifted — for a pull-up, the whole body plus the plate.
        const total = bodyweight ? top.e1rm : e1rm;
        const rel = relativeStrength(total, bw);
        point.relative = Math.round(rel.ratio * 1000) / 1000;
        point.allometric = Math.round(rel.allometric * 100) / 100;
        point.dots = round1(dots(total, bw));
      }
      const key = `${r.date}|${r.lift}`;
      const existing = bySession.get(key);
      if (!existing || point.e1rm > existing.point.e1rm) bySession.set(key, { record: r, point });
    }
    for (const { record, point } of bySession.values()) {
      const entry = byLift.get(record.lift) ?? { lift: liftOf(record), points: [] };
      entry.points.push(point);
      byLift.set(record.lift, entry);
    }

    const prSeries = [...byLift.values()].map((e) => ({ ...e, points: e.points.sort((a, b) => a.date.localeCompare(b.date)) }));

    // --- blocks -------------------------------------------------------------------
    const blocks = new Map<string, { program: string; start: string; weeks: number; lifts: Map<string, { lift: Lift; byWeek: Map<number, number> }> }>();
    for (const t of tms) {
      const block = blocks.get(t.program) ?? { program: t.program, start: t.programStart, weeks: 0, lifts: new Map() };
      block.weeks = Math.max(block.weeks, t.week);
      const entry = block.lifts.get(t.lift) ?? { lift: liftOf(t), byWeek: new Map() };
      entry.byWeek.set(t.week, t.kg);
      block.lifts.set(t.lift, entry);
      blocks.set(t.program, block);
    }
    const blockSummaries = [...blocks.values()].map((b) => ({
      program: b.program,
      start: b.start,
      weeks: b.weeks,
      lifts: [...b.lifts.values()]
        .map((e) => analyseBlockLift(e.lift, Array.from({ length: b.weeks }, (_, i) => e.byWeek.get(i + 1) ?? null)))
        .filter((s): s is BlockLiftSeries => s !== undefined)
        .sort((x, y) => x.lift.family.localeCompare(y.lift.family) || x.lift.label.localeCompare(y.lift.label)),
    }));

    return ok({
      prs: prSeries,
      repMax,
      blocks: blockSummaries,
      weightsJoined: prSeries.reduce((n, s) => n + s.points.filter((p) => p.bodyweightSource === "weight-table").length, 0),
    });
  } catch (error) {
    context.error("Failed to build lifts", error);
    return serverError("Failed to build lifts");
  }
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

app.http("getLifts", { route: "api/lifts", methods: ["GET"], authLevel: "anonymous", handler: getLifts });
