import type { D1Client, D1Statement } from "./cloudflare-d1-client";

// 单订阅 Feed token 是不可推导的 bearer secret；0035 前只能靠无外键持久备份跨越 subscriptions 表重建。
// prepare/restore 可能由不同进程执行，所有恢复进度必须由 migration 记录、备份表和 trigger 持久表达。
const migration0035 = "0035_rebuild_cost_sharing_collection_reminder_schema.sql";
const calendarFeedMigration = "0005_calendar_feeds.sql";
const calendarFeedManagementMigration = "0038_calendar_feed_management.sql";
export const CALENDAR_FEED_0035_BACKUP_TABLE = "renewlet_calendar_feeds_0035_backup";
const feedMirrorTriggers = [
  "renewlet_calendar_feeds_0035_insert",
  "renewlet_calendar_feeds_0035_update",
  "renewlet_calendar_feeds_0035_delete",
  "renewlet_subscriptions_0035_delete",
] as const;

const calendarFeedColumns = [
  "id", "user_id", "scope", "subscription_id", "token", "created_at", "updated_at",
] as const;
const subscriptionColumns0035 = [
  "id", "user_id", "name", "logo", "price", "currency", "billing_cycle", "custom_days", "custom_cycle_unit",
  "one_time_term_count", "one_time_term_unit", "category", "status", "pinned", "public_hidden", "payment_method",
  "start_date", "next_billing_date", "auto_renew", "auto_calculate_next_billing_date", "trial_end_date", "website",
  "notes", "tags_json", "reminder_days", "repeat_reminder_enabled", "repeat_reminder_interval",
  "repeat_reminder_window", "cost_sharing_json", "cost_sharing_collection_reminder_enabled",
  "cost_sharing_next_collection_reminder_date", "extra_json", "created_at", "updated_at",
] as const;
const pre0035AllowedExtraColumns = new Set([
  ...subscriptionColumns0035,
  "cost_sharing_collection_reminder_enabled",
  "cost_sharing_next_collection_reminder_date",
  "cost_sharing_collection_reminder_days",
]);
const subscriptionMigrationTempTables = [
  "subscriptions_new",
  "subscriptions_decimal",
  "subscriptions_0035_new",
] as const;

interface CountRow {
  count: number | string;
}

interface NameRow {
  name: string;
}

interface ColumnRow {
  cid: number;
  dflt_value: number | string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

interface SqlRow {
  sql: string | null;
}

interface IndexListRow {
  name: string;
  partial: number;
  unique: number;
}

interface IndexColumnRow {
  name: string;
  seqno: number;
}

interface ForeignKeyRow {
  from: string;
  on_delete: string;
  on_update: string;
  table: string;
  to: string;
}

/** Feed 保护阶段只报告持久状态结果；feeds 是已备份或已恢复的精确行数，不代表生成了新 token。 */
export interface CalendarFeedUpgradeResult {
  action: "backed-up" | "restored" | "skipped";
  feeds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCountRow(value: unknown): CountRow {
  if (!isRecord(value) || (typeof value["count"] !== "number" && typeof value["count"] !== "string")) {
    throw new Error("Cloudflare D1 count query returned an invalid row");
  }
  return { count: value["count"] };
}

function parseNameRow(value: unknown): NameRow {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    throw new Error("Cloudflare D1 schema query returned an invalid row");
  }
  return { name: value["name"] };
}

function parseColumnRow(value: unknown): ColumnRow {
  if (
    !isRecord(value)
    || typeof value["cid"] !== "number"
    || (value["dflt_value"] !== null && typeof value["dflt_value"] !== "number" && typeof value["dflt_value"] !== "string")
    || typeof value["name"] !== "string"
    || typeof value["notnull"] !== "number"
    || typeof value["pk"] !== "number"
    || typeof value["type"] !== "string"
  ) {
    throw new Error("Cloudflare D1 table-info query returned an invalid row");
  }
  return {
    cid: value["cid"],
    dflt_value: value["dflt_value"],
    name: value["name"],
    notnull: value["notnull"],
    pk: value["pk"],
    type: value["type"],
  };
}

function parseSqlRow(value: unknown): SqlRow {
  if (!isRecord(value) || (value["sql"] !== null && typeof value["sql"] !== "string")) {
    throw new Error("Cloudflare D1 sqlite_master query returned an invalid row");
  }
  return { sql: value["sql"] };
}

function parseIndexListRow(value: unknown): IndexListRow {
  if (
    !isRecord(value)
    || typeof value["name"] !== "string"
    || typeof value["partial"] !== "number"
    || typeof value["unique"] !== "number"
  ) {
    throw new Error("Cloudflare D1 index-list query returned an invalid row");
  }
  return { name: value["name"], partial: value["partial"], unique: value["unique"] };
}

function parseIndexColumnRow(value: unknown): IndexColumnRow {
  if (!isRecord(value) || typeof value["name"] !== "string" || typeof value["seqno"] !== "number") {
    throw new Error("Cloudflare D1 index-info query returned an invalid row");
  }
  return { name: value["name"], seqno: value["seqno"] };
}

function parseForeignKeyRow(value: unknown): ForeignKeyRow {
  if (
    !isRecord(value)
    || typeof value["from"] !== "string"
    || typeof value["on_delete"] !== "string"
    || typeof value["on_update"] !== "string"
    || typeof value["table"] !== "string"
    || typeof value["to"] !== "string"
  ) {
    throw new Error("Cloudflare D1 foreign-key query returned an invalid row");
  }
  return {
    from: value["from"],
    on_delete: value["on_delete"],
    on_update: value["on_update"],
    table: value["table"],
    to: value["to"],
  };
}

function countValue(row: CountRow | undefined): number {
  const count = Number(row?.count ?? Number.NaN);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Cloudflare D1 count query returned an invalid value");
  return count;
}

async function tableExists(client: D1Client, table: string): Promise<boolean> {
  const rows = await client.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [table],
    parseNameRow,
  );
  return rows.length === 1;
}

async function tableColumnRows(client: D1Client, table: string): Promise<ColumnRow[]> {
  if (!/^[a-z0-9_]+$/.test(table)) throw new Error("Invalid D1 table name");
  const rows = await client.query(`PRAGMA table_info(${table})`, [], parseColumnRow);
  return rows.sort((left, right) => left.cid - right.cid);
}

async function tableColumns(client: D1Client, table: string): Promise<string[]> {
  return (await tableColumnRows(client, table)).map((row) => row.name);
}

async function primaryKeyColumns(client: D1Client, table: string): Promise<string[]> {
  if (!/^[a-z0-9_]+$/.test(table)) throw new Error("Invalid D1 table name");
  const rows = await client.query(`PRAGMA table_info(${table})`, [], parseColumnRow);
  return rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name);
}

async function foreignKeySignatures(client: D1Client, table: string): Promise<string[]> {
  if (!/^[a-z0-9_]+$/.test(table)) throw new Error("Invalid D1 table name");
  const rows = await client.query(`PRAGMA foreign_key_list(${table})`, [], parseForeignKeyRow);
  return rows.map((row) => (
    `${row.from}->${row.table}.${row.to}:${row.on_update.toUpperCase()}:${row.on_delete.toUpperCase()}`
  )).sort();
}

async function indexColumns(client: D1Client, index: string): Promise<string[]> {
  if (!/^[a-z0-9_]+$/.test(index)) throw new Error("Invalid D1 index name");
  const rows = await client.query(`PRAGMA index_info(${index})`, [], parseIndexColumnRow);
  return rows.sort((left, right) => left.seqno - right.seqno).map((row) => row.name);
}

async function migrationApplied(client: D1Client, migration: string): Promise<boolean> {
  if (!(await tableExists(client, "d1_migrations"))) return false;
  const rows = await client.query(
    "SELECT name FROM d1_migrations WHERE name = ? LIMIT 1",
    [migration],
    parseNameRow,
  );
  return rows.length === 1;
}

async function rowCount(client: D1Client, table: string): Promise<number> {
  if (!/^[a-z0-9_]+$/.test(table)) throw new Error("Invalid D1 table name");
  const [row] = await client.query(`SELECT COUNT(*) AS count FROM ${table}`, [], parseCountRow);
  return countValue(row);
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function columnSignature(row: ColumnRow): string {
  return [
    row.name,
    row.type.toUpperCase(),
    row.notnull,
    row.dflt_value === null ? "<null>" : String(row.dflt_value),
    row.pk,
  ].join("|");
}

const calendarFeedColumnSignatures = [
  "id|TEXT|0|<null>|1",
  "user_id|TEXT|1|<null>|0",
  "scope|TEXT|1|<null>|0",
  "subscription_id|TEXT|0|<null>|0",
  "token|TEXT|1|<null>|0",
  "created_at|TEXT|1|<null>|0",
  "updated_at|TEXT|1|<null>|0",
] as const;

async function assertCalendarFeedChecks(client: D1Client): Promise<void> {
  const [row] = await client.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'calendar_feeds'",
    [],
    parseSqlRow,
  );
  const sql = (row?.sql ?? "").replace(/\s+/g, " ").toLowerCase();
  if (
    !sql.includes("check (scope in ('all', 'subscription'))")
    || !sql.includes("check (length(token) = 43)")
    || !sql.includes("scope = 'all' and subscription_id is null")
    || !sql.includes("scope = 'subscription' and subscription_id is not null")
  ) {
    throw new Error("Cloudflare calendar Feed constraints are invalid or mixed; refusing automatic recovery");
  }
}

async function indexSql(client: D1Client, index: string): Promise<string> {
  const [row] = await client.query(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    [index],
    parseSqlRow,
  );
  // IF NOT EXISTS 不改变索引语义；其余定义必须完整一致，不能让放宽后的 partial predicate 混入升级。
  return (row?.sql ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^create (unique )?index if not exists /, "create $1index ")
    .replace(/;$/, "");
}

function assertCalendarFeedShape(columns: readonly string[], label: string): void {
  if (!sameOrderedValues(columns, calendarFeedColumns)) {
    throw new Error(`Cloudflare ${label} schema is invalid or mixed; refusing automatic calendar Feed recovery`);
  }
}

async function assertCalendarFeedTable(client: D1Client, table: string, label: string): Promise<void> {
  const columns = await tableColumnRows(client, table);
  assertCalendarFeedShape(columns.map((row) => row.name), label);
  if (!sameOrderedValues(columns.map(columnSignature), calendarFeedColumnSignatures)) {
    throw new Error(`Cloudflare ${label} column definitions are invalid or mixed; refusing automatic calendar Feed recovery`);
  }
  if (!sameOrderedValues(await primaryKeyColumns(client, table), ["id"])) {
    throw new Error(`Cloudflare ${label} primary key is invalid or mixed; refusing automatic calendar Feed recovery`);
  }
  const foreignKeys = await foreignKeySignatures(client, table);
  if (table === CALENDAR_FEED_0035_BACKUP_TABLE) {
    if (foreignKeys.length !== 0) {
      throw new Error("Cloudflare calendar Feed backup must remain independent of migration foreign keys");
    }
    return;
  }
  await assertCalendarFeedChecks(client);
  const expectedForeignKeys = [
    "subscription_id->subscriptions.id:NO ACTION:CASCADE",
    "user_id->users.id:NO ACTION:CASCADE",
  ];
  if (!sameOrderedValues(foreignKeys, expectedForeignKeys)) {
    throw new Error(`Cloudflare ${label} foreign keys are invalid or mixed; refusing automatic calendar Feed recovery`);
  }
  const indexes = await client.query(`PRAGMA index_list(${table})`, [], parseIndexListRow);
  const requiredIndexes = [
    {
      name: "idx_calendar_feeds_user_all_unique",
      columns: ["user_id"],
      partial: 1,
      sql: "create unique index idx_calendar_feeds_user_all_unique on calendar_feeds (user_id) where scope = 'all'",
      unique: 1,
    },
    {
      name: "idx_calendar_feeds_token",
      columns: ["token"],
      partial: 0,
      sql: "create unique index idx_calendar_feeds_token on calendar_feeds (token)",
      unique: 1,
    },
    {
      name: "idx_calendar_feeds_user_subscription_unique",
      columns: ["user_id", "subscription_id"],
      partial: 1,
      sql: "create unique index idx_calendar_feeds_user_subscription_unique on calendar_feeds (user_id, subscription_id) where scope = 'subscription'",
      unique: 1,
    },
  ];
  if (await migrationApplied(client, calendarFeedManagementMigration)) {
    requiredIndexes.push({
      name: "idx_calendar_feeds_user_scope_updated_id",
      columns: ["user_id", "scope", "updated_at", "id"],
      partial: 0,
      sql: "create index idx_calendar_feeds_user_scope_updated_id on calendar_feeds (user_id, scope, updated_at desc, id desc)",
      unique: 0,
    });
  }
  for (const required of requiredIndexes) {
    const index = indexes.find((candidate) => candidate.name === required.name);
    if (!index || index.unique !== required.unique || index.partial !== required.partial
      || !sameOrderedValues(await indexColumns(client, required.name), required.columns)
      || await indexSql(client, required.name) !== required.sql) {
      throw new Error(`Cloudflare ${label} indexes are invalid or mixed; refusing automatic calendar Feed recovery`);
    }
  }
}

async function assertSubscriptionTableKeys(client: D1Client): Promise<void> {
  const primaryKey = await primaryKeyColumns(client, "subscriptions");
  const foreignKeys = await foreignKeySignatures(client, "subscriptions");
  if (
    !sameOrderedValues(primaryKey, ["id"])
    || !sameOrderedValues(foreignKeys, ["user_id->users.id:NO ACTION:CASCADE"])
  ) {
    throw new Error("Cloudflare subscriptions keys are invalid or mixed; refusing automatic recovery");
  }
}

function assertPre0035SubscriptionShape(columns: readonly string[]): void {
  // 0034 曾以同名 migration 发布过两种提醒列；只容纳已知历史列，出现完整 0035 形状但无记录时视为手工混合库。
  if (sameOrderedValues(columns, subscriptionColumns0035)) {
    throw new Error("Cloudflare subscriptions schema already has the 0035 shape without its migration record; refusing automatic recovery");
  }
  const actual = new Set(columns);
  const missingIdentity = !actual.has("id") || !actual.has("user_id");
  const unexpected = columns.some((column) => !pre0035AllowedExtraColumns.has(column));
  if (missingIdentity || unexpected || actual.size !== columns.length) {
    throw new Error("Cloudflare subscriptions schema before 0035 is invalid or mixed; refusing automatic recovery");
  }
}

async function hasSubscriptionMigrationTempTable(client: D1Client): Promise<boolean> {
  const results = await Promise.all(subscriptionMigrationTempTables.map((table) => tableExists(client, table)));
  return results.some(Boolean);
}

async function assertPost0035SubscriptionShape(client: D1Client): Promise<void> {
  const columns = await tableColumns(client, "subscriptions");
  // 0047 只追加两列；Feed 恢复仍严格核对已记账版本，不能把合法增量升级误判为混合库。
  const expected = await migrationApplied(client, "0047_subscription_balance.sql")
    ? [...subscriptionColumns0035, "balance", "balance_currency"]
    : subscriptionColumns0035;
  if (!sameOrderedValues(columns, expected)) {
    throw new Error("Cloudflare subscriptions schema after 0035 is invalid or mixed; refusing automatic recovery");
  }
}

async function assertFreshDatabase(client: D1Client): Promise<boolean> {
  const [users, subscriptions, calendarFeeds, backup] = await Promise.all([
    tableExists(client, "users"),
    tableExists(client, "subscriptions"),
    tableExists(client, "calendar_feeds"),
    tableExists(client, CALENDAR_FEED_0035_BACKUP_TABLE),
  ]);
  if (users || subscriptions || calendarFeeds || backup) return false;
  if (!(await tableExists(client, "d1_migrations"))) return true;
  return (await rowCount(client, "d1_migrations")) === 0;
}

async function backupFeeds(client: D1Client): Promise<number> {
  const removeConflictingBackupRows = `
    DELETE FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}
    WHERE id != NEW.id
      AND (
        token = NEW.token
        OR (
          user_id = NEW.user_id
          AND scope = NEW.scope
          AND subscription_id IS NEW.subscription_id
        )
      )`;
  const upsertBackupFrom = (source: "NEW" | "calendar_feeds"): string => `
    INSERT INTO ${CALENDAR_FEED_0035_BACKUP_TABLE}
      (id, user_id, scope, subscription_id, token, created_at, updated_at)
    ${source === "NEW"
      ? "VALUES (NEW.id, NEW.user_id, NEW.scope, NEW.subscription_id, NEW.token, NEW.created_at, NEW.updated_at)"
      : "SELECT id, user_id, scope, subscription_id, token, created_at, updated_at FROM calendar_feeds WHERE true"}
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      scope = excluded.scope,
      subscription_id = excluded.subscription_id,
      token = excluded.token,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`;
  // trigger 覆盖 prepare 到 migration 的旧 Worker 写入；中断重跑只合并当前行，不能清掉已被表重建级联删除的备份。
  await client.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS ${CALENDAR_FEED_0035_BACKUP_TABLE} (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              subscription_id TEXT,
              token TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )`,
    },
    ...feedMirrorTriggers.map((trigger): D1Statement => ({ sql: `DROP TRIGGER IF EXISTS ${trigger}` })),
    {
      sql: `CREATE TRIGGER renewlet_calendar_feeds_0035_insert
            AFTER INSERT ON calendar_feeds
            BEGIN
              ${removeConflictingBackupRows};
              ${upsertBackupFrom("NEW")};
            END`,
    },
    {
      sql: `CREATE TRIGGER renewlet_calendar_feeds_0035_update
            AFTER UPDATE ON calendar_feeds
            BEGIN
              DELETE FROM ${CALENDAR_FEED_0035_BACKUP_TABLE} WHERE id = OLD.id AND OLD.id != NEW.id;
              ${removeConflictingBackupRows};
              ${upsertBackupFrom("NEW")};
            END`,
    },
    {
      // 只有历史 subscriptions_* 临时表存在时，Feed 删除才来自 D1 表重建级联；稳定 schema 下的删除必须视为用户撤销。
      sql: `CREATE TRIGGER renewlet_calendar_feeds_0035_delete
            AFTER DELETE ON calendar_feeds
            WHEN OLD.scope = 'all' OR NOT EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type = 'table'
                AND name IN ('subscriptions_new', 'subscriptions_decimal', 'subscriptions_0035_new')
            )
            BEGIN
              DELETE FROM ${CALENDAR_FEED_0035_BACKUP_TABLE} WHERE id = OLD.id;
            END`,
    },
    {
      // SQLite DROP TABLE 的隐式 DELETE 不运行表自身 trigger；显式删除订阅则先同步用户的撤销意图。
      sql: `CREATE TRIGGER renewlet_subscriptions_0035_delete
            BEFORE DELETE ON subscriptions
            BEGIN
              DELETE FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}
              WHERE user_id = OLD.user_id AND subscription_id = OLD.id;
            END`,
    },
    {
      sql: `DELETE FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}
            WHERE EXISTS (
              SELECT 1 FROM calendar_feeds AS current
              WHERE current.id != ${CALENDAR_FEED_0035_BACKUP_TABLE}.id
                AND (
                  current.token = ${CALENDAR_FEED_0035_BACKUP_TABLE}.token
                  OR (
                    current.user_id = ${CALENDAR_FEED_0035_BACKUP_TABLE}.user_id
                    AND current.scope = ${CALENDAR_FEED_0035_BACKUP_TABLE}.scope
                    AND current.subscription_id IS ${CALENDAR_FEED_0035_BACKUP_TABLE}.subscription_id
                  )
                )
            )`,
    },
    { sql: upsertBackupFrom("calendar_feeds") },
  ]);
  const [mismatch] = await client.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT ${calendarFeedColumns.join(", ")} FROM calendar_feeds
      EXCEPT
      SELECT ${calendarFeedColumns.join(", ")} FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}
    )
  `, [], parseCountRow);
  if (countValue(mismatch) !== 0) throw new Error("Cloudflare calendar Feed backup verification failed");
  return rowCount(client, CALENDAR_FEED_0035_BACKUP_TABLE);
}

async function removeRevokedBackupFeeds(client: D1Client): Promise<void> {
  // 0035 DROP TABLE 会连同 subscriptions delete trigger 一起删除；重跑时只能以仍存在的事实同步迁移期间的真实撤销。
  await client.batch([{
    sql: `DELETE FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}
          WHERE NOT EXISTS (
            SELECT 1 FROM users WHERE users.id = ${CALENDAR_FEED_0035_BACKUP_TABLE}.user_id
          )
             OR (
               scope = 'subscription'
               AND subscription_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM subscriptions
                 WHERE subscriptions.id = ${CALENDAR_FEED_0035_BACKUP_TABLE}.subscription_id
               )
             )`,
  }]);
}

/**
 * 在 0035 首次执行前持久化 Feed 并安装写入镜像；已执行 0035 的库只恢复遗留状态，绝不伪造已丢 token。
 * 临时表、migration 记录与真实 schema 互相矛盾时立即阻断，保留现场给人工恢复。
 */
export async function prepareCalendarFeedsFor0035(client: D1Client): Promise<CalendarFeedUpgradeResult> {
  const hasBackup = await tableExists(client, CALENDAR_FEED_0035_BACKUP_TABLE);
  if (hasBackup) {
    await assertCalendarFeedTable(client, CALENDAR_FEED_0035_BACKUP_TABLE, "calendar Feed backup");
  }
  if (await hasSubscriptionMigrationTempTable(client)) {
    throw new Error("Cloudflare subscriptions migration has a partial temporary table; refusing automatic recovery");
  }
  const applied0035 = await migrationApplied(client, migration0035);
  if (applied0035) {
    if (!(await tableExists(client, "subscriptions")) || !(await tableExists(client, "calendar_feeds"))) {
      throw new Error("Cloudflare 0035 migration is recorded but its subscription or calendar Feed schema is missing");
    }
    await assertPost0035SubscriptionShape(client);
    await assertSubscriptionTableKeys(client);
    await assertCalendarFeedTable(client, "calendar_feeds", "calendar Feed");
    if (hasBackup) {
      await backupFeeds(client);
      await removeRevokedBackupFeeds(client);
    }
    return { action: "skipped", feeds: hasBackup ? await rowCount(client, CALENDAR_FEED_0035_BACKUP_TABLE) : 0 };
  }

  if (await assertFreshDatabase(client)) return { action: "skipped", feeds: 0 };
  if (!(await tableExists(client, "subscriptions")) || !(await tableExists(client, "users"))) {
    throw new Error("Cloudflare pre-0035 schema is incomplete; refusing automatic calendar Feed recovery");
  }
  assertPre0035SubscriptionShape(await tableColumns(client, "subscriptions"));
  await assertSubscriptionTableKeys(client);

  const hasCalendarFeeds = await tableExists(client, "calendar_feeds");
  if (!hasCalendarFeeds) {
    if (hasBackup || await migrationApplied(client, calendarFeedMigration)) {
      throw new Error("Cloudflare calendar Feed schema is missing despite persisted migration state");
    }
    return { action: "skipped", feeds: 0 };
  }
  await assertCalendarFeedTable(client, "calendar_feeds", "calendar Feed");
  return { action: "backed-up", feeds: await backupFeeds(client) };
}

/**
 * 仅在 0035 已记账且 post-schema 完整时恢复备份；ID、owner、scope、token 和时间逐字段一致后才清理备份。
 * 进程在恢复提交后丢失响应时，下一轮会从仍存在的备份或已完成的事实安全收敛。
 */
export async function restoreCalendarFeedsAfter0035(client: D1Client): Promise<CalendarFeedUpgradeResult> {
  if (!(await tableExists(client, CALENDAR_FEED_0035_BACKUP_TABLE))) {
    return { action: "skipped", feeds: 0 };
  }
  await assertCalendarFeedTable(client, CALENDAR_FEED_0035_BACKUP_TABLE, "calendar Feed backup");
  if (!(await migrationApplied(client, migration0035))) {
    throw new Error("Cloudflare calendar Feed backup exists but migration 0035 is not recorded");
  }
  if (!(await tableExists(client, "subscriptions")) || !(await tableExists(client, "calendar_feeds"))) {
    throw new Error("Cloudflare post-0035 schema is incomplete; preserving calendar Feed backup");
  }
  await assertPost0035SubscriptionShape(client);
  await assertSubscriptionTableKeys(client);
  await assertCalendarFeedTable(client, "calendar_feeds", "calendar Feed");
  await removeRevokedBackupFeeds(client);

  const [invalid] = await client.query(`
    SELECT COUNT(*) AS count
    FROM ${CALENDAR_FEED_0035_BACKUP_TABLE} AS backup
    LEFT JOIN users ON users.id = backup.user_id
    LEFT JOIN subscriptions
      ON subscriptions.id = backup.subscription_id
     AND subscriptions.user_id = backup.user_id
    WHERE users.id IS NULL
       OR length(backup.token) != 43
       OR (backup.scope = 'all' AND backup.subscription_id IS NOT NULL)
       OR (backup.scope = 'subscription' AND subscriptions.id IS NULL)
       OR backup.scope NOT IN ('all', 'subscription')
       OR EXISTS (
         SELECT 1 FROM ${CALENDAR_FEED_0035_BACKUP_TABLE} AS duplicate
         WHERE duplicate.id != backup.id
           AND (
             duplicate.token = backup.token
             OR (
               duplicate.user_id = backup.user_id
               AND duplicate.scope = backup.scope
               AND duplicate.subscription_id IS backup.subscription_id
             )
           )
       )
  `, [], parseCountRow);
  if (countValue(invalid) !== 0) {
    throw new Error("Cloudflare calendar Feed backup no longer matches subscription facts; preserving backup");
  }

  await client.batch([{
    sql: `INSERT INTO calendar_feeds (id, user_id, scope, subscription_id, token, created_at, updated_at)
          SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
          FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}
          WHERE true
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            scope = excluded.scope,
            subscription_id = excluded.subscription_id,
            token = excluded.token,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
  }]);

  const [mismatch] = await client.query(`
    SELECT COUNT(*) AS count
    FROM ${CALENDAR_FEED_0035_BACKUP_TABLE} AS backup
    WHERE NOT EXISTS (
      SELECT 1 FROM calendar_feeds AS feed
      WHERE feed.id IS backup.id
        AND feed.user_id IS backup.user_id
        AND feed.scope IS backup.scope
        AND feed.subscription_id IS backup.subscription_id
        AND feed.token IS backup.token
        AND feed.created_at IS backup.created_at
        AND feed.updated_at IS backup.updated_at
    )
  `, [], parseCountRow);
  if (countValue(mismatch) !== 0) {
    throw new Error("Cloudflare calendar Feed restore verification failed; preserving backup");
  }

  const feeds = await rowCount(client, CALENDAR_FEED_0035_BACKUP_TABLE);
  // 只有逐字段恢复校验成功后才删除无外键备份；删除响应丢失时 IF EXISTS 允许安全重放。
  await client.batch([
    ...feedMirrorTriggers.map((trigger): D1Statement => ({ sql: `DROP TRIGGER IF EXISTS ${trigger}` })),
    { sql: `DROP TABLE IF EXISTS ${CALENDAR_FEED_0035_BACKUP_TABLE}` },
  ]);
  return { action: "restored", feeds };
}
