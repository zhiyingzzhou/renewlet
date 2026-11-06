import { z } from "zod";
import type { D1Client } from "./cloudflare-d1-client";
import {
  classifyDerivedSchema,
  SUBSCRIPTION_DERIVED_BACKFILL_NAME,
  type DerivedBackfillState,
  type DerivedSchemaShape,
} from "./cloudflare-derived-backfill-state";

// migration 记录只能证明文件曾被执行；部署放行还必须同时证明列定义、键、索引、约束和 v4 marker 互相一致。
const backfillName = SUBSCRIPTION_DERIVED_BACKFILL_NAME;

const migrationRowSchema = z.object({ name: z.string() }).passthrough();
const markerRowSchema = z.object({ name: z.string() }).passthrough();
const tableColumnRowSchema = z.object({
  cid: z.number(),
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  dflt_value: z.union([z.string(), z.number()]).nullable(),
  pk: z.number(),
}).passthrough();
const indexListRowSchema = z.object({ name: z.string(), unique: z.number(), partial: z.number() }).passthrough();
const indexColumnRowSchema = z.object({ seqno: z.number(), name: z.string() }).passthrough();
const indexXinfoRowSchema = z.object({
  seqno: z.number(),
  name: z.string().nullable(),
  desc: z.number(),
  key: z.number(),
}).passthrough();
const foreignKeyRowSchema = z.object({
  table: z.string(),
  from: z.string(),
  to: z.string(),
  on_update: z.string(),
  on_delete: z.string(),
}).passthrough();
const tableSqlRowSchema = z.object({ sql: z.string().nullable() }).passthrough();

type TableColumnRow = z.infer<typeof tableColumnRowSchema>;

function column(
  name: string,
  notNull = 0,
  defaultValue: string | null = null,
  primaryKey = 0,
  type = "TEXT",
): string {
  return [name, type, notNull, defaultValue ?? "<null>", primaryKey].join("|");
}

// 签名包含类型、NOT NULL、默认值和 PK 序号；只比较列名会把手工修改的混合 schema 误当成可修复状态。
const subscriptionsColumns = [
  column("id", 0, null, 1), column("user_id", 1), column("name", 1), column("logo"),
  column("price", 1), column("currency", 1), column("billing_cycle", 1), column("custom_days", 0, null, 0, "INTEGER"),
  column("custom_cycle_unit"), column("one_time_term_count", 0, null, 0, "INTEGER"), column("one_time_term_unit"),
  column("category", 1), column("status", 1), column("pinned", 1, "0", 0, "INTEGER"),
  column("public_hidden", 1, "0", 0, "INTEGER"), column("payment_method"), column("start_date"),
  column("next_billing_date", 1), column("auto_renew", 1, "0", 0, "INTEGER"),
  column("auto_calculate_next_billing_date", 1, null, 0, "INTEGER"), column("trial_end_date"), column("website"),
  column("notes"), column("tags_json", 1, "'[]'"), column("reminder_days", 1, null, 0, "INTEGER"),
  column("repeat_reminder_enabled", 1, null, 0, "INTEGER"), column("repeat_reminder_interval", 1),
  column("repeat_reminder_window", 1), column("cost_sharing_json", 1, "'{}'"),
  column("cost_sharing_collection_reminder_enabled", 1, "0", 0, "INTEGER"),
  column("cost_sharing_next_collection_reminder_date"), column("extra_json", 1, "'{}'"),
  column("created_at", 1), column("updated_at", 1),
] as const;

const listIndexColumns = [
  column("subscription_id", 0, null, 1), column("user_id", 1), column("name", 1), column("website"),
  column("notes"), column("search_text_lower", 1), column("category", 1), column("billing_cycle", 1),
  column("currency", 1), column("payment_method"), column("status", 1), column("pinned", 1, "0", 0, "INTEGER"),
  column("public_hidden", 1, "0", 0, "INTEGER"), column("next_billing_date", 1), column("trial_end_date"),
  column("one_time_term_count", 0, null, 0, "INTEGER"), column("auto_renew", 1, "0", 0, "INTEGER"),
  column("reminder_days", 1, "0", 0, "INTEGER"), column("repeat_reminder_enabled", 1, "0", 0, "INTEGER"),
  column("created_at", 1), column("updated_at", 1),
] as const;
const tagColumns = [
  column("user_id", 1, null, 1), column("subscription_id", 1, null, 2), column("tag_norm", 1, null, 3),
  column("tag", 1), column("created_at", 1), column("updated_at", 1),
] as const;
const statsColumns = [
  column("user_id", 0, null, 1), column("total_count", 1, "0", 0, "INTEGER"),
  column("trial_count", 1, "0", 0, "INTEGER"), column("active_count", 1, "0", 0, "INTEGER"),
  column("expired_count", 1, "0", 0, "INTEGER"), column("paused_count", 1, "0", 0, "INTEGER"),
  column("cancelled_count", 1, "0", 0, "INTEGER"), column("created_at", 1), column("updated_at", 1),
] as const;
const repeatScheduleColumns = [
  column("user_id", 1, null, 1), column("subscription_id", 1, null, 2), column("next_due_at_utc", 1),
] as const;
const schedulerColumns = [
  column("user_id", 0, null, 1), column("auto_renew_count", 1, "0", 0, "INTEGER"),
  column("repeat_reminder_count", 1, "0", 0, "INTEGER"), column("last_auto_renew_local_date", 1, "''"),
  column("created_at", 1), column("updated_at", 1), column("next_auto_renew_check_at_utc"),
  column("next_daily_notification_due_at_utc"), column("next_repeat_notification_due_at_utc"),
] as const;
const backfillColumns = [column("name", 0, null, 1), column("completed_at", 1)] as const;

interface IndexSpec {
  columns: readonly string[];
  name: string;
  partial?: number;
  unique?: number;
}

// ORDER BY 热路径依赖 DESC 方向，PRAGMA index_info 看不见方向，因此完整校验必须读取 index_xinfo。
const indexSpecs: Readonly<Record<string, readonly IndexSpec[]>> = {
  subscription_list_index: [
    { name: "idx_subscription_list_index_user_order", columns: ["user_id", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_category_order", columns: ["user_id", "category", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_billing_cycle_order", columns: ["user_id", "billing_cycle", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_currency_order", columns: ["user_id", "currency", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_payment_method_order", columns: ["user_id", "payment_method", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_pinned_order", columns: ["user_id", "pinned", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_public_hidden_order", columns: ["user_id", "public_hidden", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_reminder_order", columns: ["user_id", "reminder_days", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_list_index_user_repeat_order", columns: ["user_id", "repeat_reminder_enabled", "created_at DESC", "subscription_id DESC"] },
  ],
  subscription_tags: [
    { name: "idx_subscription_tags_user_tag_order", columns: ["user_id", "tag_norm", "created_at DESC", "subscription_id DESC"] },
    { name: "idx_subscription_tags_user_updated", columns: ["user_id", "updated_at DESC", "tag_norm"] },
  ],
  subscription_repeat_schedule: [
    { name: "idx_subscription_repeat_schedule_due", columns: ["user_id", "next_due_at_utc", "subscription_id"] },
  ],
  subscription_scheduler_state: [
    { name: "idx_subscription_scheduler_auto_due", columns: ["next_auto_renew_check_at_utc", "user_id"] },
    { name: "idx_subscription_scheduler_daily_due", columns: ["next_daily_notification_due_at_utc", "user_id"] },
    { name: "idx_subscription_scheduler_repeat_due", columns: ["next_repeat_notification_due_at_utc", "user_id"] },
  ],
};

function columnSignature(row: TableColumnRow): string {
  const defaultValue = row.dflt_value === null ? "<null>" : String(row.dflt_value);
  return [row.name, row.type.toUpperCase(), row.notnull, defaultValue, row.pk].join("|");
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function tableColumnRows(client: D1Client, table: string): Promise<TableColumnRow[]> {
  return (await client.query(`PRAGMA table_info(${table})`, [], tableColumnRowSchema.parse))
    .sort((left, right) => left.cid - right.cid);
}

async function indexColumns(client: D1Client, index: string): Promise<string[]> {
  const rows = await client.query(`PRAGMA index_info(${index})`, [], indexColumnRowSchema.parse);
  return rows.sort((left, right) => left.seqno - right.seqno).map((row) => row.name);
}

async function primaryKeyColumns(client: D1Client, table: string): Promise<string[]> {
  const rows = await tableColumnRows(client, table);
  return rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name);
}

async function foreignKeySignatures(client: D1Client, table: string): Promise<string[]> {
  const rows = await client.query(`PRAGMA foreign_key_list(${table})`, [], foreignKeyRowSchema.parse);
  return rows.map((row) => (
    `${row.from}->${row.table}.${row.to}:${row.on_update.toUpperCase()}:${row.on_delete.toUpperCase()}`
  )).sort();
}

async function tableDefinitionsValid(client: D1Client, balanceMigrationApplied: boolean): Promise<boolean> {
  const expected = {
    // 升级前后按账本选择精确列签名；不接受缺列、半个余额字段或未记账的手工 ALTER。
    subscriptions: balanceMigrationApplied
      ? [...subscriptionsColumns, column("balance"), column("balance_currency")]
      : subscriptionsColumns,
    subscription_list_index: listIndexColumns,
    subscription_tags: tagColumns,
    subscription_user_stats: statsColumns,
    subscription_repeat_schedule: repeatScheduleColumns,
    subscription_scheduler_state: schedulerColumns,
    subscription_derived_backfills: backfillColumns,
  } as const;
  const checks = await Promise.all(Object.entries(expected).map(async ([table, columns]) => {
    const actual = (await tableColumnRows(client, table)).map(columnSignature);
    return sameValues(actual, columns);
  }));
  return checks.every(Boolean);
}

async function requiredIndexesValid(client: D1Client): Promise<boolean> {
  for (const [table, specs] of Object.entries(indexSpecs)) {
    const indexes = await client.query(`PRAGMA index_list(${table})`, [], indexListRowSchema.parse);
    for (const spec of specs) {
      const index = indexes.find((candidate) => candidate.name === spec.name);
      if (!index || index.unique !== (spec.unique ?? 0) || index.partial !== (spec.partial ?? 0)) return false;
      const xinfo = await client.query(`PRAGMA index_xinfo(${spec.name})`, [], indexXinfoRowSchema.parse);
      const columns = xinfo.filter((row) => row.key === 1).sort((left, right) => left.seqno - right.seqno)
        .map((row) => `${row.name ?? ""}${row.desc === 1 ? " DESC" : ""}`);
      if (!sameValues(columns, spec.columns)) return false;
    }
  }
  return true;
}

async function statsChecksValid(client: D1Client): Promise<boolean> {
  const [row] = await client.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscription_user_stats'",
    [],
    tableSqlRowSchema.parse,
  );
  const sql = (row?.sql ?? "").replace(/\s+/g, " ").toLowerCase();
  return sql.includes("check (total_count >= 0 and trial_count >= 0 and active_count >= 0 and expired_count >= 0 and paused_count >= 0 and cancelled_count >= 0)")
    && sql.includes("check (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)");
}

async function primaryKeysValid(client: D1Client): Promise<boolean> {
  const actual = await Promise.all([
    primaryKeyColumns(client, "subscriptions"),
    primaryKeyColumns(client, "subscription_list_index"),
    primaryKeyColumns(client, "subscription_tags"),
    primaryKeyColumns(client, "subscription_user_stats"),
    primaryKeyColumns(client, "subscription_repeat_schedule"),
    primaryKeyColumns(client, "subscription_scheduler_state"),
    primaryKeyColumns(client, "subscription_derived_backfills"),
  ]);
  const expected = [["id"], ["subscription_id"], ["user_id", "subscription_id", "tag_norm"], ["user_id"],
    ["user_id", "subscription_id"], ["user_id"], ["name"]];
  return actual.every((columns, index) => sameValues(columns, expected[index] ?? []));
}

async function foreignKeysValid(client: D1Client): Promise<boolean> {
  const actual = await Promise.all([
    foreignKeySignatures(client, "subscriptions"),
    foreignKeySignatures(client, "subscription_list_index"),
    foreignKeySignatures(client, "subscription_tags"),
    foreignKeySignatures(client, "subscription_user_stats"),
    foreignKeySignatures(client, "subscription_repeat_schedule"),
    foreignKeySignatures(client, "subscription_scheduler_state"),
  ]);
  const user = "user_id->users.id:NO ACTION:CASCADE";
  const subscription = "subscription_id->subscriptions.id:NO ACTION:CASCADE";
  const expected = [[user], [subscription, user].sort(), [subscription, user].sort(), [user],
    [subscription, user].sort(), [user]];
  return actual.every((keys, index) => sameValues(keys, expected[index] ?? []));
}

/**
 * 从数据库持久事实分类升级状态；旧 v2/v3 marker 或单独一条 migration 记录都不能授权跳过 v4。
 * 返回 invalid-mixed 时调用方只能阻断部署，不能现场 ALTER 或猜测缺失结构。
 */
export async function probeDerivedBackfillState(client: D1Client): Promise<DerivedBackfillState> {
  const migrationRows = await client.query(
    "SELECT name FROM d1_migrations WHERE name IN (?, ?, ?)",
    ["0036_subscription_derived_state_v2.sql", "0039_rebuild_subscription_collection_projections.sql", "0047_subscription_balance.sql"],
    migrationRowSchema.parse,
  );
  const listRows = await tableColumnRows(client, "subscription_list_index");
  const tagRows = await tableColumnRows(client, "subscription_tags");
  const statsRows = await tableColumnRows(client, "subscription_user_stats");
  const repeatRows = await tableColumnRows(client, "subscription_repeat_schedule");
  const schedulerRows = await tableColumnRows(client, "subscription_scheduler_state");
  const backfillRows = await tableColumnRows(client, "subscription_derived_backfills");
  const canReadMarker = backfillRows.some((row) => row.name === "name")
    && backfillRows.some((row) => row.name === "completed_at");
  const markerRows = canReadMarker
    ? await client.query(
        "SELECT name FROM subscription_derived_backfills WHERE name = ? LIMIT 1",
        [backfillName],
        markerRowSchema.parse,
      )
    : [];
  const shape: DerivedSchemaShape = {
    v2MigrationApplied: migrationRows.some((row) => row.name === "0036_subscription_derived_state_v2.sql"),
    v3MigrationApplied: migrationRows.some((row) => row.name === "0039_rebuild_subscription_collection_projections.sql"),
    listIndexColumns: listRows.map((row) => row.name),
    tagColumns: tagRows.map((row) => row.name),
    statsColumns: statsRows.map((row) => row.name),
    repeatScheduleColumns: repeatRows.map((row) => row.name),
    repeatScheduleIndexColumns: await indexColumns(client, "idx_subscription_repeat_schedule_due"),
    schedulerColumns: schedulerRows.map((row) => row.name),
    schedulerAutoIndexColumns: await indexColumns(client, "idx_subscription_scheduler_auto_due"),
    schedulerDailyIndexColumns: await indexColumns(client, "idx_subscription_scheduler_daily_due"),
    schedulerRepeatIndexColumns: await indexColumns(client, "idx_subscription_scheduler_repeat_due"),
    backfillColumns: backfillRows.map((row) => row.name),
    primaryKeysValid: await primaryKeysValid(client),
    foreignKeysValid: await foreignKeysValid(client),
    constraintsValid: await tableDefinitionsValid(client, migrationRows.some((row) => row.name === "0047_subscription_balance.sql"))
      && await requiredIndexesValid(client)
      && await statsChecksValid(client),
    markerPresent: markerRows.length === 1,
  };
  // migration 记录、完整结构和 marker 必须一致；半升级只允许重放数据回填，混合 schema 不做现场猜测。
  return classifyDerivedSchema(shape);
}
