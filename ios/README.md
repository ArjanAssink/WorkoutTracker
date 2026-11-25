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

Re-run `xcodegen` after pulling changes to `project.yml` or adding files; the
`.xcodeproj` is generated and gitignored.

## Every 7 days (free account)

The free signing profile expires after 7 days and the app stops launching. Plug the phone
in (or same Wi-Fi), open the project, press Run. Data already synced is unaffected.
