import { RestError, TableClient } from "@azure/data-tables";
import type { HeartRateSeriesRecord } from "../domain/heartRateSeries.js";

/**
 * One row per workout that had a heart-rate stream: PartitionKey `<userId>|<YYYY-MM>` of the
 * start, RowKey the workout id. Only ever read one at a time — a point read when a workout is
 * opened in the history page — so the key is whatever makes that read exact.
 */
export class HeartRateSeriesRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "heartrate"): HeartRateSeriesRepository {
    return new HeartRateSeriesRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  private partition(startedAt: string): string {
    return `${this.userId}|${startedAt.slice(0, 7)}`;
  }

  async upsertMany(records: HeartRateSeriesRecord[]): Promise<number> {
    const byPartition = new Map<string, HeartRateSeriesRecord[]>();
    for (const r of records) {
      const key = this.partition(r.startedAt);
      (byPartition.get(key) ?? byPartition.set(key, []).get(key)!).push(r);
    }
    let written = 0;
    for (const [partitionKey, bucket] of byPartition) {
      // Two rows with one RowKey fail the whole transaction.
      const rows = [...new Map(bucket.map((r) => [r.workoutId, r])).values()];
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await this.client.submitTransaction(
          chunk.map((r) => ["upsert", { partitionKey, rowKey: r.workoutId, ...r }, "Replace"] as const) as Parameters<TableClient["submitTransaction"]>[0],
        );
        written += chunk.length;
      }
    }
    return written;
  }

  async get(startedAt: string, workoutId: string): Promise<HeartRateSeriesRecord | undefined> {
    try {
      const e = await this.client.getEntity<Record<string, unknown>>(this.partition(startedAt), workoutId);
      return { workoutId: String(e["workoutId"]), startedAt: String(e["startedAt"]), series: String(e["series"]) };
    } catch (error) {
      if (error instanceof RestError && error.statusCode === 404) return undefined;
      throw error;
    }
  }
}
