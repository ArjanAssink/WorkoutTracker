import CoreLocation
import Foundation
import HealthKit

/// Everything HealthKit holds that the monthly export import reads, beyond the workouts
/// themselves, in export.xml's own `<Record>` shape so the backend runs it through the
/// export's converters (`src/ingest/nativeRecords.ts`). Units are the export's.
enum HealthRecords {
    struct Quantity {
        let id: HKQuantityTypeIdentifier
        let unit: HKUnit
        let unitName: String
    }

    static var quantities: [Quantity] {
        var list: [Quantity] = [
            Quantity(id: .bodyMass, unit: .gramUnit(with: .kilo), unitName: "kg"),
            Quantity(id: .restingHeartRate, unit: .count().unitDivided(by: .minute()), unitName: "count/min"),
            Quantity(id: .heartRateVariabilitySDNN, unit: .secondUnit(with: .milli), unitName: "ms"),
            Quantity(id: .respiratoryRate, unit: .count().unitDivided(by: .minute()), unitName: "count/min"),
            Quantity(id: .oxygenSaturation, unit: .percent(), unitName: "%"),
            Quantity(id: .appleSleepingWristTemperature, unit: .degreeCelsius(), unitName: "degC"),
            Quantity(id: .timeInDaylight, unit: .minute(), unitName: "min"),
            Quantity(id: .stepCount, unit: .count(), unitName: "count"),
        ]
        if #available(iOS 18.0, *) {
            list.append(Quantity(id: .appleSleepingBreathingDisturbances, unit: .count(), unitName: "count"))
        }
        return list
    }

    /// Every type the app reads, for the permission sheet.
    static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType(.heartRate),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.basalEnergyBurned),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.distanceCycling),
            HKQuantityType(.distanceSwimming),
            HKQuantityType(.distanceWheelchair),
            HKQuantityType(.distanceDownhillSnowSports),
            HKCategoryType(.sleepAnalysis),
        ]
        for q in quantities { types.insert(HKQuantityType(q.id)) }
        return types
    }

    private static let sleepValues: [Int: String] = [
        HKCategoryValueSleepAnalysis.inBed.rawValue: "HKCategoryValueSleepAnalysisInBed",
        HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue: "HKCategoryValueSleepAnalysisAsleepUnspecified",
        HKCategoryValueSleepAnalysis.awake.rawValue: "HKCategoryValueSleepAnalysisAwake",
        HKCategoryValueSleepAnalysis.asleepCore.rawValue: "HKCategoryValueSleepAnalysisAsleepCore",
        HKCategoryValueSleepAnalysis.asleepDeep.rawValue: "HKCategoryValueSleepAnalysisAsleepDeep",
        HKCategoryValueSleepAnalysis.asleepREM.rawValue: "HKCategoryValueSleepAnalysisAsleepREM",
    ]

    /// All records since `from`, every type. A type that fails to read (not permitted,
    /// not on this iOS) is skipped rather than failing the rest.
    static func collect(since from: Date, store: HKHealthStore) async -> [[String: Any]] {
        let window = HKQuery.predicateForSamples(withStart: from, end: nil)
        var out: [[String: Any]] = []
        for q in quantities {
            let query = HKSampleQueryDescriptor(
                predicates: [.quantitySample(type: HKQuantityType(q.id), predicate: window)],
                sortDescriptors: [SortDescriptor(\.startDate)]
            )
            guard let samples = try? await query.result(for: store) else { continue }
            for s in samples {
                out.append(record(type: q.id.rawValue, sample: s, value: s.quantity.doubleValue(for: q.unit), unit: q.unitName))
            }
        }
        let sleep = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: window)],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        if let samples = try? await sleep.result(for: store) {
            for s in samples {
                guard let value = sleepValues[s.value] else { continue }
                var r = record(type: HKCategoryTypeIdentifier.sleepAnalysis.rawValue, sample: s, value: nil, unit: nil)
                r["value"] = value
                out.append(r)
            }
        }
        return out
    }

    private static func record(type: String, sample: HKSample, value: Double?, unit: String?) -> [String: Any] {
        var r: [String: Any] = [
            "type": type,
            "sourceName": sample.sourceRevision.source.name,
            "startDate": WorkoutPayload.appleDate(sample.startDate),
            "endDate": WorkoutPayload.appleDate(sample.endDate),
        ]
        if let value { r["value"] = value }
        if let unit { r["unit"] = unit }
        return r
    }

    // MARK: per-workout extras

    /// The heart-rate samples during a workout, as `heartRateData` — the server builds the
    /// zone histogram and the HR-over-session series from them, as it does from the export.
    static func heartRate(during w: HKWorkout, store: HKHealthStore) async -> [[String: Any]] {
        let query = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: HKQuantityType(.heartRate),
                                         predicate: HKQuery.predicateForSamples(withStart: w.startDate, end: w.endDate))],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        guard let samples = try? await query.result(for: store) else { return [] }
        let bpm = HKUnit.count().unitDivided(by: .minute())
        return samples.map { ["date": WorkoutPayload.appleDate($0.startDate), "qty": $0.quantity.doubleValue(for: bpm)] }
    }

    /// The workout's GPS track as `[[lat, lon], …]`, empty when it has none.
    static func route(of w: HKWorkout, store: HKHealthStore) async -> [[Double]] {
        let routes: [HKWorkoutRoute] = await withCheckedContinuation { done in
            let q = HKSampleQuery(sampleType: HKSeriesType.workoutRoute(), predicate: HKQuery.predicateForObjects(from: w),
                                  limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                done.resume(returning: (samples as? [HKWorkoutRoute]) ?? [])
            }
            store.execute(q)
        }
        var points: [[Double]] = []
        for route in routes {
            let locations: [CLLocation] = await withCheckedContinuation { done in
                var collected: [CLLocation] = []
                var finished = false
                let q = HKWorkoutRouteQuery(route: route) { _, batch, isDone, error in
                    if finished { return }
                    collected.append(contentsOf: batch ?? [])
                    if isDone || error != nil {
                        finished = true
                        done.resume(returning: collected)
                    }
                }
                store.execute(q)
            }
            let r6 = { (x: Double) in (x * 1e6).rounded() / 1e6 }
            points += locations.map { [r6($0.coordinate.latitude), r6($0.coordinate.longitude)] }
        }
        return points
    }
}
