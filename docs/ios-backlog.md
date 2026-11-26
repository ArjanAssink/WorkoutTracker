# Native iOS app — backlog

Goal: a native app on the phone that reads workouts from HealthKit and posts them to the
backend automatically, replacing the monthly `npm run sync` for training data. **MVP first**:
the smallest thing that runs on the phone and syncs a real workout. Everything else waits
in "Later".

Work top to bottom. Each item has a *done when* line; tick it off only after that has been
checked on the real phone, not just in theory. Items marked **(you)** need the Mac, the
phone or an Apple portal. Claude can't do them from a cloud session.

## Decisions (2026-11-25)

| Decision | Choice | Why / consequence |
|---|---|---|
| Apple account | **Free Apple ID** (personal team) for now | No cost. Installs only through Xcode, and the app **stops launching after 7 days** until you reinstall it from Xcode. No TestFlight, no signed CI builds. Upgrade later if it proves useful. |
| Build machine | **Your Mac with Xcode** | Required on the free account. Also the fastest debugging loop for HealthKit on a real phone. |
| MVP scope | **Workouts only** | Weight, sleep/recovery and HR series are "Later". |
| Backend contract | **Reuse `POST /api/ingest/health-auto-export`** | No backend change for v1. Dedupe, scoring, milestones and the stale-push alert all work as they do now. Auth is the existing `x-api-key`. |
| App UI | **One screen** | API key + base URL (Keychain), last-sync status, "Sync now". The web pages stay the real UI. |
| Project format | **XcodeGen** (`ios/project.yml`) | The Xcode project is generated from a text file, so Claude can write and review it from Linux and there is no `.pbxproj` merge noise. `.xcodeproj` is gitignored. |

**Public repo rules apply to `ios/`:** no team ID, no bundle ID containing the domain, no URL, no
API key. They go in a gitignored `ios/Local.xcconfig` (template: `Local.xcconfig.example`)
and in the app's Keychain.

**Inferred, not yet tested.** Verify these early, because they decide whether the free route works at all:
- ~~A free personal team can sign an app with the **HealthKit** capability.~~ **Confirmed 2026-11-26.**
- A free personal team can use HealthKit **background delivery**
  (`com.apple.developer.healthkit.background-delivery`). This is the uncertain one; item 7 tests it.
- Free-team limits: about 3 sideloaded apps per device and 10 new app IDs per 7 days.

## MVP

### 1. Mac and phone setup (you) — ✅ done 2026-11-26
- Xcode from the App Store. Open it once and let it install its components.
- Xcode → Settings → Accounts → add your Apple ID. A "Personal Team" appears.
- `brew install xcodegen`
- iPhone: plug in, trust the Mac, then Settings → Privacy & Security → **Developer Mode** on (the phone restarts).
- *Done when:* Xcode lists the phone as a run destination.

### 2. Empty app on the phone (Claude writes it, you run it) — ✅ done 2026-11-26
- `ios/project.yml`, `ios/Local.xcconfig.example`, a SwiftUI app that shows one line of text,
  `.gitignore` entries for `ios/*.xcodeproj`, `ios/Local.xcconfig`, `DerivedData`.
- You: copy `Local.xcconfig.example` → `Local.xcconfig`, fill in team ID and a bundle prefix,
  `cd ios && xcodegen && open WorkoutSync.xcodeproj`, then Run on the phone.
- First launch: Settings → General → VPN & Device Management → trust your developer certificate.
- *Done when:* the app opens on the phone. This proves signing before any HealthKit code exists.
- Result: works on the free personal team. Pairing needs a cable once; Developer Mode only
  appears in Settings after Xcode has seen the phone; Xcode must finish downloading the iOS
  platform before it can prepare the device.

### 3. HealthKit permission and a read-only list — ✅ done 2026-11-26
- HealthKit capability and entitlement, `NSHealthShareUsageDescription`, a request for read access to
  workouts, heart rate and active energy.
- The screen lists the last 10 workouts (type, start, duration, avg HR).
- *Done when:* the list matches the Health app for those 10.

### 4. Workout → payload mapping, with an identity test — ✅ done 2026-11-26
- Map `HKWorkout` to the HAE workout shape the parser already accepts (`name`, `start`, `end`,
  `duration`, `distance`, `activeEnergyBurned`, `avgHeartRate`, `maxHeartRate`).
- **Identity is the trap.** Ids are `sha256(activityType|startedAt|roundedDuration)`, so the app
  must produce the **same slug, start instant and rounded duration** as the export does for the
  same workout, or every workout gets stored twice. Send the activity type's export name
  (`HKWorkoutActivityTypeRunning`, …) so `normaliseActivityType` maps it identically. Send
  the start with full seconds and the duration in seconds.
- Backend side: a test in `test/` that feeds an app-shaped payload (synthetic, no real
  data) through the HAE parser and asserts the id equals the export parser's id for the same
  workout. This may need small parser tweaks; keep them lenient.
- Status (2026-11-26): `test/nativeAppParity.test.ts` passes. The HAE parser now applies
  `relabelActivity` with the payload's `sourceName`, as the export does; before this, a Strava "Other"
  class or a "Wrestling" entry via HAE got a different slug from the export. The app shows each
  workout's JSON (tap a row).
- Verified on the phone (2026-11-26): a strength session's payload (start in whole seconds,
  duration 2751.04 s) derives exactly the id of the row already stored for it. The actual post
  happens in item 6.
- *Done when:* the test passes, and one real workout posted from the app shows up as the *same*
  row the export already stored, not a second one.

### 5. Settings: base URL and API key — ✅ done 2026-11-26
- Two fields, stored in the Keychain, never in the repo or `UserDefaults`.
- A "Test connection" button: `GET /api/health`, then an authenticated `GET /api/workouts?limit=1`.
- Team ID lives in `ios/Local.xcconfig` (`DEVELOPMENT_TEAM`), so regenerating no longer drops the signing team.
- Keychain item is `AfterFirstUnlockThisDeviceOnly` so item 7's background sync can read it while locked.
- *Done when:* a wrong key shows an error and the right key shows OK.

### 6. "Sync now" — ✅ done 2026-11-26
- `HKAnchoredObjectQuery` for workouts. Save the anchor **only after a 2xx** so a failed post retries.
- First run: limit to the last 30 days so the first post isn't the whole history (the export
  already has it).
- Post in chunks (e.g. 50). Show the counts the endpoint returns, and the last sync time.
- Prerequisite: item 4's relabel fix (`healthAutoExport.ts`) merged to `main` and deployed, or a
  Strava BJJ class posted by the app gets a second row under `other`.
- "Re-send the last 30 days" forgets the anchor; harmless, because the backend upserts by id.
- Verified: relabel fix deployed first (run 96, `7ebcb3a`). The first sync sent 17 workouts; the
  table holds exactly 17 rows for those 30 days, all rewritten at the sync time, no doubles.
- *Done when:* finishing a workout and tapping Sync puts it on the dashboard, and a second tap
  posts nothing new.

### 7. Background sync (the actual point) — written, awaiting phone test
- `HKObserverQuery` on workouts plus `enableBackgroundDelivery(.immediate)`, registered at launch.
  The handler runs the same anchored sync, then calls the completion handler.
- Background delivery entitlement. **If the free team refuses it, record that here.** Then the MVP
  falls back to "open the app to sync", and the case for the paid account gets stronger.
- Also syncs whenever the app comes to the foreground ("On open"), to catch up on a wake that
  happened while the phone was locked. HealthKit is unreadable while locked, so such a wake fails and
  leaves the anchor in place. Results are labelled "Background sync: …" / "On open sync: …"; a wake
  with nothing new leaves the last result on screen.
- *Done when:* a workout finished with the app closed reaches the dashboard without opening the
  app. Test with the phone locked.

### 8. Living with the 7-day expiry
- After the build expires the app doesn't launch, and background sync stops silently. The existing
  **silence alert** (`ingestWatch.ts`, Telegram after 3 quiet days) already covers this, because
  the endpoint stamps `ingest.lastPush.workouts`.
- Write the reinstall routine in `ios/README.md` (plug in, Run, done).
- *Done when:* the routine is written down and has been done once.

## After the MVP: one app, not two

### 9. App icon — written 2026-11-26
- Same W and blue family as the web app's icon, on a deeper gradient, with a sync badge, so the
  home-screen bookmark and the app are told apart at a glance.
  `scripts/dev/make-ios-icon.py` draws it into `ios/WorkoutSync/Assets.xcassets`.

### 10. The dashboard inside the app — written 2026-11-26
- The app opens on `/api/dashboard` in a web view. The native screen (sync status, Sync now,
  settings, the HealthKit list) is a sheet over it.
- **Key:** the app writes its Keychain key into the page's localStorage
  (`workout-tracker.apiKey`, the name every page reads) before any page script runs, on the
  configured host only, so the key gate never appears in the app.
- **Status → page:** `window.workoutSyncNative` = `{ lastSuccess, lastResult, syncing, failed }`
  plus a `workout-sync-native` event on change. The dashboard header shows a **Phone sync** chip
  (green; amber when failed or older than 3 days) only when that bridge exists, so a browser or the
  PWA never sees it. Tapping it posts `{ action: "openSync" }` to the `workoutSync` handler.
- Links to other hosts open in Safari. Pull to refresh reloads the page and syncs. The web view
  can be inspected from Safari → Develop on the Mac.
- Until a server and key are set, the native screen is the whole app.
- Open: the other pages (Strength, Recovery…) get the key and work in the app, but the chip is
  on the dashboard only.
- *Done when:* the app opens on the dashboard without asking for a key, the chip shows the last
  sync, and tapping it opens the native screen.

## Later (not MVP — pick by need)

- **Source label.** The endpoint stamps pushes and notifications as "Health Auto Export". Let the
  app identify itself (e.g. an `x-client` header) so the silence alert and logs say "iPhone app".
  This is a small backend change.
- **Body weight.** `HKQuantityType(.bodyMass)` → the `data.metrics` weight the endpoint already reads.
- **HR series and zones — done (2026-11-26).** `WorkoutPayload.heartRateSamples` queries the
  readings inside each workout's window from any device and sends them as `heartRateData`
  (`{ date, qty }`); the backend builds the histogram and series, and summarises the stream
  when the workout has no statistics. That last part is what Polar-recorded BJJ needs: its
  sessions arrive with no statistics, and until this shipped they were stored with no heart
  rate at all and scored by duration. Chunks dropped from 50 to 5 workouts for the payload size.
  After installing the build, *Reset* re-sends the last 30 days and fills the gaps in.
- **Recovery.** Sleep stages, resting HR, HRV, steps → the recovery fields. This also settles
  the open question about HAE `sleep_analysis` field names, because we would control the shape.
- **Routes.** `HKWorkoutRoute` → GPX → `routes`.
- **Compile check in CI.** A macOS runner job that builds unsigned (`CODE_SIGNING_ALLOWED=NO`)
  on pushes touching `ios/`. It works on the free account and catches breakage without the Mac.
- **Paid account ($99/yr) → TestFlight.** CI builds and signs with an App Store Connect API key
  and uploads to TestFlight; internal testers need no App Store review. Builds last 90 days, so
  add a scheduled monthly rebuild. One-time setup: join the program, register the app ID with
  HealthKit, create the app record (never published), store the API key as a repo secret.
- **Last push from the server's side.** The chip shows what the phone knows. The server also
  knows (`ingest.lastPush.workouts`) and could show it on every page and in the PWA.
- **Notifications in the app.** Read `/api/notifications` natively, or push via APNs (paid account only).
