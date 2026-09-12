import { z } from "zod";
import { isValidDateOnly } from "../packages/shared/src/runtime";
import { settingsFromRowJson } from "../apps/worker/src/db";
import {
  addDays,
  dateOnlyInZone,
  getLocalScheduleDecision,
  getNextLocalScheduleOccurrence,
  scheduleOccurrence,
  toRfc3339Seconds,
} from "../apps/worker/src/notification-schedule";
import type { D1Client } from "./cloudflare-d1-client";

const schedulerVerificationRowSchema = z.object({
  user_id: z.string(),
  settings_json: z.string().nullable(),
  stored_auto_renew_count: z.union([z.number(), z.string()]),
  stored_repeat_reminder_count: z.union([z.number(), z.string()]),
  last_auto_renew_local_date: z.string(),
  stored_next_auto_renew_check_at_utc: z.string().nullable(),
  stored_next_daily_notification_due_at_utc: z.string().nullable(),
  stored_next_repeat_notification_due_at_utc: z.string().nullable(),
  fact_auto_renew_count: z.union([z.number(), z.string()]),
  fact_repeat_reminder_count: z.union([z.number(), z.string()]),
  fact_subscription_count: z.union([z.number(), z.string()]),
  fact_next_repeat_notification_due_at_utc: z.string().nullable(),
});

/** 重建自动续订 due：本地当天未处理则立即补检查，已处理则推进到下一本地日，防止部署触发二次续订。 */
export function nextAutoRenewCheckAt(
  now: Date,
  timezone: string,
  autoRenewCount: number,
  lastAutoRenewLocalDate: string,
): string | null {
  if (autoRenewCount <= 0) return null;
  const today = dateOnlyInZone(now, timezone);
  // 当天已执行过自动续订时推迟到下一本地日，避免 backfill 部署立即触发同日第二次续订。
  if (lastAutoRenewLocalDate !== today) return toRfc3339Seconds(now);
  return scheduleOccurrence(addDays(today, 1), "00:00", timezone).scheduledInstantUtc;
}

/** 重建每日通知 due：当前容差窗口内保留本次 occurrence，窗口外才推进到下一次。 */
export function nextDailyNotificationDueAt(
  now: Date,
  timezone: string,
  localTime: string,
  windowMinutes: number,
): string {
  // 当前仍在容差窗口时保留本次 occurrence，否则直接指向下一次，避免迁移把刚到期提醒跳过一天。
  const current = getLocalScheduleDecision(now, timezone, localTime, windowMinutes, false);
  if (current.due) return current.scheduledInstantUtc;
  return getNextLocalScheduleOccurrence(now, timezone, localTime).scheduledInstantUtc;
}

function canonicalInstant(value: string): Date | null {
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && toRfc3339Seconds(instant) === value ? instant : null;
}

function storedAutoRenewOccurrenceValid(
  value: string | null,
  autoRenewCount: number,
  lastAutoRenewLocalDate: string,
  timezone: string,
  now: Date,
  windowMinutes: number,
): boolean {
  const today = dateOnlyInZone(now, timezone);
  // 设置从 UTC+14 切到 UTC-12 时，旧本地日期最多领先新时区两天；更远的未来值不是合法 timezone 过渡。
  if (lastAutoRenewLocalDate !== ""
    && (!isValidDateOnly(lastAutoRenewLocalDate) || lastAutoRenewLocalDate > addDays(today, 2))) {
    return false;
  }
  if (autoRenewCount <= 0) return value === null;
  if (value === null) return false;
  const instant = canonicalInstant(value);
  if (!instant) return false;
  if (lastAutoRenewLocalDate !== today) {
    return instant.getTime() <= now.getTime() + Math.max(windowMinutes, 0) * 60_000;
  }
  return value === scheduleOccurrence(addDays(lastAutoRenewLocalDate, 1), "00:00", timezone).scheduledInstantUtc;
}

function storedDailyOccurrenceValid(value: string | null, timezone: string, localTime: string, now: Date): boolean {
  if (value === null) return false;
  const instant = canonicalInstant(value);
  if (!instant) return false;
  // 已完成态允许仍待重试的历史 occurrence，但拒绝超过下一本地日的未来值和不匹配当前设置的时刻。
  const localDate = dateOnlyInZone(instant, timezone);
  if (localDate > addDays(dateOnlyInZone(now, timezone), 1)) return false;
  return value === scheduleOccurrence(localDate, localTime, timezone).scheduledInstantUtc;
}

/**
 * 复验已有 v3 marker 的 scheduler：合法逾期值可能代表失败重试，不能按当前 now 强制改写成新的 due。
 * 聚合计数和 repeat 最小值仍必须与 subscriptions/repeat schedule 双向一致。
 */
export async function assertStoredSubscriptionSchedulerRowsValid(
  client: D1Client,
  now: Date,
  pageSize: number,
  notificationWindowMinutes: number,
): Promise<void> {
  let cursorUserId = "";
  for (;;) {
    const rows = await client.query(`
      SELECT
        users.id AS user_id,
        settings.settings_json,
        scheduler.auto_renew_count AS stored_auto_renew_count,
        scheduler.repeat_reminder_count AS stored_repeat_reminder_count,
        scheduler.last_auto_renew_local_date,
        scheduler.next_auto_renew_check_at_utc AS stored_next_auto_renew_check_at_utc,
        scheduler.next_daily_notification_due_at_utc AS stored_next_daily_notification_due_at_utc,
        scheduler.next_repeat_notification_due_at_utc AS stored_next_repeat_notification_due_at_utc,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND auto_renew = 1) AS fact_auto_renew_count,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND repeat_reminder_enabled = 1)
          AS fact_repeat_reminder_count,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id) AS fact_subscription_count,
        (SELECT next_due_at_utc FROM subscription_repeat_schedule
         WHERE user_id = users.id ORDER BY next_due_at_utc, subscription_id LIMIT 1)
          AS fact_next_repeat_notification_due_at_utc
      FROM users
      LEFT JOIN settings ON settings.user_id = users.id
      LEFT JOIN subscription_scheduler_state AS scheduler ON scheduler.user_id = users.id
      WHERE users.id > ?
      ORDER BY users.id
      LIMIT ?
    `, [cursorUserId, pageSize], schedulerVerificationRowSchema.parse);
    if (rows.length === 0) return;
    for (const row of rows) {
      const settings = settingsFromRowJson(row.settings_json);
      const autoRenewCount = Number(row.fact_auto_renew_count);
      const repeatReminderCount = Number(row.fact_repeat_reminder_count);
      const subscriptionCount = Number(row.fact_subscription_count);
      const dailyOccurrenceValid = row.stored_next_daily_notification_due_at_utc === null
        ? subscriptionCount === 0
        : storedDailyOccurrenceValid(
          row.stored_next_daily_notification_due_at_utc,
          settings.timezone,
          settings.notificationTimeLocal,
          now,
        );
      if (
        Number(row.stored_auto_renew_count) !== autoRenewCount
        || Number(row.stored_repeat_reminder_count) !== repeatReminderCount
        || !storedAutoRenewOccurrenceValid(
          row.stored_next_auto_renew_check_at_utc,
          autoRenewCount,
          row.last_auto_renew_local_date,
          settings.timezone,
          now,
          notificationWindowMinutes,
        )
        || !dailyOccurrenceValid
        || row.stored_next_repeat_notification_due_at_utc !== row.fact_next_repeat_notification_due_at_utc
      ) {
        throw new Error("subscription_scheduler_state stored occurrence invariant failed");
      }
    }
    const last = rows.at(-1);
    if (!last) throw new Error("Stored subscription scheduler verification returned an empty page");
    cursorUserId = last.user_id;
    if (rows.length < pageSize) return;
  }
}

/** 新建 v3 marker 前按本轮冻结的 now 精确核对刚重建的 scheduler，防止分页跨分钟产生漂移。 */
export async function assertSubscriptionSchedulerRows(
  client: D1Client,
  now: Date,
  pageSize: number,
  notificationWindowMinutes: number,
): Promise<void> {
  let cursorUserId = "";
  for (;;) {
    const rows = await client.query(`
      SELECT
        users.id AS user_id,
        settings.settings_json,
        scheduler.auto_renew_count AS stored_auto_renew_count,
        scheduler.repeat_reminder_count AS stored_repeat_reminder_count,
        scheduler.last_auto_renew_local_date,
        scheduler.next_auto_renew_check_at_utc AS stored_next_auto_renew_check_at_utc,
        scheduler.next_daily_notification_due_at_utc AS stored_next_daily_notification_due_at_utc,
        scheduler.next_repeat_notification_due_at_utc AS stored_next_repeat_notification_due_at_utc,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND auto_renew = 1) AS fact_auto_renew_count,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND repeat_reminder_enabled = 1)
          AS fact_repeat_reminder_count,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id) AS fact_subscription_count,
        (SELECT next_due_at_utc FROM subscription_repeat_schedule
         WHERE user_id = users.id ORDER BY next_due_at_utc, subscription_id LIMIT 1)
          AS fact_next_repeat_notification_due_at_utc
      FROM users
      LEFT JOIN settings ON settings.user_id = users.id
      LEFT JOIN subscription_scheduler_state AS scheduler ON scheduler.user_id = users.id
      WHERE users.id > ?
      ORDER BY users.id
      LIMIT ?
    `, [cursorUserId, pageSize], schedulerVerificationRowSchema.parse);
    if (rows.length === 0) return;
    for (const row of rows) {
      const settings = settingsFromRowJson(row.settings_json);
      const autoRenewCount = Number(row.fact_auto_renew_count);
      const repeatReminderCount = Number(row.fact_repeat_reminder_count);
      if (
        Number(row.stored_auto_renew_count) !== autoRenewCount
        || Number(row.stored_repeat_reminder_count) !== repeatReminderCount
        || row.stored_next_auto_renew_check_at_utc !== nextAutoRenewCheckAt(
          now,
          settings.timezone,
          autoRenewCount,
          row.last_auto_renew_local_date,
        )
        || row.stored_next_daily_notification_due_at_utc !== nextDailyNotificationDueAt(
          now,
          settings.timezone,
          settings.notificationTimeLocal,
          notificationWindowMinutes,
        )
        || row.stored_next_repeat_notification_due_at_utc !== row.fact_next_repeat_notification_due_at_utc
      ) {
        throw new Error("subscription_scheduler_state value invariant failed");
      }
    }
    const last = rows.at(-1);
    if (!last) throw new Error("Subscription scheduler verification returned an empty page");
    cursorUserId = last.user_id;
    if (rows.length < pageSize) return;
  }
}
