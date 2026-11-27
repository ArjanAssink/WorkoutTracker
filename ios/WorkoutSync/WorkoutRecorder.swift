import Foundation
import HealthKit
import UIKit

/// The activities the record screen offers, and the Apple type each is saved as. Apple has
/// no BJJ or Capoeira type: they are saved as Martial Arts and Tai Chi, exactly as the watch
/// records them, so the backend's relabels (`PERSONAL_OVERRIDES`) and derived ids treat an
/// app-recorded class like any other.
enum RecordedActivity: String, CaseIterable, Codable, Identifiable {
    case bjj, capoeira, strength, other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .bjj: return "BJJ"
        case .capoeira: return "Capoeira"
        case .strength: return "Strength training"
        case .other: return "Other"
        }
    }

    var healthType: HKWorkoutActivityType {
        switch self {
        case .bjj: return .martialArts
        case .capoeira: return .taiChi
        case .strength: return .traditionalStrengthTraining
        case .other: return .other
        }
    }
}

/// One session in progress (or ended, awaiting Save). Written to disk as it grows, so a
/// crash, an eviction or a dead phone battery loses at most the last few seconds.
struct Recording: Codable {
    var activity: RecordedActivity
    /// Whole seconds: the backend derives the workout's id from the start, and the export
    /// writes whole seconds, so both paths must see the same instant.
    var start: Date
    var end: Date?
    /// Seconds after `start`, one per reading, with `bpm` alongside.
    var offsets: [Double] = []
    var bpm: [Int] = []
    var strap: StrapInfo?
    var lastWrite: Date?

    var count: Int { bpm.count }
    var average: Double? { bpm.isEmpty ? nil : Double(bpm.reduce(0, +)) / Double(bpm.count) }
    var maximum: Int? { bpm.max() }
    var lastSample: Date? { offsets.last.map { start.addingTimeInterval($0) } }

    func duration(at now: Date = Date()) -> TimeInterval { (end ?? now).timeIntervalSince(start) }

    /// Share of the session's seconds that have a reading, for a strap reading once a second;
    /// shows how much a dropout cost.
    var coverage: Double? {
        let seconds = duration()
        guard seconds >= 1 else { return nil }
        return min(1, Double(count) / seconds)
    }
}

/// Records a workout on the phone from a Bluetooth strap and saves it to Health — a workout
/// with its heart-rate samples attached, by `HKWorkoutBuilder` — instead of Polar Flow,
/// whose Health sync leaves the heart rate off the workout. The normal sync then sends it
/// to the backend like any other workout.
@MainActor
final class WorkoutRecorder: ObservableObject {
    enum Phase { case idle, recording, review, saving }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var recording: Recording?
    @Published var activity: RecordedActivity {
        didSet { UserDefaults.standard.set(activity.rawValue, forKey: Self.activityKey) }
    }
    @Published var screenShown = false
    @Published private(set) var message: String?
    /// False when Health refused write access; the screen says how to fix it.
    @Published private(set) var canWriteHealth = true

    let monitor: HeartRateMonitor
    private let sync: SyncEngine
    private let store = HKHealthStore()
    private var unsaved = 0
    private var backgroundWatch: NSObjectProtocol?

    private static let activityKey = "recordActivity"
    /// Reopened within this long after the last write, an unfinished recording carries on;
    /// later, it ends at its last reading and waits for Save.
    private static let resumeWindow: TimeInterval = 30 * 60

    private static var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("recording.json")
    }

    init(monitor: HeartRateMonitor, sync: SyncEngine) {
        self.monitor = monitor
        self.sync = sync
        activity = UserDefaults.standard.string(forKey: Self.activityKey).flatMap(RecordedActivity.init) ?? .bjj
        monitor.onReading = { [weak self] date, bpm in self?.add(date, bpm) }
        restore()
        if phase == .recording { monitor.activate() }
        // Locking the phone is the usual way a session continues; write before iOS may evict.
        backgroundWatch = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.persist() }
        }
    }

    var isBusy: Bool { phase != .idle }

    // MARK: actions

    func open() {
        monitor.activate()
        screenShown = true
        Task { await requestWriteAccess() }
    }

    /// Closing the screen while idle lets go of the strap.
    func close() {
        screenShown = false
        if phase == .idle { monitor.deactivate() }
    }

    func start() {
        guard phase == .idle else { return }
        message = nil
        recording = Recording(activity: activity, start: Self.wholeSecond(Date()), strap: monitor.strap)
        phase = .recording
        persist()
    }

    func end() {
        guard phase == .recording, var rec = recording else { return }
        rec.end = Self.wholeSecond(Date())
        recording = rec
        phase = .review
        persist()
    }

    /// An End tapped by mistake: carry on, the gap included.
    func resume() {
        guard phase == .review, var rec = recording else { return }
        rec.end = nil
        recording = rec
        phase = .recording
        persist()
    }

    func setActivity(_ a: RecordedActivity) {
        activity = a
        recording?.activity = a
        persist()
    }

    func discard() {
        try? FileManager.default.removeItem(at: Self.file)
        recording = nil
        phase = .idle
        message = "Discarded"
    }

    func save() async {
        guard phase == .review, var rec = recording, let end = rec.end else { return }
        if rec.strap == nil { rec.strap = monitor.strap }
        phase = .saving
        message = nil
        do {
            await requestWriteAccess()
            let workout = try await Self.write(rec, end: end, store: store)
            try? FileManager.default.removeItem(at: Self.file)
            recording = nil
            phase = .idle
            let minutes = Int((workout.duration / 60).rounded())
            message = "Saved to Health: \(rec.activity.label), \(minutes) min, \(rec.count) heart-rate readings"
            // The observer would also pick it up; asking now shows the result on this screen.
            Task { await sync.sync(trigger: "Recorded") }
        } catch {
            phase = .review
            message = "Could not save to Health: \(error.localizedDescription). The recording is kept; try again."
        }
    }

    // MARK: recording

    private func add(_ date: Date, _ bpm: Int) {
        guard phase == .recording, var rec = recording else { return }
        if rec.strap == nil { rec.strap = monitor.strap }
        let offset = date.timeIntervalSince(rec.start)
        guard offset >= 0 else { return }
        rec.offsets.append(offset)
        rec.bpm.append(bpm)
        recording = rec
        unsaved += 1
        if unsaved >= 15 { persist() }
    }

    private func persist() {
        unsaved = 0
        guard var rec = recording else { return }
        rec.lastWrite = Date()
        recording = rec
        do {
            let data = try JSONEncoder().encode(rec)
            // Writable while the phone is locked (after the first unlock since boot), which is
            // when nearly all of a session is written.
            try data.write(to: Self.file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            message = "Could not write the recording to disk: \(error.localizedDescription)"
        }
    }

    private func restore() {
        guard let data = try? Data(contentsOf: Self.file),
              var rec = try? JSONDecoder().decode(Recording.self, from: data) else { return }
        if rec.end == nil {
            let last = rec.lastWrite ?? rec.lastSample ?? rec.start
            if Date().timeIntervalSince(last) < Self.resumeWindow {
                recording = rec
                phase = .recording
                return
            }
            rec.end = Self.wholeSecond(max(rec.lastSample ?? rec.start, rec.start.addingTimeInterval(1)))
            message = "This recording was interrupted; it ends at its last heart-rate reading."
        }
        recording = rec
        activity = rec.activity
        phase = .review
        persist()
    }

    private func requestWriteAccess() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            canWriteHealth = false
            return
        }
        let share: Set<HKSampleType> = [HKObjectType.workoutType(), HKQuantityType(.heartRate)]
        try? await store.requestAuthorization(toShare: share, read: HealthRecords.readTypes)
        // Unlike read access, write access is visible to the app.
        canWriteHealth = share.allSatisfy { store.authorizationStatus(for: $0) == .sharingAuthorized }
    }

    private static func wholeSecond(_ date: Date) -> Date {
        Date(timeIntervalSince1970: date.timeIntervalSince1970.rounded(.down))
    }

    // MARK: Health

    private struct SaveError: LocalizedError {
        let errorDescription: String?
    }

    /// A workout with its readings attached as heart-rate samples, so Health — and the
    /// export, and the sync — carry heart-rate statistics on the workout itself.
    private static func write(_ rec: Recording, end: Date, store: HKHealthStore) async throws -> HKWorkout {
        let config = HKWorkoutConfiguration()
        config.activityType = rec.activity.healthType
        config.locationType = .indoor
        let device = rec.strap.map {
            HKDevice(name: $0.name, manufacturer: $0.manufacturer, model: $0.model,
                     hardwareVersion: $0.hardware, firmwareVersion: $0.firmware, softwareVersion: nil,
                     localIdentifier: $0.identifier, udiDeviceIdentifier: nil)
        }
        let builder = HKWorkoutBuilder(healthStore: store, configuration: config, device: device)
        do {
            try await step { builder.beginCollection(withStart: rec.start, completion: $0) }

            let type = HKQuantityType(.heartRate)
            let unit = HKUnit.count().unitDivided(by: .minute())
            var samples: [HKSample] = []
            for (offset, bpm) in zip(rec.offsets, rec.bpm) {
                let at = rec.start.addingTimeInterval(offset)
                guard at <= end else { continue }
                samples.append(HKQuantitySample(type: type, quantity: HKQuantity(unit: unit, doubleValue: Double(bpm)),
                                                start: at, end: at, device: device, metadata: nil))
            }
            for i in stride(from: 0, to: samples.count, by: 500) {
                let chunk = Array(samples[i..<min(i + 500, samples.count)])
                try await step { builder.add(chunk, completion: $0) }
            }
            try await step { builder.addMetadata([HKMetadataKeyIndoorWorkout: true], completion: $0) }
            try await step { builder.endCollection(withEnd: end, completion: $0) }
            return try await withCheckedThrowingContinuation { (c: CheckedContinuation<HKWorkout, Error>) in
                builder.finishWorkout { workout, error in
                    if let workout { c.resume(returning: workout) }
                    else { c.resume(throwing: error ?? SaveError(errorDescription: "Health returned no workout")) }
                }
            }
        } catch {
            builder.discardWorkout()
            throw error
        }
    }

    private static func step(_ body: (@escaping (Bool, Error?) -> Void) -> Void) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            body { ok, error in
                if ok { c.resume() } else { c.resume(throwing: error ?? SaveError(errorDescription: "Health refused the workout")) }
            }
        }
    }
}
