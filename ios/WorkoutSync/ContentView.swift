import SwiftUI

/// Health permission and the last 10 workouts, read-only. Tap one for the JSON it would send.
struct ContentView: View {
    @StateObject private var health = HealthStore()
    @StateObject private var settings = Settings()
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                if !settings.isConfigured {
                    Section {
                        Button("Set the server and API key") { showingSettings = true }
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
    ContentView()
}
