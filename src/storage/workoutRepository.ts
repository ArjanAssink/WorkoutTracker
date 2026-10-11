import { TableClient, odata, type TableEntity } from "@azure/data-tables";
import type { Workout } from "../domain/workout.js";

/**
 * Table Storage layout
 * --------------------
 * PartitionKey: `<userId>|<YYYY-MM>`   RowKey: `<startedAt ISO>|<id>`
 *
 * Partitioning by month keeps every partition small and bounded while making the query this
 * app actually runs — "everything between two dates" — a scan of a handful of partitions
 * rather than the whole table. RowKeys sort lexicographically, and ISO-8601 sorts
 * chronologically, so a range query within a partition needs no client-side sorting.
 *
 * The `id` suffix on the RowKey keeps two workouts that started in the same second distinct
 * (a strength session and a cooldown logged together, say).
 */

type WorkoutEntity = TableEntity<Omit<Workout, "id">> & { id: string };

export function partitionKey(userId: string, startedAt: string): string {
  return `${userId}|${startedAt.slice(0, 7)}`;
}

export function rowKey(startedAt: string, id: string): string {
  return `${startedAt}|${id}`;
}

/** Inclusive-start, exclusive-end window used by every read. */
export interface DateRange {
  from: Date;
  to: Date;
}

export interface ListOptions {
  activityType?: string;
  /** Hard cap on returned rows, so a careless query cannot pull years of data. */
  limit?: number;
}

export class WorkoutRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, tableName: string, userId: string): WorkoutRepository {
    return new WorkoutRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  /** Idempotent — creates the table on first use and does nothing on every call after. */
  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  /**
   * Writes a workout, replacing any existing row with the same derived id. Returns whether
   * this was the first time we saw it, which is what the ingest endpoint reports back to the
   * Shortcut so a retry is visibly a no-op rather than a silent duplicate.
   */
  async upsert(workout: Workout): Promise<{ created: boolean }> {
    const existing = await this.get(workout.startedAt, workout.id);
    const { id, ...rest } = workout;
    const entity: WorkoutEntity = {
      partitionKey: partitionKey(this.userId, workout.startedAt),
      rowKey: rowKey(workout.startedAt, workout.id),
      id,
      ...rest,
    };
    await this.client.upsertEntity(entity, "Replace");
    return { created: existing === undefined };
  }

  /** Bulk path for imports. Transactions are per-partition and capped at 100 entities. */
  async upsertMany(workouts: Workout[]): Promise<number> {
    const byPartition = new Map<string, Workout[]>();
    for (const workout of workouts) {
      const key = partitionKey(this.userId, workout.startedAt);
      const bucket = byPartition.get(key);
      if (bucket) bucket.push(workout);
      else byPartition.set(key, [workout]);
    }

    let written = 0;
    for (const [key, bucket] of byPartition) {
      // Two workouts in one batch sharing a RowKey would make the whole transaction fail,
      // so collapse duplicates first — last one wins, matching upsert semantics.
      const unique = new Map(bucket.map((w) => [rowKey(w.startedAt, w.id), w]));
      for (const chunk of chunks([...unique.values()], 100)) {
        await this.client.submitTransaction(
          chunk.map((workout) => {
            const { id, ...rest } = workout;
            return [
              "upsert",
              { partitionKey: key, rowKey: rowKey(workout.startedAt, workout.id), id, ...rest },
              "Replace",
            ] as const;
          }) as Parameters<TableClient["submitTransaction"]>[0],
        );
        written += chunk.length;
      }
    }
    return written;
  }

  async get(startedAt: string, id: string): Promise<Workout | undefined> {
    try {
      const entity = await this.client.getEntity<WorkoutEntity>(
        partitionKey(this.userId, startedAt),
        rowKey(startedAt, id),
      );
      return toWorkout(entity);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * Returns workouts in the range, oldest first.
   *
   * The filter names each month partition explicitly rather than relying on a RowKey range
   * alone; without the PartitionKey predicate Table Storage would scan every partition in the
   * table, which gets slower every month you keep using the app.
   */
  async *list(range: DateRange, options: ListOptions = {}): AsyncGenerator<Workout> {
    const from = range.from.toISOString();
    const to = range.to.toISOString();
    let remaining = options.limit ?? Number.POSITIVE_INFINITY;

    for (const month of monthsBetween(range.from, range.to)) {
      if (remaining <= 0) return;
      const filter = odata`PartitionKey eq ${`${this.userId}|${month}`} and RowKey ge ${from} and RowKey lt ${to}`;
      for await (const entity of this.client.listEntities<WorkoutEntity>({ queryOptions: { filter } })) {
        if (options.activityType && entity.activityType !== options.activityType) continue;
        yield toWorkout(entity);
        if (--remaining <= 0) return;
      }
    }
  }

  async listAll(range: DateRange, options: ListOptions = {}): Promise<Workout[]> {
    const out: Workout[] = [];
    for await (const workout of this.list(range, options)) out.push(workout);
    return out;
  }

  async delete(startedAt: string, id: string): Promise<void> {
    try {
      await this.client.deleteEntity(partitionKey(this.userId, startedAt), rowKey(startedAt, id));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/** Every `YYYY-MM` partition touched by the range, inclusive of both ends. */
export function monthsBetween(from: Date, to: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);
  while (cursor.getTime() <= last) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function toWorkout(entity: WorkoutEntity): Workout {
  const { partitionKey: _p, rowKey: _r, etag: _e, timestamp: _t, ...workout } = entity as WorkoutEntity & {
    etag?: string;
    timestamp?: string;
  };
  return workout as unknown as Workout;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { statusCode?: number }).statusCode === 404;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
