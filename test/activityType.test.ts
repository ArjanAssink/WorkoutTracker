import { describe, expect, it } from "vitest";
import { displayName, metValue, normaliseActivityType, relabelActivity } from "../src/domain/activityType.js";

describe("normaliseActivityType", () => {
  it("maps Health Auto Export's long names onto the same slugs as Apple's", () => {
    expect(normaliseActivityType("Outdoor Cycling")).toBe("cycling");
    expect(normaliseActivityType("Indoor Cycling")).toBe("cycling");
    expect(normaliseActivityType("Outdoor Running")).toBe("running");
    expect(normaliseActivityType("Outdoor Walking")).toBe("walking");
  });
  it("collapses HealthKit identifiers and Shortcuts display names onto one slug", () => {
    const expected = "running";
    for (const raw of ["HKWorkoutActivityTypeRunning", "Running", "Outdoor Run", "indoor_run", "treadmill"]) {
      expect(normaliseActivityType(raw), raw).toBe(expected);
    }
  });

  it("maps the strength variants Apple distinguishes but reports separately", () => {
    expect(normaliseActivityType("HKWorkoutActivityTypeTraditionalStrengthTraining")).toBe("strength");
    expect(normaliseActivityType("HKWorkoutActivityTypeFunctionalStrengthTraining")).toBe("functionalstrength");
  });

  it("keeps an unrecognised activity distinct rather than lumping it into 'other'", () => {
    expect(normaliseActivityType("HKWorkoutActivityTypePickleball")).toBe("pickleball");
    expect(normaliseActivityType("HKWorkoutActivityTypeFencing")).toBe("fencing");
  });

  it("falls back to 'other' only for genuinely empty input", () => {
    expect(normaliseActivityType(undefined)).toBe("other");
    expect(normaliseActivityType("")).toBe("other");
    expect(normaliseActivityType("   ")).toBe("other");
  });
});

describe("activity types seen in real Apple exports", () => {
  // These turned up in a real import as bare slugs with no label and the generic MET
  // value — visible precisely because unknown types stay distinct instead of
  // collapsing into "other".
  it("names and rates the types a real export surfaced", () => {
    for (const [raw, slug, label] of [
      ["HKWorkoutActivityTypeTaiChi", "taichi", "Capoeira"],
      ["HKWorkoutActivityTypePaddleSports", "paddlesports", "Paddle Sports"],
      ["HKWorkoutActivityTypeUnderwaterDiving", "underwaterdiving", "Underwater Diving"],
    ] as const) {
      expect(normaliseActivityType(raw)).toBe(slug);
      expect(displayName(slug)).toBe(label);
      expect(metValue(slug)).not.toBe(metValue("other"));
    }
  });

  it("maps Apple's wordier identifiers onto one slug", () => {
    expect(normaliseActivityType("HKWorkoutActivityTypeMixedMetabolicCardioTraining")).toBe("mixedcardio");
    expect(normaliseActivityType("HKWorkoutActivityTypeWheelchairRunPace")).toBe("wheelchair");
    expect(normaliseActivityType("HKWorkoutActivityTypeWheelchairWalkPace")).toBe("wheelchair");
    expect(normaliseActivityType("HKWorkoutActivityTypeEquestrianSports")).toBe("equestrian");
  });

  it("still keeps 'Other' as a real category — Apple uses it for unclassified workouts", () => {
    expect(normaliseActivityType("HKWorkoutActivityTypeOther")).toBe("other");
    expect(displayName("other")).toBe("Other");
  });

  it("gives every named activity a display name that is not just its slug", () => {
    for (const slug of ["taichi", "paddlesports", "barre", "tabletennis", "crosstraining"]) {
      expect(displayName(slug), slug).not.toBe(slug);
    }
  });
});

describe("personal activity overrides", () => {
  // Apple Watch has no Capoeira or BJJ type, so these are logged as the nearest thing
  // it offers. The override corrects the label and the exertion, not the slug.
  it("relabels what Apple recorded as the activity actually done", () => {
    expect(displayName("taichi")).toBe("Capoeira");
    expect(displayName("martialarts")).toBe("BJJ");
  });

  it("leaves the slug alone, because workout ids are derived from it", () => {
    expect(normaliseActivityType("HKWorkoutActivityTypeTaiChi")).toBe("taichi");
    expect(normaliseActivityType("HKWorkoutActivityTypeMartialArts")).toBe("martialarts");
  });

  it("rates Capoeira as the vigorous activity it is, not as Tai Chi", () => {
    expect(metValue("taichi")).toBeGreaterThan(8);
    expect(metValue("taichi")).toBeGreaterThan(metValue("yoga"));
  });

  it("does not disturb activities it has no opinion about", () => {
    expect(displayName("running")).toBe("Running");
    expect(metValue("running")).toBe(9.8);
  });
});

describe("metValue", () => {
  it("rates running above walking", () => {
    expect(metValue("running")).toBeGreaterThan(metValue("walking"));
  });

  it("falls back to the generic rate for an unknown activity", () => {
    expect(metValue("pickleball")).toBe(metValue("other"));
  });
});

describe("displayName", () => {
  it("returns the slug itself when there is no friendly name", () => {
    expect(displayName("running")).toBe("Running");
    expect(displayName("pickleball")).toBe("pickleball");
  });
});

describe("relabelActivity — personal parse-time rules", () => {
  it("files a long Strava 'Other' session as BJJ", () => {
    expect(relabelActivity("other", { sourceName: "Strava", durationSeconds: 105 * 60 })).toBe("martialarts");
  });
  it("leaves a short Strava 'Other' alone — that is not a class", () => {
    expect(relabelActivity("other", { sourceName: "Strava", durationSeconds: 25 * 60 })).toBe("other");
  });
  it("leaves 'Other' from any other source alone", () => {
    expect(relabelActivity("other", { sourceName: "Health", durationSeconds: 105 * 60 })).toBe("other");
    expect(relabelActivity("other", { durationSeconds: 105 * 60 })).toBe("other");
  });
  it("files Wrestling as BJJ regardless of source", () => {
    expect(relabelActivity("wrestling", { sourceName: "Health", durationSeconds: 90 * 60 })).toBe("martialarts");
  });
  it("touches nothing else", () => {
    expect(relabelActivity("running", { sourceName: "Strava", durationSeconds: 120 * 60 })).toBe("running");
  });
});

describe("BJJ effort calibration", () => {
  it("rates a BJJ class from measured sessions, not the compendium's vigorous figure", () => {
    // 57 chest-strap classes scored a median 0.69 TRIMP/min; met × 0.12 must land near that.
    expect(metValue("martialarts") * 0.12).toBeCloseTo(0.69, 1);
    expect(metValue("martialarts")).toBeLessThan(8);
  });
});
