import { TableClient, odata } from "@azure/data-tables";
import type { RouteRecord } from "../domain/routes.js";

/**
 * One row per workout that has a GPS track: PartitionKey `<userId>|<YYYY>` of the start,
 * RowKey `<startedAt>|<workoutId>` so a year lists in date order. A row is a few kilobytes
 * (the encoded polyline); a year of routes is one partition scan.
 */
export class RouteRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "routes"): RouteRepository {
    return new RouteRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  private key(r: RouteRecord): { partitionKey: string; rowKey: string } {
    return { partitionKey: `${this.userId}|${r.startedAt.slice(0, 4)}`, rowKey: `${r.startedAt}|${r.workoutId}` };
  }

  async upsertMany(records: RouteRecord[]): Promise<number> {
    const byPartition = new Map<string, RouteRecord[]>();
    for (const r of records) {
      const { partitionKey } = this.key(r);
      (byPartition.get(partitionKey) ?? byPartition.set(partitionKey, []).get(partitionKey)!).push(r);
    }
    let written = 0;
    for (const bucket of byPartition.values()) {
      const rows = [...new Map(bucket.map((r) => [r.workoutId, r])).values()];
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await this.client.submitTransaction(
          chunk.map((r) => ["upsert", { ...this.key(r), ...r }, "Replace"] as const) as Parameters<TableClient["submitTransaction"]>[0],
        );
        written += chunk.length;
      }
    }
    return written;
  }

  /** Routes starting in [from, to), oldest first. */
  async list(from: Date, to: Date): Promise<RouteRecord[]> {
    const out: RouteRecord[] = [];
    const fromIso = from.toISOString(), toIso = to.toISOString();
    for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
      const filter = odata`PartitionKey eq ${`${this.userId}|${y}`} and RowKey ge ${fromIso} and RowKey lt ${toIso}`;
      for await (const e of this.client.listEntities({ queryOptions: { filter } })) {
        const { partitionKey: _p, rowKey: _r, etag: _e, timestamp: _t, ...rest } = e as Record<string, unknown>;
        out.push(rest as unknown as RouteRecord);
      }
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
