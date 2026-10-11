import { TableClient, odata } from "@azure/data-tables";
import type { RecoveryDay } from "../domain/recovery.js";

/**
 * PartitionKey `<userId>|<YYYY>`, RowKey `<YYYY-MM-DD>` — the body-weight layout. Writes
 * **merge** rather than replace: a Health Auto Export batch that carries only resting
 * heart rate must not wipe the night's sleep already on the row.
 */
export class RecoveryRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "recovery"): RecoveryRepository {
    return new RecoveryRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  private key(date: string): { partitionKey: string; rowKey: string } {
    return { partitionKey: `${this.userId}|${date.slice(0, 4)}`, rowKey: date };
  }

  async upsertMany(entries: RecoveryDay[]): Promise<number> {
    const byPartition = new Map<string, RecoveryDay[]>();
    for (const e of entries) {
      const { partitionKey } = this.key(e.date);
      (byPartition.get(partitionKey) ?? byPartition.set(partitionKey, []).get(partitionKey)!).push(e);
    }
    let written = 0;
    for (const bucket of byPartition.values()) {
      const rows = [...new Map(bucket.map((e) => [e.date, e])).values()];
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await this.client.submitTransaction(
          chunk.map((e) => ["upsert", { ...this.key(e.date), ...e }, "Merge"] as const) as Parameters<TableClient["submitTransaction"]>[0],
        );
        written += chunk.length;
      }
    }
    return written;
  }

  /** Inclusive of both dates, oldest first. */
  async list(fromDate: string, toDate: string): Promise<RecoveryDay[]> {
    const out: RecoveryDay[] = [];
    for (let y = Number(fromDate.slice(0, 4)); y <= Number(toDate.slice(0, 4)); y++) {
      const filter = odata`PartitionKey eq ${`${this.userId}|${y}`} and RowKey ge ${fromDate} and RowKey le ${toDate}`;
      for await (const e of this.client.listEntities({ queryOptions: { filter } })) {
        const { partitionKey: _p, rowKey: _r, etag: _e, timestamp: _t, ...rest } = e as Record<string, unknown>;
        out.push(rest as unknown as RecoveryDay);
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
}
