import Foundation
import HealthKit

/// Builds the body `POST /api/ingest/health-auto-export` accepts. Backlog item 4.
///
/// Identity is the point: the backend derives a workout's id from its activity slug, its
/// start and its duration rounded to the second, and the same workout arrives later from
/// export.xml. So this sends exactly what the export carries — the export's activity name,
/// the start in Apple's `yyyy-MM-dd HH:mm:ss Z` format (whole seconds, as the export writes
/// it), the duration in seconds — and the recording app's name for the relabels.
/// `test/nativeAppParity.test.ts` pins the backend half of that contract.
enum WorkoutPayload {
    private static let appleFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        return f
    }()

    private static let distanceTypes: [HKQuantityType] = [
        HKQuantityType(.distanceWalkingRunning),
        HKQuantityType(.distanceCycling),
        HKQuantityType(.distanceSwimming),
        HKQuantityType(.distanceWheelchair),
        HKQuantityType(.distanceDownhillSnowSports),
    ]

    static func workout(_ w: HKWorkout) -> [String: Any] {
        var out: [String: Any] = [
            "name": ActivityName.export(w.workoutActivityType),
            "sourceName": w.sourceRevision.source.name,
            "start": appleFormatter.string(from: w.startDate),
            "end": appleFormatter.string(from: w.endDate),
            "duration": w.duration,
        ]

        let bpm = HKUnit.count().unitDivided(by: .minute())
        if let hr = w.statistics(for: HKQuantityType(.heartRate)) {
            if let v = hr.averageQuantity()?.doubleValue(for: bpm) { out["avgHeartRate"] = v }
            if let v = hr.minimumQuantity()?.doubleValue(for: bpm) { out["minHeartRate"] = v }
            if let v = hr.maximumQuantity()?.doubleValue(for: bpm) { out["maxHeartRate"] = v }
        }

        let active = sum(w, .activeEnergyBurned, .kilocalorie())
        if let active { out["activeEnergyBurned"] = ["qty": active, "units": "kcal"] }
        // The export stores total = active + basal; send the same so both paths agree.
        if let basal = sum(w, .basalEnergyBurned, .kilocalorie()) {
            out["totalEnergyBurned"] = ["qty": (active ?? 0) + basal, "units": "kcal"]
        }

        for type in distanceTypes {
            if let metres = w.statistics(for: type)?.sumQuantity()?.doubleValue(for: .meter()), metres > 0 {
                out["distance"] = ["qty": metres, "units": "m"]
                break
            }
        }
        return out
    }

    static func appleDate(_ date: Date) -> String { appleFormatter.string(from: date) }

    /// The workout plus what the export also carries for it: the heart-rate samples (for
    /// zones and the session chart) and the GPS track. Slower; used by the real sync.
    static func enriched(_ w: HKWorkout, store: HKHealthStore) async -> [String: Any] {
        var out = workout(w)
        let hr = await HealthRecords.heartRate(during: w, store: store)
        if !hr.isEmpty { out["heartRateData"] = hr }
        let track = await HealthRecords.route(of: w, store: store)
        if track.count >= 2 { out["route"] = track }
        return out
    }

    static func body(workouts: [[String: Any]], extra: [String: Any] = [:]) throws -> Data {
        var data: [String: Any] = ["workouts": workouts]
        for (k, v) in extra { data[k] = v }
        return try JSONSerialization.data(withJSONObject: ["data": data], options: [.sortedKeys])
    }

    static func body(_ workouts: [HKWorkout]) throws -> Data {
        try JSONSerialization.data(
            withJSONObject: ["data": ["workouts": workouts.map(workout)]],
            options: [.sortedKeys]
        )
    }

    /// The single-workout JSON, indented, for the detail screen.
    static func preview(_ w: HKWorkout) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: workout(w), options: [.prettyPrinted, .sortedKeys]) else {
            return "(could not encode)"
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func sum(_ w: HKWorkout, _ id: HKQuantityTypeIdentifier, _ unit: HKUnit) -> Double? {
        w.statistics(for: HKQuantityType(id))?.sumQuantity()?.doubleValue(for: unit)
    }
}
