import Foundation
import HealthKit

/// One workout as the screen shows it. Read-only: nothing is sent yet.
struct WorkoutRow: Identifiable {
    let id: UUID
    let name: String
    let exportName: String
    let start: Date
    let duration: TimeInterval
    let averageHeartRate: Double?
    let source: String
    /// Exactly what would be posted for this workout (item 4); nothing is sent yet.
    let payload: String

    init(_ workout: HKWorkout) {
        id = workout.uuid
        name = ActivityName.display(workout.workoutActivityType)
        exportName = ActivityName.export(workout.workoutActivityType)
        start = workout.startDate
        duration = workout.duration
        let bpm = HKUnit.count().unitDivided(by: .minute())
        averageHeartRate = workout.statistics(for: HKQuantityType(.heartRate))?
            .averageQuantity()?.doubleValue(for: bpm)
        source = workout.sourceRevision.source.name
        payload = WorkoutPayload.preview(workout)
    }
}

@MainActor
final class HealthStore: ObservableObject {
    @Published private(set) var workouts: [WorkoutRow] = []
    @Published private(set) var message: String?
    @Published private(set) var loading = false

    private let store = HKHealthStore()

    private var readTypes: Set<HKObjectType> {
        [
            HKObjectType.workoutType(),
            HKQuantityType(.heartRate),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.basalEnergyBurned),
            HKQuantityType(.distanceWheelchair),
            HKQuantityType(.distanceDownhillSnowSports),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.distanceCycling),
            HKQuantityType(.distanceSwimming),
        ]
    }

    /// Shows the Health permission sheet the first time; afterwards it returns at once.
    /// HealthKit never says whether *read* access was granted (privacy), so a denial
    /// looks exactly like having no workouts.
    func requestAccessAndLoad() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            message = "Health data is not available on this device."
            return
        }
        loading = true
        defer { loading = false }
        do {
            try await store.requestAuthorization(toShare: [], read: readTypes)
            let query = HKSampleQueryDescriptor(
                predicates: [.workout()],
                sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)],
                limit: 10
            )
            workouts = try await query.result(for: store).map(WorkoutRow.init)
            message = workouts.isEmpty
                ? "No workouts visible. If you have some, allow access in Settings → Health → Data Access & Devices → Workout Sync."
                : nil
        } catch {
            message = error.localizedDescription
        }
    }
}
