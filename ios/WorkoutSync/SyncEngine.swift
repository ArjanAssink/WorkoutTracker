import Foundation
import HealthKit
import UIKit

/// Sends new workouts to the backend. Backlog item 6.
///
/// An `HKAnchoredObjectQuery` returns only what was added since the saved anchor, and the
/// anchor is saved **only after every chunk got a 2xx** — a failed post is retried next time
/// rather than lost. Re-sending is harmless: ids are derived, so the backend upserts.
/// The very first run reaches back 30 days only; older history came in through the export.
@MainActor
final class SyncEngine: ObservableObject {
    @Published private(set) var syncing = false
    @Published private(set) var lastResult: String?
    @Published private(set) var lastSuccess: Date?

    private let store = HKHealthStore()
    private let settings: AppSettings
    private let defaults = UserDefaults.standard
    private static let anchorKey = "workoutAnchor"
    private static let cutoffKey = "workoutCutoff"
    private static let lastSuccessKey = "lastSuccess"
    private static let lastResultKey = "lastResult"
    private static let chunkSize = 50

    init(settings: AppSettings) {
        self.settings = settings
        lastSuccess = defaults.object(forKey: Self.lastSuccessKey) as? Date
        lastResult = defaults.string(forKey: Self.lastResultKey)
    }

    /// Backlog item 7. Registers for HealthKit background delivery: iOS wakes the app when a
    /// workout is saved — even after the app was swiped away — and runs the observer.
    /// Must be called at every launch, background launches included, before anything else.
    /// The observer also fires once right after registering, which doubles as a launch sync.
    func startObserving() {
        let type = HKObjectType.workoutType()
        let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
            Task { @MainActor in
                if let error {
                    self?.record("Background observer error: \(error.localizedDescription)")
                } else {
                    await self?.syncInBackground()
                }
                // Always call it: HealthKit backs off delivery for apps that don't.
                completion()
            }
        }
        store.execute(query)
        store.enableBackgroundDelivery(for: type, frequency: .immediate) { [weak self] ok, error in
            guard !ok else { return }
            Task { @MainActor in
                self?.record("Background delivery unavailable: \(error?.localizedDescription ?? "unknown")")
            }
        }
    }

    /// Asks iOS for extra time so a post started in the background can finish.
    private func syncInBackground() async {
        let app = UIApplication.shared
        var task: UIBackgroundTaskIdentifier = .invalid
        task = app.beginBackgroundTask(withName: "workout-sync") {
            app.endBackgroundTask(task)
            task = .invalid
        }
        let inForeground = app.applicationState == .active
        await sync(trigger: inForeground ? "On open" : "Background")
        if task != .invalid { app.endBackgroundTask(task) }
    }

    /// Returns true when everything new was delivered (or there was nothing to send).
    @discardableResult
    func sync(trigger: String? = nil) async -> Bool {
        guard !syncing else { return false }
        guard settings.isConfigured else {
            record("Set the server and API key first")
            return false
        }
        syncing = true
        defer { syncing = false }

        do {
            let query = HKAnchoredObjectQueryDescriptor(
                predicates: [.workout(HKQuery.predicateForSamples(withStart: cutoff(), end: nil))],
                anchor: loadAnchor()
            )
            let result = try await query.result(for: store)
            let workouts = result.addedSamples.sorted { $0.startDate < $1.startDate }

            var written = 0, skipped = 0, merged = 0
            for start in stride(from: 0, to: workouts.count, by: Self.chunkSize) {
                let chunk = Array(workouts[start..<min(start + Self.chunkSize, workouts.count)])
                let reply = try await post(chunk)
                written += reply.written
                skipped += reply.skipped
                merged += reply.duplicatesMerged
            }

            saveAnchor(result.newAnchor)
            let now = Date()
            lastSuccess = now
            defaults.set(now, forKey: Self.lastSuccessKey)
            let prefix = trigger.map { "\($0) sync: " } ?? ""
            if workouts.isEmpty {
                // A quiet background wake (e.g. the observer's launch call) shouldn't hide the
                // last real result.
                if trigger == nil { record("Up to date, nothing new") }
            } else {
                var text = "\(prefix)Sent \(workouts.count): \(written) written"
                if skipped > 0 { text += ", \(skipped) rejected" }
                if merged > 0 { text += ", \(merged) duplicates merged" }
                record(text + " at \(now.formatted(date: .omitted, time: .shortened))")
            }
            return true
        } catch {
            // While the phone is locked HealthKit is unreadable ("Protected health data is
            // inaccessible"); the anchor stays put, and the next unlock-time sync catches up.
            record("\(trigger.map { "\($0) sync " } ?? "")failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Forget the anchor so the next sync re-sends the last 30 days. Harmless (upserts).
    func reset() {
        defaults.removeObject(forKey: Self.anchorKey)
        defaults.removeObject(forKey: Self.cutoffKey)
        record("Reset: next sync re-sends the last 30 days")
    }

    private struct Reply: Decodable {
        var written: Int = 0
        var skipped: Int = 0
        var duplicatesMerged: Int = 0

        enum CodingKeys: String, CodingKey { case written, skipped, duplicatesMerged }
        init() {}
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            written = try c.decodeIfPresent(Int.self, forKey: .written) ?? 0
            skipped = try c.decodeIfPresent(Int.self, forKey: .skipped) ?? 0
            duplicatesMerged = try c.decodeIfPresent(Int.self, forKey: .duplicatesMerged) ?? 0
        }
    }

    private struct HTTPError: LocalizedError {
        let status: Int
        let body: String
        var errorDescription: String? { "server answered \(status) \(body.prefix(200))" }
    }

    private func post(_ workouts: [HKWorkout]) async throws -> Reply {
        guard var request = settings.request(path: "api/ingest/health-auto-export", method: "POST") else {
            throw HTTPError(status: 0, body: "bad server address")
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try WorkoutPayload.body(workouts)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw HTTPError(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return (try? JSONDecoder().decode(Reply.self, from: data)) ?? Reply()
    }

    /// Fixed on the first run, so the anchored query keeps the same predicate afterwards.
    private func cutoff() -> Date {
        if let saved = defaults.object(forKey: Self.cutoffKey) as? Date { return saved }
        let date = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
        defaults.set(date, forKey: Self.cutoffKey)
        return date
    }

    private func loadAnchor() -> HKQueryAnchor? {
        guard let data = defaults.data(forKey: Self.anchorKey) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor) {
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) {
            defaults.set(data, forKey: Self.anchorKey)
        }
    }

    private func record(_ text: String) {
        lastResult = text
        defaults.set(text, forKey: Self.lastResultKey)
    }
}
