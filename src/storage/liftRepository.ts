import { TableClient, odata } from "@azure/data-tables";
import type { Lift, LiftFamily } from "../domain/strength.js";

/**
 * Strength records. Four kinds share one table, told apart by partition:
 *
 *   me|pr                 a dated top set — RowKey `<date>|<lift>`
 *   me|repmax             the rep-max board — RowKey `<lift>|<reps>` (one current best each)
 *   me|tm|<program>       a training max per week of a block — RowKey `<date>|<lift>`
 *   me|set                every logged exercise row of the weekly log — RowKey `<date>|<lift>|<exercise>`
 *
 * Each kind is a few hundred rows at most, so a kind is one partition scan.
 */

export interface PrRecord {
  kind: "pr";
  date: string;
  lift: string;
  family: LiftFamily;
  label: string;
  reps: number;
  kg: number;
  program?: string;
  /** From the sheet when it had one; the bodyweight table is the better source. */
  bodyweightKg?: number;
  source: string;
  recordedAt: string;
}

export interface RepMaxRecord {
  kind: "repmax";
  lift: string;
  family: LiftFamily;
  label: string;
  reps: number;
  kg: number;
  asOf: string;
  recordedAt: string;
}

export interface TrainingMaxRecord {
  kind: "tm";
  program: string;
  programStart: string;
  week: number;
  date: string;
  lift: string;
  family: LiftFamily;
  label: string;
  kg: number;
  recordedAt: string;
}

/** One exercise row of the weekly log: all its sets, as written, plus what the row said about intent. */
export interface SetRecord {
  kind: "set";
  date: string;
  program: string;
  session: string;
  /** The row's name as written ("Slow Chinups (palms in)"); `lift` is what it resolved to. */
  exercise: string;
  lift: string;
  family: LiftFamily;
  label: string;
  rowKg?: number;
  /** Reps in reserve the row was taken to, when the log said. */
  rir?: number;
  /** JSON-encoded `LoggedSet[]` — Table Storage has no array type. */
  sets: string;
  notes?: string;
  source: string;
  recordedAt: string;
}

export type LiftRecord = PrRecord | RepMaxRecord | TrainingMaxRecord | SetRecord;

export function liftOf(record: { lift: string; family: LiftFamily; label: string }): Lift {
  return { slug: record.lift, family: record.family, label: record.label };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export class LiftRepository {
  constructor(
    private readonly client: TableClient,
    private readonly userId: string,
  ) {}

  static fromConnectionString(connectionString: string, userId: string, tableName = "lifts"): LiftRepository {
    return new LiftRepository(TableClient.fromConnectionString(connectionString, tableName), userId);
  }

  async ensureTable(): Promise<void> {
    await this.client.createTable();
  }

  keys(r: LiftRecord): { partitionKey: string; rowKey: string } {
    switch (r.kind) {
      case "pr": return { partitionKey: `${this.userId}|pr`, rowKey: `${r.date}|${r.lift}` };
      case "repmax": return { partitionKey: `${this.userId}|repmax`, rowKey: `${r.lift}|${String(r.reps).padStart(2, "0")}` };
      case "tm": return { partitionKey: `${this.userId}|tm|${slugify(r.program)}`, rowKey: `${r.date}|${r.lift}` };
      case "set": return { partitionKey: `${this.userId}|set`, rowKey: `${r.date}|${r.lift}|${slugify(r.exercise)}` };
    }
  }

  async upsertMany(records: LiftRecord[]): Promise<number> {
    const byPartition = new Map<string, LiftRecord[]>();
    for (const r of records) {
      const { partitionKey } = this.keys(r);
      (byPartition.get(partitionKey) ?? byPartition.set(partitionKey, []).get(partitionKey)!).push(r);
    }
    let written = 0;
    for (const bucket of byPartition.values()) {
      const unique = new Map(bucket.map((r) => [this.keys(r).rowKey, r]));
      const rows = [...unique.values()];
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await this.client.submitTransaction(
          chunk.map((r) => ["upsert", { ...this.keys(r), ...r }, "Replace"] as const) as Parameters<TableClient["submitTransaction"]>[0],
        );
        written += chunk.length;
      }
    }
    return written;
  }

  private async scan<T extends LiftRecord>(partitionKey: string): Promise<T[]> {
    const out: T[] = [];
    const filter = odata`PartitionKey eq ${partitionKey}`;
    for await (const e of this.client.listEntities({ queryOptions: { filter } })) {
      const { partitionKey: _p, rowKey: _r, etag: _e, timestamp: _t, ...rest } = e as Record<string, unknown>;
      out.push(rest as unknown as T);
    }
    return out;
  }

  async prs(): Promise<PrRecord[]> {
    return (await this.scan<PrRecord>(`${this.userId}|pr`)).sort((a, b) => a.date.localeCompare(b.date));
  }

  async repMaxes(): Promise<RepMaxRecord[]> {
    return (await this.scan<RepMaxRecord>(`${this.userId}|repmax`)).sort((a, b) => a.lift.localeCompare(b.lift) || a.reps - b.reps);
  }

  async sets(): Promise<SetRecord[]> {
    return (await this.scan<SetRecord>(`${this.userId}|set`)).sort((a, b) => a.date.localeCompare(b.date) || a.lift.localeCompare(b.lift));
  }

  /** All blocks: partitions are discovered by prefix, since Table Storage cannot list them. */
  async trainingMaxes(): Promise<TrainingMaxRecord[]> {
    const out: TrainingMaxRecord[] = [];
    const prefix = `${this.userId}|tm|`;
    // Range query over the partition key prefix: ge prefix and lt prefix + '~'.
    const filter = odata`PartitionKey ge ${prefix} and PartitionKey lt ${`${prefix}~`}`;
    for await (const e of this.client.listEntities({ queryOptions: { filter } })) {
      const { partitionKey: _p, rowKey: _r, etag: _e, timestamp: _t, ...rest } = e as Record<string, unknown>;
      out.push(rest as unknown as TrainingMaxRecord);
    }
    return out.sort((a, b) => a.program.localeCompare(b.program) || a.week - b.week || a.lift.localeCompare(b.lift));
  }
}
