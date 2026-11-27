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

## Recording a workout (heart-rate strap)

Heart button over the dashboard → pick the activity → the strap connects (first time: tap it in
the list; Polar OH1: press its button until the light blinks) → Start. Lock the phone and put it
away. Afterwards: End → Save to Health. Don't also record the session in Polar Flow, or the
same class arrives twice (the backend's dedupe would merge them, but it's cleaner not to).
For a class that starts later than you put the strap on, turn on "Training starts later" and set
the time: the clock starts then. At the end, just switch the strap off — after 10 quiet minutes a
notification says so, and opening the app ends the workout at the last reading and offers Save.
Don't swipe the app away mid-session: that stops Bluetooth in the background.
