import SwiftUI

@main
struct WorkoutSyncApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var sync: SyncEngine

    init() {
        let settings = AppSettings()
        _settings = StateObject(wrappedValue: settings)
        _sync = StateObject(wrappedValue: SyncEngine(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(sync)
        }
    }
}
