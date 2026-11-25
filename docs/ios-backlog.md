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
- A free personal team can sign an app with the **HealthKit** capability. I believe yes.
- A free personal team can use HealthKit **background delivery**
  (`com.apple.developer.healthkit.background-delivery`). This is the uncertain one; item 7 tests it.
- Free-team limits: about 3 sideloaded apps per device and 10 new app IDs per 7 days.

## MVP

### 1. Mac and phone setup (you)
- Xcode from the App Store. Open it once and let it install its components.
- Xcode → Settings → Accounts → add your Apple ID. A "Personal Team" appears.
- `brew install xcodegen`
- iPhone: plug in, trust the Mac, then Settings → Privacy & Security → **Developer Mode** on (the phone restarts).
- *Done when:* Xcode lists the phone as a run destination.

### 2. Empty app on the phone (Claude writes it, you run it)
- `ios/project.yml`, `ios/Local.xcconfig.example`, a SwiftUI app that shows one line of text,
  `.gitignore` entries for `ios/*.xcodeproj`, `ios/Local.xcconfig`, `DerivedData`.
- You: copy `Local.xcconfig.example` → `Local.xcconfig`, fill in team ID and a bundle prefix,
  `cd ios && xcodegen && open WorkoutSync.xcodeproj`, then Run on the phone.
- First launch: Settings → General → VPN & Device Management → trust your developer certificate.
- *Done when:* the app opens on the phone. This proves signing before any HealthKit code exists.

### 3. HealthKit permission and a read-only list
- HealthKit capability and entitlement, `NSHealthShareUsageDescription`, a request for read access to
  workouts, heart rate and active energy.
- The screen lists the last 10 workouts (type, start, duration, avg HR).
- *Done when:* the list matches the Health app for those 10.

### 4. Workout → payload mapping, with an identity test
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
- *Done when:* the test passes, and one real workout posted from the app shows up as the *same*
  row the export already stored, not a second one.

### 5. Settings: base URL and API key
- Two fields, stored in the Keychain, never in the repo or `UserDefaults`.
- A "Test connection" button: `GET /api/health`, then an authenticated request that reads.
- *Done when:* a wrong key shows an error and the right key shows OK.

### 6. "Sync now"
- `HKAnchoredObjectQuery` for workouts. Save the anchor **only after a 2xx** so a failed post retries.
- First run: limit to the last 30 days so the first post isn't the whole history (the export
  already has it).
- Post in chunks (e.g. 50). Show the counts the endpoint returns, and the last sync time.
- *Done when:* finishing a workout and tapping Sync puts it on the dashboard, and a second tap
  posts nothing new.

### 7. Background sync (the actual point)
- `HKObserverQuery` on workouts plus `enableBackgroundDelivery(.immediate)`, registered at launch.
  The handler runs the same anchored sync, then calls the completion handler.
- Background delivery entitlement. **If the free team refuses it, record that here.** Then the MVP
  falls back to "open the app to sync", and the case for the paid account gets stronger.
- *Done when:* a workout finished with the app closed reaches the dashboard without opening the
  app. Test with the phone locked.

### 8. Living with the 7-day expiry
- After the build expires the app doesn't launch, and background sync stops silently. The existing
  **silence alert** (`ingestWatch.ts`, Telegram after 3 quiet days) already covers this, because
  the endpoint stamps `ingest.lastPush.workouts`.
- Write the reinstall routine in `ios/README.md` (plug in, Run, done).
- *Done when:* the routine is written down and has been done once.

## Later (not MVP — pick by need)

- **Source label.** The endpoint stamps pushes and notifications as "Health Auto Export". Let the
  app identify itself (e.g. an `x-client` header) so the silence alert and logs say "iPhone app".
  This is a small backend change.
- **Body weight.** `HKQuantityType(.bodyMass)` → the `data.metrics` weight the endpoint already reads.
- **HR series and zones.** Per-workout heart-rate samples → the `heartrate` table and the zone histogram
  (the export import does this today).
- **Recovery.** Sleep stages, resting HR, HRV, steps → the recovery fields. This also settles
  the open question about HAE `sleep_analysis` field names, because we would control the shape.
- **Routes.** `HKWorkoutRoute` → GPX → `routes`.
- **Compile check in CI.** A macOS runner job that builds unsigned (`CODE_SIGNING_ALLOWED=NO`)
  on pushes touching `ios/`. It works on the free account and catches breakage without the Mac.
- **Paid account ($99/yr) → TestFlight.** CI builds and signs with an App Store Connect API key
  and uploads to TestFlight; internal testers need no App Store review. Builds last 90 days, so
  add a scheduled monthly rebuild. One-time setup: join the program, register the app ID with
  HealthKit, create the app record (never published), store the API key as a repo secret.
- **Notifications in the app.** Read `/api/notifications` natively, or push via APNs (paid account only).
