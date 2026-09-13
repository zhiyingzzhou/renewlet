import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import { NOTIFICATION_CHANNELS } from "@renewlet/shared/runtime";
import { notificationJobResultResponseSchema } from "@renewlet/shared/schemas/notifications";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { UpstreamErrorDetails } from "@renewlet/shared/schemas/upstream";
import { NOTIFICATION_JOB_COLUMNS, newId, nowIso, parseJobResult } from "./db";
import type { AppLocale } from "./http";
import type { Env, NotificationJobRow } from "./types";
import type { ScheduleOccurrence } from "./notification-schedule";
import { notificationMessageStatements, splitNotificationJobMessage } from "./notification-message-storage";

// Worker 不能读取 Go 的通知 env；Cloudflare 调度常量固定在这里，并由 shared fixture 与 Go 测试锁住。
export const NOTIFICATION_CRON_WINDOW_MINUTES = 2;
export const NOTIFICATION_MAX_RETRIES = 3;
export const NOTIFICATION_STALE_SENDING_MINUTES = 15;

export type Channel = ApiAppSettings["enabledChannels"][number];

export interface ChannelFailure {
  channel: Channel;
  error: string;
  details?: UpstreamErrorDetails;
}

export interface JobChannels {
  attempted: Channel[];
  succeeded: Channel[];
  failed: ChannelFailure[];
}

export interface SendSummary extends JobChannels {}

const knownChannels = new Set<string>(NOTIFICATION_CHANNELS);

export async function getNotificationJob(env: Env, userId: string, schedule: ScheduleOccurrence): Promise<NotificationJobRow | null> {
  // 这组字段必须与 D1 唯一索引一致，是 cron 幂等和失败重试的同一个业务 key。
  return await env.DB.prepare(`
    SELECT ${NOTIFICATION_JOB_COLUMNS} FROM notification_jobs
    WHERE user_id = ? AND scheduled_local_date = ? AND scheduled_local_time = ? AND time_zone = ?
    LIMIT 1
  `).bind(userId, schedule.scheduledLocalDate, schedule.scheduledLocalTime, schedule.timeZone).first<NotificationJobRow>();
}

export async function createNotificationJob(
  env: Env,
  userId: string,
  schedule: ScheduleOccurrence,
  status: NotificationJobRow["status"],
  attempts: number,
): Promise<{ row: NotificationJobRow | null; created: boolean }> {
  const timestamp = nowIso();
  const id = newId("job");
  // INSERT OR IGNORE 让并发 Cron 只抢到一个发送者；抢不到时回读现有 job 交给状态机判断。
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO notification_jobs (
      id, user_id, scheduled_local_date, scheduled_local_time, time_zone, scheduled_instant_utc,
      status, attempts, last_error, result_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)
  `).bind(id, userId, schedule.scheduledLocalDate, schedule.scheduledLocalTime, schedule.timeZone, schedule.scheduledInstantUtc, status, attempts, timestamp, timestamp).run();
  if ((result.meta.changes ?? 0) === 0) {
    return { row: await getNotificationJob(env, userId, schedule), created: false };
  }
  return {
    row: {
      id,
      user_id: userId,
      scheduled_local_date: schedule.scheduledLocalDate,
      scheduled_local_time: schedule.scheduledLocalTime,
      time_zone: schedule.timeZone,
      scheduled_instant_utc: schedule.scheduledInstantUtc,
      status,
      attempts,
      last_error: null,
      result_json: "{}",
      created_at: timestamp,
      updated_at: timestamp,
    },
    created: true,
  };
}

export async function markNotificationJobSending(env: Env, row: NotificationJobRow, attempts: number): Promise<NotificationJobRow> {
  const timestamp = nowIso();
  // failed/stale sending 接管时先清空 last_error；最终失败摘要只由本次发送结果重新生成。
  await env.DB.prepare(`
    UPDATE notification_jobs SET status = 'sending', attempts = ?, last_error = NULL, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).bind(attempts, timestamp, row.user_id, row.id).run();
  return { ...row, status: "sending", attempts, last_error: null, updated_at: timestamp };
}

export async function finalizeNotificationJob(
  env: Env,
  row: NotificationJobRow | null,
  userId: string,
  schedule: ScheduleOccurrence,
  status: NotificationJobRow["status"],
  attempts: number,
  error: string | null,
  result: unknown,
): Promise<void> {
  let target = row;
  if (!target) {
    // skipped 也需要历史行，否则用户只能看到“没有发送”，看不到本轮 Cron 已检查过。
    const created = await createNotificationJob(env, userId, schedule, status, Math.max(1, attempts));
    target = created.row;
  }
  const timestamp = nowIso();
  const persistedResult = stripNotificationFailureDetails(result);
  if (!target || target.user_id !== userId) throw new Error("Notification job owner mismatch");
  const snapshot = splitNotificationJobMessage(persistedResult);
  // finalize 按调度唯一键更新而不是只按 id，确保 INSERT OR IGNORE 抢占后的同一窗口仍能幂等落最终态。
  const finalize = env.DB.prepare(`
    UPDATE notification_jobs SET status = ?, attempts = ?, last_error = ?, result_json = ?, updated_at = ?
    WHERE user_id = ? AND scheduled_local_date = ? AND scheduled_local_time = ? AND time_zone = ?
  `).bind(status, Math.max(0, attempts), error, snapshot.metadata, timestamp, userId, schedule.scheduledLocalDate, schedule.scheduledLocalTime, schedule.timeZone);
  // D1 batch 统一提交消息与最终态；失败时保留上次完整快照和渠道记录，不能部分替换。
  await env.DB.batch([...notificationMessageStatements(env, target.id, snapshot.parts), finalize]);
}

function stripNotificationFailureDetails(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const channels = record["channels"];
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) return result;
  const channelRecord = channels as Record<string, unknown>;
  const failed = channelRecord["failed"];
  if (!Array.isArray(failed)) return result;
  return {
    ...record,
    channels: {
      ...channelRecord,
      failed: failed.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const { details: _details, ...rest } = item as Record<string, unknown>;
        return rest;
      }),
    },
  };
}

export function isNotificationJobTerminal(row: NotificationJobRow | null): boolean {
  return row?.status === "sent" || row?.status === "skipped";
}

export function isSendingJobFresh(row: NotificationJobRow, now: Date, staleSendingMinutes: number): boolean {
  if (row.status !== "sending") return false;
  const updatedAt = Date.parse(row.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  // sending 可能只是上一轮外部 provider 还没返回；未过 stale 窗口不能抢占，避免重复推送。
  return now.getTime() - updatedAt < Math.max(1, staleSendingMinutes) * 60_000;
}

export function readJobChannels(row: NotificationJobRow | null): JobChannels {
  if (!row) return normalizeJobChannels({});
  const result = parseJobResult(row);
  if (!isRecord(result) || result["source"] !== "cron" || !isRecord(result["channels"])) {
    // 手动运行不写 job；坏历史 result 不能参与失败重试，避免把未知 JSON 当作发送依据。
    return normalizeJobChannels({});
  }
  return normalizeJobChannels(result["channels"]);
}

export function channelsToSend(existing: NotificationJobRow | null, previous: JobChannels, enabled: Channel[]): Channel[] {
  if (existing?.status !== "failed") return uniqueValidChannels(enabled);
  // 失败重试只发上次失败且仍启用的渠道，已成功渠道不应因为重试收到重复提醒。
  const enabledSet = new Set(enabled);
  return uniqueValidChannels(previous.failed.map((failure) => failure.channel).filter((channel) => enabledSet.has(channel)));
}

export function mergeChannelResults(previous: JobChannels, summary: SendSummary, enabled: Channel[]): JobChannels {
  // 合并时保留历史成功、替换本轮失败；被禁用渠道的旧失败不再阻塞 job 收敛。
  const sentThisRun = new Set(summary.attempted);
  const succeeded = uniqueValidChannels([...previous.succeeded, ...summary.succeeded]);
  const succeededSet = new Set(succeeded);
  const enabledSet = new Set(enabled);
  const failures = new Map<Channel, string>();
  for (const failure of previous.failed) {
    if (!enabledSet.has(failure.channel)) continue;
    if (sentThisRun.has(failure.channel)) continue;
    if (succeededSet.has(failure.channel)) continue;
    failures.set(failure.channel, failure.error);
  }
  for (const failure of summary.failed) {
    if (succeededSet.has(failure.channel)) continue;
    failures.set(failure.channel, failure.error);
  }
  return {
    attempted: uniqueValidChannels([...previous.attempted, ...summary.attempted]),
    succeeded,
    failed: [...failures.entries()]
      .map(([channel, error]) => ({ channel, error }))
      .sort((a, b) => a.channel.localeCompare(b.channel)),
  };
}

export function normalizeJobChannels(value: unknown): JobChannels {
  const record = isRecord(value) ? value : {};
  const failedByChannel = new Map<Channel, string>();
  const rawFailed = Array.isArray(record["failed"]) ? record["failed"] : [];
  for (const item of rawFailed) {
    if (!isRecord(item) || typeof item["channel"] !== "string") continue;
    const channel = parseChannel(item["channel"]);
    if (!channel) continue;
    failedByChannel.set(channel, typeof item["error"] === "string" ? item["error"] : "");
  }
  return {
    attempted: uniqueValidChannels(Array.isArray(record["attempted"]) ? record["attempted"] : []),
    succeeded: uniqueValidChannels(Array.isArray(record["succeeded"]) ? record["succeeded"] : []),
    failed: [...failedByChannel.entries()]
      .map(([channel, error]) => ({ channel, error }))
      .sort((a, b) => a.channel.localeCompare(b.channel)),
  };
}

export function lastErrorFromChannels(channels: JobChannels): string | null {
  if (channels.failed.length === 0) return null;
  return channels.failed.map((failure) => `${failure.channel}: ${failure.error}`).join(" | ");
}

export function publicScheduleOccurrence(schedule: ScheduleOccurrence): ScheduleOccurrence {
  // due/reason 只属于 Cron 内存决策；notification_jobs.result_json 必须落 shared 公开 occurrence 契约。
  return {
    scheduledLocalDate: schedule.scheduledLocalDate,
    scheduledLocalTime: schedule.scheduledLocalTime,
    timeZone: schedule.timeZone,
    scheduledInstantUtc: schedule.scheduledInstantUtc,
  };
}

export function normalizeNotificationJobResultForHistory(result: unknown): unknown {
  // history 读路径只验收当前 shared cron result；旧/坏 result 不再运行时重塑，统一以 `{}` 出站。
  const parsed = notificationJobResultResponseSchema.safeParse(result);
  return parsed.success ? parsed.data : {};
}

export function createCronJobResult(input: {
  reason: string | null;
  force: boolean;
  windowMinutes: number;
  triggeredAtUtc: string;
  schedule: ScheduleOccurrence;
  settings: ApiAppSettings;
  locale: AppLocale;
  message: NotificationEmailMessage;
  channels: JobChannels;
}): unknown {
  // 历史 result 只保存可解释的 cron 快照，不写 provider token、完整外部响应或 manual source。
  return {
    source: "cron",
    reason: input.reason,
    force: input.force,
    windowMinutes: input.windowMinutes,
    triggeredAtUtc: input.triggeredAtUtc,
    schedule: publicScheduleOccurrence(input.schedule),
    settings: {
      timezone: input.settings.timezone,
      locale: input.locale,
      notificationTimeLocal: input.settings.notificationTimeLocal,
      enabledChannels: input.settings.enabledChannels,
      showExpired: input.settings.showExpired,
    },
    message: input.message,
    channels: normalizeJobChannels(input.channels),
  };
}

function uniqueValidChannels(values: unknown[]): Channel[] {
  const out: Channel[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const channel = typeof value === "string" ? parseChannel(value) : null;
    if (!channel || seen.has(channel)) continue;
    seen.add(channel);
    out.push(channel);
  }
  return out;
}

function parseChannel(value: string): Channel | null {
  return knownChannels.has(value) ? value as Channel : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
