import { z } from "zod";

/**
 * 上游错误详情的跨运行面契约。
 *
 * rawResponseText 只随当前失败响应回显给操作者；Go、Worker 和前端共享这个 shape，
 * 但 cron history、版本缓存、provider lastError、导出和备份包都只能保存短摘要。
 */
export const UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS = 1 << 20;
export const UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS = 64 * 1024;

// 1MiB 是跨 Go/Worker/前端 schema 的硬上限；运行时默认只采集 64KiB，避免 Worker isolate 或 Go route 被错误页拖垮。
// 上游 raw response 只随当前失败响应回显给操作者；history/cache/lastError 只能保存短摘要。
export const upstreamErrorDetailsSchema = z.object({
  rawResponseText: z.string().max(UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS),
}).strict();
export type UpstreamErrorDetails = z.infer<typeof upstreamErrorDetailsSchema>;

/** SSE 已经建立后无法修改 HTTP status，因此把已收到的上游响应事实放进 error 事件。 */
export const upstreamResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  statusText: z.string().max(256).nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  body: z.string().max(UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS).nullable(),
  bodyTruncated: z.boolean(),
}).strict();
export type UpstreamResponse = z.infer<typeof upstreamResponseSchema>;
