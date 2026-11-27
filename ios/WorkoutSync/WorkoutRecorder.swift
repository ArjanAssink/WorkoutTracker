import Foundation
import HealthKit
import UIKit
import UserNotifications

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

    /// Armed for a set start time that hasn't come yet: the strap is live, the clock isn't.
    func waiting(at now: Date = Date()) -> Bool { end == nil && start > now }

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
    /// "Training starts at": on, the recording begins at `startTime` rather than at Start, so
    /// the strap can go on while changing and the minutes before class don't count.
    @Published var startLater = UserDefaults.standard.bool(forKey: "recordStartLater") {
        didSet { UserDefaults.standard.set(startLater, forKey: "recordStartLater") }
    }
    @Published var startTime = WorkoutRecorder.nextHalfHour()

    let monitor: HeartRateMonitor
    private let sync: SyncEngine
    private let store = HKHealthStore()
    private var unsaved = 0
    private var backgroundWatch: NSObjectProtocol?
    private var goneAlertScheduled = false

    private static let activityKey = "recordActivity"
    /// Reopened within this long after the last write, an unfinished recording carries on;
    /// later, it ends at its last reading and waits for Save.
    private static let resumeWindow: TimeInterval = 30 * 60
    /// No reading for this long while recording means the strap was switched off (or left
    /// behind): the workout ends at its last reading. Shorter gaps are dropouts and carry on.
    static let strapGoneLimit: TimeInterval = 10 * 60
    private static let goneAlertID = "strap-gone"
    private static let startAlertID = "recording-started"

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
        monitor.onConnectionChange = { [weak self] connected in self?.strapConnection(connected) }
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
        // A fresh guess each time: the next :00 or :30 (19:40 → 20:00).
        if phase == .idle { startTime = Self.nextHalfHour() }
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
        let now = Self.wholeSecond(Date())
        let begin = startLater ? max(Self.wholeSecond(Self.today(at: startTime)), now) : now
        recording = Recording(activity: activity, start: begin, strap: monitor.strap)
        phase = .recording
        persist()
        requestNotifications()
        if begin > now { notifyStart(at: begin) }
    }

    /// Class started early: the clock starts now instead of at the set time.
    func startNow() {
        guard phase == .recording, var rec = recording, rec.waiting() else { return }
        rec.start = Self.wholeSecond(Date())
        recording = rec
        cancelAlert(Self.startAlertID)
        persist()
    }

    func end() {
        end(at: Self.wholeSecond(Date()))
    }

    private func end(at date: Date) {
        guard phase == .recording, var rec = recording else { return }
        rec.end = max(date, rec.start.addingTimeInterval(1))
        recording = rec
        phase = .review
        cancelAlert(Self.goneAlertID)
        cancelAlert(Self.startAlertID)
        goneAlertScheduled = false
        persist()
    }

    /// Run when the app comes to the front. A strap that has been silent for
    /// `strapGoneLimit` was switched off at the end of class: end at its last reading, so
    /// turning the strap off is all it takes, and the phone only has to be opened to Save.
    func checkStrapGone(now: Date = Date()) {
        guard phase == .recording, let rec = recording, !rec.waiting(at: now) else { return }
        if case .connected = monitor.status, let seen = monitor.lastReading,
           now.timeIntervalSince(seen) < Self.strapGoneLimit { return }
        let last = rec.lastSample ?? rec.start
        guard now.timeIntervalSince(last) >= Self.strapGoneLimit else { return }
        end(at: Self.wholeSecond(last))
        message = "The strap went quiet at \(last.formatted(date: .omitted, time: .shortened)); the workout ends there. Resume if that was a dropout."
        screenShown = true
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
        cancelAlert(Self.goneAlertID)
        cancelAlert(Self.startAlertID)
        goneAlertScheduled = false
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
        if goneAlertScheduled {
            cancelAlert(Self.goneAlertID)
            goneAlertScheduled = false
        }
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
            let last = max(rec.lastWrite ?? rec.lastSample ?? rec.start, rec.start)
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

    // MARK: notifications

    /// The strap dropped while recording: if it stays away for the limit, say so on the lock
    /// screen. A reading in the meantime withdraws it.
    private func strapConnection(_ connected: Bool) {
        guard phase == .recording, let rec = recording, !rec.waiting() else { return }
        if connected { return }
        guard !goneAlertScheduled else { return }
        goneAlertScheduled = true
        let content = UNMutableNotificationContent()
        content.title = "\(rec.activity.label): strap disconnected"
        content.body = "No heart rate for \(Int(Self.strapGoneLimit / 60)) minutes. Open the app to save the workout; it ends at the last reading."
        content.sound = .default
        schedule(Self.goneAlertID, content, after: Self.strapGoneLimit)
    }

    private func notifyStart(at date: Date) {
        let content = UNMutableNotificationContent()
        content.title = "\(activity.label) recording started"
        content.body = "Recording since \(date.formatted(date: .omitted, time: .shortened)). Switch the strap off when you're done."
        schedule(Self.startAlertID, content, after: date.timeIntervalSinceNow)
    }

    private func schedule(_ id: String, _ content: UNNotificationContent, after seconds: TimeInterval) {
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, seconds), repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    private func cancelAlert(_ id: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }

    private func requestNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// The next :00 or :30 at least five minutes away — 19:40 gives 20:00.
    static func nextHalfHour(after now: Date = Date()) -> Date {
        let cal = Calendar.current
        let soon = now.addingTimeInterval(5 * 60)
        guard let hour = cal.dateInterval(of: .hour, for: soon)?.start else { return soon }
        let minute = cal.component(.minute, from: soon)
        let second = cal.component(.second, from: soon)
        let step = (minute == 0 && second == 0) ? 0 : (minute < 30 || (minute == 30 && second == 0) ? 30 : 60)
        return hour.addingTimeInterval(TimeInterval(step * 60))
    }

    /// The picker shows a clock time; this pins it to today.
    private static func today(at time: Date) -> Date {
        let cal = Calendar.current
        let hm = cal.dateComponents([.hour, .minute], from: time)
        return cal.date(bySettingHour: hm.hour ?? 0, minute: hm.minute ?? 0, second: 0, of: Date()) ?? time
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
