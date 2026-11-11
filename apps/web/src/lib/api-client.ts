/**
 * 浏览器端 API client。
 *
 * 架构位置：
 * - React hooks/application 层通过这里调用 Go/PocketBase 自定义 API。
 * - Renewlet 产品 session 由 HttpOnly cookie 承载，unsafe 请求自动附带 CSRF header。
 *
 * 请求/校验流转：
 * ```mermaid
 * flowchart LR
 *   A[调用方传入 Zod schema] --> B[补齐认证/语言/时区 headers]
 *   B --> C[合并外部取消与本地超时]
 *   C --> D[fetch]
 *   D --> E[安全解析 JSON]
 *   E --> F{HTTP ok?}
 *   F -- 否 --> G[提取后端错误并抛 ApiError]
 *   F -- 是 --> H{schema.safeParse}
 *   H -- 失败 --> I[抛 invalid_response ApiError]
 *   H -- 成功 --> J[返回 parse 后的数据]
 * ```
 *
 * 注意： 无 body 请求不声明 JSON content-type；FormData 请求也不能手动设置，否则浏览器不会自动补 multipart boundary。
 * 注意： 不要恢复 `apiFetch<T>` 式的纯类型断言；本文件是前端拒绝异常 API 响应的唯一运行时边界。
 */
import { clearAuthSession } from "@/lib/auth-session";
import { getApiLocale, getLocaleHeaders } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import {
  getProductCsrfHeader,
  readProductSessionSnapshot,
  type ProductSessionSnapshot,
} from "@/services/product-session";
import type { ApiSuccessResponse } from "@renewlet/shared/schemas/api";
import { apiErrorResponseSchema } from "@renewlet/shared/schemas/errors";
import { z } from "zod";

export class ApiError extends Error {
  // rawResponseText 只服务当前错误详情回显；不要把它持久化或拿来驱动业务分支。
  status: number;
  details: unknown;
  code: "timeout" | "aborted" | "network" | (string & {}) | undefined;
  rawResponseText: string;
  retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    status: number,
    details?: unknown,
    code?: "timeout" | "aborted" | "network" | (string & {}),
    rawResponseText = "",
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.code = code;
    this.rawResponseText = rawResponseText;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ApiAuthMode = "required" | "optional" | "none";
type ApiSuccessResponseSchema = z.ZodType<ApiSuccessResponse<unknown>>;
type ApiSuccessData<Schema extends ApiSuccessResponseSchema> =
  z.infer<Schema> extends ApiSuccessResponse<infer Data> ? Data : never;

/** 请求级 fetch 配置；`timeoutMs`、`streamIdleTimeoutMs` 和 `authMode` 只在本 client 内消费。 */
export type ApiFetchInit = RequestInit & {
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  authMode?: ApiAuthMode;
};

const DEFAULT_JSON_TIMEOUT_MS = 30_000;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function createAbortSignal(
  externalSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal?: AbortSignal; clearTimeout: () => void; cleanup: () => void; didTimeout: () => boolean; abortForTimeout: () => void } {
  const normalizedTimeout = Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : 0;
  if (!externalSignal && normalizedTimeout <= 0) {
    return {
      clearTimeout: () => undefined,
      cleanup: () => undefined,
      didTimeout: () => false,
      abortForTimeout: () => undefined,
    };
  }

  // 首包超时必须可在响应头到达后解除，流式请求再切换到 idle watchdog；因此由本 controller 统一外部取消和两阶段超时。
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const clearLocalTimeout = () => {
    if (!timeout) return;
    clearTimeout(timeout);
    timeout = null;
  };
  const abortForTimeout = () => {
    timedOut = true;
    controller.abort();
  };
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
  }

  if (normalizedTimeout > 0) {
    timeout = setTimeout(abortForTimeout, normalizedTimeout);
  }

  return {
    signal: controller.signal,
    clearTimeout: clearLocalTimeout,
    cleanup: () => {
      clearLocalTimeout();
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
    didTimeout: () => timedOut,
    abortForTimeout,
  };
}

function createStreamIdleWatchdog(
  abort: ReturnType<typeof createAbortSignal>,
  timeoutMs: number | null | undefined,
): { reset: () => void; cleanup: () => void } {
  const normalizedTimeout = Number.isFinite(timeoutMs ?? 0) ? Math.floor(timeoutMs ?? 0) : 0;
  if (normalizedTimeout <= 0) {
    return { reset: () => undefined, cleanup: () => undefined };
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (!timeout) return;
    clearTimeout(timeout);
    timeout = null;
  };
  const reset = () => {
    clear();
    timeout = setTimeout(() => {
      abort.abortForTimeout();
    }, normalizedTimeout);
  };
  return { reset, cleanup: clear };
}

function responseWithStreamActivity(response: Response, onChunk: () => void, signal: AbortSignal | undefined): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let removeAbortListener: (() => void) | null = null;
  // SSE 首包成功后仍要监控后续 chunk；这里包装 body 只报告流活跃度，不改变调用方的解析协议。
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!signal) return;
      const abortStream = () => {
        controller.error(new DOMException("Aborted", "AbortError"));
        void reader.cancel();
      };
      if (signal.aborted) {
        abortStream();
        return;
      }
      signal.addEventListener("abort", abortStream, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abortStream);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        removeAbortListener?.();
        controller.close();
        return;
      }
      onChunk();
      controller.enqueue(value);
    },
    async cancel(reason) {
      removeAbortListener?.();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function readResponsePayload(response: Response): Promise<{ json: unknown; text: string }> {
  // 错误详情可能是 JSON、HTML 或 text/plain；先保留原文，成功路径仍必须由调用方 schema 校验 JSON。
  const text = await response.text();
  if (!text) return { json: null, text };
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    return { json: null, text };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function getFieldErrors(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(value)) {
    const normalized = getStringArray(messages);
    if (normalized.length > 0) result[field] = normalized;
  }
  return result;
}

function formatValidationSummary(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const formErrors = getStringArray(value["formErrors"]);
  const fieldErrors = getFieldErrors(value["fieldErrors"]);
  const lines = [
    ...formErrors,
    ...Object.entries(fieldErrors).map(([field, messages]) => `${field}: ${messages[0]}`),
  ].filter(Boolean);

  // 后端/Zod 的 flatten 结构不适合直接展示完整 JSON；压缩到前三条能保留定位价值且避免 Toast 撑爆。
  if (lines.length === 0) return undefined;
  const separator = getApiLocale() === "zh-CN" ? "；" : "; ";
  const visible = lines.slice(0, 3).join(separator);
  const suffix = lines.length > 3
    ? `${separator}${translate(getApiLocale(), "error.moreErrors", { count: lines.length - 3 })}`
    : "";
  const headingSeparator = getApiLocale() === "zh-CN" ? "：" : ": ";
  return `${translate(getApiLocale(), "error.invalidParams")}${headingSeparator}${visible}${suffix}`;
}

function getValidationMessage(details: unknown): string | undefined {
  return formatValidationSummary(details);
}

function shouldPreferValidationMessage(code: string | undefined, message: string | undefined): boolean {
  if (code === "INVALID_PAYLOAD" || code === "VALIDATION_ERROR") return true;
  return message === "Invalid payload" || message === translate(getApiLocale(), "error.invalidParams");
}

function parseApiErrorPayload(payload: unknown): { code: string; message: string; details?: unknown } | undefined {
  // Renewlet 已彻底切到 shared envelope；不要恢复旧扁平 `{ message, code }` 的兼容解析。
  const parsed = apiErrorResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.error : undefined;
}

function getErrorMessage(payload: unknown): string | undefined {
  const error = parseApiErrorPayload(payload);
  if (!error) return undefined;

  const validationMessage = getValidationMessage(error.details);
  if (validationMessage && shouldPreferValidationMessage(error.code, error.message)) return validationMessage;

  return error.message || validationMessage;
}

function getErrorCode(payload: unknown): string | undefined {
  return parseApiErrorPayload(payload)?.code;
}

function getErrorDetails(payload: unknown): unknown {
  return parseApiErrorPayload(payload)?.details;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function shouldClearAuthSession(status: number, payload: unknown, authMode: ApiAuthMode, sessionSnapshot: ProductSessionSnapshot | null): boolean {
  if (authMode !== "required" || !sessionSnapshot) return false;
  if (status !== 401) return false;
  // 非 Renewlet envelope 的 401 是被代理透传的上游响应，不能清除当前产品登录态。
  if (!apiErrorResponseSchema.safeParse(payload).success) return false;
  const details = getErrorDetails(payload);
  // 第三方 provider 的 401/403 经过产品 API 代理返回时仍是业务失败；rawResponseText
  // 是统一的上游事实标记，不能因为 HTTP 状态相同而清除 Renewlet 登录态。
  if (isRecord(details) && typeof details["rawResponseText"] === "string" && details["rawResponseText"].trim()) return false;
  return true;
}

function getClientTimeZoneHeader(): string | null {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone || null;
  } catch {
    return null;
  }
}

function isUnsafeMethod(method: string | undefined): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes((method ?? "GET").toUpperCase());
}

function buildApiHeaders(headersInit: HeadersInit | undefined, body: BodyInit | null | undefined, method: string | undefined, authMode: ApiAuthMode): {
  headers: Headers;
  sessionSnapshot: ProductSessionSnapshot | null;
} {
  const headers = new Headers(headersInit);
  const isFormDataBody = typeof FormData !== "undefined" && body instanceof FormData;
  const hasBody = body !== null && body !== undefined;
  // 业务 GET/DELETE 统一走产品 API，不带伪 JSON body；POST/PUT/PATCH 的普通对象才默认声明 JSON。
  if (!headers.has("content-type") && hasBody && !isFormDataBody) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("x-client-time-zone")) {
    const timeZone = getClientTimeZoneHeader();
    if (timeZone) headers.set("x-client-time-zone", timeZone);
  }
  for (const [key, value] of Object.entries(getLocaleHeaders())) {
    if (!headers.has(key)) headers.set(key, value);
  }
  headers.delete("authorization");
  if (authMode === "none") {
    if (isUnsafeMethod(method)) {
      for (const [key, value] of Object.entries(getProductCsrfHeader())) {
        if (!headers.has(key)) headers.set(key, value);
      }
    }
    return { headers, sessionSnapshot: null };
  }
  if (isUnsafeMethod(method)) {
    for (const [key, value] of Object.entries(getProductCsrfHeader())) {
      if (!headers.has(key)) headers.set(key, value);
    }
  }
  return { headers, sessionSnapshot: readProductSessionSnapshot() };
}

async function fetchWithApiBoundary(input: RequestInfo, init?: ApiFetchInit): Promise<{
  abort: ReturnType<typeof createAbortSignal>;
  authMode: ApiAuthMode;
  sessionSnapshot: ProductSessionSnapshot | null;
  response: Response;
}> {
  const {
    timeoutMs = DEFAULT_JSON_TIMEOUT_MS,
    signal: externalSignal,
    streamIdleTimeoutMs: _streamIdleTimeoutMs,
    authMode = "required",
    ...fetchInit
  } = init ?? {};
  const { headers, sessionSnapshot } = buildApiHeaders(fetchInit.headers, fetchInit.body ?? null, fetchInit.method, authMode);
  const abort = createAbortSignal(externalSignal, timeoutMs);
  try {
    const requestInit: RequestInit = {
      ...fetchInit,
      headers,
      credentials: "include",
      ...(abort.signal ? { signal: abort.signal } : {}),
    };
    const response = await fetch(input, requestInit);
    return { abort, authMode, sessionSnapshot, response };
  } catch (e: unknown) {
    abort.cleanup();
    if (abort.didTimeout()) {
      throw new ApiError(translate(getApiLocale(), "error.timeout"), 0, undefined, "timeout");
    }
    if (isAbortError(e)) {
      throw new ApiError(translate(getApiLocale(), "error.aborted"), 0, undefined, "aborted");
    }
    throw new ApiError(e instanceof Error ? e.message : translate(getApiLocale(), "error.network"), 0, undefined, "network");
  }
}

/**
 * 带运行时 schema 校验的 fetch 封装。
 *
 * 约定：
 * - 有普通 body 时自动加 JSON content-type；无 body 和 FormData 保持浏览器默认边界
 * - 自动携带 Cookie，unsafe 请求附带 CSRF header
 * - 非 2xx 时抛出 `ApiError`
 * - 2xx 响应必须通过调用方传入的 Zod schema，否则抛出 `ApiError`
 */
export async function apiFetch<Schema extends ApiSuccessResponseSchema>(
  input: RequestInfo,
  responseSchema: Schema,
  init?: ApiFetchInit,
): Promise<ApiSuccessData<Schema>> {
  const { abort, authMode, sessionSnapshot, response: res } = await fetchWithApiBoundary(input, init);
  try {
    const payload = await readResponsePayload(res);
    const json = payload.json;

    if (!res.ok) {
      const message = getErrorMessage(json) || payload.text || res.statusText || "Request failed";
      if (shouldClearAuthSession(res.status, json, authMode, sessionSnapshot)) {
        clearAuthSession(sessionSnapshot);
      }
      throw new ApiError(
        message,
        res.status,
        getErrorDetails(json),
        getErrorCode(json),
        payload.text,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }

    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      // API 返回即使是 2xx，也必须重新过 schema。这样后端字段漂移、代理返回 HTML、
      // 或第三方错误页被误转发时，会在边界变成 ApiError，而不是污染 domain/UI 状态。
      throw new ApiError(
        translate(getApiLocale(), "error.invalidResponse"),
        res.status,
        parsed.error.flatten(),
        "invalid_response",
        payload.text,
      );
    }

    // 所有产品 JSON API 成功响应都必须是 shared success envelope；业务层只消费 data。
    return parsed.data.data as ApiSuccessData<Schema>;
  } finally {
    abort.cleanup();
  }
}

/** 二进制下载也复用 API 认证/错误边界；调用方只接收已经通过 HTTP ok 校验的 Blob。 */
export async function apiFetchBlob(input: RequestInfo, init?: ApiFetchInit): Promise<Blob> {
  const { abort, authMode, sessionSnapshot, response } = await fetchWithApiBoundary(input, init);
  try {
    if (!response.ok) {
      const payload = await readResponsePayload(response);
      const json = payload.json;
      const message = getErrorMessage(json) || payload.text || response.statusText || "Request failed";
      if (shouldClearAuthSession(response.status, json, authMode, sessionSnapshot)) {
        clearAuthSession(sessionSnapshot);
      }
      throw new ApiError(
        message,
        response.status,
        getErrorDetails(json),
        getErrorCode(json),
        payload.text,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return await response.blob();
  } finally {
    abort.cleanup();
  }
}

export async function apiFetchStream<T>(
  input: RequestInfo,
  init: ApiFetchInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const { abort, authMode, sessionSnapshot, response } = await fetchWithApiBoundary(input, init);
  abort.clearTimeout();
  // 流式 API 的首包和后续 chunk 是两类风险：拿到响应头后只保留 idle watchdog，避免真实 SSE 仍在推进时被总时长计时器误杀。
  const idleWatchdog = createStreamIdleWatchdog(abort, init.streamIdleTimeoutMs);
  try {
    if (!response.ok) {
      const payload = await readResponsePayload(response);
      const json = payload.json;
      const message = getErrorMessage(json) || payload.text || response.statusText || "Request failed";
      if (shouldClearAuthSession(response.status, json, authMode, sessionSnapshot)) {
        clearAuthSession(sessionSnapshot);
      }
      throw new ApiError(
        message,
        response.status,
        getErrorDetails(json),
        getErrorCode(json),
        payload.text,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    idleWatchdog.reset();
    const responseForConsume = responseWithStreamActivity(response, idleWatchdog.reset, abort.signal);
    try {
      return await consume(responseForConsume);
    } catch (e: unknown) {
      if (abort.didTimeout()) {
        throw new ApiError(translate(getApiLocale(), "error.timeout"), 0, undefined, "timeout");
      }
      if (isAbortError(e)) {
        throw new ApiError(translate(getApiLocale(), "error.aborted"), 0, undefined, "aborted");
      }
      throw e;
    }
  } finally {
    idleWatchdog.cleanup();
    abort.cleanup();
  }
}
