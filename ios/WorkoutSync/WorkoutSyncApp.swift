import SwiftUI

@main
struct WorkoutSyncApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var sync: SyncEngine
    @StateObject private var bridge: WebBridge
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let settings = AppSettings()
        let engine = SyncEngine(settings: settings)
        // At every launch — iOS launches the app in the background for HealthKit delivery,
        // and the observer has to be registered again each time for that to keep working.
        engine.startObserving()
        _settings = StateObject(wrappedValue: settings)
        _sync = StateObject(wrappedValue: engine)
        _bridge = StateObject(wrappedValue: WebBridge(settings: settings, sync: engine))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(sync)
                .environmentObject(bridge)
        }
        .onChange(of: scenePhase) { _, phase in
            // Catches up on anything a locked-phone background wake could not read.
            if phase == .active { Task { await sync.sync(trigger: "On open") } }
        }
    }
}
