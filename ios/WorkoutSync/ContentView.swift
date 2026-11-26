import SwiftUI

/// Backlog item 3: Health permission and the last 10 workouts, read-only.
struct ContentView: View {
    @StateObject private var health = HealthStore()

    var body: some View {
        NavigationStack {
            List {
                if let message = health.message {
                    Section { Text(message).foregroundStyle(.secondary) }
                }
                Section("Last 10 workouts") {
                    ForEach(health.workouts) { WorkoutRowView(row: $0) }
                }
                Section {
                    Text("Build \(build)").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Workout Sync")
            .toolbar {
                if health.loading { ProgressView() }
            }
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

#Preview {
    ContentView()
}
