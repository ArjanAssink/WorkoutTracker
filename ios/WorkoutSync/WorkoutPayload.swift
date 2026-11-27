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

    /// The heart-rate samples recorded during a workout, from any device. A Polar strap saves
    /// its sessions with no heart-rate statistics on the workout — the readings sit beside it
    /// as loose samples — so this is the only way their heart rate reaches the backend, which
    /// summarises the stream when statistics are missing and builds time in zone from it always.
    static func heartRateSamples(for w: HKWorkout, in store: HKHealthStore) async throws -> [HKQuantitySample] {
        let window = HKQuery.predicateForSamples(withStart: w.startDate, end: w.endDate, options: [])
        let query = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: HKQuantityType(.heartRate), predicate: window)],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        return try await query.result(for: store)
    }

    static func workout(_ w: HKWorkout, heartRate: [HKQuantitySample] = []) -> [String: Any] {
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
        if !heartRate.isEmpty {
            // The shape Health Auto Export uses for a dated series: { date, qty } per reading.
            out["heartRateData"] = heartRate.map {
                ["date": appleFormatter.string(from: $0.startDate), "qty": $0.quantity.doubleValue(for: bpm)] as [String: Any]
            }
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

    /// The workout plus what the export also carries for it: the heart-rate samples (zones,
    /// the session chart, and the summary when the recorder wrote no statistics) and the GPS
    /// track. Slower; used by the real sync. A sample query that fails costs that extra only.
    static func enriched(_ w: HKWorkout, store: HKHealthStore) async -> [String: Any] {
        let hr = (try? await heartRateSamples(for: w, in: store)) ?? []
        var out = workout(w, heartRate: hr)
        let track = await HealthRecords.route(of: w, store: store)
        if track.count >= 2 { out["route"] = track }
        return out
    }

    static func body(workouts: [[String: Any]], extra: [String: Any] = [:]) throws -> Data {
        var data: [String: Any] = ["workouts": workouts]
        for (k, v) in extra { data[k] = v }
        return try JSONSerialization.data(withJSONObject: ["data": data], options: [.sortedKeys])
    }

    /// Workouts alone, without samples — what the sync check sends.
    static func body(_ workouts: [HKWorkout]) throws -> Data {
        try JSONSerialization.data(
            withJSONObject: ["data": ["workouts": workouts.map { workout($0) }]],
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
