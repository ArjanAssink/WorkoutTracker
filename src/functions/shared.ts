import { config } from "../config/index.js";
import { MAX_HR_WINDOW_DAYS, trailingMaxHeartRate } from "../domain/effort.js";
import type { WorkoutInput } from "../domain/workout.js";
import { WorkoutRepository } from "../storage/workoutRepository.js";
import { BodyWeightRepository } from "../storage/bodyWeightRepository.js";
import { LiftRepository } from "../storage/liftRepository.js";
import { MilestoneRepository } from "../storage/milestoneRepository.js";
import { RecoveryRepository } from "../storage/recoveryRepository.js";

/**
 * One repository per process. Azure Functions reuses a warm worker across invocations, so
 * building the TableClient once avoids re-negotiating a connection on every workout posted,
 * and `ensureTable` only pays its round-trip on a cold start.
 */
let repositoryPromise: Promise<WorkoutRepository> | undefined;

/**
 * Observed maximum heart rates from storage covering the trailing window of every workout
 * in `inputs`, plus the inputs' own peaks — so a batch scores each row against everything
 * known up to that row's date, including rows earlier in the same batch.
 */
export async function observedMaxResolver(
  repository: WorkoutRepository,
  inputs: WorkoutInput[],
): Promise<(workout: WorkoutInput) => number | undefined> {
  const times = inputs.map((w) => Date.parse(w.startedAt)).filter(Number.isFinite);
  if (times.length === 0) return () => undefined;

  const from = new Date(Math.min(...times) - MAX_HR_WINDOW_DAYS * 86_400_000);
  const to = new Date(Math.max(...times) + 1);
  const stored = await repository.listAll({ from, to });

  const observations = [
    ...stored.map((w) => ({ startedAt: w.startedAt, maxHeartRate: w.maxHeartRate })),
    ...inputs.map((w) => ({ startedAt: w.startedAt, maxHeartRate: w.maxHeartRate })),
  ];
  return (workout) => trailingMaxHeartRate(observations, new Date(workout.startedAt));
}

let bodyWeightPromise: Promise<BodyWeightRepository> | undefined;

export function getBodyWeightRepository(): Promise<BodyWeightRepository> {
  bodyWeightPromise ??= (async () => {
    const { storageConnectionString, userId } = config();
    const repository = BodyWeightRepository.fromConnectionString(storageConnectionString, userId);
    await repository.ensureTable();
    return repository;
  })();
  return bodyWeightPromise;
}

let liftPromise: Promise<LiftRepository> | undefined;

export function getLiftRepository(): Promise<LiftRepository> {
  liftPromise ??= (async () => {
    const { storageConnectionString, userId } = config();
    const repository = LiftRepository.fromConnectionString(storageConnectionString, userId);
    await repository.ensureTable();
    return repository;
  })();
  return liftPromise;
}

export function getRepository(): Promise<WorkoutRepository> {
  repositoryPromise ??= (async () => {
    const { storageConnectionString, tableName, userId } = config();
    const repository = WorkoutRepository.fromConnectionString(storageConnectionString, tableName, userId);
    await repository.ensureTable();
    return repository;
  })();
  return repositoryPromise;
}

let milestonePromise: Promise<MilestoneRepository> | undefined;

export function getMilestoneRepository(): Promise<MilestoneRepository> {
  milestonePromise ??= (async () => {
    const { storageConnectionString, userId } = config();
    const repository = MilestoneRepository.fromConnectionString(storageConnectionString, userId);
    await repository.ensureTable();
    return repository;
  })();
  return milestonePromise;
}

let recoveryPromise: Promise<RecoveryRepository> | undefined;

export function getRecoveryRepository(): Promise<RecoveryRepository> {
  recoveryPromise ??= (async () => {
    const { storageConnectionString, userId } = config();
    const repository = RecoveryRepository.fromConnectionString(storageConnectionString, userId);
    await repository.ensureTable();
    return repository;
  })();
  return recoveryPromise;
}
