import { TableClient, odata } from "@azure/data-tables";

/**
 * Which milestone messages have gone out for which week, so nothing is announced twice.
 * One partition, RowKey `<weekStart>|<key>`; a week's rows are one prefix range query.
 */
export class MilestoneRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "milestones"): MilestoneRepository {
    return new MilestoneRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  private get partitionKey(): string {
    return `${this.userId}|milestones`;
  }

  async sentKeys(weekStart: string): Promise<Set<string>> {
    const prefix = `${weekStart}|`;
    const filter = odata`PartitionKey eq ${this.partitionKey} and RowKey ge ${prefix} and RowKey lt ${`${prefix}~`}`;
    const keys = new Set<string>();
    for await (const e of this.client.listEntities<{ key: string }>({ queryOptions: { filter } })) keys.add(e.key);
    return keys;
  }

  async markSent(weekStart: string, keys: string[], sentAt: string): Promise<void> {
    for (const key of keys) {
      await this.client.upsertEntity({ partitionKey: this.partitionKey, rowKey: `${weekStart}|${key}`, key, weekStart, sentAt }, "Replace");
    }
  }
}
