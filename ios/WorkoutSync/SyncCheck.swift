import Foundation
import HealthKit
import SwiftUI

/// Compares the phone's last 30 days of workouts with what the server stored, using the
/// server's own rules (`POST /api/sync/check`, read-only). Each workout comes back stored,
/// merged (the same session kept under another recording), missing, or rejected; stored rows
/// the phone does not account for are listed as server-only.
@MainActor
final class SyncCheck: ObservableObject {
    struct Row: Identifiable {
        let id = UUID()
        let name: String
        let start: Date
        let duration: TimeInterval
        let source: String
        let status: String
        let detail: String?
        let workout: HKWorkout
    }

    struct ServerOnly: Identifiable {
        let id: String
        let name: String
        let start: String
        let duration: Int
        let source: String
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var serverOnly: [ServerOnly] = []
    @Published private(set) var checking = false
    @Published private(set) var sending = false
    @Published private(set) var message: String?
    @Published private(set) var checkedAt: Date?

    private let store = HKHealthStore()
    private let settings: AppSettings

    init(settings: AppSettings) { self.settings = settings }

    var missing: [Row] { rows.filter { $0.status == "missing" } }

    func run() async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        do {
            let since = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
            let query = HKSampleQueryDescriptor(
                predicates: [.workout(HKQuery.predicateForSamples(withStart: since, end: nil))],
                sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)]
            )
            let workouts = try await query.result(for: store)
            guard var request = settings.request(path: "api/sync/check", method: "POST") else {
                message = "Set the server and API key first"
                return
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try WorkoutPayload.body(workouts)
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                message = "Server answered \(status)\(status == 404 ? " (the check isn't deployed yet)" : "")"
                return
            }
            let reply = try JSONDecoder().decode(Reply.self, from: data)
            rows = reply.rows.compactMap { r in
                guard r.index >= 0, r.index < workouts.count else { return nil }
                let w = workouts[r.index]
                let detail: String?
                switch r.status {
                case "merged": detail = "Kept the \(r.matchedSource ?? "other") recording of this session"
                case "stored": detail = r.matchedSource.map { "Stored via \($0)" }
                case "rejected": detail = r.reason
                default: detail = "Not on the server"
                }
                return Row(name: ActivityName.display(w.workoutActivityType), start: w.startDate, duration: w.duration,
                           source: w.sourceRevision.source.name, status: r.status, detail: detail, workout: w)
            }
            serverOnly = reply.serverOnly.map {
                ServerOnly(id: $0.id, name: $0.name, start: $0.startedAt, duration: $0.durationSeconds, source: $0.source)
            }
            let c = reply.counts
            message = "\(c.sent) on the phone: \(c.stored) stored, \(c.merged) merged, \(c.missing) missing"
                + (c.rejected > 0 ? ", \(c.rejected) rejected" : "")
            checkedAt = Date()
        } catch {
            message = error.localizedDescription
        }
    }

    /// Posts the missing ones through the normal ingest path, then checks again.
    func sendMissing() async {
        let workouts = missing.map(\.workout)
        guard !workouts.isEmpty, var request = settings.request(path: "api/ingest/health-auto-export", method: "POST") else { return }
        sending = true
        defer { sending = false }
        do {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try WorkoutPayload.body(workouts)
            let (_, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                message = "Sending failed: server answered \(status)"
                return
            }
        } catch {
            message = "Sending failed: \(error.localizedDescription)"
            return
        }
        sending = false
        await run()
    }

    private struct Reply: Decodable {
        struct Counts: Decodable { let sent, stored, merged, missing, rejected: Int }
        struct R: Decodable {
            let index: Int
            let status: String
            let matchedSource: String?
            let reason: String?
        }
        struct S: Decodable {
            let id, name, startedAt, source: String
            let durationSeconds: Int
        }
        let counts: Counts
        let rows: [R]
        let serverOnly: [S]
    }
}

struct SyncCheckView: View {
    @StateObject private var check: SyncCheck

    init(settings: AppSettings) {
        _check = StateObject(wrappedValue: SyncCheck(settings: settings))
    }

    var body: some View {
        List {
            Section {
                if let message = check.message { Text(message) }
                if let at = check.checkedAt {
                    Text("Checked \(at.formatted(date: .omitted, time: .shortened))")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !check.missing.isEmpty {
                    Button {
                        Task { await check.sendMissing() }
                    } label: {
                        HStack {
                            Text("Send the \(check.missing.count) missing")
                            Spacer()
                            if check.sending { ProgressView() }
                        }
                    }
                    .disabled(check.sending || check.checking)
                }
            } footer: {
                Text("Last 30 days of workouts in Health, against what the server stored. Checking writes nothing.")
            }

            Section("On the phone") {
                ForEach(check.rows) { row in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: icon(row.status))
                            .foregroundStyle(color(row.status))
                            .frame(width: 22)
                            .accessibilityLabel(row.status)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(row.name).font(.headline)
                                Spacer()
                                Text(Self.duration(row.duration)).monospacedDigit().foregroundStyle(.secondary)
                            }
                            Text("\(row.start.formatted(date: .abbreviated, time: .shortened)) · \(row.source)")
                                .font(.subheadline).foregroundStyle(.secondary)
                            if let detail = row.detail {
                                Text(detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if !check.serverOnly.isEmpty {
                Section {
                    ForEach(check.serverOnly) { s in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.name).font(.headline)
                            Text("\(Self.date(s.start)) · \(Self.duration(TimeInterval(s.duration))) · \(s.source)")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Only on the server")
                } footer: {
                    Text("Stored workouts in the same period that no workout on this phone accounts for: manual entries, the Strava archive, or workouts since deleted from Health.")
                }
            }
        }
        .navigationTitle("Sync check")
        .overlay { if check.checking && check.rows.isEmpty { ProgressView() } }
        .refreshable { await check.run() }
        .task { await check.run() }
    }

    private func icon(_ status: String) -> String {
        switch status {
        case "stored": return "checkmark.circle.fill"
        case "merged": return "arrow.triangle.merge"
        case "missing": return "xmark.circle.fill"
        default: return "exclamationmark.triangle.fill"
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "stored", "merged": return .green
        case "missing": return .red
        default: return .orange
        }
    }

    private static func duration(_ seconds: TimeInterval) -> String {
        let f = DateComponentsFormatter()
        f.allowedUnits = [.hour, .minute]
        f.unitsStyle = .abbreviated
        return f.string(from: seconds) ?? ""
    }

    private static func date(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter.withFractions.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return d.formatted(date: .abbreviated, time: .shortened)
    }
}

private extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
