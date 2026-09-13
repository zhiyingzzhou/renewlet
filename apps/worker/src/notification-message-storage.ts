import { cronJobResultResponseSchema } from "@renewlet/shared/schemas/notifications";
import { NOTIFICATION_JOB_COLUMNS } from "./db";
import type { Env, NotificationJobRow } from "./types";

const messageChunkCharacters = 8192;

export function splitNotificationJobMessage(result: unknown): { metadata: string; parts: string[] } {
  const { message, ...metadata } = cronJobResultResponseSchema.parse(result);
  // 与 Go/SQLite substr 统一按 Unicode 码点计数；快照总大小不再决定任务 JSON 能否提交。
  const characters = Array.from(JSON.stringify(message));
  const parts: string[] = [];
  for (let start = 0; start < characters.length; start += messageChunkCharacters) {
    parts.push(characters.slice(start, start + messageChunkCharacters).join(""));
  }
  return { metadata: JSON.stringify({ ...metadata, messageChunkCount: parts.length }), parts };
}

export function notificationMessageStatements(env: Env, jobId: string, parts: string[]): D1PreparedStatement[] {
  const statements = [env.DB.prepare("DELETE FROM notification_job_messages WHERE job_id = ?").bind(jobId)];
  // 单批最多 16 段，包含转义也不接近 D1 单值限制；调用者与最终状态放进同一次 batch。
  for (let start = 0; start < parts.length; start += 16) {
    statements.push(env.DB.prepare(`INSERT INTO notification_job_messages (job_id, chunk_index, content)
      SELECT ?, ? + CAST(key AS INTEGER), value FROM json_each(?)`).bind(jobId, start, JSON.stringify(parts.slice(start, start + 16))));
  }
  return statements;
}

export function restoreNotificationJobMessage(metadata: string, parts: string[]): string {
  let fields: unknown;
  try { fields = JSON.parse(metadata); } catch { return "{}"; }
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !("messageChunkCount" in fields)) return "{}";
  const { messageChunkCount, ...result } = fields;
  // 分段数属于完整性校验，不是兼容版本；缺段不能伪装成“这次没有通知内容”。
  if (!Number.isInteger(messageChunkCount) || messageChunkCount !== parts.length || parts.length === 0) {
    throw new Error("Notification message snapshot is incomplete");
  }
  return JSON.stringify({ ...result, message: JSON.parse(parts.join("")) as unknown });
}

type NotificationMessageRow = NotificationJobRow & { chunk_index: number | null; content: string | null };

export async function readNotificationHistoryRows(env: Env, userId: string, status: string, limit: number, offset = 0): Promise<NotificationJobRow[]> {
  const params: (string | number)[] = [userId];
  let filter = "WHERE user_id = ?";
  if (status !== "all") { filter += " AND status = ?"; params.push(status); }
  params.push(limit, offset);
  // 先按账号分页；单条查询同时读状态和分段，避免并发重试让两次读拼出不同版本。
  const rows = await env.DB.prepare(`WITH page AS (
    SELECT ${NOTIFICATION_JOB_COLUMNS} FROM notification_jobs ${filter} ORDER BY scheduled_instant_utc DESC, created_at DESC LIMIT ? OFFSET ?
  ) SELECT page.*, messages.chunk_index, messages.content FROM page
  LEFT JOIN notification_job_messages AS messages ON messages.job_id = page.id
  ORDER BY page.scheduled_instant_utc DESC, page.created_at DESC, page.id, messages.chunk_index`).bind(...params).all<NotificationMessageRow>();
  const jobs: NotificationJobRow[] = [];
  for (let start = 0; start < rows.results.length;) {
    const row = rows.results[start];
    if (!row) break;
    const parts: string[] = [];
    let end = start;
    while (rows.results[end]?.id === row.id) {
      const part = rows.results[end];
      if (!part) break;
      if (part.chunk_index !== null) {
        if (part.chunk_index !== parts.length || part.content === null) throw new Error("Notification message snapshot has a missing part");
        parts.push(part.content);
      }
      end++;
    }
    const { chunk_index: _chunkIndex, content: _content, ...job } = row;
    jobs.push({ ...job, result_json: restoreNotificationJobMessage(row.result_json, parts) });
    start = end;
  }
  return jobs;
}
