# Workout Tracker — operating guide

Azure Functions (Node 24, TypeScript, ESM) + Table Storage. Ingests Apple workouts, body
weight and lifting logs; serves a dashboard, a Strength page, an iCal feed and a Monday
Telegram summary. One user. Written so a fresh session can continue without the previous
conversation: **everything below was true on 2026-10-11** — verify before relying on it.

## State of the project

- **Live** on a custom domain (managed cert, `/` → dashboard). The domain and the Azure
  names — resource group, Function App (Flex Consumption, westeurope), storage account —
  are **not in the repo**: they live in the gitignored `.env` as `WORKOUTS_URL`,
  `AZURE_RESOURCE_GROUP`, `AZURE_FUNCTION_APP`, `AZURE_STORAGE_ACCOUNT` (template:
  `.env.example`). Tables `workouts`, `bodyweight`, `lifts`, `milestones`, `recovery`, `routes`, `strava`, `settings`; blob
  container `photos`. The signed-in `az` user owns
  the subscription.
- **Data loaded**: ~3,180 workouts (Feb 2018 → now, Apple Health export + Health Auto
  Export + manual), 4,229 days of body weight (Feb 2012 →), 96 lift PRs + 40 rep maxes +
  584 training-max values (the long-term workbook), 1,031 logged exercise rows from the
  weekly block log (`Cable Rack Summer 2025`, Aug 2025 → Oct 2026). Effort was last rescored under the
  current model on 2026-10-11.
- **CI deploy is not wired.** `.github/workflows/deploy.yml` is OIDC-shaped and skips while
  `DEPLOY_ENABLED=false`. Flex Consumption has no publish profile; `scripts/setup-github-oidc.sh`
  does the one-time wiring but needs an Entra app registration, which the assistant's
  permission policy blocked. Until then **deploy by hand** (below).
- **Telegram** is configured (bot token + chat id in app settings). Three senders: the
  Monday 10:00 summary, the Thursday 18:00 check-in, and milestones fired from the ingest
  paths (`notifyMilestones.ts`, state in the `milestones` table, one announcement per key
  per ISO week). Preview any of them over HTTP before trusting a timer.

## Secrets and where they live

Nothing secret is in the repo, ever. All of it is in the Function App's settings:
`INGEST_API_KEY` (every data endpoint, header `x-api-key`), `CALENDAR_TOKEN` (iCal, query
string, read-only), `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, `WEEKLY_GOALS`,
`GOOD_WEEK_SESSIONS`, `ATHLETE_RESTING_HR`, `ATHLETE_MAX_HR` (fallback only),
`STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` / `PUBLIC_URL` (OAuth tokens themselves are
in the `settings` table, key `strava.tokens`, because Strava rotates them). Read
one back with:

```bash
set -a; . ./.env; set +a      # every command below assumes this
az functionapp config appsettings list -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" \
  --query "[?name=='INGEST_API_KEY'].value | [0]" -o tsv
```

Local `.env` (gitignored) mirrors `ATHLETE_*` for the CLIs — **not** the storage string;
any CLI that writes (`block`, `lifts`, `add`, `rescore`, `import`) needs it in the shell:

```bash
export WORKOUTS_STORAGE="$(az functionapp config appsettings list -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" \
  --query "[?name=='AzureWebJobsStorage'].value | [0]" -o tsv)"
```
 The assistant's scratchpad is
**ephemeral** — never assume a key file from a previous session exists.

## Routines

```bash
npm test && npm run typecheck          # 280-ish tests, under a second, no Azure needed
npm run preview                        # dashboard on synthetic data at localhost:7099 (key: preview)
npm run sync                           # monthly: newest Health export zip in ~/Downloads → import
npm run rescore -- --dry-run           # after any scoring change; then without --dry-run
npm run lifts -- <workbook.xlsx> --as-of YYYY-MM-DD   # the long-term lift workbook
npm run block -- <weekly-log.xlsx> --program "Name"    # a block's weekly log; re-runs are upserts
npm run add -- sessions.csv            # manual workout backfill
npm run dedupe -- --dry-run            # the same session recorded twice (Wahoo + watch)
WORKOUT_KEY=$(…) node scripts/dev/screenshot.cjs "$WORKOUTS_URL/api/strength" out.png dark
```

**Deploy by hand** (what every deploy in this project has actually been):

```bash
npm run build && rm -rf /tmp/pkg && mkdir /tmp/pkg \
 && cp host.json package.json package-lock.json /tmp/pkg/ && cp -r dist public /tmp/pkg/ \
 && rm -rf /tmp/pkg/dist/scripts && (cd /tmp/pkg && npm ci --omit=dev && zip -qr ../app.zip .) \
 && az functionapp deployment source config-zip -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" --src /tmp/app.zip
```

Takes 2–4 minutes and **rolls out per instance**: right after a deploy some requests hit
old code. Verify by polling until five consecutive responses agree, never with one request.
`public/` must ship (the page functions read it at runtime); `dist/scripts` must not.

## How the pieces fit

```
src/domain/     pure: activityType (slugs, MET, PERSONAL_OVERRIDES, relabels), workout,
                effort (TRIMP / MET, trailing-year observed max), scoring, summary (dense
                buckets, per-activity split, peak HR), goals (weekly verdicts, typical
                effort, lead-in), weeklySummary (Telegram text), calendar (ICS),
                bodyWeight, strength (lifts, 1RM estimators, DOTS, block analysis),
                milestones (instant announcements + the Thursday check-in text),
                recovery (nights from sleep segments, daily signals, baselines, weekly join),
                routes (track simplification, polyline codec, home/away split by start)
src/ingest/     shortcutPayload, healthExport (streaming SAX; joins loose HR samples; body
                mass hook), healthAutoExport (batch + weight metrics), units, xlsx (no-lib)
src/storage/    workoutRepository (PK me|YYYY-MM), bodyWeightRepository (PK me|YYYY),
                liftRepository (PK me|pr, me|repmax, me|tm|<program>, me|set),
                milestoneRepository (PK me|milestones, RK <week>|<key>)
src/functions/  thin HTTP wiring; routePrefix is "" so every route carries api/ explicitly
public/         index.html (dashboard), strength.html, recovery.html, map.html — standalone, no build
scripts/        the CLIs above, preview server, OIDC setup, dev/screenshot.cjs
```

Every write path scores through `scoreWithReference`. Workout ids are
`sha256(activityType|startedAt|roundedDuration)` — derived, so every source dedupes
against every other, and relabelling a slug changes identity.

## Model decisions (the person's numbers stay out of the repo)

- Weekly targets per activity live in `WEEKLY_GOALS` / `GOOD_WEEK_SESSIONS` /
  `VERY_GOOD_WEEK_SESSIONS` / `VERY_GOOD_WEEK_MIN` (app settings). The ladder: perfect =
  every target; very good = 6+ sessions of any kind with 2+ strength; good = 5+ of any
  kind; short. Any activity counts for good/very good; only targets count for perfect. Apple Watch has no BJJ/Capoeira type: BJJ is
  recorded as Martial Arts, Capoeira as Tai Chi; `PERSONAL_OVERRIDES` relabels on the way
  out. Strava "Other" ≥60 min and "Wrestling" are BJJ (`relabelActivity`, at parse time).
- **Max HR is observed**, trailing year as of each workout, falling back to `ATHLETE_MAX_HR`,
  and an observation must be within 25 bpm of the fallback. Resting is `ATHLETE_RESTING_HR`.
  Never score against a monthly max.
- **BJJ MET is 5.8**, calibrated from 57 chest-strap classes (median 0.69 TRIMP/min);
  the compendium's 10.3 nearly doubles it. Re-derive the same way if history grows.
- **Weight**: one reading per local day, earliest wins; readings log via Siri lately.
- **Lifting**: PR comparisons use a **personal rep curve** per lift (10RM sits at 85% of
  the single, not Epley's 75%); Wendler (= Epley) elsewhere; sets >10 reps are hollow.
  "Bow bar" = buffalo bar. The long-term sheet's "Squat" column mixes SSB and straight bar
  (its 145×10 is SSB) — unresolved, user to decide.
- Weekly logs: sessions not taken to failure; treat e1RM from them as a floor.

## In flight (pick up here)

1. **Block-log importer is live** (`npm run block -- file.xlsx --program NAME`; see
   README "The weekly log"). Still open: the long-term sheet's "Squat" column mixes SSB and
   straight bar (145×10 is SSB); the `set` rows are only read for their top set so far —
   volume, per-session tonnage and the accessory lifts are stored but not shown.
2. **Recovery page is live** (`/api/recovery`, data at `/api/recovery/data`; domain
   `recovery.ts`, table `recovery`, rows merge on write). Fed by the export import and the
   HAE batch. Open: the HAE `sleep_analysis` field names are from the app's documentation,
   not a real payload — verify against the first batch that carries sleep. The **recovery
   rating** (`rateDay`/`rateWeek`) is a weighted score against personal baselines with the
   breakdown attached; weights and scales are in README "The recovery rating" — change
   them there and in the code together.
3. **Public repo** — scrubbed on 2026-10-11: history restarted from a single root commit
   (the old history is on the local, never-pushed branch `private-history`), deployment
   names moved to `.env`, the person's numbers taken out of the docs. Keep it that way:
   no domain, resource names, heart rates, bodyweights or lift numbers in commits or docs.
4. CI via OIDC (needs the user to run `scripts/setup-github-oidc.sh`).
5. **Strava** comes from the free data archive (`npm run strava -- export_*.zip`;
   `src/ingest/stravaArchive.ts`, `scripts/import-strava.ts`), not the API — Strava only
   lets subscribers create API applications and the user is on the free tier. The API
   code (`src/strava/client.ts`, `functions/strava.ts`) stays, dormant. Photos are blobs
   in the private `photos` container of the storage account, served through signed URLs
   from `/api/photos`; the `strava` table holds activities (`me|strava|YYYY`) and photo
   records (`me|photos|YYYY`). Archive CSV dates are UTC. FIT files are not parsed.

## Working agreements

Deploy and verify without asking; never leave test rows in the live tables (date them
2030+ and delete after); say what was inferred versus tested — two iOS claims in this
project turned out false; render a change and look at it before calling it done.

## Commands

```bash
npm test            # vitest, no Azure needed
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm start           # func start (needs Azurite + local.settings.json)
npm run sync        # the monthly routine: find export, unzip, import, clean up
npm run sync -- --max-hr          # read true max HR out of an export
npm run import -- <export.xml> [--since YYYY-MM-DD] [--dry-run]
npm run preview     # dashboard on synthetic data, no Azure — http://localhost:7099/api/dashboard
```

## Architecture rules

- **`src/domain/` and `src/ingest/` must stay free of Azure SDK imports and I/O.** They are
  pure functions over plain data; that is what keeps the test suite fast and runnable with
  nothing provisioned. `src/storage/` is the only module that imports `@azure/data-tables`.
- **`src/functions/` files are thin wiring.** Auth, parse, build, store, respond. Logic that
  needs a test belongs in the layers below.
- **One unit per dimension: seconds, metres, kilocalories.** Convert at the edges in
  `src/ingest/units.ts`. Nothing past the parsers should carry a unit.

## The dashboard (`public/index.html`)

One file, no build step, no dependencies — hand-rolled SVG rather than a chart library, so
the Function App stays self-contained. `src/functions/dashboard.ts` reads it out of the
deployment package at runtime, which is why **`public/` must never be added to
`.funcignore`**.

- **Colours are roles, not hex.** The CSS custom properties at the top are the only place a
  colour is written. Dark values are declared under *both* `prefers-color-scheme` and
  `[data-theme="dark"]` so the in-page toggle wins either way.
- **One series, one hue.** The bars are all `--series-1`; shading them by value would
  double-encode the bar length. The calendar heatmap is the only ramp, and its steps are
  validated against both surfaces — do not nudge them by eye.
- **Series colour is assigned by slug in `SERIES_SLOTS`, never derived from the data.** A
  filter or range change must not repaint the survivors. Eight slots, then a grey "Other";
  never generate a ninth hue. Re-run the dataviz validator if the palette changes.
- **A `.mark` class rule beats a `fill` presentation attribute.** Per-segment colours are set
  inline via `style`, not as `fill="…"`, or everything renders in the default series hue.
- **Hit targets precede their mark in the DOM.** The hover rule is `.hit:hover + .mark`, so
  inserting a hit anywhere else silently kills the hover state.
- **Values must be reachable without hovering.** Every chart's numbers also appear in a
  table (the trend chart's "Show data table", the recent-workouts list). Keep it that way.
- Labels come from the API: insert them with `textContent`, never `innerHTML`.

## How workouts actually arrive

**The Health app does not expose workouts to Shortcuts.** No native Shortcuts action returns
a workout's type, duration, distance or heart rate; the "when a workout ends" automation can
fire but cannot read the workout. Do not write documentation suggesting otherwise — an
earlier version of the README did, with an invented field-mapping table, and it cost the user
an afternoon.

The project syncs from Apple's `export.xml` on whatever cadence suits — `npm run sync` wraps
the whole routine. `/api/ingest/health-auto-export` also exists for the Health Auto Export
app, whose automatic sync is a paid tier the user has not bought. All paths produce the same
derived ids, so they deduplicate against each other.

The import CLI reads its athlete profile from a gitignored `.env` (loaded via Node's
`--env-file-if-exists`), **not** from the Function App's settings — those are configured
separately and drift apart silently. It prints the profile it is using for exactly that
reason; do not remove that line.

Bodies posted from Shortcuts go through `src/http/jsonBody.ts`, not `request.json()`.
An export action hands the Shortcut a *file*, which arrives as `application/octet-stream`,
`text/plain`, or `multipart/form-data` depending on how it is attached — all of which
`request.json()` rejects. Parse failures echo a bounded excerpt of the body because a phone
offers no other way to see what was sent.

The batch endpoint returns **200 even when individual workouts fail**. A non-2xx makes the
app retry the identical payload forever, so a single bad row would wedge the automation; a
malformed envelope still returns 400. Keep that asymmetry.

## Things that will bite you

- **`host.json` sets `routePrefix: ""` — every HTTP route must start with `api/` explicitly.**
  That is what lets `src/functions/root.ts` claim `/` for the dashboard redirect. A new
  function registered with `route: "foo"` lands at `/foo`, not `/api/foo`.
- **Never register a `{*path}` catch-all.** One was observed beating `api/notify/weekly`
  for GET while POST still reached it: the catch-all accepted GET/HEAD and won the template
  match for those methods only. `root.ts` uses `{path?}` — root or one segment — which
  cannot overlap any real route, since every API path has at least two segments.

- **ESM + `NodeNext`**: relative imports need an explicit `.js` extension even in `.ts`
  source. `import { x } from "./foo.js"`.
- **`exactOptionalPropertyTypes` is on.** You cannot assign `undefined` to an optional
  property. Either omit the key (the `optional()`/`present()` helpers in the ingest modules
  spread an empty object) or type the field as `T | undefined` explicitly.
- **`PERSONAL_OVERRIDES` in `activityType.ts` relabels Tai Chi as Capoeira and Martial Arts
  as BJJ** — Apple Watch has no type for either. It overrides the label and MET only; the
  slug must stay as Apple recorded it, because ids are derived from it. BJJ's MET (5.8) is
  calibrated from 57 measured classes; do not "correct" it back to the compendium's 10.3.
  Re-derive it the same way (median TRIMP/min of chest-strap sessions, avg ≥95 bpm, ÷ 0.12)
  if the measured history grows.
- **The calendar feed authenticates by query-string token, not `x-api-key`.** Calendar
  clients cannot send headers. `CALENDAR_TOKEN` is separate from `INGEST_API_KEY` and
  read-only, because a subscription URL is stored and synced by the calendar app.
- **Peak heart rate is computed in `summarise`, not from `/api/workouts`.** The workout
  list is capped at 2,000 rows oldest-first, so anything derived from it on a wide range
  silently drops the newest data; the summary endpoint is uncapped.
- **`state.days` is not the range.** The dashboard has a custom from/to; everything that
  scopes by range must go through `rangeParams()` / `rangeDays()` / `rangeEnd()`.
- **Max heart rate for TRIMP is observed, not configured.** `scoreWithReference` is the
  only scorer; every write path supplies the trailing-year peak as of the workout's date
  (`trailingMaxHeartRate`), falling back to `ATHLETE_MAX_HR`. Never score against a monthly
  max — an easy month would lower the ceiling and inflate the scores in it. The import does
  two passes (parse all, sort, then score) because Apple's export is not chronological and
  a row must not see peaks from its own future.
- **Changing the scoring model means `npm run rescore`, not a re-import.** It reads the
  table, sorts, scores each row against the peaks before it, and rewrites only what changed.
  The observed max must be within 25 bpm of the fallback to be trusted — a sparse early year
  of easy sessions "observed" 108 bpm and would have made every moderate workout maximal.
- **`typicalEffort` is per week, against the twelve before it**, not the request window;
  absent under four prior weeks. The dashboard and the Telegram line both read it.
- **The export parser joins loose heart-rate samples to workouts lacking statistics.**
  Polar/Strava workouts carry none; the samples are separate `<Record>`s, all of which
  precede the `<Workout>`s in the file. `HeartRateIndex` buffers them (~16 MB per million)
  and `toWorkoutInput` consults it only when the workout has no `WorkoutStatistics`. Stray
  readings (<10, or <0.5/min) are rejected so a watch glance never becomes an average.
- **`relabelActivity` changes identity and must run at parse time**, before the id is
  derived. Rows written under the old slug are not removed by a re-import; delete them.
- **Strength is its own page, table and importers** (`strength.ts`, `liftRepository.ts`,
  `scripts/import-lifts.ts`, `scripts/import-block-log.ts`). Four record kinds share the
  `lifts` table by partition; `set` rows hold every logged set as written (JSON in a
  string column) and `getLifts` derives each session's top set with reps + RIR, flagged
  `submax`. Pull-ups are estimated on bodyweight + load and shown as added load. The
  1RM used for comparison is a per-lift personal curve, not Wendler — the lifter's 10RM sits
  at 85% of the single, not Epley's 75% — and every estimate carries its estimator. Lift
  names come from hand-written sheets: extend `LIFT_RULES` (specific before general) rather
  than normalising ad hoc.
- **`src/ingest/xlsx.ts` reads .xlsx without a library.** Zip central directory by hand,
  `inflateRawSync`, `sax` for the XML. Error cells (`#N/A`) come back null; date-styled
  numbers come back as `YYYY-MM-DD`.
- **Routes are keyed by workout id and start at the parser.** `<WorkoutRoute><FileReference>`
  is captured into `WorkoutInput.routeFile`, which `buildWorkout` strips — it is for the
  importer, never the row. `sync.sh` must unzip `*workout-routes/*` or the import silently
  stores no routes. Home is `homeOf` (densest 1 km bin of starts); the split is by *start*
  point, not centroid, on purpose. The page geocodes place names client-side via Nominatim
  (one request a second, cached in localStorage) — the only external call any page makes.
- **Recovery rows merge, never replace.** `RecoveryRepository.upsertMany` uses Table
  Storage's Merge mode because the two sources carry different fields on different days;
  a Replace would let a resting-heart-rate-only batch erase the night. A night is keyed by
  the morning it ends on (`nightOf`: start + 9 h, by wall clock) and takes **one** source —
  the staged one — never a sum across sources. Export parsing: the recovery hook sits in
  the same `onopentag` as body mass; the record types are grouped in the file, so a test on
  the first 200 MB sees none of them.
- **Body weight is not a workout.** Separate domain (`bodyWeight.ts`), separate table and
  repository, one row per local day, earliest reading wins. The export parser delivers it
  through the `onBodyMass` hook rather than a second pass over a 500 MB file. The weight
  chart is the emphasis form — grey readings, accent 7-day trend — and its axis does not
  start at zero on purpose.
- **Display names resolve at read time; MET values apply at write time.** Adding an entry to
  `DISPLAY_NAMES` fixes existing rows immediately. Adding one to `MET_BY_ACTIVITY` only
  affects workouts written afterwards, and only those without heart rate — everything else
  needs a re-import to rescore.
- **Workout ids are derived, not assigned** — `sha256(activityType|startedAt|roundedDuration)`.
  Changing `workoutId()` orphans every row already stored. Duration is rounded to the second
  on purpose: Apple reports sub-second jitter across sources, and the Shortcut and the export
  must agree on the id for the same workout.
- **Only identity and timing may be strictly validated on ingest.** The first real Health
  Auto Export batch lost all nineteen workouts because `activeEnergy` arrived as a per-sample
  array and the schema demanded `{ qty, units }`. Measurements are now `z.unknown()` and read
  defensively — a shape that cannot be read drops that field, never the workout. Only a
  missing name, an unparseable start, or no way to determine duration rejects a row.
- **In Zod 4 a bare `z.unknown()` in an object is NOT optional** — it requires the key to be
  present. `z.unknown().optional()` is what you want; without it every workout missing any
  one enrichment field is rejected.
- **Flex Consumption rolls a deployment out across instances.** Immediately after a deploy
  some requests hit old code and some new. Verifying a fix with a single request is
  unreliable; poll until several consecutive responses agree.
- **Weekly goals are independent tests — perfect (every target), very good (total with
  floors), good (total).** Do not collapse them into one score; the substitution case
  ("missed BJJ, got a run in") is the whole reason for the split. Targets come from
  `WEEKLY_GOALS` so they can change without a deploy.
- **The same session recorded twice is one workout** (`domain/dedupe.ts`): same activity,
  starts within 15 min, overlap ≥60% of the shorter — the Wahoo ride via Strava beside the
  watch's own. HR wins, then length, then first recorded. Applied in the import, both
  ingest paths, and `npm run dedupe` for the table. Derived ids cannot catch this — the
  seconds differ — so never rely on the id alone for "already have it".
- **The weekly timer fires at 08:00 and 09:00 UTC and checks the Amsterdam hour itself**,
  because Linux Flex Consumption ignores `WEBSITE_TIME_ZONE`. `GET /api/notify/weekly`
  previews the message; never wait a week to find out it is wrong. The Thursday check-in
  (`16,17 UTC → 18:00 local`) works the same way; `GET /api/notify/checkin?for=` previews it.
- **Milestones are announced once per key per ISO week.** `announceMilestones` runs after
  every HTTP ingest and must never throw into the response; the Health Auto Export batch
  re-posts the same week daily, so without the `milestones` table every good week would be
  announced every morning. Records (`max-hr`, `longest`) are credited only to workouts in
  the batch that just arrived, never to re-posts of stored ones.
- **The dashboard computes the streak over complete weeks only.** It asks for `until=today`,
  so the last week is the one in progress and is "short" on any Monday; counting it would
  zero a streak that is still intact.
- **`summarise` emits a per-activity split per bucket** (`bucket.byActivity`). The stacked
  chart reads that rather than recomputing from `/api/workouts`, which is row-capped and
  would silently disagree with the headline totals.
- **The preview server must honour every filter the real endpoints do.** It ignored
  `activityType` once and reported a working dashboard for a filter that did nothing.
- **`summarise` returns dense buckets** — every period in the range, including empty ones.
  Code that assumes "a bucket means a workout happened" is wrong; filter on `workouts > 0`.
  The density is what keeps a per-period average from becoming a per-*active*-period average.
- **Chrome does not fire `focus` on an SVG element focused programmatically** (`el.focus()`),
  though a real Tab keypress does. A headless test that focuses a chart mark in script and
  then asserts the tooltip appeared will fail against working code — drive it with
  `Input.dispatchKeyEvent` instead.
- **The app runs on Flex Consumption, not Linux Consumption.** A new Linux Y1 app does not
  start on this subscription — site and SCM both serve 503 forever. Under Flex the runtime
  and scaling live in `functionAppConfig`, not `linuxFxVersion`/`FUNCTIONS_*`, and the app is
  served from a blob container. `WEBSITE_RUN_FROM_PACKAGE=1` is unsupported on Linux and will
  stop the site booting.
- **Flex Consumption uses site-scoped certificates.** `az webapp config ssl create` fails on
  it; create under `Microsoft.Web/sites/<app>/certificates` and bind by PATCHing
  `hostNameSslStates`. A cert can be issued but unbound, which presents as a TLS failure even
  though routing works — check `hostNameSslStates` before re-issuing.
- **Flex Consumption has no publish profile.** CI must use OIDC via `azure/login`; the
  `Azure/functions-action` `sku: flexconsumption` input switches it to RBAC auth and makes it
  ignore any publish profile. `scripts/setup-github-oidc.sh` does the one-time wiring.
- **Table Storage queries must name the PartitionKey.** `WorkoutRepository.list` iterates
  month partitions explicitly. A RowKey-only filter silently becomes a full table scan.
- **Batch transactions are per-partition and capped at 100 entities**, and two entities with
  the same RowKey in one batch fail the whole transaction — `upsertMany` deduplicates first.
- **`parseHealthExport` streams.** Never buffer the export; real files are hundreds of MB.
  SAX is push-based and the generator is pull-based, so parsed workouts queue in `ready[]`
  and drain after each chunk.
- **Apple's date format** (`2026-03-14 07:21:03 +0100`) is not reliably `Date`-parseable
  because of the space separator. Always go through `parseAppleDate`.

## Conventions

- Tests live in `test/`, named after the module under test, and assert behaviour rather than
  implementation. Every parser change wants a case with real Apple-shaped input.
- Config is read through `src/config/index.ts` only; nothing else touches `process.env`.
- Never log the API key, a connection string, or workout contents beyond type and duration.
- `export.xml` is full medical history. `.gitignore` excludes `*.xml` — do not add exceptions.
