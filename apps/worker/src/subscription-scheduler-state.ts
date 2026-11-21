import { ordinaryRemindersAllowed } from "@renewlet/shared/runtime";
import { getSettings, listRepeatReminderCandidateSubscriptions, nowIso, toApiSubscription } from "./db";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { NOTIFICATION_CRON_WINDOW_MINUTES } from "./notification-jobs";
import {
  addDays,
  dateOnlyInZone,
  getLocalScheduleDecision,
  getNextLocalScheduleOccurrence,
  getNextRepeatScheduleOccurrence,
  getRepeatScheduleDecision,
  scheduleOccurrence,
  toRfc3339Seconds,
} from "./notification-schedule";
import type { Env, SubscriptionSchedulerStateRow } from "./types";
import type { SubscriptionRow } from "./types";

// scheduler state 是 Cron 的用户级候选索引，不是通知幂等事实源；普通订阅 mutation 只能增量维护计数与单行 schedule。
// 用户级 DELETE/rebuild 仅允许设置时区或提醒规则变化、迁移和离线修复调用。

const emptySchedulerState: Omit<SubscriptionSchedulerStateRow, "user_id"> = {
  auto_renew_count: 0,
  repeat_reminder_count: 0,
  last_auto_renew_local_date: "",
  next_auto_renew_check_at_utc: null,
  next_daily_notification_due_at_utc: null,
  next_repeat_notification_due_at_utc: null,
  created_at: "",
  updated_at: "",
};

/** 读取空状态时立即补建，保证新用户也能进入 due-index，而不是依赖下一次订阅写入。 */
export async function getSubscriptionSchedulerState(env: Env, userId: string): Promise<SubscriptionSchedulerStateRow> {
  const row = await readSubscriptionSchedulerState(env, userId);
  if (row) return normalizeSchedulerState(row);
  await refreshSubscriptionSchedulerState(env, userId, { resetAutoRenewCheck: false });
  return normalizeSchedulerState(await readSubscriptionSchedulerState(env, userId) ?? { user_id: userId, ...emptySchedulerState });
}

export async function refreshSubscriptionSchedulerState(
  env: Env,
  userId: string,
  options: SubscriptionSchedulerRefreshOptions = {},
): Promise<void> {
  const statements = await buildSubscriptionSchedulerRefreshStatements(env, userId, options);
  // schedule 行和绝对 aggregate 在同一事务提交；设置变更失败时不能留下新时区 schedule 配旧 scheduler。
  if (statements.length > 0) await env.DB.batch(statements);
}

export interface SubscriptionSchedulerRefreshOptions {
  resetAutoRenewCheck?: boolean;
  now?: Date;
  skipCurrentNotificationWindow?: boolean;
  repeatCandidates?: ApiSubscription[];
  settings?: ApiAppSettings;
  aggregateCounts?: { autoRenewCount: number; repeatReminderCount: number };
}

export async function buildSubscriptionSchedulerRefreshStatements(
  env: Env,
  userId: string,
  options: SubscriptionSchedulerRefreshOptions = {},
): Promise<D1PreparedStatement[]> {
  if (!userId) return [];
  const now = options.now ?? new Date();
  const current = options.resetAutoRenewCheck === true ? null : await readSubscriptionSchedulerState(env, userId);
  // 订阅写入会改变“今天是否已检查自动续订”的含义；重算 gate 时清空日期，让下一次 due-index 能重新判定新数据。
  const lastAutoRenewLocalDate = options.resetAutoRenewCheck === true
    ? ""
    : normalizeSchedulerState(current ?? { user_id: userId, ...emptySchedulerState }).last_auto_renew_local_date;
  const counts = options.aggregateCounts ?? await env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN auto_renew = 1 THEN 1 ELSE 0 END), 0) AS autoRenewCount,
        COALESCE(SUM(CASE WHEN repeat_reminder_enabled = 1 AND status NOT IN ('paused', 'cancelled') THEN 1 ELSE 0 END), 0) AS repeatReminderCount
      FROM subscriptions
      WHERE user_id = ?
    `).bind(userId).first<{ autoRenewCount: number; repeatReminderCount: number }>();
  const autoRenewCount = numberValue(counts?.autoRenewCount ?? 0);
  const repeatReminderCount = numberValue(counts?.repeatReminderCount ?? 0);
  const settings = options.settings ?? await getSettings(env, userId);
  // 这个入口只用于缺失状态、设置变化和离线重建；普通 mutation 与通知推进不得做用户级 schedule DELETE。
  const statements = await subscriptionRepeatScheduleRebuildStatements(env, userId, now, settings, options.repeatCandidates);
  statements.push(subscriptionSchedulerAggregateStatement(env, {
    userId,
    autoRenewCount,
    repeatReminderCount,
    lastAutoRenewLocalDate,
    settings,
    now,
    skipCurrentNotificationWindow: options.skipCurrentNotificationWindow === true,
  }));
  return statements;
}

export function subscriptionSchedulerAggregateStatement(
  env: Env,
  input: {
    userId: string;
    autoRenewCount: number;
    repeatReminderCount: number;
    lastAutoRenewLocalDate: string;
    settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal">;
    now: Date;
    skipCurrentNotificationWindow: boolean;
  },
): D1PreparedStatement {
  const timestamp = toRfc3339Seconds(input.now);
  const nextAutoRenewCheck = nextAutoRenewCheckAt(
    input.now,
    input.settings.timezone,
    input.autoRenewCount,
    input.lastAutoRenewLocalDate,
  );
  const nextDailyNotificationDue = nextDailyNotificationDueAt(
    input.now,
    input.settings.timezone,
    input.settings.notificationTimeLocal,
    input.skipCurrentNotificationWindow,
  );
  // count 是候选查询 gate，next_* 是 Cron 用户枚举索引；repeat MIN 读取本 batch 前序写入后的行集。
  return env.DB.prepare(`
    INSERT INTO subscription_scheduler_state (
      user_id,
      auto_renew_count,
      repeat_reminder_count,
      last_auto_renew_local_date,
      next_auto_renew_check_at_utc,
      next_daily_notification_due_at_utc,
      next_repeat_notification_due_at_utc,
      created_at,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      (SELECT next_due_at_utc FROM subscription_repeat_schedule
       WHERE user_id = ? ORDER BY next_due_at_utc, subscription_id LIMIT 1),
      ?, ?
    )
    ON CONFLICT(user_id) DO UPDATE SET
      auto_renew_count = excluded.auto_renew_count,
      repeat_reminder_count = excluded.repeat_reminder_count,
      last_auto_renew_local_date = excluded.last_auto_renew_local_date,
      next_auto_renew_check_at_utc = excluded.next_auto_renew_check_at_utc,
      next_daily_notification_due_at_utc = excluded.next_daily_notification_due_at_utc,
      next_repeat_notification_due_at_utc = excluded.next_repeat_notification_due_at_utc,
      updated_at = excluded.updated_at
  `).bind(
    input.userId,
    input.autoRenewCount,
    input.repeatReminderCount,
    input.lastAutoRenewLocalDate,
    nextAutoRenewCheck,
    nextDailyNotificationDue,
    input.userId,
    timestamp,
    timestamp,
  );
}

export async function advanceSubscriptionSchedulerDueState(
  env: Env,
  userId: string,
  now: Date,
  skipCurrentNotificationWindow: boolean,
  repeatCandidates: ApiSubscription[] = [],
): Promise<void> {
  const settings = await getSettings(env, userId);
  const schedules = repeatCandidates.map((candidate) => [candidate.id, nextRepeatNotificationDueForCandidates(now, settings, [candidate], skipCurrentNotificationWindow)]);
  // 提醒完成时一次推进整组候选；逐订阅SQL会让1000条repeat超过Free单次50查询限额。
  const statements: D1PreparedStatement[] = schedules.length > 0 ? [
    env.DB.prepare(`DELETE FROM subscription_repeat_schedule
      WHERE user_id = ? AND subscription_id IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`)
      .bind(userId, JSON.stringify(schedules)),
    env.DB.prepare(`INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
      SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
      WHERE json_extract(value, '$[1]') IS NOT NULL`).bind(userId, JSON.stringify(schedules)),
  ] : [];
  statements.push(env.DB.prepare(`
      UPDATE subscription_scheduler_state
      SET next_daily_notification_due_at_utc = ?,
          next_repeat_notification_due_at_utc = (
            SELECT next_due_at_utc FROM subscription_repeat_schedule
            WHERE user_id = ? ORDER BY next_due_at_utc, subscription_id LIMIT 1
          ),
          updated_at = ?
      WHERE user_id = ?
    `).bind(
    nextDailyNotificationDueAt(now, settings.timezone, settings.notificationTimeLocal, skipCurrentNotificationWindow),
    userId,
    nowIso(),
    userId,
  ));
  // 候选行和聚合 MIN 必须在同一 D1 batch；否则下一个 Cron tick 可能读到半更新的 due-index。
  const results = await env.DB.batch(statements);
  const result = results[results.length - 1];
  if ((result?.meta.changes ?? 0) > 0) return;
  // 新账号缺行时才允许完整初始化；正常 Cron 永远命中已由 setup/settings 建好的 scheduler 行。
  await refreshSubscriptionSchedulerState(env, userId, { resetAutoRenewCheck: false, now, skipCurrentNotificationWindow });
}

export function subscriptionSchedulerMutationStatement(
  env: Env,
  mutation: { before: SubscriptionRow | null; after: SubscriptionRow | null },
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal">,
  now: Date,
): D1PreparedStatement {
  const row = mutation.after ?? mutation.before;
  if (!row) throw new Error("subscription scheduler mutation requires a row");
  const autoDelta = Number(mutation.after?.auto_renew === 1) - Number(mutation.before?.auto_renew === 1);
  const repeatDelta = subscriptionRepeatReminderContribution(mutation.after) - subscriptionRepeatReminderContribution(mutation.before);
  return subscriptionSchedulerDeltaStatement(env, row.user_id, autoDelta, repeatDelta, settings, now);
}

/** scheduler count 与 repeat schedule 必须排除暂停及取消记录，状态切换才能产生对称 delta。 */
export function subscriptionRepeatReminderContribution(
  row: Pick<SubscriptionRow, "status" | "repeat_reminder_enabled"> | null,
): number {
  return row?.repeat_reminder_enabled === 1 && ordinaryRemindersAllowed(row.status) ? 1 : 0;
}

export function subscriptionSchedulerDeltaStatement(
  env: Env,
  userId: string,
  autoDelta: number,
  repeatDelta: number,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal">,
  now: Date,
): D1PreparedStatement {
  const timestamp = toRfc3339Seconds(now);
  const nextDaily = nextDailyNotificationDueAt(now, settings.timezone, settings.notificationTimeLocal, false);
  // repeat schedule statement 在本条 SQL 前执行；同一 D1 batch 内的 MIN 能看到 mutation 后的最终行集。
  return env.DB.prepare(`
    UPDATE subscription_scheduler_state SET
      auto_renew_count = CASE
        WHEN auto_renew_count + ? >= 0 THEN auto_renew_count + ?
        ELSE json('SUBSCRIPTION_DERIVED_SCHEDULER_INVALID')
      END,
      repeat_reminder_count = CASE
        WHEN repeat_reminder_count + ? >= 0 THEN repeat_reminder_count + ?
        ELSE json('SUBSCRIPTION_DERIVED_SCHEDULER_INVALID')
      END,
      last_auto_renew_local_date = '',
      next_auto_renew_check_at_utc = CASE
        WHEN auto_renew_count + ? > 0 THEN ?
        ELSE NULL
      END,
      next_daily_notification_due_at_utc = ?,
      next_repeat_notification_due_at_utc = (
        SELECT next_due_at_utc FROM subscription_repeat_schedule
        WHERE user_id = ? ORDER BY next_due_at_utc, subscription_id LIMIT 1
      ),
      updated_at = ?
    WHERE user_id = ?
  `).bind(
    autoDelta,
    autoDelta,
    repeatDelta,
    repeatDelta,
    autoDelta,
    timestamp,
    nextDaily,
    userId,
    timestamp,
    userId,
  );
}

export async function markAutoRenewCheckedForLocalDate(env: Env, userId: string, localDate: string): Promise<void> {
  if (!userId || !localDate) return;
  const settings = await getSettings(env, userId);
  // 自动续订按用户本地日期幂等；检查完成后推进到下一次本地零点，避免同一天每分钟重复查 due 订阅。
  const nextCheck = scheduleOccurrence(addDays(localDate, 1), "00:00", settings.timezone).scheduledInstantUtc;
  const result = await env.DB.prepare(`
    UPDATE subscription_scheduler_state
    SET last_auto_renew_local_date = ?, next_auto_renew_check_at_utc = ?, updated_at = ?
    WHERE user_id = ?
  `).bind(localDate, nextCheck, nowIso(), userId).run();
  if ((result.meta.changes ?? 0) > 0) return;
  await refreshSubscriptionSchedulerState(env, userId, { resetAutoRenewCheck: false });
  await env.DB.prepare(`
    UPDATE subscription_scheduler_state
    SET last_auto_renew_local_date = ?, next_auto_renew_check_at_utc = ?, updated_at = ?
    WHERE user_id = ?
  `).bind(localDate, nextCheck, nowIso(), userId).run();
}

async function readSubscriptionSchedulerState(env: Env, userId: string): Promise<SubscriptionSchedulerStateRow | null> {
  if (!userId) return null;
  return await env.DB.prepare(`
    SELECT
      user_id,
      auto_renew_count,
      repeat_reminder_count,
      last_auto_renew_local_date,
      next_auto_renew_check_at_utc,
      next_daily_notification_due_at_utc,
      next_repeat_notification_due_at_utc,
      created_at,
      updated_at
    FROM subscription_scheduler_state
    WHERE user_id = ?
  `).bind(userId).first<SubscriptionSchedulerStateRow>();
}

function normalizeSchedulerState(row: SubscriptionSchedulerStateRow): SubscriptionSchedulerStateRow {
  return {
    ...row,
    auto_renew_count: numberValue(row.auto_renew_count),
    repeat_reminder_count: numberValue(row.repeat_reminder_count),
    last_auto_renew_local_date: row.last_auto_renew_local_date ?? "",
    next_auto_renew_check_at_utc: row.next_auto_renew_check_at_utc ?? null,
    next_daily_notification_due_at_utc: row.next_daily_notification_due_at_utc ?? null,
    next_repeat_notification_due_at_utc: row.next_repeat_notification_due_at_utc ?? null,
  };
}

function nextAutoRenewCheckAt(now: Date, timezone: string, autoRenewCount: number, lastAutoRenewLocalDate: string): string | null {
  if (autoRenewCount <= 0) return null;
  const today = dateOnlyInZone(now, timezone);
  if (lastAutoRenewLocalDate !== today) return toRfc3339Seconds(now);
  return scheduleOccurrence(addDays(today, 1), "00:00", timezone).scheduledInstantUtc;
}

function nextDailyNotificationDueAt(now: Date, timezone: string, localTime: string, skipCurrentWindow: boolean): string {
  // 只有通知 job 已收敛时才跳过当前 2 分钟窗口；失败或 sending 状态会保留旧 due 供下一分钟重试。
  // 续接使用冻结的窗口instant；完成后必须严格推进，不能依赖真实时钟越过整分钟。
  if (skipCurrentWindow) return getNextLocalScheduleOccurrence(now, timezone, localTime, false).scheduledInstantUtc;
  const current = getLocalScheduleDecision(now, timezone, localTime, NOTIFICATION_CRON_WINDOW_MINUTES, false);
  if (current.due) return current.scheduledInstantUtc;
  return getNextLocalScheduleOccurrence(now, timezone, localTime).scheduledInstantUtc;
}

async function subscriptionRepeatScheduleRebuildStatements(
  env: Env,
  userId: string,
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal" | "notificationReminderDays">,
  suppliedCandidates?: ApiSubscription[],
): Promise<D1PreparedStatement[]> {
  const candidates = suppliedCandidates
    ?? (await listRepeatReminderCandidateSubscriptions(env, userId, dateOnlyInZone(now, settings.timezone))).map(toApiSubscription);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM subscription_repeat_schedule WHERE user_id = ?").bind(userId),
  ];
  for (const candidate of candidates) {
    const nextDue = nextRepeatNotificationDueForCandidates(now, settings, [candidate]);
    if (!nextDue) continue;
    statements.push(env.DB.prepare(`
      INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
      VALUES (?, ?, ?)
    `).bind(userId, candidate.id, nextDue));
  }
  return statements;
}

function nextRepeatNotificationDueForCandidates(
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal" | "notificationReminderDays">,
  candidates: ApiSubscription[],
  skipCurrentWindow = false,
): string | null {
  if (candidates.length === 0) return null;
  const current = getRepeatScheduleDecision(now, settings, candidates, NOTIFICATION_CRON_WINDOW_MINUTES);
  if (current.due && !skipCurrentWindow) return current.scheduledInstantUtc;
  return getNextRepeatScheduleOccurrence(now, settings, candidates)?.scheduledInstantUtc ?? null;
}

function numberValue(value: number | string | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value) || 0;
  return 0;
}
