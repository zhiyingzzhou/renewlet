/**
 * Worker 上游 HTTP 统一出口。
 *
 * 产品主动请求第三方时，只在这里处理 timeout、AbortController、Full redacted 诊断和响应体释放。
 * Cloudflare 运行面没有 per-request proxy；本地出站差异只能被诊断暴露，不能在产品代码里绕代理。
 */
import {
  UpstreamOperationError,
  createUpstreamErrorDetails,
  providerMessageFromResponse,
  redactUpstreamSecrets,
  safeUpstreamHeaderName,
  upstreamProviderResponseFromFetchResponse,
} from "./upstream-response";

import { CronBudgetExceeded, type CronBudget } from "./cron-budget";
import { UPSTREAM_MAX_REDIRECTS, UPSTREAM_REDIRECT_STATUSES, upstreamRedirect } from "./upstream-redirect";

export const DEFAULT_UPSTREAM_HTTP_TIMEOUT_MS = 10_000;
const REQUEST_BODY_SUMMARY_MAX_CHARS = 4096;

type UpstreamRequestOptions = {
  provider: string;
  budget?: CronBudget;
  timeoutMs?: number;
  secrets?: readonly string[];
};

type UpstreamJsonOptions = UpstreamRequestOptions & {
  headers?: HeadersInit;
};

type UpstreamRequestInput = RequestInfo | URL;

export class UpstreamRequestError extends UpstreamOperationError {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message, createUpstreamErrorDetails({ responseText: message }));
    this.name = "UpstreamRequestError";
  }
}

export async function sendUpstreamJson(
  url: UpstreamRequestInput,
  payload: unknown,
  options: UpstreamJsonOptions,
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  return await sendUpstreamRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, options);
}

export async function sendUpstreamRequest(
  url: UpstreamRequestInput,
  init: RequestInit = {},
  options: UpstreamRequestOptions,
): Promise<Response> {
  const timeoutMs = normalizedTimeoutMs(options.timeoutMs);
  const abort = createUpstreamAbort(init.signal ?? (url instanceof Request ? url.signal : undefined), timeoutMs);
  try {
    // Worker fetch 没有 Go http.Client.Timeout；所有调用点必须复用这个显式超时边界。
    return await fetchUpstream(url, {
      ...init,
      ...(abort.signal ? { signal: abort.signal } : {}),
    }, options.budget);
  } catch (error) {
    if (error instanceof CronBudgetExceeded) throw error;
    throw new UpstreamRequestError(
      upstreamTransportDiagnosticMessage(url, init, options, error, timeoutMs, abort.didTimeout()),
      abort.didTimeout(),
    );
  } finally {
    abort.cleanup();
  }
}

// 协议SDK复用相同外发出口，但自行拥有整次认证操作的超时和错误语义，不能逐次握手重置。
export function fetchUpstream(input: UpstreamRequestInput, init: RequestInit, budget?: CronBudget): Promise<Response> {
  return budget ? fetchWithBudget(input, init, budget) : fetch(input, init);
}

async function fetchWithBudget(input: UpstreamRequestInput, init: RequestInit, budget: CronBudget): Promise<Response> {
  const initial = new Request(input, init);
  const signal = init.signal ?? initial.signal;
  let url = new URL(initial.url);
  let method = initial.method;
  let body = init.body ?? initial.body;
  // 让Fetch本身归一化自动Content-Type和替换headers，不能把原请求的鉴权头错误合并到新headers。
  const headers = new Headers(initial.headers);
  const mode = initial.redirect;
  for (let redirects = 0; ; redirects++) {
    signal?.throwIfAborted();
    budget.consumeExternalRequest();
    const response = await fetch(url, { ...init, method, headers, body: body ?? null, ...(signal ? { signal } : {}), redirect: "manual" });
    const location = response.headers.get("location");
    if (!UPSTREAM_REDIRECT_STATUSES.has(response.status) || mode === "manual") return response;
    if (mode !== "error" && location === null) return response;
    if (response.body) await response.body.cancel();
    if (mode === "error") throw new TypeError("Upstream redirect disallowed");
    if (redirects === UPSTREAM_MAX_REDIRECTS) throw new TypeError("Too many upstream redirects");
    const next = upstreamRedirect(url, location ?? "", response.status, method, body instanceof ReadableStream);
    // 当前workerd跨源剥离Authorization、保留Cookie及Content-*；计数不能扩大原有凭据转发范围。
    if (next.url.origin !== url.origin) headers.delete("authorization");
    url = next.url;
    method = next.method;
    if (next.dropBody) body = null;
  }
}

export async function requireUpstreamHttpOk(
  response: Response,
  options: { provider: string; secrets?: readonly string[] },
): Promise<void> {
  if (!response.ok) {
    const providerResponse = await upstreamProviderResponseFromFetchResponse(response, { secrets: options.secrets ?? [] });
    const providerMessage = providerMessageFromResponse(providerResponse);
    throw new UpstreamOperationError(
      providerMessage ? `${options.provider} HTTP ${response.status}: ${providerMessage}` : `${options.provider} HTTP ${response.status}`,
      createUpstreamErrorDetails({ responseText: providerMessage, providerResponse }),
      response.status,
    );
  }
  // 成功响应不需要 body 时主动 cancel，避免 provider 响应流悬挂到请求结束后才被运行时回收。
  if (response.body) await response.body.cancel().catch(() => undefined);
}

export function upstreamTransportDiagnosticMessage(
  url: UpstreamRequestInput,
  init: RequestInit,
  options: UpstreamRequestOptions,
  error: unknown,
  timeoutMs: number,
  timedOut: boolean,
): string {
  // rawResponseText 允许呈现请求结构来定位运行面偏移，但 path/query/header/body 中的真实 secret 必须先脱敏。
  const method = requestMethod(url, init);
  const target = redactedRequestTarget(url, options.secrets ?? []);
  const headers = redactedRequestHeaders(requestHeaders(url, init), options.secrets ?? []);
  const body = redactedRequestBody(requestBody(url, init), options.secrets ?? []);
  const summary = timedOut
    ? `${options.provider} ${method} request to ${target} timed out after ${Math.round(timeoutMs / 1000)}s before response headers`
    : `${options.provider} ${method} request to ${target} failed before response headers: ${redactedErrorMessage(error, options.secrets ?? [])}`;
  return [
    summary,
    headers ? `headers=${headers}` : "",
    body ? `body=${body}` : "",
  ].filter(Boolean).join("; ");
}

export function redactedRequestTarget(url: UpstreamRequestInput, secrets: readonly string[] = []): string {
  try {
    // 保留 host/path/query 才能区分 Discord、GitHub、S3 等上游偏移；敏感 segment 和签名 query 在这里统一抹掉。
    const parsed = new URL(url instanceof Request ? url.url : url.toString());
    const path = parsed.pathname
      .split("/")
      .map((segment) => redactedPathSegment(segment, secrets))
      .join("/");
    const query = redactedQuery(parsed.searchParams, secrets);
    return `${parsed.protocol}//${parsed.host}${path}${query}`;
  } catch {
    return redactUpstreamSecrets(String(url), secrets);
  }
}

export function redactedRequestHeaders(headers: HeadersInit | undefined, secrets: readonly string[] = []): string {
  if (!headers) return "";
  const visible: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (!safeUpstreamHeaderName(normalized)) {
      // Header 采用 deny-by-default：未知鉴权、签名和 cookie 名只显示存在性，不回显值。
      visible[normalized] = "[redacted]";
      return;
    }
    visible[normalized] = truncateDiagnosticText(redactUpstreamSecrets(value, secrets), 512);
  });
  return Object.keys(visible).length ? JSON.stringify(visible) : "";
}

export function redactedRequestBody(body: BodyInit | null | undefined, secrets: readonly string[] = []): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return summarizeTextBody(body, secrets);
  if (body instanceof URLSearchParams) return summarizeURLSearchParams(body, secrets);
  if (typeof FormData !== "undefined" && body instanceof FormData) return summarizeFormData(body);
  // stream/binary body 可能是图片、备份包或 SDK 私有流；诊断只暴露类型和大小，避免读取大对象或泄露正文。
  if (typeof Blob !== "undefined" && body instanceof Blob) return `[binary body type=${body.type || "application/octet-stream"} size=${body.size}]`;
  if (body instanceof ArrayBuffer) return `[binary body size=${body.byteLength}]`;
  if (ArrayBuffer.isView(body)) return `[binary body size=${body.byteLength}]`;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return "[stream body]";
  return "[body omitted]";
}

function normalizedTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_UPSTREAM_HTTP_TIMEOUT_MS)) return DEFAULT_UPSTREAM_HTTP_TIMEOUT_MS;
  return Math.max(1, Math.floor(value ?? DEFAULT_UPSTREAM_HTTP_TIMEOUT_MS));
}

function createUpstreamAbort(
  externalSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal?: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    // 不传自定义 reason，避免 workerd/SDK 把内部 TimeoutError 文本当作 provider 错误传播。
    controller.abort();
  }, timeoutMs);
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
    didTimeout: () => timedOut,
  };
}

function requestMethod(url: UpstreamRequestInput, init: RequestInit): string {
  return (init.method || (url instanceof Request ? url.method : "") || "GET").toUpperCase();
}

function requestHeaders(url: UpstreamRequestInput, init: RequestInit): HeadersInit | undefined {
  if (!(url instanceof Request)) return init.headers;
  const headers = new Headers(url.headers);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function requestBody(url: UpstreamRequestInput, init: RequestInit): BodyInit | null | undefined {
  if (init.body !== undefined) return init.body;
  if (url instanceof Request && url.body && !["GET", "HEAD"].includes(url.method.toUpperCase())) return url.body;
  return init.body;
}

function redactedPathSegment(segment: string, secrets: readonly string[]): string {
  if (!segment) return segment;
  const decoded = safeDecodeURIComponent(segment);
  if (sensitivePathSegment(decoded, secrets)) return "[redacted]";
  const redacted = redactUpstreamSecrets(segment, secrets);
  if (redacted !== segment) return redacted;
  return segment;
}

function sensitivePathSegment(segment: string, secrets: readonly string[]): boolean {
  if (looksLikeSensitiveName(segment)) return true;
  return secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= 4)
    .some((secret) => segment === secret || segment === safeDecodeURIComponent(secret));
}

function redactedQuery(params: URLSearchParams, secrets: readonly string[]): string {
  if ([...params.keys()].length === 0) return "";
  const out = new URLSearchParams();
  params.forEach((value, key) => {
    out.append(key, sensitiveKey(key) ? "[redacted]" : redactUpstreamSecrets(value, secrets));
  });
  return `?${out.toString()}`;
}

function redactedErrorMessage(error: unknown, secrets: readonly string[]): string {
  const value = error instanceof Error ? error.message || error.name : String(error);
  const code = errorCauseCode(error);
  const message = redactUpstreamSecrets(value.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (match) => redactedRequestTarget(match, secrets)), secrets);
  return code ? `${message} (${code})` : message;
}

function summarizeTextBody(value: string, secrets: readonly string[]): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return truncateDiagnosticText(JSON.stringify(redactJsonValue(JSON.parse(trimmed), secrets)), REQUEST_BODY_SUMMARY_MAX_CHARS);
  } catch {
    return truncateDiagnosticText(redactUpstreamSecrets(trimmed, secrets), REQUEST_BODY_SUMMARY_MAX_CHARS);
  }
}

function summarizeURLSearchParams(params: URLSearchParams, secrets: readonly string[]): string {
  const out: Record<string, string | string[]> = {};
  params.forEach((value, key) => {
    const next = sensitiveKey(key) ? "[redacted]" : redactUpstreamSecrets(value, secrets);
    const current = out[key];
    if (Array.isArray(current)) current.push(next);
    else if (typeof current === "string") out[key] = [current, next];
    else out[key] = next;
  });
  return truncateDiagnosticText(JSON.stringify(out), REQUEST_BODY_SUMMARY_MAX_CHARS);
}

function summarizeFormData(form: FormData): string {
  const out: Record<string, unknown[]> = {};
  form.forEach((value, key) => {
    const item = typeof File !== "undefined" && value instanceof File
      ? { type: "file", name: value.name, size: value.size, mediaType: value.type || null }
      : { type: "field", value: sensitiveKey(key) ? "[redacted]" : "[text omitted]" };
    out[key] = [...(out[key] ?? []), item];
  });
  return truncateDiagnosticText(JSON.stringify(out), REQUEST_BODY_SUMMARY_MAX_CHARS);
}

function redactJsonValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactUpstreamSecrets(value, secrets);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, secrets));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sensitiveKey(key) ? "[redacted]" : redactJsonValue(item, secrets);
  }
  return out;
}

function sensitiveKey(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[_\-\s]/g, "");
  return normalized.includes("authorization")
    || normalized.includes("password")
    || normalized.includes("passwd")
    || normalized.includes("secret")
    || normalized.includes("token")
    || normalized.includes("signature")
    || normalized.includes("credential")
    || normalized.includes("accesskey")
    || normalized.includes("apikey")
    || normalized.includes("authkey")
    || normalized === "key"
    || normalized === "sign"
    || normalized === "sendkey"
    || normalized === "cookie"
    || normalized === "setcookie";
}

function looksLikeSensitiveName(value: string): boolean {
  return sensitiveKey(value);
}

function truncateDiagnosticText(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}...` : value;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function errorCauseCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("cause" in error)) return null;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}
