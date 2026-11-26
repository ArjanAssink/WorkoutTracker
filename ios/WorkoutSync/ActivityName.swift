import HealthKit

/// The name Apple's export.xml uses for each activity type (`HKWorkoutActivityTypeRunning`).
///
/// The backend derives a workout's id from its activity slug, and `normaliseActivityType`
/// canonicalises these export names. Sending the identical string is what lets a workout
/// posted by this app land on the same row the export import already stored.
/// HealthKit has no API for the name, hence the table. Deprecated cases are left to the
/// fallback rather than referenced (they only produce warnings).
enum ActivityName {
    static func export(_ type: HKWorkoutActivityType) -> String {
        "HKWorkoutActivityType" + caseName(type)
    }

    /// "TraditionalStrengthTraining" → "Traditional Strength Training", for the screen only.
    static func display(_ type: HKWorkoutActivityType) -> String {
        var out = ""
        for ch in caseName(type) {
            if ch.isUppercase, !out.isEmpty { out.append(" ") }
            out.append(ch)
        }
        return out
    }

    private static func caseName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .americanFootball: return "AmericanFootball"
        case .archery: return "Archery"
        case .australianFootball: return "AustralianFootball"
        case .badminton: return "Badminton"
        case .barre: return "Barre"
        case .baseball: return "Baseball"
        case .basketball: return "Basketball"
        case .bowling: return "Bowling"
        case .boxing: return "Boxing"
        case .cardioDance: return "CardioDance"
        case .climbing: return "Climbing"
        case .cooldown: return "Cooldown"
        case .coreTraining: return "CoreTraining"
        case .cricket: return "Cricket"
        case .crossCountrySkiing: return "CrossCountrySkiing"
        case .crossTraining: return "CrossTraining"
        case .curling: return "Curling"
        case .cycling: return "Cycling"
        case .discSports: return "DiscSports"
        case .downhillSkiing: return "DownhillSkiing"
        case .elliptical: return "Elliptical"
        case .equestrianSports: return "EquestrianSports"
        case .fencing: return "Fencing"
        case .fishing: return "Fishing"
        case .fitnessGaming: return "FitnessGaming"
        case .flexibility: return "Flexibility"
        case .functionalStrengthTraining: return "FunctionalStrengthTraining"
        case .golf: return "Golf"
        case .gymnastics: return "Gymnastics"
        case .handCycling: return "HandCycling"
        case .handball: return "Handball"
        case .highIntensityIntervalTraining: return "HighIntensityIntervalTraining"
        case .hiking: return "Hiking"
        case .hockey: return "Hockey"
        case .hunting: return "Hunting"
        case .jumpRope: return "JumpRope"
        case .kickboxing: return "Kickboxing"
        case .lacrosse: return "Lacrosse"
        case .martialArts: return "MartialArts"
        case .mindAndBody: return "MindAndBody"
        case .mixedCardio: return "MixedCardio"
        case .other: return "Other"
        case .paddleSports: return "PaddleSports"
        case .pickleball: return "Pickleball"
        case .pilates: return "Pilates"
        case .play: return "Play"
        case .preparationAndRecovery: return "PreparationAndRecovery"
        case .racquetball: return "Racquetball"
        case .rowing: return "Rowing"
        case .rugby: return "Rugby"
        case .running: return "Running"
        case .sailing: return "Sailing"
        case .skatingSports: return "SkatingSports"
        case .snowSports: return "SnowSports"
        case .snowboarding: return "Snowboarding"
        case .soccer: return "Soccer"
        case .socialDance: return "SocialDance"
        case .softball: return "Softball"
        case .squash: return "Squash"
        case .stairClimbing: return "StairClimbing"
        case .stairs: return "Stairs"
        case .stepTraining: return "StepTraining"
        case .surfingSports: return "SurfingSports"
        case .swimBikeRun: return "SwimBikeRun"
        case .swimming: return "Swimming"
        case .tableTennis: return "TableTennis"
        case .taiChi: return "TaiChi"
        case .tennis: return "Tennis"
        case .trackAndField: return "TrackAndField"
        case .traditionalStrengthTraining: return "TraditionalStrengthTraining"
        case .transition: return "Transition"
        case .underwaterDiving: return "UnderwaterDiving"
        case .volleyball: return "Volleyball"
        case .walking: return "Walking"
        case .waterFitness: return "WaterFitness"
        case .waterPolo: return "WaterPolo"
        case .waterSports: return "WaterSports"
        case .wheelchairRunPace: return "WheelchairRunPace"
        case .wheelchairWalkPace: return "WheelchairWalkPace"
        case .wrestling: return "Wrestling"
        case .yoga: return "Yoga"
        default: return "Unknown\(type.rawValue)"
        }
    }
}
