import { TableClient, odata } from "@azure/data-tables";
import type { StravaActivityRecord, StravaPhotoRecord } from "../domain/strava.js";

/**
 * What Strava knows that Apple Health does not: the activity's name and description,
 * kudos, relative effort, gear, and its photos. Activities: PK `<userId>|strava|<YYYY>`,
 * RK `<startedAt>|<stravaId>`. Photos: PK `<userId>|photos|<YYYY>`, RK `<takenAt>|<uniqueId>`.
 * Same table, two kinds, told apart by partition.
 */
export class StravaRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "strava"): StravaRepository {
    return new StravaRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  async upsertActivities(records: StravaActivityRecord[]): Promise<number> {
    return this.upsert(records.map((r) => ({ partitionKey: `${this.userId}|strava|${r.startedAt.slice(0, 4)}`, rowKey: `${r.startedAt}|${r.stravaId}`, ...r })));
  }

  async upsertPhotos(records: StravaPhotoRecord[]): Promise<number> {
    return this.upsert(records.map((r) => ({ partitionKey: `${this.userId}|photos|${r.takenAt.slice(0, 4)}`, rowKey: `${r.takenAt}|${r.uniqueId}`, ...r })));
  }

  private async upsert(entities: Array<{ partitionKey: string; rowKey: string }>): Promise<number> {
    const byPartition = new Map<string, typeof entities>();
    for (const e of entities) (byPartition.get(e.partitionKey) ?? byPartition.set(e.partitionKey, []).get(e.partitionKey)!).push(e);
    let written = 0;
    for (const bucket of byPartition.values()) {
      const rows = [...new Map(bucket.map((e) => [e.rowKey, e])).values()];
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await this.client.submitTransaction(chunk.map((e) => ["upsert", e, "Replace"] as const) as Parameters<TableClient["submitTransaction"]>[0]);
        written += chunk.length;
      }
    }
    return written;
  }

  async activities(from: Date, to: Date): Promise<StravaActivityRecord[]> {
    return this.scan<StravaActivityRecord>("strava", from, to);
  }

  async photos(from: Date, to: Date): Promise<StravaPhotoRecord[]> {
    return this.scan<StravaPhotoRecord>("photos", from, to);
  }

  private async scan<T>(kind: string, from: Date, to: Date): Promise<T[]> {
    const out: T[] = [];
    const fromIso = from.toISOString(), toIso = to.toISOString();
    for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
      const filter = odata`PartitionKey eq ${`${this.userId}|${kind}|${y}`} and RowKey ge ${fromIso} and RowKey lt ${toIso}`;
      for await (const e of this.client.listEntities({ queryOptions: { filter } })) {
        const { partitionKey: _p, rowKey: _r, etag: _e, timestamp: _t, ...rest } = e as Record<string, unknown>;
        out.push(rest as unknown as T);
      }
    }
    return out;
  }
}
