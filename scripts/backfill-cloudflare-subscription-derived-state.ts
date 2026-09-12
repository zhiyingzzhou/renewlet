#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { effectiveReminderDays } from "../packages/shared/src/runtime";
import { settingsFromRowJson, toApiSubscription } from "../apps/worker/src/db";
import {
  normalizeSubscriptionTags,
  SUBSCRIPTION_LIST_INDEX_UPSERT_SQL,
  SUBSCRIPTION_TAG_UPSERT_SQL,
  subscriptionListProjectionValues,
} from "../apps/worker/src/subscription-derived-state";
import {
  dateOnlyInZone,
  getNextRepeatScheduleOccurrence,
  getRepeatScheduleDecision,
  localTimeInZone,
  repeatReminderOccurrenceMatches,
  repeatReminderSnapshot,
  toRfc3339Seconds,
} from "../apps/worker/src/notification-schedule";
import {
  type D1Client,
  type D1Statement,
} from "./cloudflare-d1-client";
import { createD1OperationsClient } from "./cloudflare-d1-operations";
import { assertSubscriptionCollectionProjectionRows } from "./cloudflare-subscription-collection-backfill";
import {
  assertStoredSubscriptionSchedulerRowsValid,
  assertSubscriptionSchedulerRows,
  nextAutoRenewCheckAt,
  nextDailyNotificationDueAt,
} from "./cloudflare-subscription-scheduler-backfill";
import {
  executeDerivedBackfillState,
} from "./cloudflare-derived-backfill-state";
import { probeDerivedBackfillState } from "./cloudflare-derived-schema";

// 0039 先恢复 SQL 可表达的集合基线；本脚本复用 Worker 的 Unicode 投影与日期/时区规则收敛完整派生状态。
// marker 只能在全量分页回填、逐字段投影校验、schedule 复算和 aggregate 不变量全部通过后写入。

const backfillName = "subscription-derived-state-v3";
const pageSize = 200;
const writeBatchSize = 50;
const notificationWindowMinutes = 2;

interface Options {
  configPath?: string;
  target: "local" | "remote";
}

function requireLast<T>(rows: readonly T[], context: string): T {
  const last = rows.at(-1);
  if (last === undefined) throw new Error(`${context} unexpectedly returned an empty page`);
  return last;
}

const customCycleUnitSchema = z.enum(["day", "week", "month", "year"]);
const subscriptionBackfillRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  logo: z.string().nullable(),
  price: z.string(),
  currency: z.string(),
  billing_cycle: z.string(),
  custom_days: z.number().nullable(),
  custom_cycle_unit: customCycleUnitSchema.nullable(),
  one_time_term_count: z.number().nullable(),
  one_time_term_unit: customCycleUnitSchema.nullable(),
  category: z.string(),
  status: z.string(),
  pinned: z.number(),
  public_hidden: z.number(),
  payment_method: z.string().nullable(),
  start_date: z.string().nullable(),
  next_billing_date: z.string(),
  auto_renew: z.number(),
  auto_calculate_next_billing_date: z.number(),
  trial_end_date: z.string().nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  tags_json: z.string(),
  reminder_days: z.number(),
  repeat_reminder_enabled: z.number(),
  repeat_reminder_interval: z.string(),
  repeat_reminder_window: z.string(),
  cost_sharing_json: z.string().default("{}"),
  cost_sharing_collection_reminder_enabled: z.number(),
  cost_sharing_next_collection_reminder_date: z.string().nullable(),
  extra_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  settings_json: z.string().nullable(),
}).passthrough();
type SubscriptionBackfillRow = z.infer<typeof subscriptionBackfillRowSchema>;

const subscriptionScheduleVerificationRowSchema = subscriptionBackfillRowSchema.extend({
  stored_next_due_at_utc: z.string().nullable(),
});
type SubscriptionScheduleVerificationRow = z.infer<typeof subscriptionScheduleVerificationRowSchema>;

const schedulerBackfillRowSchema = z.object({
  user_id: z.string(),
  settings_json: z.string().nullable(),
  auto_renew_count: z.union([z.number(), z.string()]),
  repeat_reminder_count: z.union([z.number(), z.string()]),
  last_auto_renew_local_date: z.string().nullable(),
  next_repeat_notification_due_at_utc: z.string().nullable(),
}).passthrough();
type SchedulerBackfillRow = z.infer<typeof schedulerBackfillRowSchema>;

const countRowSchema = z.object({ count: z.union([z.number(), z.string()]) }).passthrough();
const migrationRowSchema = z.object({ name: z.string() }).passthrough();

function parseArgs(argv: string[]): Options {
  let target: Options["target"] | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local" || argument === "--remote") {
      const nextTarget: Options["target"] = argument === "--local" ? "local" : "remote";
      if (target) throw new Error("Specify exactly one D1 target: --local or --remote");
      target = nextTarget;
      continue;
    }
    if (argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!target) throw new Error("Derived-state backfill requires an explicit --local or --remote target");
  return configPath === undefined ? { target } : { target, configPath };
}

function nextRepeatDue(row: SubscriptionBackfillRow, now: Date): string | null {
  if (row.repeat_reminder_enabled !== 1) return null;
  const settings = settingsFromRowJson(row.settings_json);
  // 调度不依赖标签；旧事实里的空白/重复标签只影响可重建投影，不能阻断 repeat schedule 恢复。
  const subscription = toApiSubscription({
    ...row,
    tags_json: JSON.stringify(normalizeSubscriptionTags(row).map((tag) => tag.value)),
  });
  const current = getRepeatScheduleDecision(now, settings, [subscription], notificationWindowMinutes);
  if (current.due) return current.scheduledInstantUtc;
  return getNextRepeatScheduleOccurrence(now, settings, [subscription])?.scheduledInstantUtc ?? null;
}

async function writeStatements(client: D1Client, statements: readonly D1Statement[]): Promise<void> {
  // 每批限制 50 条控制 REST/CLI 请求体；语句均以业务键 UPSERT/DELETE，整批可在响应丢失后安全重放。
  for (let offset = 0; offset < statements.length; offset += writeBatchSize) {
    await client.batch(statements.slice(offset, offset + writeBatchSize));
  }
}

async function assertBackfilledSchedules(client: D1Client, now: Date): Promise<number> {
  // 校验重新运行同一 Worker 时间规则作为 oracle，不读取 scheduler aggregate 推导预期值，避免派生数据自证正确。
  let cursorUserId = "";
  let cursorSubscriptionId = "";
  let expectedCount = 0;
  for (;;) {
    const rows = await client.query(`
      SELECT subscriptions.*, settings.settings_json,
             repeat_schedule.next_due_at_utc AS stored_next_due_at_utc
      FROM subscriptions
      LEFT JOIN settings ON settings.user_id = subscriptions.user_id
      LEFT JOIN subscription_repeat_schedule AS repeat_schedule
        ON repeat_schedule.user_id = subscriptions.user_id
       AND repeat_schedule.subscription_id = subscriptions.id
      WHERE subscriptions.user_id > ?
         OR (subscriptions.user_id = ? AND subscriptions.id > ?)
      ORDER BY subscriptions.user_id, subscriptions.id
      LIMIT ?
    `, [cursorUserId, cursorUserId, cursorSubscriptionId, pageSize], (value): SubscriptionScheduleVerificationRow => (
      subscriptionScheduleVerificationRowSchema.parse(value)
    ));
    if (rows.length === 0) break;
    for (const row of rows) {
      const expected = nextRepeatDue(row, now);
      if (expected) expectedCount += 1;
      if ((row.stored_next_due_at_utc ?? null) !== expected) {
        throw new Error("subscription_repeat_schedule value invariant failed");
      }
    }
    const last = requireLast(rows, "Repeat schedule verification");
    cursorUserId = last.user_id;
    cursorSubscriptionId = last.id;
    if (rows.length < pageSize) break;
  }
  return expectedCount;
}

function storedRepeatScheduleMatches(row: SubscriptionScheduleVerificationRow, stored: string): boolean {
  const instant = new Date(stored);
  if (!Number.isFinite(instant.getTime())) return false;
  const settings = settingsFromRowJson(row.settings_json);
  const subscription = toApiSubscription({
    ...row,
    tags_json: JSON.stringify(normalizeSubscriptionTags(row).map((tag) => tag.value)),
  });
  if (!subscription.repeatReminderEnabled) return false;
  const reminderDays = effectiveReminderDays(subscription.reminderDays, settings.notificationReminderDays);
  if (reminderDays === undefined) return false;
  const occurrence = {
    scheduledLocalDate: dateOnlyInZone(instant, settings.timezone),
    scheduledLocalTime: localTimeInZone(instant, settings.timezone),
    timeZone: settings.timezone,
    scheduledInstantUtc: stored,
  };
  const repeat = repeatReminderSnapshot(subscription);
  const targets = subscription.status === "trial" && subscription.trialEndDate
    ? [subscription.nextBillingDate, subscription.trialEndDate]
    : [subscription.nextBillingDate];
  return targets.some((target) => repeatReminderOccurrenceMatches(
    occurrence,
    settings,
    reminderDays,
    target,
    repeat,
  ));
}

async function assertStoredSchedulesValid(client: D1Client, now: Date): Promise<void> {
  // v3 完成后调度器可能已推进 schedule，也可能为失败重试保留逾期 occurrence；不能再拿新的 now 强求精确相等。
  // 此处只验证存量时间仍是当前订阅与设置允许的 occurrence，并阻止仍有后续提醒的订阅缺失派生行。
  let cursorUserId = "";
  let cursorSubscriptionId = "";
  for (;;) {
    const rows = await client.query(`
      SELECT subscriptions.*, settings.settings_json,
             repeat_schedule.next_due_at_utc AS stored_next_due_at_utc
      FROM subscriptions
      LEFT JOIN settings ON settings.user_id = subscriptions.user_id
      LEFT JOIN subscription_repeat_schedule AS repeat_schedule
        ON repeat_schedule.user_id = subscriptions.user_id
       AND repeat_schedule.subscription_id = subscriptions.id
      WHERE subscriptions.user_id > ?
         OR (subscriptions.user_id = ? AND subscriptions.id > ?)
      ORDER BY subscriptions.user_id, subscriptions.id
      LIMIT ?
    `, [cursorUserId, cursorUserId, cursorSubscriptionId, pageSize], (value): SubscriptionScheduleVerificationRow => (
      subscriptionScheduleVerificationRowSchema.parse(value)
    ));
    if (rows.length === 0) return;
    for (const row of rows) {
      const stored = row.stored_next_due_at_utc;
      if (stored !== null && !storedRepeatScheduleMatches(row, stored)) {
        throw new Error("subscription_repeat_schedule value invariant failed");
      }
      if (stored === null && nextRepeatDue(row, now) !== null) {
        throw new Error("subscription_repeat_schedule missing-row invariant failed");
      }
    }
    const last = requireLast(rows, "Completed repeat schedule verification");
    cursorUserId = last.user_id;
    cursorSubscriptionId = last.id;
    if (rows.length < pageSize) return;
  }
}

async function assertDerivedInvariants(client: D1Client, expectedScheduleCount?: number): Promise<void> {
  // 所有计数都回到 subscriptions 事实表复算；marker 只有在这些跨表不变量和外键同时通过后才允许写入。
  const [orphaned] = await client.query(`
    SELECT COUNT(*) AS count
    FROM subscription_repeat_schedule AS repeat_schedule
    LEFT JOIN subscriptions ON subscriptions.id = repeat_schedule.subscription_id
    WHERE subscriptions.id IS NULL OR subscriptions.user_id != repeat_schedule.user_id
  `, [], countRowSchema.parse);
  if (Number(orphaned?.count ?? 0) !== 0) {
    throw new Error("subscription_repeat_schedule owner invariant failed");
  }

  const [collectionOrphans] = await client.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT list_index.subscription_id
      FROM subscription_list_index AS list_index
      LEFT JOIN subscriptions ON subscriptions.id = list_index.subscription_id
      WHERE subscriptions.id IS NULL OR subscriptions.user_id != list_index.user_id
      UNION ALL
      SELECT tags.subscription_id
      FROM subscription_tags AS tags
      LEFT JOIN subscriptions ON subscriptions.id = tags.subscription_id
      WHERE subscriptions.id IS NULL OR subscriptions.user_id != tags.user_id
    )
  `, [], countRowSchema.parse);
  if (Number(collectionOrphans?.count ?? 0) !== 0) {
    throw new Error("subscription collection owner invariant failed");
  }

  const [statsMismatch] = await client.query(`
    SELECT COUNT(*) AS count
    FROM users
    LEFT JOIN subscription_user_stats AS stats ON stats.user_id = users.id
    WHERE stats.user_id IS NULL
       OR stats.total_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id)
       OR stats.trial_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'trial')
       OR stats.active_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'active')
       OR stats.expired_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'expired')
       OR stats.paused_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'paused')
       OR stats.cancelled_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'cancelled')
       OR stats.total_count != stats.trial_count + stats.active_count + stats.expired_count + stats.paused_count + stats.cancelled_count
  `, [], countRowSchema.parse);
  if (Number(statsMismatch?.count ?? 0) !== 0) throw new Error("subscription_user_stats invariant failed");

  const [aggregateOrphans] = await client.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT stats.user_id FROM subscription_user_stats AS stats
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = stats.user_id)
      UNION ALL
      SELECT scheduler.user_id FROM subscription_scheduler_state AS scheduler
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = scheduler.user_id)
    )
  `, [], countRowSchema.parse);
  if (Number(aggregateOrphans?.count ?? 0) !== 0) throw new Error("subscription aggregate owner invariant failed");

  const [schedulerMismatch] = await client.query(`
    SELECT COUNT(*) AS count
    FROM users
    LEFT JOIN subscription_scheduler_state AS scheduler ON scheduler.user_id = users.id
    WHERE scheduler.user_id IS NULL
    OR scheduler.auto_renew_count != (
      SELECT COUNT(*) FROM subscriptions WHERE user_id = scheduler.user_id AND auto_renew = 1
    ) OR scheduler.repeat_reminder_count != (
      SELECT COUNT(*) FROM subscriptions WHERE user_id = scheduler.user_id AND repeat_reminder_enabled = 1
    ) OR COALESCE(scheduler.next_repeat_notification_due_at_utc, '') != COALESCE((
      SELECT next_due_at_utc FROM subscription_repeat_schedule
      WHERE user_id = scheduler.user_id ORDER BY next_due_at_utc, subscription_id LIMIT 1
    ), '')
    OR (scheduler.auto_renew_count = 0 AND scheduler.next_auto_renew_check_at_utc IS NOT NULL)
    OR (scheduler.auto_renew_count > 0 AND scheduler.next_auto_renew_check_at_utc IS NULL)
    OR (
      scheduler.next_daily_notification_due_at_utc IS NULL
      AND EXISTS (SELECT 1 FROM subscriptions WHERE user_id = scheduler.user_id)
    )
    OR (scheduler.next_auto_renew_check_at_utc IS NOT NULL AND unixepoch(scheduler.next_auto_renew_check_at_utc) IS NULL)
    OR (
      scheduler.next_daily_notification_due_at_utc IS NOT NULL
      AND unixepoch(scheduler.next_daily_notification_due_at_utc) IS NULL
    )
    OR (
      scheduler.next_repeat_notification_due_at_utc IS NOT NULL
      AND unixepoch(scheduler.next_repeat_notification_due_at_utc) IS NULL
    )
  `, [], countRowSchema.parse);
  if (Number(schedulerMismatch?.count ?? 0) !== 0) throw new Error("subscription_scheduler_state invariant failed");

  if (expectedScheduleCount !== undefined) {
    const [scheduleCount] = await client.query(
      "SELECT COUNT(*) AS count FROM subscription_repeat_schedule",
      [],
      countRowSchema.parse,
    );
    if (Number(scheduleCount?.count ?? 0) !== expectedScheduleCount) {
      throw new Error(`subscription_repeat_schedule count mismatch: expected ${expectedScheduleCount}`);
    }
  }
}

async function assertForeignKeys(client: D1Client): Promise<void> {
  const violations = await client.query("PRAGMA foreign_key_check", [], (value): unknown => value);
  if (violations.length > 0) throw new Error("Cloudflare D1 foreign key check found violations");
}

async function upsertSchedulerRows(client: D1Client, now: Date): Promise<void> {
  // repeat schedule 先逐订阅落库，再由索引最小值汇总用户级 next due，避免聚合指向尚未写完的分页。
  let cursorUserId = "";
  for (;;) {
    const rows = await client.query(`
      SELECT
        users.id AS user_id,
        settings.settings_json,
        COALESCE(scheduler.last_auto_renew_local_date, '') AS last_auto_renew_local_date,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND auto_renew = 1) AS auto_renew_count,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND repeat_reminder_enabled = 1) AS repeat_reminder_count,
        (SELECT next_due_at_utc FROM subscription_repeat_schedule
         WHERE user_id = users.id ORDER BY next_due_at_utc, subscription_id LIMIT 1) AS next_repeat_notification_due_at_utc
      FROM users
      LEFT JOIN settings ON settings.user_id = users.id
      LEFT JOIN subscription_scheduler_state AS scheduler ON scheduler.user_id = users.id
      WHERE users.id > ?
      ORDER BY users.id
      LIMIT ?
    `, [cursorUserId, pageSize], (value): SchedulerBackfillRow => schedulerBackfillRowSchema.parse(value));
    if (rows.length === 0) return;

    const statements = rows.map((row): D1Statement => {
      const settings = settingsFromRowJson(row.settings_json);
      const autoRenewCount = Number(row.auto_renew_count) || 0;
      const repeatReminderCount = Number(row.repeat_reminder_count) || 0;
      const lastAutoRenewLocalDate = row.last_auto_renew_local_date ?? "";
      const timestamp = toRfc3339Seconds(now);
      return {
        sql: `INSERT INTO subscription_scheduler_state (
                user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
                next_auto_renew_check_at_utc, next_daily_notification_due_at_utc,
                next_repeat_notification_due_at_utc, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                auto_renew_count = excluded.auto_renew_count,
                repeat_reminder_count = excluded.repeat_reminder_count,
                last_auto_renew_local_date = excluded.last_auto_renew_local_date,
                next_auto_renew_check_at_utc = excluded.next_auto_renew_check_at_utc,
                next_daily_notification_due_at_utc = excluded.next_daily_notification_due_at_utc,
                next_repeat_notification_due_at_utc = excluded.next_repeat_notification_due_at_utc,
                updated_at = excluded.updated_at`,
        params: [
          row.user_id,
          autoRenewCount,
          repeatReminderCount,
          lastAutoRenewLocalDate,
          nextAutoRenewCheckAt(now, settings.timezone, autoRenewCount, lastAutoRenewLocalDate),
          nextDailyNotificationDueAt(now, settings.timezone, settings.notificationTimeLocal, notificationWindowMinutes),
          row.next_repeat_notification_due_at_utc,
          timestamp,
          timestamp,
        ],
      };
    });
    await writeStatements(client, statements);
    cursorUserId = requireLast(rows, "Scheduler backfill").user_id;
    if (rows.length < pageSize) return;
  }
}

async function upsertStatsRows(client: D1Client, now: Date): Promise<void> {
  let cursorUserId = "";
  const timestamp = toRfc3339Seconds(now);
  for (;;) {
    const users = await client.query(
      "SELECT id AS name FROM users WHERE id > ? ORDER BY id LIMIT ?",
      [cursorUserId, pageSize],
      migrationRowSchema.parse,
    );
    if (users.length === 0) return;
    await writeStatements(client, users.map((user): D1Statement => ({
      sql: `INSERT INTO subscription_user_stats (
              user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count,
              created_at, updated_at
            )
            SELECT
              users.id,
              (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id),
              (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'trial'),
              (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'active'),
              (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'expired'),
              (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'paused'),
              (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'cancelled'),
              ?, ?
            FROM users WHERE users.id = ?
            ON CONFLICT(user_id) DO UPDATE SET
              total_count = excluded.total_count,
              trial_count = excluded.trial_count,
              active_count = excluded.active_count,
              expired_count = excluded.expired_count,
              paused_count = excluded.paused_count,
              cancelled_count = excluded.cancelled_count,
              updated_at = excluded.updated_at`,
      params: [timestamp, timestamp, user.name],
    })));
    cursorUserId = requireLast(users, "Subscription stats backfill").name;
    if (users.length < pageSize) return;
  }
}

async function removeOrphanedDerivedRows(client: D1Client): Promise<void> {
  // owner 错配和孤儿行都是可从 facts 重建的派生数据，只允许在这些表内清理；subscriptions、users 和 Feed 不属于修复目标。
  await writeStatements(client, [
    {
      sql: `DELETE FROM subscription_list_index
            WHERE NOT EXISTS (
              SELECT 1 FROM subscriptions
              WHERE subscriptions.id = subscription_list_index.subscription_id
                AND subscriptions.user_id = subscription_list_index.user_id
            )`,
    },
    {
      sql: `DELETE FROM subscription_tags
            WHERE NOT EXISTS (
              SELECT 1 FROM subscriptions
              WHERE subscriptions.id = subscription_tags.subscription_id
                AND subscriptions.user_id = subscription_tags.user_id
            )`,
    },
    {
      sql: `DELETE FROM subscription_repeat_schedule
            WHERE NOT EXISTS (
              SELECT 1 FROM subscriptions
              WHERE subscriptions.id = subscription_repeat_schedule.subscription_id
                AND subscriptions.user_id = subscription_repeat_schedule.user_id
            )`,
    },
    { sql: "DELETE FROM subscription_user_stats WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = subscription_user_stats.user_id)" },
    { sql: "DELETE FROM subscription_scheduler_state WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = subscription_scheduler_state.user_id)" },
  ]);
}

interface DerivedRebuildResult {
  now: Date;
  processed: number;
  expectedScheduleCount: number;
}

async function rebuildDerivedState(client: D1Client, now: Date): Promise<DerivedRebuildResult> {
  // 复合游标保证跨用户分页稳定；每类派生写都以事实主键 UPSERT/DELETE，可从任意中断点整轮重放。
  let cursorUserId = "";
  let cursorSubscriptionId = "";
  let processed = 0;
  let expectedScheduleCount = 0;
  for (;;) {
    // 所有游标和写入值都保留为结构化 params；remote 绑定、local 类型化编码，两条路径都不记录账本 SQL。
    const rows = await client.query(`
      SELECT subscriptions.*, settings.settings_json
      FROM subscriptions
      LEFT JOIN settings ON settings.user_id = subscriptions.user_id
      WHERE subscriptions.user_id > ?
         OR (subscriptions.user_id = ? AND subscriptions.id > ?)
      ORDER BY subscriptions.user_id, subscriptions.id
      LIMIT ?
    `, [cursorUserId, cursorUserId, cursorSubscriptionId, pageSize], (value): SubscriptionBackfillRow => (
      subscriptionBackfillRowSchema.parse(value)
    ));
    if (rows.length === 0) break;

    const statements: D1Statement[] = [];
    for (const row of rows) {
      const tags = normalizeSubscriptionTags(row);
      statements.push({
        sql: SUBSCRIPTION_LIST_INDEX_UPSERT_SQL,
        params: subscriptionListProjectionValues(row, tags),
      });
      statements.push({
        sql: "DELETE FROM subscription_tags WHERE user_id = ? AND subscription_id = ?",
        params: [row.user_id, row.id],
      });
      statements.push(...tags.map((tag): D1Statement => ({
        sql: SUBSCRIPTION_TAG_UPSERT_SQL,
        params: [row.user_id, row.id, tag.key, tag.value, row.created_at, row.updated_at],
      })));
      const dueAt = nextRepeatDue(row, now);
      if (dueAt) {
        expectedScheduleCount += 1;
        statements.push({
          sql: `INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id, subscription_id) DO UPDATE SET next_due_at_utc = excluded.next_due_at_utc`,
          params: [row.user_id, row.id, dueAt],
        });
      } else {
        statements.push({
          sql: "DELETE FROM subscription_repeat_schedule WHERE user_id = ? AND subscription_id = ?",
          params: [row.user_id, row.id],
        });
      }
    }
    await writeStatements(client, statements);
    processed += rows.length;
    const last = requireLast(rows, "Subscription schedule backfill");
    cursorUserId = last.user_id;
    cursorSubscriptionId = last.id;
    if (rows.length < pageSize) break;
  }

  await removeOrphanedDerivedRows(client);
  await upsertStatsRows(client, now);
  await upsertSchedulerRows(client, now);
  return { now, processed, expectedScheduleCount };
}

/**
 * 将 canonical v3 schema 收敛到 subscriptions 事实状态，并在全部不变量通过后最后写 marker。
 * mixed schema 在任何写入前阻断；已有 v3 marker 时只复验、不静默改写。所有重建写入均可在 D1 已提交但响应丢失后整轮重放。
 */
export async function runBackfill(
  client: D1Client,
  now: () => Date = () => new Date(),
): Promise<void> {
  const state = await probeDerivedBackfillState(client);
  console.log(`Cloudflare subscription derived-state schema state: ${state}`);
  let rebuilt: DerivedRebuildResult | undefined;

  await executeDerivedBackfillState(state, {
    rebuild: async (): Promise<void> => {
      // 整轮固定同一 now，保证写入与复算校验跨分页时不会因分钟窗口滚动产生假不一致。
      rebuilt = await rebuildDerivedState(client, now());
    },
    verify: async (): Promise<void> => {
      const verifiedProjections = await assertSubscriptionCollectionProjectionRows(client, pageSize);
      if (state === "v3-complete") {
        const verificationNow = now();
        await assertStoredSchedulesValid(client, verificationNow);
        await assertStoredSubscriptionSchedulerRowsValid(client, verificationNow, pageSize, notificationWindowMinutes);
        await assertDerivedInvariants(client);
        await assertForeignKeys(client);
        console.log(`Cloudflare subscription collection projections verified: subscriptions=${verifiedProjections}`);
        return;
      }
      const current = rebuilt;
      if (current === undefined) throw new Error("Derived-state verification started before rebuild");
      const verifiedScheduleCount = await assertBackfilledSchedules(client, current.now);
      if (verifiedScheduleCount !== current.expectedScheduleCount) {
        throw new Error(
          `subscription_repeat_schedule verification mismatch: expected ${current.expectedScheduleCount}, verified ${verifiedScheduleCount}`,
        );
      }
      await assertSubscriptionSchedulerRows(client, current.now, pageSize, notificationWindowMinutes);
      await assertDerivedInvariants(client, verifiedScheduleCount);
      await assertForeignKeys(client);
    },
    markComplete: async (): Promise<void> => {
      const current = rebuilt;
      if (current === undefined) throw new Error("Derived-state completion marker started before rebuild");
      // completion marker 是最后一次独立提交；响应丢失后的重跑会先校验 marker 和全部派生不变量。
      await client.batch([{
        sql: `INSERT INTO subscription_derived_backfills (name, completed_at) VALUES (?, ?)
              ON CONFLICT(name) DO UPDATE SET completed_at = excluded.completed_at`,
        params: [backfillName, current.now.toISOString()],
      }]);
    },
  });

  if (state === "v3-complete") {
    console.log("Cloudflare subscription derived-state backfill already complete; invariants passed.");
    return;
  }
  const completed = rebuilt;
  if (completed === undefined) throw new Error("Derived-state backfill completed without rebuild evidence");
  console.log(
    `Cloudflare subscription derived-state backfill complete: subscriptions=${completed.processed}, schedules=${completed.expectedScheduleCount}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runBackfill(createD1OperationsClient(options));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
