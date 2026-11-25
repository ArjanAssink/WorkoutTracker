import { TableClient, odata } from "@azure/data-tables";
import type { AppNotification, Delivery, NotificationKind } from "../domain/notifications.js";

interface NotificationEntity {
  partitionKey: string;
  rowKey: string;
  kind: string;
  title: string;
  html: string;
  createdAt: string;
  link: string;
  /** JSON: Table Storage has no arrays. */
  deliveries: string;
  meta?: string;
}

/** A string property holds 64 KiB of UTF-16; stay well inside it. */
const MAX_HTML = 30_000;

/**
 * Every message sent, newest first. One partition — a few a week is a few hundred a year —
 * with the RowKey counting down in time (`notificationId`), so a plain range scan is the
 * newest-first list and `after` is the cursor for the next page.
 */
export class NotificationRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "notifications"): NotificationRepository {
    return new NotificationRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  private get partitionKey(): string {
    return `${this.userId}|notifications`;
  }

  async save(n: AppNotification): Promise<void> {
    const entity: NotificationEntity = {
      partitionKey: this.partitionKey,
      rowKey: n.id,
      kind: n.kind,
      title: n.title,
      html: n.html.length > MAX_HTML ? `${n.html.slice(0, MAX_HTML)}…` : n.html,
      createdAt: n.createdAt,
      link: n.link,
      deliveries: JSON.stringify(n.deliveries),
      ...(n.meta ? { meta: JSON.stringify(n.meta) } : {}),
    };
    await this.client.upsertEntity(entity, "Replace");
  }

  /** Newest first; `after` is the id of the last row of the previous page. */
  async list(limit: number, after?: string): Promise<AppNotification[]> {
    const filter = after
      ? odata`PartitionKey eq ${this.partitionKey} and RowKey gt ${after}`
      : odata`PartitionKey eq ${this.partitionKey}`;
    const out: AppNotification[] = [];
    for await (const e of this.client.listEntities<NotificationEntity>({ queryOptions: { filter } })) {
      out.push({
        id: e.rowKey,
        kind: e.kind as NotificationKind,
        title: e.title,
        html: e.html,
        createdAt: e.createdAt,
        link: e.link,
        deliveries: parse<Delivery[]>(e.deliveries) ?? [],
        ...(e.meta ? { meta: parse<Record<string, string | string[]>>(e.meta) ?? {} } : {}),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    await this.client.deleteEntity(this.partitionKey, id);
  }
}

function parse<T>(s: string | undefined): T | undefined {
  if (!s) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
}
