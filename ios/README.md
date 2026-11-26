# Workout Sync (iOS)

Native HealthKit → backend sync. Plan and decisions: `../docs/ios-backlog.md`.

## First run (free Apple ID, your Mac)

```bash
cd ios
cp Local.xcconfig.example Local.xcconfig   # then edit: team ID + bundle prefix
xcodegen
open WorkoutSync.xcodeproj
```

In Xcode pick your iPhone as the run destination and press Run (⌘R). The first install
needs the phone to trust the certificate: Settings → General → VPN & Device Management →
your Apple ID → Trust.

**After every `git pull`:** close the project in Xcode, run `xcodegen`, reopen. The
`.xcodeproj` is generated and gitignored and only lists the files that existed when it was
generated — a new Swift file shows up as "Cannot find 'X' in scope" until you regenerate.

The console fills with iOS system noise (`Client not entitled`, `cannot add handler`…);
ignore it. "Debug session ended with code 9: killed" means the app was stopped from outside
(swiped away, re-run, Health permission changed), not that it crashed.

## Every 7 days (free account)

The free signing profile expires after 7 days and the app stops launching. Plug the phone
in (or same Wi-Fi), open the project, press Run. Data already synced is unaffected.
