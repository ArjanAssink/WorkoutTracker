import SwiftUI

/// The native screen: sync status and controls, settings, and the last 10 workouts from
/// HealthKit (tap one for the JSON it sends). Opened from the dashboard's phone-sync chip;
/// it is the whole app until a server and key are set.
struct SyncView: View {
    /// Set when shown as a sheet over the dashboard.
    var onDone: (() -> Void)?

    init(onDone: (() -> Void)? = nil) {
        self.onDone = onDone
    }
    @StateObject private var health = HealthStore()
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var sync: SyncEngine
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                if !settings.isConfigured {
                    Section {
                        Button("Set the server and API key") { showingSettings = true }
                    }
                }
                if settings.isConfigured {
                    Section("Sync") {
                        Button {
                            Task {
                                await sync.sync()
                                await health.requestAccessAndLoad()
                            }
                        } label: {
                            HStack {
                                Text("Sync now")
                                Spacer()
                                if sync.syncing { ProgressView() }
                            }
                        }
                        .disabled(sync.syncing)
                        if let result = sync.lastResult {
                            Text(result).foregroundStyle(.secondary)
                        }
                        NavigationLink("Check against the server") {
                            SyncCheckView(settings: settings)
                        }
                        if let when = sync.lastSuccess {
                            Text("Last successful sync \(when.formatted(.relative(presentation: .named)))")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if let message = health.message {
                    Section { Text(message).foregroundStyle(.secondary) }
                }
                Section("Last 10 workouts") {
                    ForEach(health.workouts) { row in
                        NavigationLink {
                            PayloadView(row: row)
                        } label: {
                            WorkoutRowView(row: row)
                        }
                    }
                }
                Section {
                    Text("Build \(build)").font(.footnote).foregroundStyle(.secondary)
                    if settings.isConfigured {
                        Button("Re-send the last 30 days", role: .destructive) { sync.reset() }
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("Workout Sync")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if health.loading { ProgressView() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
                if let onDone {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: onDone)
                    }
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView(settings: settings) }
            .refreshable { await health.requestAccessAndLoad() }
            .task { await health.requestAccessAndLoad() }
        }
    }

    private var build: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let number = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(number))"
    }
}

private struct WorkoutRowView: View {
    let row: WorkoutRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(row.name).font(.headline)
                Spacer()
                Text(duration).monospacedDigit()
            }
            HStack {
                Text(row.start.formatted(date: .abbreviated, time: .shortened))
                Spacer()
                if let hr = row.averageHeartRate {
                    Text("\(Int(hr.rounded())) bpm avg")
                } else {
                    Text("no HR")
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            Text(row.source).font(.caption).foregroundStyle(.tertiary)
        }
    }

    private var duration: String {
        let f = DateComponentsFormatter()
        f.allowedUnits = [.hour, .minute]
        f.unitsStyle = .abbreviated
        return f.string(from: row.duration) ?? ""
    }
}

/// The body that would be posted for one workout (backlog item 4), to check by eye.
private struct PayloadView: View {
    let row: WorkoutRow

    var body: some View {
        ScrollView {
            Text(row.payload)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .navigationTitle(row.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Copy") { UIPasteboard.general.string = row.payload }
        }
    }
}

#Preview {
    let settings = AppSettings()
    return SyncView()
        .environmentObject(settings)
        .environmentObject(SyncEngine(settings: settings))
}
