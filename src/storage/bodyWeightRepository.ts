import { TableClient, odata, type TableEntity } from "@azure/data-tables";
import type { BodyWeight } from "../domain/bodyWeight.js";

/**
 * PartitionKey `<userId>|<YYYY>`, RowKey `<YYYY-MM-DD>`. One row per day; a year is at
 * most 366 rows, so a multi-year range is a handful of small partition scans, and the
 * RowKey sorts chronologically for free.
 */
type Entity = TableEntity<Omit<BodyWeight, "date">> & { date: string };

export class BodyWeightRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "bodyweight"): BodyWeightRepository {
    return new BodyWeightRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  private key(date: string): { partitionKey: string; rowKey: string } {
    return { partitionKey: `${this.userId}|${date.slice(0, 4)}`, rowKey: date };
  }

  async upsertMany(entries: BodyWeight[]): Promise<number> {
    const byPartition = new Map<string, BodyWeight[]>();
    for (const e of entries) {
      const { partitionKey } = this.key(e.date);
      (byPartition.get(partitionKey) ?? byPartition.set(partitionKey, []).get(partitionKey)!).push(e);
    }
    let written = 0;
    for (const bucket of byPartition.values()) {
      const unique = new Map(bucket.map((e) => [e.date, e]));
      const rows = [...unique.values()];
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await this.client.submitTransaction(
          chunk.map((e) => ["upsert", { ...this.key(e.date), ...e }, "Replace"] as const) as Parameters<TableClient["submitTransaction"]>[0],
        );
        written += chunk.length;
      }
    }
    return written;
  }

  async upsert(entry: BodyWeight): Promise<void> {
    await this.client.upsertEntity({ ...this.key(entry.date), ...entry }, "Replace");
  }

  /** Inclusive of both dates, oldest first. */
  async list(fromDate: string, toDate: string): Promise<BodyWeight[]> {
    const out: BodyWeight[] = [];
    for (let y = Number(fromDate.slice(0, 4)); y <= Number(toDate.slice(0, 4)); y++) {
      const filter = odata`PartitionKey eq ${`${this.userId}|${y}`} and RowKey ge ${fromDate} and RowKey le ${toDate}`;
      for await (const e of this.client.listEntities<Entity>({ queryOptions: { filter } })) {
        const { partitionKey: _p, rowKey: _r, etag: _e, timestamp: _t, ...rest } = e as Entity & { etag?: string; timestamp?: string };
        out.push(rest as unknown as BodyWeight);
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
}
