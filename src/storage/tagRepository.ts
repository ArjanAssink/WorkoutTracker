import { RestError, TableClient, odata } from "@azure/data-tables";
import type { WorkoutTags } from "../domain/tags.js";

/**
 * Tags per workout: one partition `<userId>|tags`, RowKey the workout id, the tags as a JSON
 * string column. Tagged workouts number in the hundreds at most, so the history page reads
 * them all in one partition scan.
 */
export class TagRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "tags"): TagRepository {
    return new TagRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  private get partitionKey(): string {
    return `${this.userId}|tags`;
  }

  /** Replaces a workout's tags; an empty list deletes the row. */
  async set(entry: WorkoutTags): Promise<void> {
    if (entry.tags.length === 0) {
      try {
        await this.client.deleteEntity(this.partitionKey, entry.workoutId);
      } catch (error) {
        if (!(error instanceof RestError && error.statusCode === 404)) throw error;
      }
      return;
    }
    await this.client.upsertEntity(
      { partitionKey: this.partitionKey, rowKey: entry.workoutId, workoutId: entry.workoutId, startedAt: entry.startedAt, tags: JSON.stringify(entry.tags), updatedAt: entry.updatedAt },
      "Replace",
    );
  }

  async list(): Promise<WorkoutTags[]> {
    const out: WorkoutTags[] = [];
    const filter = odata`PartitionKey eq ${this.partitionKey}`;
    for await (const e of this.client.listEntities<Record<string, unknown>>({ queryOptions: { filter } })) {
      let tags: unknown;
      try { tags = JSON.parse(String(e["tags"])); } catch { tags = []; }
      out.push({
        workoutId: String(e["workoutId"]),
        startedAt: String(e["startedAt"]),
        tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
        updatedAt: String(e["updatedAt"] ?? ""),
      });
    }
    return out;
  }
}
