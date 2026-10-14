/**
 * Imports a Strava data archive.
 *
 *   npm run strava -- export_123.zip [--dry-run] [--no-photos]
 *
 * The archive (Settings → My Account → Request Your Archive) has every activity, every
 * kudos, the photos at full size, and GPX files for routes recorded in the Strava app.
 * Activities are matched to the Apple Health workouts by start time and stored beside
 * them; photos go to Blob storage; GPX routes fill in workouts the export had none for.
 * Needs WORKOUTS_STORAGE (or AzureWebJobsStorage) unless --dry-run.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import process from "node:process";
import { loadTableTarget } from "../src/config/index.js";
import { buildRouteRecord, type RouteRecord } from "../src/domain/routes.js";
import { matchWorkout, toActivityRecord, toPhotoRecords, type StravaActivityRecord, type StravaPhoto, type StravaPhotoRecord } from "../src/domain/strava.js";
import { parseGpxTrack } from "../src/ingest/gpx.js";
import { parseArchiveActivities, parseMediaCaptions, parsePrivacyZone } from "../src/ingest/stravaArchive.js";
import { readZip } from "../src/ingest/xlsx.js";
import { PhotoStore } from "../src/storage/photoStore.js";
import { RouteRepository } from "../src/storage/routeRepository.js";
import { StravaRepository } from "../src/storage/stravaRepository.js";
import { WorkoutRepository } from "../src/storage/workoutRepository.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false }, "no-photos": { type: "boolean", default: false } } });
  const file = positionals[0];
  if (!file) { console.log("Usage: npm run strava -- <export_*.zip> [--dry-run] [--no-photos]"); process.exit(1); }

  const zip = readZip(readFileSync(file));
  // The archive may have been re-zipped with a top-level folder; find the CSVs wherever they are.
  const find = (suffix: string) => [...zip.keys()].find((k) => k.endsWith(suffix) && !k.includes("__MACOSX"));
  const read = (suffix: string) => { const k = find(suffix); return k ? zip.get(k)!.toString("utf8") : ""; };
  const root = (find("activities.csv") ?? "activities.csv").replace(/activities\.csv$/, "");
  const entries = parseArchiveActivities(read("activities.csv"), read("reactions.csv"));
  const captions = parseMediaCaptions(read("media.csv"));
  const privacy = parsePrivacyZone(read("privacy_zones.csv"));
  if (!entries.length) { console.error("No activities.csv in the archive"); process.exit(1); }

  const target = values["dry-run"] ? undefined : loadTableTarget();
  const first = entries[0]!.activity.start_date, last = entries[entries.length - 1]!.activity.start_date;
  const workouts = target
    ? await WorkoutRepository.fromConnectionString(target.storageConnectionString, target.tableName, target.userId).listAll({ from: new Date(Date.parse(first) - 3_600_000), to: new Date(Date.parse(last) + 86_400_000) })
    : [];
  const routeRepo = target ? RouteRepository.fromConnectionString(target.storageConnectionString, target.userId) : undefined;
  const existingRoutes = new Set(routeRepo ? (await routeRepo.list(new Date(Date.parse(first) - 3_600_000), new Date(Date.parse(last) + 86_400_000))).map((r) => r.workoutId) : []);
  const photoStore = target && !values["no-photos"] ? PhotoStore.fromConnectionString(target.storageConnectionString) : undefined;
  await photoStore?.ensureContainer();

  const now = new Date();
  const records: StravaActivityRecord[] = [], photos: StravaPhotoRecord[] = [], routes: RouteRecord[] = [];
  let matched = 0, uploaded = 0, skippedMedia = 0, gpxRead = 0;
  for (const e of entries) {
    const workout = matchWorkout(e.activity, workouts);
    if (workout) matched++;
    records.push(toActivityRecord(e.activity, workout, now));
    // Photos: a blob per file, named by the archive's own id; the record points at the blob.
    const mediaPhotos = e.media.filter((m) => /\.(jpe?g|png|heic)$/i.test(m));
    skippedMedia += e.media.length - mediaPhotos.length;
    const asStrava: StravaPhoto[] = mediaPhotos.map((m) => { const name = m.replace(/^media\//, ""); const caption = captions.get(m); return { unique_id: name.replace(/\.[^.]+$/, ""), urls: { "9999": `blob:${name}` }, created_at: e.activity.start_date, ...(caption ? { caption } : {}) }; });
    photos.push(...toPhotoRecords(e.activity, asStrava, workout, now));
    if (photoStore) {
      for (const m of mediaPhotos) {
        const name = m.replace(/^media\//, ""); const data = zip.get(`${root}${m}`) ?? zip.get(m);
        if (!data) continue;
        if (!(await photoStore.exists(name))) { await photoStore.put(name, data, /\.png$/i.test(name) ? "image/png" : "image/jpeg"); uploaded++; }
      }
    }
    // Routes: GPX only (FIT is the watch's own recording, which the Apple export already carries).
    const filename = e.filename;
    if (workout && filename && /\.gpx$/i.test(filename) && !existingRoutes.has(workout.id)) {
      const data = zip.get(`${root}${filename}`) ?? zip.get(filename);
      if (data) { gpxRead++; const r = buildRouteRecord({ id: workout.id, startedAt: workout.startedAt, activityType: workout.activityType }, parseGpxTrack(data.toString("utf8")), "strava", now, privacy); if (r) routes.push(r); }
    }
  }

  console.log(`Archive            : ${entries.length} activities, ${first.slice(0, 10)} → ${last.slice(0, 10)}`);
  console.log(`Matched to workouts: ${matched}${target ? "" : " (dry run — no workouts loaded to match against)"}`);
  console.log(`Photos             : ${photos.length} records${photoStore ? `, ${uploaded} uploaded` : values["no-photos"] ? " (not uploaded)" : " (would upload)"}${skippedMedia ? `, ${skippedMedia} videos skipped` : ""}`);
  console.log(`Routes from GPX    : ${routes.length}${gpxRead ? ` of ${gpxRead} read` : ""}${privacy ? " · Strava privacy zone applied" : ""}`);
  const types = new Map<string, number>(); for (const r of records) types.set(r.activityType, (types.get(r.activityType) ?? 0) + 1);
  console.log(`By type            : ${[...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (values["dry-run"] || !target) { console.log("\nDry run — nothing written."); return; }
  const strava = StravaRepository.fromConnectionString(target.storageConnectionString, target.userId);
  await strava.ensureTable();
  console.log(`\nWritten: ${await strava.upsertActivities(records)} activities, ${photos.length ? await strava.upsertPhotos(photos) : 0} photos${routes.length && routeRepo ? `, ${await (async () => { await routeRepo.ensureTable(); return routeRepo.upsertMany(routes); })()} routes` : ""}`);
}

const invokedDirectly = process.argv[1]?.endsWith("import-strava.js");
if (invokedDirectly) main().catch((e: unknown) => { console.error(`\nImport failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
