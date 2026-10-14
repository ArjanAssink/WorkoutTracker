import { TableClient, odata } from "@azure/data-tables";

/** Small JSON values that must outlive a process — OAuth tokens, sync cursors. PK `<userId>|settings`, RK the key. */
export class SettingsRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "settings"): SettingsRepository {
    return new SettingsRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const filter = odata`PartitionKey eq ${`${this.userId}|settings`} and RowKey eq ${key}`;
    for await (const e of this.client.listEntities<{ value: string }>({ queryOptions: { filter } })) {
      try { return JSON.parse(e.value) as T; } catch { return undefined; }
    }
    return undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.client.upsertEntity({ partitionKey: `${this.userId}|settings`, rowKey: key, value: JSON.stringify(value), updatedAt: new Date().toISOString() }, "Replace");
  }
}
