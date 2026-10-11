import { describe, expect, it } from "vitest";
import { ConfigError, loadAthleteProfile, loadConfig, loadTableTarget } from "../src/config/index.js";
import { DEFAULT_PROFILE } from "../src/domain/effort.js";

describe("loadAthleteProfile", () => {
  it("never throws — every field has a default", () => {
    expect(loadAthleteProfile({})).toEqual(DEFAULT_PROFILE);
  });

  it("reads the athlete's own numbers", () => {
    const profile = loadAthleteProfile({ ATHLETE_RESTING_HR: "48", ATHLETE_MAX_HR: "191" });
    expect(profile.restingHeartRate).toBe(48);
    expect(profile.maxHeartRate).toBe(191);
  });

  it("rejects a non-numeric value rather than silently scoring against NaN", () => {
    expect(() => loadAthleteProfile({ ATHLETE_MAX_HR: "high" })).toThrow(ConfigError);
  });

  it("treats an empty value as absent", () => {
    expect(loadAthleteProfile({ ATHLETE_MAX_HR: "" }).maxHeartRate).toBe(DEFAULT_PROFILE.maxHeartRate);
  });
});

describe("loadTableTarget", () => {
  it("needs a storage connection and nothing else", () => {
    const target = loadTableTarget({ AzureWebJobsStorage: "UseDevelopmentStorage=true" });
    expect(target).toEqual({
      storageConnectionString: "UseDevelopmentStorage=true",
      tableName: "workouts",
      userId: "me",
    });
  });

  it("does not require an API key — the import CLI has no HTTP surface", () => {
    expect(() => loadTableTarget({ AzureWebJobsStorage: "x" })).not.toThrow();
  });

  it("lets WORKOUTS_STORAGE override the Functions runtime's own setting", () => {
    const target = loadTableTarget({ AzureWebJobsStorage: "runtime", WORKOUTS_STORAGE: "explicit" });
    expect(target.storageConnectionString).toBe("explicit");
  });

  it("throws a named error when there is no connection string at all", () => {
    expect(() => loadTableTarget({})).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("additionally requires the shared secret", () => {
    expect(() => loadConfig({ AzureWebJobsStorage: "x" })).toThrow(ConfigError);
    expect(loadConfig({ AzureWebJobsStorage: "x", INGEST_API_KEY: "k" }).ingestApiKey).toBe("k");
  });

  it("composes storage, secret and profile", () => {
    const config = loadConfig({
      AzureWebJobsStorage: "x",
      INGEST_API_KEY: "k",
      WORKOUTS_TABLE: "custom",
      ATHLETE_RESTING_HR: "50",
    });
    expect(config.tableName).toBe("custom");
    expect(config.profile.restingHeartRate).toBe(50);
  });
});
