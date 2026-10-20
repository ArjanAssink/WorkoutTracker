# Workout Tracker

A private, self-hosted record of every workout, built to answer one question well:
**how much have I actually been training lately?**

Two things feed it:

1. **An Apple Shortcut** that fires when a workout ends and `POST`s it to an HTTPS endpoint.
2. **Your Apple Health `export.xml`**, imported once to backfill everything before that.

Both land in the same table with the same derived identity, so importing the export after the
Shortcut has already been running does not create duplicates.

It runs on Azure Functions' Consumption plan and Table Storage — comfortably inside the
always-free allowances at personal volume.

---

## Endpoints

All but `/api/health` require the shared secret in an `x-api-key` header
(an `Authorization: Bearer <key>` header also works).

| Method | Route           | Purpose |
| ------ | --------------- | ------- |
| `POST` | `/api/workouts` | Record one workout. |
| `POST` | `/api/ingest/health-auto-export` | Batch ingest from the Health Auto Export app. |
| `GET`  | `/api/workouts` | The raw record feed for a date range. |
| `GET`  | `/api/summary`  | Per-period totals, per-activity breakdown, active days, longest streak. |
| `GET`  | `/`              | Redirects to the dashboard, query string included. |
| `GET`  | `/api/dashboard` | The web dashboard. Unauthenticated shell; it asks for the key in the browser. |
| `GET`  | `/api/weekly`   | Each ISO week reviewed against your goals, plus the typical week and streak. |
| `GET`/`POST` | `/api/bodyweight` | One body-weight reading per day; `POST` a manual one. |
| `GET`/`POST` | `/api/notify/weekly` | Preview the Monday summary as text, or send it to Telegram now. |
| `GET`/`POST` | `/api/notify/milestones` | What the week in progress has earned and what was already announced; `POST` sends what is due. |
| `GET`/`POST` | `/api/notify/checkin` | Preview the Thursday check-in, or send it now. |
| `GET`  | `/api/strength`  | The Strength page: PRs over time, rep-max board, block tracker. |
| `GET`  | `/api/recovery`  | The Recovery page: sleep, resting HR and HRV against training load. |
| `GET`  | `/api/map`       | The Routes page: every GPS track, home as the hero and each place away as a card. |
| `GET`  | `/api/strava/connect` | Start the Strava OAuth flow (`?key=` accepted, it opens in a browser). |
| `GET`/`POST` | `/api/strava/status`, `/api/strava/sync` | Connection state; pull activities and photos since the last sync. |
| `GET`  | `/api/photos`    | Photos from Strava, newest first, each linked to its workout. |
| `GET`  | `/api/routes/data` | Every stored route as an encoded polyline, with home and the away places worked out. |
| `GET`  | `/api/recovery/data` | What it reads: one row per day with 28-day baselines, the weekly join with effort, the 90-day typical night. |
| `GET`  | `/api/recovery/patterns` | The whole history analysed: training against sleep, resting HR, HRV, weight, daylight; readings generated from the numbers. |
| `GET`  | `/api/lifts`     | Everything the Strength page reads, as JSON. |
| `GET`  | `/api/calendar.ics` | iCalendar feed to subscribe to. Token in the query string. |
| `GET`  | `/api/health`   | Unauthenticated liveness probe. |

### `POST /api/workouts`

A single workout, in a forgiving shape — useful for scripting, manual entry, or any client
that can make an HTTP request. For automatic capture from Apple Health, see
[Getting workouts in automatically](#getting-workouts-in-automatically).

Only `activityType` and `startedAt` are strictly required, plus *either* `endedAt` or
`duration` so the length is known. Everything else is recorded when present and omitted
when the watch did not capture it.

```json
{
  "activityType": "Outdoor Run",
  "startedAt": "2026-03-14T07:00:00Z",
  "endedAt": "2026-03-14T07:45:30Z",
  "duration": "45 min",
  "distance": "8.2 km",
  "activeEnergy": "512 kcal",
  "averageHeartRate": 148,
  "maxHeartRate": 176,
  "sourceName": "Apple Watch"
}
```

Measurements accept a bare number *or* a string with a unit (`"8.2 km"`, `"5 mi"`,
`"2000 kJ"`, `"8,2 km"` with a locale comma). Key names are forgiving too — `Workout Type`,
`Start Date`, `Total Distance`, `Active Calories` and `Device` are accepted as aliases of
the canonical names.

Returns **201** for a new workout and **200** with `"status": "duplicate"` if the same
workout is posted again, so a Shortcut retrying on a flaky connection is harmless.

### `GET /api/summary`

```
/api/summary?days=90&granularity=week
/api/summary?from=2026-01-01&to=2026-04-01&granularity=month
/api/summary?days=365&granularity=month&activityType=running
```

`granularity` is `day`, `week`, `month` or `year` (default `week`). The range defaults to
the last 90 days; `from`/`to` override `days`.

**Buckets are dense**: every period in the range is returned, including the ones you did not
train. A sparse series makes a rest week vanish instead of showing as a gap, so a chart drawn
from it has an evenly spaced axis that is not evenly spaced in time — and an average over the
buckets quietly becomes "per active week" rather than "per week".

```json
{
  "from": "2026-01-01T00:00:00.000Z",
  "to": "2026-04-01T00:00:00.000Z",
  "granularity": "month",
  "totals": { "workouts": 54, "durationSeconds": 183600, "distanceMeters": 412000,
              "activeEnergyKcal": 31200, "effort": 3980.5, "activeDays": 47 },
  "buckets": [ { "period": "2026-01", "workouts": 18, "activeDays": 16, "effort": 1320.4, "...": "..." } ],
  "byActivity": [ { "activityType": "running", "label": "Running", "workouts": 31, "...": "..." } ],
  "longestStreakDays": 9
}
```

---

## The dashboard

`https://<your-domain>/api/dashboard`

A single page, served by the Function App itself — no second resource, no CORS, nothing to
deploy separately. It asks once for the API key, keeps it in `localStorage`, and calls the
same JSON endpoints you would call by hand.

It shows:

- **Headline numbers** — workouts, active days, total time, distance, effort, longest streak.
- **Effort over time**, **stacked by activity** — switchable to time, distance, workout
  count, or **heart rate**, grouped by day, week or month. Rest periods appear as gaps,
  because the buckets are dense (see below).
- **An activity filter** scoping every panel, for "how often do I actually lift?".
- **Weekly goals** — every week judged against your targets, a verdict strip for progress
  over time, and the current streak. Last cell is the week in progress.
- **Max heart rate** in the range, and which workout it came from.
- The **heart rate** view is per workout rather than per period: a dot at the average with
  a whisker from min to max, on a real time axis, with your configured max HR drawn as a
  reference line. If dots routinely sit above that line, `ATHLETE_MAX_HR` is set too low.
- **Body weight** — daily readings as quiet dots with a 7-day centred trend, the endpoint
  labelled, and a tile with the trend value and its 30-day change.
- **Range presets or a custom from/to**, scoping everything.
- **A training calendar** — one cell per day, shaded by that day's total effort, binned on
  the quartiles of your own active days rather than fixed thresholds.
- **Time by activity** and **recent workouts**, with effort scored from MET-minutes marked
  `*` so an estimate never reads as a measurement.

Every chart has a tooltip on hover *and* keyboard focus, and the trend chart has a
**Show data table** toggle, so no value is reachable only by pointing at it. The page follows
the system light/dark setting and has its own toggle.

### Colour

Activities get a fixed categorical slot, assigned **up front by slug rather than derived
from the data**. Colour has to follow the activity, not its current rank: if slots were
handed out by volume, changing the range or the filter would repaint the survivors and a
reader who learned "strength is blue" would be misled. The same slot is used in the stacked
chart and the activity breakdown, so an activity keeps one identity across the page.

Eight slots are mapped; everything else folds into a grey **Other**. There is no ninth hue
on purpose — a generated one is indistinguishable from an existing slot under colour-vision
deficiency.

The palette is the validated default set, checked against both surfaces before use (worst
adjacent CVD ΔE 9.1 light / 8.4 dark; normal-vision ΔE 19.6 / 19.3). Three light-mode slots
sit below 3:1 contrast, which is why the legend and the table view are mandatory rather than
decorative.

You can pass the key as `?key=…` to open it from a bookmark or a Shortcut; the page strips it
from the URL immediately so it does not linger in history.

### Working on the dashboard

```bash
npm run preview     # http://localhost:7099/api/dashboard — API key: preview
```

The preview server generates a year of synthetic workouts and serves them through the **real**
`summarise`, `scoreEffort` and `buildWorkout`, so the aggregation you see is the aggregation
that ships; only the rows are invented. No Azure account and no Functions host needed.

---

## Weekly goals and the Monday summary

A week is judged two independent ways, and that is the point:

- **Perfect** — every per-activity target hit.
- **Good** — a total session count reached, however it is composed. Missing jiu-jitsu but
  getting a run in still counts as showing up.
- **Short** — neither.

A single combined score would hide exactly the distinction between those first two.

Targets are app settings, so they change without a deploy:

```bash
az functionapp config appsettings set -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" \
  --settings WEEKLY_GOALS="strength:3,martialarts:2,taichi:1" GOOD_WEEK_SESSIONS=5
```

**Goals are time-bound.** Each week is judged by the goals in force when it happened, so
changing the goals never rewrites history. `WEEKLY_GOALS` / `GOOD_WEEK_SESSIONS` /
`VERY_GOOD_WEEK_SESSIONS` / `VERY_GOOD_WEEK_MIN` are the current goals, from
`WEEKLY_GOALS_FROM`; earlier periods go in `WEEKLY_GOALS_HISTORY`, a JSON array of
`{from, targets, good, veryGood, veryGoodMin}` (missing fields inherit the current
values; empty `targets` means the week is judged on counts alone and can never be perfect):

```bash
az functionapp config appsettings set -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" --settings \
  WEEKLY_GOALS_FROM=2026-04-27 \
  WEEKLY_GOALS_HISTORY='[{"from":"2022-02-07","targets":"strength:3","good":4,"veryGood":5,"veryGoodMin":"strength:2"},
                         {"from":"2023-10-16","targets":"strength:3,martialarts:2","good":5}]'
```

To change your goals from today: move the current ones into the history with their
`from`, set the new ones, and set `WEEKLY_GOALS_FROM` to this Monday. The dashboard's
table shows a column for every target any shown week had, with — where a week had none.

The ladder has four rungs. **Perfect**: every per-activity target met. **Very good**: at
least `VERY_GOOD_WEEK_SESSIONS` (6) sessions of *any* kind, provided the floors in
`VERY_GOOD_WEEK_MIN` hold (`strength:2`). **Good**: at least `GOOD_WEEK_SESSIONS` (5) of
any kind. Otherwise short. A ride, a hike or a swim counts for good and very good; only the
named targets count for perfect.

```bash
az functionapp config appsettings set -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" \
  --settings VERY_GOOD_WEEK_SESSIONS=6 VERY_GOOD_WEEK_MIN="strength:2"
```

The keys are the slugs Apple records — `martialarts` for BJJ, `taichi` for Capoeira — and
the defaults above are what ships. `GET /api/weekly?weeks=12` returns each week's review,
the **typical week** (a median over prior weeks, so one huge weekend does not skew it) and
the streak of good-or-better weeks. By default it ends at the last *complete* week, which
on a Monday morning is the week that just finished; add `until=today` to include the one in
progress, which is what the dashboard does.

Each week also carries how its effort compares to the **median of the twelve weeks before
it** — about a quarter, long enough to be a habit, short enough to still be "you lately". The
dashboard table shows it as `312 ▲30%`; the Monday message says *"Effort 312 — 30% above
your typical week (240)"*, and calls a week past ±40% hard or light. The twelve weeks
behind the first returned week are evaluated too (but not returned), so every row has a
comparison; only when your history itself holds fewer than four prior weeks is none made,
since a median of two numbers is not a baseline.

### The Monday 10:00 message

A timer sends last week's review to Telegram every Monday at 10:00 Amsterdam time. Flex
Consumption ignores `WEBSITE_TIME_ZONE`, so the schedule fires at both 08:00 and 09:00 UTC
and the handler sends only when the local hour is 10 — that is what keeps it right on both
sides of a DST change.

Setting it up, once:

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts. It gives you a
   token like `123456789:ABC…`.
2. Open a chat with your new bot and send it any message.
3. Get your chat id: `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"` and read
   `result[0].message.chat.id`.
4. Store both:

```bash
az functionapp config appsettings set -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" \
  --settings TELEGRAM_BOT_TOKEN="<token>" TELEGRAM_CHAT_ID="<chat id>"
```

Then test without waiting for Monday:

```bash
# What would it say?
curl -s "$WORKOUTS_URL/api/notify/weekly" -H "x-api-key: $KEY"
# As if run on a given Monday
curl -s "$WORKOUTS_URL/api/notify/weekly?for=2026-09-28" -H "x-api-key: $KEY"
# Send it now
curl -s -X POST "$WORKOUTS_URL/api/notify/weekly" -H "x-api-key: $KEY"
```

With Telegram unconfigured the timer logs and does nothing; `POST` returns 503 saying so.

### Milestones, the moment they happen

Some things should not wait for Monday. After every ingest — a Shortcut post, the daily
Health Auto Export batch — the week in progress is re-read and anything newly earned goes
to Telegram:

| Key | When |
| --- | --- |
| `good` | The week reaches the good threshold; the message says what very good and perfect still need. |
| `verygood` | The very-good threshold with its minimums met (six sessions, two of them strength). Supersedes `good`. |
| `target:<activity>` | One target ticked off — the third strength session of the week — with what is still open. |
| `perfect` | Every target met. Supersedes everything below it. |
| `volume` | Enough sessions for a very good week, but not its shape — "6 sessions, one strength session missing". |
| `streak:N` | The week is good or perfect and makes it 4, 8, 12, 26 or 52 in a row. |
| `effort-high` | Effort already above every completed week of the past year (needs 12 weeks of history). |
| `max-hr:<bpm>` | A workout that just arrived beat the past year's max heart rate, within 25 bpm of `ATHLETE_MAX_HR`. |
| `longest:<activity>` | Longest session of a target activity in a year, after five earlier ones. |

Each key is announced **once per ISO week**; the `milestones` table remembers what went
out, which is what keeps the automation's daily re-post of the same seven days quiet. Only
the two HTTP ingest paths trigger this — the export CLI writes history, not news.

```bash
curl -s "$WORKOUTS_URL/api/notify/milestones" -H "x-api-key: $KEY"           # due + already sent
curl -s -X POST "$WORKOUTS_URL/api/notify/milestones" -H "x-api-key: $KEY"   # send what is due
```

### The Thursday 18:00 check-in

A second timer, same DST trick (16:00 and 17:00 UTC, sends at 18:00 Amsterdam): how many
sessions so far against a typical week, the target rows, what a good week still needs with
the days left, and what a perfect one needs. It stays silent when the week is already
perfect — the milestone message said so.

```bash
curl -s "$WORKOUTS_URL/api/notify/checkin" -H "x-api-key: $KEY"              # preview
curl -s "$WORKOUTS_URL/api/notify/checkin?for=2026-10-08" -H "x-api-key: $KEY"
curl -s -X POST "$WORKOUTS_URL/api/notify/checkin" -H "x-api-key: $KEY"      # send now
```

## Body weight

Weight is its own record, not a workout, and lives in its own table (`bodyweight`, one row
per calendar day). Three ways in:

- **The Health export** — `npm run sync` now also picks `HKQuantityTypeIdentifierBodyMass`
  records off the stream (kg or lb) alongside the workouts.
- **Health Auto Export** — add the **Weight** metric to the automation's export and the
  batch endpoint stores it from `data.metrics`; the response gains `weightsWritten`.
- **By hand** — `POST /api/bodyweight` with `{"date":"2026-10-10","kg":80.2}` (or
  `"weight":"176 lb"`).

Several readings on one day collapse to the **earliest** — the morning weigh-in is the
measurement; averaging it with a post-dinner one gives a number nobody stood on a scale to
see. Readings outside 20–400 kg are dropped as scale glitches or unit mix-ups. The day is the
*local* day Apple wrote, so a 00:30 weigh-in is not filed under yesterday.

## Strength

Lifting is a separate page — `/api/strength`, linked from the dashboard header — because it
asks different questions: per-lift progress, a rep-max board, and whether a training block
is moving week to week. It reads its own table (`lifts`), fed by a spreadsheet importer:

```bash
npm run lifts -- LongTermLiftProgress.xlsx --dry-run
npm run lifts -- LongTermLiftProgress.xlsx --as-of 2025-11-14
```

The workbook's three sheets become three kinds of record: dated top sets per lift with the
program in force ("PRs over time"), a board of best weight per rep count per variation
("rep PRs" — undated, so stamped with `--as-of` or the file's date), and a training block's
week-by-week training maxes ("Sheet1"). Apple Health has no sets-and-reps model, so this is
the only way lifting data gets in. The `.xlsx` is read without a spreadsheet library — it is
a zip of XML, and `sax` was already a dependency.

### The weekly log

The block tracker above is a summary sheet. The raw weekly log is a different shape — one
sheet, a grid per session laid side by side and stacked down, reps typed by hand in a dozen
notations (`100x1,95x10,8,6`, `102,5x5`, `BWx7`, `14,MYO 14`, `~5?`, `-`) — and has its own
importer:

```bash
npm run block -- Cable_Rack_Summer_2025.xlsx --dry-run
npm run block -- Cable_Rack_Summer_2025.xlsx --program "Cable Rack Summer 2025"
```

Every exercise row is stored as written: date, session, lift, row weight, the stated RIR and
each set. The page derives one point per session and lift from the **top set** — the set
implying the highest 1RM, with reps in reserve counted as reps not done, so 102.5 × 5 at
2 RIR is read as a 7. Those points are drawn as **diamonds**: a block's working sets are not
taken to failure, so they track the trend without competing for the "best" tile, which only
sets taken to failure can win.

Pull-ups and chin-ups are a family of their own. The log's number is the added load (0 is
bodyweight), the estimate is made on bodyweight plus that load, and the result is shown back
as added load — "+25 kg" — which is how a weighted pull-up is thought about. Weight-assisted
variants are stored but never charted; their number is assistance, not load. Accessory
lifts the name rules do not recognise are stored too, but kept off the chart — eighty
series of cable raises would bury the lifts the page is for. The chart has a **Since**
control (all / 5 y / 2 y / 1 y) because weekly points on a thirteen-year axis are a smear;
the tiles stay all-time, since "best" means best ever.

### Estimating a one-rep max

The sheet uses Wendler's `w × reps × 0.0333 + w`, which is Epley to 0.1%. It is fine at low
reps and wrong for this lifter at high ones: the rep-max board shows a 10RM at **85%** of the
logged single where Epley assumes 75%, so every "best" e1RM on the sheet came from a 10–14-rep
set and overstated the lifter by 15–25%. Brzycki is worse above 10 reps, not better.

So the comparison estimate is a **personal curve**: the same shape, `1RM = w × (1 + k × reps)`,
with `k` fitted per lift to the lifter's own rep maxes (median of the implied `k` across the
board's points, anchored on the logged single). Wendler stands in where a lift has fewer than
three points. Every point says which estimator produced it, and sets past ten reps are drawn
hollow — extrapolation for any formula.

### Bodyweight

Each PR is matched to the nearest weigh-in within ten days from the body-weight table, so the
page can show **× bodyweight** and **DOTS** (powerlifting's current bodyweight-normalised
score, published male coefficients; a 100 kg lift at 85 kg scores ≈66.6) alongside raw kg.
That answers "stronger pound-for-pound than in 2016?" even ten kilos heavier.

### Block tracker

Per lift in a block: training max by week as a sparkline, first → last, change, the slope over
the last four trained weeks, weeks since the training max last rose, and a verdict —
progressing / holding / regressing. Untrained weeks are skipped, not read as zero.

## Recovery

A third page — `/api/recovery`, linked from the dashboard header — puts the overnight
signals the watch records next to the training load: sleep by night with its stages,
resting heart rate and HRV against their own 28-day baselines, a week-by-week table of
effort beside sleep, deep/REM share, wake-ups, bedtime consistency and the heart figures,
and small multiples for respiratory rate, SpO₂, sleeping wrist temperature, breathing
disturbances and time in daylight.

The data comes from the same two paths as everything else. The export import reads the
`SleepAnalysis`, `RestingHeartRate`, `HeartRateVariabilitySDNN`, `RespiratoryRate`,
`OxygenSaturation`, `AppleSleepingWristTemperature`, `AppleSleepingBreathingDisturbances`
and `TimeInDaylight` records as they stream past; the Health Auto Export batch reads the
matching metrics (`sleep_analysis`, `resting_heart_rate`, `heart_rate_variability`, …).
Both reduce to **one row per day** in the `recovery` table, and rows **merge** on write, so
a batch carrying only resting heart rate does not erase the night already stored.

Decisions worth knowing:

- **A night belongs to the morning it ended on.** A sleep that starts after 15:00 is the
  next day's night; a nap stays with its day. "Last night" on the 11th is the row dated the 11th.
- **One source per night.** The watch records stages; the phone records in-bed time for
  the same hours. The source with stages wins outright — summing both would double-count.
  Before the watch (2016–2021) there is only in-bed time, stored as such and never shown
  as sleep.
- **Wake-ups** are awake segments of a minute or more between falling asleep and the final
  wake-up. **Bedtime consistency** is the circular standard deviation of bedtimes, so
  23:50 and 00:10 are twenty minutes apart, not twenty-three hours.
- **Baselines are personal**: the median of the previous 28 days with a value, shown once
  a week of them exists. The page reads today against that, not against a population norm.
- HRV is the day's mean of Apple's SDNN samples (several a day, most overnight);
  respiratory rate, wrist temperature and breathing disturbances file under the morning.

### Patterns

A card at the bottom of the Recovery page, computed from everything stored — kept for a
day, recomputed the moment a push writes something (a Shortcut post, a Health Auto Export
batch, a weigh-in) and after `npm run sync`; `?fresh=1` forces it:
the next morning by what the day held (nothing / walks only / one session / two or more /
≥ 90 min), by activity, late vs early sessions, day of the week, training load against
resting HR in the same week and the week after, sleep against resting HR, year by year,
season and daylight (sunrise, sunset and day length at your home latitude against sleep,
bedtime and wake time), and weight within each year.

Three habits keep it honest, in `src/domain/patterns.ts`: walks are kept apart from
training (the watch auto-detects them, twenty a week in some years); weekly correlations
are taken on deviations from the surrounding quarter, because weight, resting HR and
walking drift together across the years; and "a day with nothing" is reported with its
caveat, since nobody trains when ill. The **readings** at the top are sentences produced
by thresholds over those numbers — a pattern that stops holding stops being claimed, and
each one carries its n.

### The recovery rating

A 0–100 rating per day and per week, built only from how the signals sit against *your
own* baselines, with the breakdown shown wherever the number is:

| Component | Against | Scale | Weight |
| --- | --- | --- | --- |
| Sleep | 90-day typical night | 100 at typical, 0 at half of it | 30 |
| HRV | 28-day baseline | 100 at baseline, 0 at −40 % | 25 |
| Resting HR | 28-day baseline | 100 at baseline, 0 at +10 bpm | 25 |
| Wake-ups | typical count | −12 per extra wake-up | 10 |
| Respiratory rate | 90-day typical | −25 per breath/min above | 5 |
| Wrist temperature | 28-day baseline | −40 per +0.5 °C | 5 |

A missing component drops out and the rest are renormalised; a day needs sleep plus one
heart signal to be rated at all. Better than baseline never scores above 100 — rested is
the ceiling, not a bonus. Labels: **80+ recovered · 65 okay · 50 under-recovered · below
50 run down.** The week is the mean of its rated days with a seventh component, **bedtime
consistency** (100 at ±30 min, 0 at ±120), because the same hours slept at random times
recover less. "Recovery now" is the latest rated day.

The weekly table's note gives the same-week correlation between effort and resting heart
rate, and between effort and sleep. With a year of weeks it is a real number; under about
0.3 either way it is noise, and it says so.

## Routes

Walks, rides, runs and hikes carry a GPS track; the export ships them as one GPX file per
workout in `workout-routes/`, referenced from each `<Workout>`. `npm run sync` unpacks the
folder beside `export.xml` and the importer reads it (`--routes <dir>` to point elsewhere).
Each track is simplified (Douglas–Peucker, 12 m) and stored as a Google-encoded polyline on
a row in the `routes` table — a few kilobytes per workout, so three years is one response.

The page (`/api/map`, linked from the dashboard) draws everything on a canvas with additive
blending, so brightness is how often a street has been walked. **Home** is where most
routes *start*; a route is a home route if it starts within 15 km of that point — a ride
from the front door that ends sixty kilometres away is still a home ride. Everything else
is **away**, grouped into places (starts within 40 km of each other), each a card; click
one and it becomes the hero. Colour is one warm hue by default or the activity's fixed
colour; activities toggle; the range cuts by date; hover lights a route and names its day.
Place names come from Nominatim one request a second, remembered in the browser; until
then a card shows its coordinates.

**Privacy zone.** `ROUTE_PRIVACY_ZONE=lat,lon,metres` in `.env` (or `--privacy` on the
import) drops every point within that radius before anything is stored, so the glow starts
a street away from the front door. Off by default; the page is behind the API key either way.

## Strava

Strava adds what Apple Health lacks: the name you gave a session, its photos, kudos, its
own "relative effort" and training load, the gear, the weather, and GPX for anything
recorded in the Strava app. Nothing is created on the workout side; Strava only decorates,
matched to the Apple Health workout that starts within five minutes.

Two ways in. The **archive** needs no subscription and is the one that works for a free
account; the **API** route is wired but Strava now only lets subscribers create API
applications.

### The archive (free)

Settings → My Account → *Download or Delete Your Account* → **Request Your Archive**. The
zip arrives by email within an hour or two: `activities.csv` (one row per activity with
~100 columns), `media/` (the photos at full size), `media.csv` (captions), `reactions.csv`
(every kudos), `privacy_zones.csv`, GPX/FIT files, planned routes, gear. Then:

```bash
npm run strava -- ~/Downloads/export_123.zip --dry-run
npm run strava -- ~/Downloads/export_123.zip            # needs WORKOUTS_STORAGE
```

The importer matches activities to workouts by start time (the CSV's dates are UTC,
written the American way — checked against the same workout in the Apple data), stores
them beside the workouts, copies the photos into a private **Blob container** in the same
storage account (served to the pages through day-long signed URLs, never through the
function), reads the GPX files as routes for workouts the export had none for, and uses
your Strava privacy zone as the route privacy zone. FIT files are skipped — they are the
watch's own recording, which the Apple export already carries. Videos are skipped.
Re-runs are idempotent (photos already in the container are not re-uploaded).

### The API (subscribers)

1. At [strava.com/settings/api](https://www.strava.com/settings/api) create an application
   with **Authorization Callback Domain** = your app's host. Note the Client ID and Secret.
2. Store them, and the public URL the callback should use:

```bash
az functionapp config appsettings set -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" \
  --settings STRAVA_CLIENT_ID="<id>" STRAVA_CLIENT_SECRET="<secret>" PUBLIC_URL="$WORKOUTS_URL"
```

3. Open `$WORKOUTS_URL/api/strava/connect?key=<INGEST_API_KEY>` in a browser and approve.
   Tokens go to the `settings` table (Strava rotates the refresh token). Then
   `POST /api/strava/sync?since=2022-01-01` for the backfill — a few rounds, since Strava
   allows 200 requests per 15 minutes and a sync stops cleanly at the limit — and a timer
   syncs daily at 03:20 UTC from the stored cursor.

What else the API offers, not wired: per-second **streams** (heart rate, pace, altitude,
cadence, power); **best efforts** and **segment efforts** with PRs; **laps** and
**splits**; athlete **zones** and **FTP**; **webhooks** for a push on every new activity.

## One session, two recordings

A ride tracked on a Wahoo reaches Health through Strava while the watch runs its own
cycling workout; Apple keeps both, and their ids differ because the start times and
durations differ by seconds. Two workouts of the same activity whose starts are within
15 minutes and which overlap for at least 60 % of the shorter one are treated as one
session: the copy with heart rate wins, then the longer, then the one recorded first. The
rule runs in the export import, in both HTTP ingest paths (where a losing arrival is
answered with the stored copy, and a winning one replaces it), and as a cleanup:

```bash
npm run dedupe -- --dry-run     # list what would go
npm run dedupe                  # delete the losing copies
```

## Rescoring history

When the scoring model changes — a new max-HR reference, a corrected resting rate — the
stored efforts are stale until recomputed. No export is needed: every row already holds its
own heart rates.

```bash
npm run rescore -- --dry-run   # what would change, and which reference max each row gets
npm run rescore
```

It reads the whole table, sorts by date, scores each workout against the peaks recorded
before it, and rewrites only the rows whose score changed. MET estimates (no heart rate) are
untouched. A second run is a no-op. Needs `WORKOUTS_STORAGE` and the `ATHLETE_*` settings
from `.env`, as the import does.

## Backfilling sessions by hand

For workouts that never reached Apple Health — a class logged nowhere, a watch left at home:

```bash
npm run add -- bjj.csv --dry-run   # look first
npm run add -- bjj.csv
```

```
start,            duration, activity,  notes
2026-09-02 19:00, 90m,      bjj,       open mat
2026-09-04 19:00, 1h30,     bjj
2026-09-06 10:00, 1h,       capoeira
```

`start` is Amsterdam local time (an offset or `Z` overrides that), durations are `90m`,
`1h30` or `1h 30m`, and `bjj` / `capoeira` are accepted alongside the slugs. Rows are stored
as `source: manual` with the note. Re-running is safe — a row already present reports
`duplicate`. These rows exist only here, not in Apple Health: if you later log the same
session there with a different start time, it will not dedupe.

## Subscribing in your calendar

`GET /api/calendar.ics?token=…` is an [RFC 5545][ics] feed. Subscribe to it and every
workout appears as a calendar event.

```
https://<your-domain>/api/calendar.ics?token=<CALENDAR_TOKEN>
```

- **iOS/macOS**: Calendar → File → New Calendar Subscription (or paste the URL in Safari).
- **Google Calendar**: Other calendars → From URL.
- Replace `https` with `webcal` if an app wants that scheme.

Events default to the last 365 days and are capped at 5,000; `days`, `from`, `to` and
`activityType` all work as they do on the other read endpoints.

Each event carries the duration, distance, energy, heart rates and effort in its
description, and is marked `TRANSP:TRANSPARENT` so a past workout never makes you look busy
to anyone checking your availability. The `UID` is the workout's derived id, so a refresh
updates events in place instead of accumulating duplicates.

### Emoji and colour

Summaries are prefixed with the activity's glyph, which is what makes a month view scannable:

```
🏃 Running · 46m · 8.2 km       🤸 Capoeira · 2h 4m
🏋️ Strength Training · 57m       🥋 BJJ · 1h 30m
🚴 Cycling · 1h 12m · 32 km      🤿 Underwater Diving · 1h 10m
```

Append `&emoji=0` for plain labels.

**Per-event colour mostly does not work.** Each event carries an RFC 7986 `COLOR`, but
Apple Calendar and Google Calendar both ignore it on a subscribed feed — they colour by
*calendar*, not by event. The property is emitted for clients that do honour it; do not
count on it.

What genuinely works is **subscribing to several filtered feeds** and colouring each one in
your client:

```
…/api/calendar.ics?token=…&activityType=running
…/api/calendar.ics?token=…&activityType=strength
…/api/calendar.ics?token=…&activityType=taichi      → shows as "Workouts · Capoeira"
```

Each feed names itself after its filter, so they are distinguishable in the sidebar. Note
that `activityType` takes the **slug Apple recorded**, not the relabelled name — `taichi`
for Capoeira, `martialarts` for BJJ. `GET /api/summary` lists every slug in your data.

### Why a separate token

Calendar clients **cannot send custom headers**, so the credential has to travel in the
URL — and that URL is then stored by the calendar app and synced between your devices.
`CALENDAR_TOKEN` is therefore distinct from `INGEST_API_KEY` and grants read access only.
Leaking a subscription link exposes your workout history; it does not let anyone write to it.

Rotate it, which immediately breaks existing subscriptions:

```bash
az functionapp config appsettings set -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_FUNCTION_APP" \
  --settings CALENDAR_TOKEN="$(openssl rand -hex 24)"
```

Leave `CALENDAR_TOKEN` unset and the endpoint returns 404 — the feed is off by default.

[ics]: https://datatracker.ietf.org/doc/html/rfc5545

## How effort is scored

Each workout gets a single `effort` number so sessions of different types and lengths are
comparable, plus an `effortModel` saying how it was derived.

- **`trimp`** — used whenever an average heart rate is present. Banister's TRIMP:
  minutes × heart-rate reserve × an exponential weighting, so time near threshold counts far
  more than the same time spent easy. Resting heart rate comes from `ATHLETE_RESTING_HR`;
  **set it or the numbers are meaningless.**

  The **maximum** is not a fixed setting. Each workout is scored against the highest heart
  rate observed in the **trailing year as of that workout's date**, and records which value
  it used (`maxHeartRateReference`). `ATHLETE_MAX_HR` is only the fallback for when the
  window holds no heart-rate data, or the observation is implausibly low.

  Why a year and not the month: max HR is a slowly drifting ceiling, not a monthly
  statistic. The highest value recorded in a *month* reflects what you did that month — an
  easy month would lower the ceiling and inflate every effort in it. A year nearly always
  contains one genuine hard effort, a new peak raises the ceiling from that day forward, and
  old peaks age out as the body changes.
- **`met-minutes`** — the fallback when the watch recorded no heart rate. Duration × the
  activity's MET value, scaled onto roughly the same range as TRIMP so a chart mixing the two
  does not show a cliff wherever HR data is missing.

A workout scored with `met-minutes` is an estimate. Filter on `effortModel` if you want to
exclude them from an analysis.

**BJJ's MET is calibrated, not looked up.** 57 classes with a chest-strap recording scored a
median 0.69 TRIMP per minute; the compendium's 10.3 for "martial arts, vigorous" would put a
no-heart-rate session at nearly double that. The personal MET (5.8) is the value that makes
the estimate land on the measured median, so a class logged with only its duration gets
≈62 effort for 90 minutes, not 111. A class is mostly drilling with short bursts of rolling —
average heart rate ~120 — which is why the generic figure overshoots.

### Personal activity corrections

Apple Watch has no Capoeira or Brazilian Jiu-Jitsu workout type, so those sessions are
logged as the nearest thing it offers. `PERSONAL_OVERRIDES` in `src/domain/activityType.ts`
corrects them on the way out:

| Apple records | Shown as |
| --- | --- |
| Tai Chi | Capoeira |
| Martial Arts | BJJ |

The **slug is deliberately unchanged** — workout ids are derived from it, so renaming it
would orphan every row already stored. Only the label and the MET value are overridden.
Labels resolve at read time, so existing workouts show the corrected name immediately; MET
values apply at write time, so previously-imported sessions keep their old effort until
re-imported, and only those with no heart rate.

Clear that map if the data ever belongs to someone else.

---

## Getting workouts in

**The Health app does not expose workouts to Shortcuts.** There is no native action that
returns a workout's type, duration, distance or heart rate. The "when I end any workout"
automation trigger exists, so a Shortcut can fire at the right moment — it just cannot read
what you did. Any guide promising otherwise is describing an API that is not there.

So this project syncs from Apple's **Health export**, on whatever cadence suits you. The
questions it answers — how much did I train this month, how does that compare to last — are
retrospective, so a monthly refresh loses nothing.

### The routine

On the iPhone: **Health → your avatar (top right) → Export All Health Data**. AirDrop the zip
to this machine. Then:

```bash
npm run sync
```

That finds the newest `apple_health_export*.zip` in `~/Downloads`, unzips it to a temp
directory, fetches the storage connection string from Azure, imports, and deletes the
extracted copy. Re-importing is an idempotent overwrite, so overlapping exports never
duplicate — just run it and let it reconcile.

```bash
npm run sync -- --dry-run          # parse and report, write nothing, no credentials needed
npm run sync -- ~/path/export.zip  # a specific file
npm run sync -- --since 2024-01-01 # only from a date forward
npm run sync -- --max-hr           # read your true max heart rate out of the export
```

Delete the zip when you are done. It is your complete medical history.

### Set your heart rates first, in `.env`

Effort is computed **at write time**, so importing before setting these scores every workout
against the defaults.

```bash
cp .env.example .env     # then edit; .env is gitignored
```

The import loads it automatically and prints what it is using, so a wrong value is visible
rather than silent:

```
Effort profile: resting 52 bpm, max 179 bpm
```

Resting heart rate is in Health under **Browse → Heart → Resting Heart Rate** — use the
monthly average. Health has no maximum-heart-rate field; `npm run sync -- --max-hr` reads the
highest per-workout maximum out of your export instead. Compare the top few values, because a
single sensor spike would otherwise become your max and flatten every score.

Changed your mind about the numbers later? Set them and re-run `npm run sync` on the same
export — every workout is rescored and replaced in place. The import scores in date order so
each row sees only the peaks recorded before it; `--since` limits what is written, not what
informs the reference. The same re-run is how a newly
captured field reaches old rows: minimum heart rate, for instance, was added after the
first import and is empty on rows written before it until the export is run through again.

### Automatic capture with a Shortcut

[Health Auto Export][hae]'s **Premium** tier does background REST API sync — that is the €30
one. You do not need it. Its **Basic** tier (one-time purchase) includes an
**`Export Workouts` Shortcuts action**, and a scheduled Shortcut does the triggering.

#### Schedule it daily; do not trigger on workout end

Shortcuts offers a **Workout → When I end any workout** trigger, but a **Time of Day**
automation exporting the *last 7 days* is strictly better:

- **Self-healing.** A failed run, a phone that was off, a workout the Watch synced late —
  the next six runs pick it up. The workout-end trigger gets one attempt and no retry.
- **One automation** instead of one firing per workout.
- **Overlap is free.** Ids are derived from the workout itself, so re-sending the same week
  costs nothing. Verified against the deployment: nine workouts across three overlapping
  daily runs produced exactly four rows.

Widen the window if you like — 30 days is still a trivial payload and survives a longer gap.

#### Build it

Install Health Auto Export and grant it read access to **Workouts** on first launch. Then in
**Shortcuts → Automation → + → Time of Day**:

| | |
| --- | --- |
| When | **02:00**, **Daily** — a time the phone is on and charging |
| Run | **Run Immediately** (turn *Notify When Run* off once you trust it) |

Choose **New Blank Automation** and add two actions.

**Action 1 — Health Auto Export → `Export Workouts`**

| Parameter | Value |
| --- | --- |
| Format | `JSON` |
| Period / date range | last **7 days** |
| Aggregation | none — one entry per workout |

**Action 2 — `Get Contents of URL`**

| Parameter | Value |
| --- | --- |
| URL | `https://<your-domain>/api/ingest/health-auto-export` |
| Method | `POST` |
| Headers | `x-api-key` → your `INGEST_API_KEY` |
| Request Body | `File` → the output variable of action 1 |

If action 1 yields text rather than a file, pass it anyway — the endpoint accepts JSON sent
as `application/json`, `text/plain`, `application/octet-stream`, or wrapped in
`multipart/form-data`, and takes either the full `{"data":{"workouts":[…]}}` envelope or a
single bare workout object. All five shapes are tested against the deployment.

#### Run it once by hand first

Tap **▶** in the editor and read the response. Add a **Quick Look** action after
`Get Contents of URL` while testing, then delete it — this is the only way to see what the
Shortcut actually sent.

```json
{ "received": 4, "written": 4, "skipped": 0, "details": [] }
```

`written` counts rows upserted, not new workouts, so re-running the same week reports the
same number every time. That is correct, not a bug.

#### When it goes wrong

The endpoint is built to be diagnosable from a phone: every failure says what arrived.

| Response | Cause | Fix |
| --- | --- | --- |
| `401 Invalid or missing API key` | header missing, misspelled, or stale | Header name is exactly `x-api-key`. Watch for a trailing space or newline pasted into the value. |
| `400 Request body is not valid JSON` with `received: …` | the body was not JSON; the excerpt shows what arrived | If the excerpt looks like a filename or `null`, action 1 produced nothing — check its date range and that Health granted Workouts access. |
| `400 Expected a workouts array …` | the export contained metrics but no workouts | Set action 1 to export **Workouts**, not Health Metrics. |
| `400 Batch of N exceeds the 5000 limit` | window far too wide | Narrow the range, or enable **Batch Requests** in the app. |
| `200` with `skipped > 0` | some workouts failed validation; `details` carries the first ten reasons | Usually workouts under 30 seconds. Harmless. |
| `500 Failed to store workouts` | the storage write failed | Check the Function App is running and the storage account is reachable. |

A malformed *envelope* returns 400, but **individual bad workouts still return 200**. That
asymmetry is deliberate: a non-2xx makes the app retry the identical batch, and a workout
that failed validation would fail identically forever, wedging the automation.

#### Alongside the manual import

Both paths derive the same ids, so a scheduled Shortcut and an occasional `npm run sync`
reconcile instead of duplicating. Running both is a reasonable belt-and-braces setup: the
Shortcut for currency, a full export now and then to catch whatever the rolling window
missed.

> **Not verified end to end.** The endpoint is tested against the live deployment in every
> body shape Shortcuts is known to produce. The Shortcut side is written from Health Auto
> Export's documented export format and tier descriptions, not from a running iPhone, so
> action 1's parameter names may differ from those above. If Basic turns out not to include
> `Export Workouts`, [Toolbox Pro][tbp]'s `Get Workouts` action ($5.99 one-time) is an
> equivalent source — post its output to `/api/workouts` one workout at a time instead.

[tbp]: https://apps.apple.com/app/toolbox-pro-for-shortcuts/id1476205977

### Heart rate from loose samples

Third-party apps — Polar Flow, Strava — write a workout and its heart-rate stream as two
separate things, and Apple attaches `WorkoutStatistics` only to workouts it recorded itself.
So a chest-strap session can arrive with a second-by-second heart-rate trace and *no*
average on the workout. The import keeps every heart-rate sample it streams past (a
million is ~16 MB) and, for a workout with no statistics of its own, derives the average,
minimum and maximum from the samples inside its span. A workout's own statistics always
win; a handful of stray readings across an hour is a watch glance, not a recording, and
is ignored (fewer than ten samples, or under one every two minutes).

### Personal relabels at parse time

`relabelActivity` in `src/domain/activityType.ts` corrects the *stored* type for cases
the data itself made unambiguous: Strava sessions typed "Other" of an hour or more are
BJJ (47 of them, all Monday and Friday evenings, filling exactly the gap in the BJJ
history), and "Wrestling" is BJJ. Unlike the display overrides this changes identity —
a relabelled row has a different derived id — which is why it happens before the row is
written, so every import agrees.

## Importing by hand

`npm run sync` wraps all of this. Reach for the underlying CLI when you want to control the
steps — a file somewhere unusual, a different storage account, debugging a parse failure.

The import runs **from your machine, not through the API**: the export is far too large for an
HTTP trigger, and the parser streams, so memory stays flat regardless of file size.

The import compiles the project first, so a fresh clone needs dev dependencies —
`npm install`, not `npm ci --omit=dev`. Without them the build fails with
`sh: tsc: command not found`.

```bash
npm install
unzip apple_health_export.zip

# See what would be imported. Needs no configuration at all — not even an
# Azure account — because it writes nothing.
npm run import -- apple_health_export/export.xml --dry-run

# Import everything
npm run import -- apple_health_export/export.xml

# Or only from a date forward
npm run import -- apple_health_export/export.xml --since 2024-01-01
```

The CLI reads the same settings as the Functions app, so point `AzureWebJobsStorage` (or
`WORKOUTS_STORAGE`) at the deployed storage account first:

```bash
export WORKOUTS_STORAGE="$(az storage account show-connection-string \
  -g <resource-group> -n <storage-account> --query connectionString -o tsv)"
npm run import -- apple_health_export/export.xml
```

The athlete profile comes from `.env` (or the shell), **not** from the Function App's
settings — those two are configured separately.

Effort is computed at write time and the import is an idempotent overwrite, so if you
later learn your true max heart rate you can set it and re-run the same file — every
workout is rescored and replaced in place.

`export.xml` is your complete medical history. `.gitignore` excludes `*.xml` for that reason —
keep it that way.

---

## Running locally

Prerequisites: Node 22+, [Azure Functions Core Tools v4][core-tools], and
[Azurite][azurite] for local storage.

```bash
npm install
cp local.settings.json.example local.settings.json   # then set INGEST_API_KEY
npx azurite --silent &                               # local storage emulator
npm start
```

```bash
curl -X POST http://localhost:7071/api/workouts \
  -H 'x-api-key: change-me-before-deploying' \
  -H 'content-type: application/json' \
  -d '{"activityType":"Outdoor Run","startedAt":"2026-03-14T07:00:00Z","duration":"45 min","distance":"8.2 km","averageHeartRate":148}'

curl 'http://localhost:7071/api/summary?days=30&granularity=week' \
  -H 'x-api-key: change-me-before-deploying'
```

```bash
npm test          # unit tests
npm run typecheck # tsc --noEmit
```

[core-tools]: https://learn.microsoft.com/azure/azure-functions/functions-run-local
[azurite]: https://learn.microsoft.com/azure/storage/common/storage-use-azurite

---

## Deploying to Azure

Four resource providers must be registered on the subscription first; this is a one-time,
subscription-wide step and takes a couple of minutes:

```bash
for p in Microsoft.Web Microsoft.Storage Microsoft.Insights Microsoft.OperationalInsights; do
  az provider register -n $p
done
```

Then:

```bash
KEY=$(openssl rand -base64 32)
az group create -n workout-tracker -l westeurope

az deployment group create \
  -g workout-tracker \
  -f infra/main.bicep \
  -p namePrefix=workouts ingestApiKey="$KEY" restingHeartRate=60 maxHeartRate=185
```

Keep `$KEY` — it is the Shortcut's credential and is not readable back from the portal.

The deployment takes a few minutes and prints the app name, the ingest endpoint and the
dashboard URL. Push the code with either the GitHub Actions workflow below or, from your
machine:

```bash
npm run build
az functionapp deployment source config-zip -g workout-tracker -n <functionAppName> --src app.zip
```

> Azure Functions Core Tools (`func`) is **not** required. If you do have it installed,
> `func azure functionapp publish <app>` works too.

### Wiring up GitHub Actions

Flex Consumption has no publish profile — `az functionapp deployment list-publishing-profiles`
refuses outright for that SKU — so CI authenticates with **OIDC**: GitHub mints a short-lived
token per run and Azure trusts it through a federated credential. Nothing long-lived is stored
in the repository.

```bash
./scripts/setup-github-oidc.sh
```

That creates the app registration, the federated credential scoped to
`repo:<owner>/<repo>:environment:production`, a Contributor role assignment on the
*resource group only*, and the four repository secrets plus `DEPLOY_ENABLED=true`. It needs
permission to create an app registration in the tenant, and it is safe to re-run.

The script sets `DEPLOY_ENABLED=true` as its last step, so deploys begin only once the
credentials exist. Until then the job **skips** — it is off by default precisely so a
workflow that cannot possibly succeed does not sit red on every push and train you to
ignore CI.

Deploying by hand meanwhile:

```bash
npm run build
az functionapp deployment source config-zip -g workout-tracker -n <app> --src app.zip
```

### Custom domain

The app serves on a custom domain with a free App Service Managed Certificate, and the
bare domain redirects to the dashboard. The Functions host otherwise
serves its own landing page at the root; claiming it means `host.json` sets `routePrefix`
to `""`, so every function declares its full `api/…` path itself and a `{*path}` catch-all
handles `/` (and 404s everything else unmatched). External URLs are unchanged.
At the DNS provider:

| Name | Type | Value |
| --- | --- | --- |
| `workouts` | `CNAME` | `<function-app>.azurewebsites.net.` |
| `asuid.workouts` | `TXT` | the app's `customDomainVerificationId` |

The `asuid` TXT record is Azure's ownership proof; without it the hostname is rejected with
an error that does not explain itself. An explicit `CNAME` takes precedence over the
wildcard record if the zone has one.

**Flex Consumption uses site-scoped certificates**, so `az webapp config ssl create` fails
with *"not supported for Flex Consumption plans"* — it targets the resource-group-scoped
`Microsoft.Web/certificates`. Create the certificate under
`Microsoft.Web/sites/<app>/certificates` instead, with `domainValidationMethod:
cname-delegation`, then bind it by PATCHing `hostNameSslStates` with the thumbprint and
`sslState: SniEnabled`. A certificate can sit **issued but unbound** — which looks exactly
like a failure, since HTTPS gives a TLS verification error while plain HTTP still redirects
correctly. Check `hostNameSslStates` before assuming issuance failed. Site-scoped
certificates are capped at 3 private + 3 public per app.

### Plan choice, and why this stays free

The app runs on **Flex Consumption (FC1)**, Azure's current Linux serverless plan: it scales
to zero and bills per execution and GB-second beyond a monthly free grant. At roughly sixty
executions a month — one per workout — it sits orders of magnitude below that.

The legacy **Linux Consumption (Y1/Dynamic)** plan is deliberately not used. A new Linux Y1
function app would not start at all on this subscription: the site and its SCM endpoint both
served `503 The service is unavailable` indefinitely, so no code could ever be deployed to
it. Flex is the supported replacement and comes up healthy from the same template.

| Resource | Plan | Cost at this volume |
| -------- | ---- | ------------------- |
| Functions | Flex Consumption (FC1) | Within the monthly free grant; no always-ready instances, which would bill continuously |
| Table + Blob Storage | Standard_LRS | A few cents/month at ~400 rows/year |
| App Insights | Workspace-based | 5 GB/month ingest free, and capped at 0.1 GB/day in Bicep |

The storage account is the only line item that is not literally zero, and at this volume it
rounds to pennies.

### Known hardening gaps

- The storage connection string is injected as an app setting, which puts the account key in
  the deployment history, and Flex's deployment container reads the same key. The Function
  App already has a system-assigned managed identity; moving `AzureWebJobsStorage` to
  `__accountName` form and the deployment storage to `SystemAssignedIdentity`, each with the
  matching data-plane role assignment, would remove the key entirely.
- Authentication is a single shared secret with no rotation mechanism and no rate limiting.
  Adequate for one user; not a multi-tenant design.

---

## Data model

Every ingest path produces the same canonical record. One unit per dimension — seconds,
metres, kilocalories — converted at the edges, so nothing downstream has to ask which unit
it is looking at.

```ts
interface Workout {
  id: string;                 // sha256(activityType|startedAt|duration), truncated
  activityType: string;       // normalised slug: "running", "strength", "cycling"
  startedAt: string;          // ISO-8601 UTC
  endedAt: string;            // ISO-8601 UTC
  durationSeconds: number;
  distanceMeters?: number;
  activeEnergyKcal?: number;
  totalEnergyKcal?: number;
  averageHeartRate?: number;
  minHeartRate?: number;
  maxHeartRate?: number;
  effort: number;
  effortModel: "trimp" | "met-minutes";
  source: "shortcut" | "health-export" | "manual";
  sourceName?: string;        // "Apple Watch"
  notes?: string;
  recordedAt: string;         // when the row was written, not when you trained
}
```

`id` is **derived, not assigned**. The same workout seen by the Shortcut and later by the
export produces the same id, so re-importing is an idempotent upsert.

Table Storage layout:

```
PartitionKey: <userId>|<YYYY-MM>
RowKey:       <startedAt ISO>|<id>
```

Monthly partitions stay small and bounded, and because ISO-8601 sorts chronologically, a date
range query is a key range scan over a handful of partitions with no client-side sorting —
rather than a full table scan that gets slower every month you keep using the app.

---

## Layout

```
src/
  domain/        activityType, workout, effort, summary — pure, no Azure, no I/O
  ingest/        shortcutPayload, healthExport, units — parsing the two input formats
  storage/       workoutRepository — the only module that knows about Table Storage
  http/          auth, responses, dateRange — HTTP concerns
  functions/     the Azure Function entry points; thin wiring over the above
public/          index.html — the dashboard, served by the dashboard function
scripts/         sync.sh (the monthly routine), import-health-export CLI,
                 import-lifts (the long-term sheet), import-block-log (the weekly log),
                 rescore (recompute effort in place),
                 add-workouts CLI (manual backfill), preview-dashboard dev server,
                 setup-github-oidc.sh (CI wiring)
public/          index.html (dashboard) and strength.html, each served by its own function
infra/           main.bicep
test/            unit tests (no Azure account needed)
```

The domain and ingest layers are pure functions over plain data, which is why the test suite
runs in under a second with nothing provisioned.
