import {
  UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS,
  upstreamErrorDetailsSchema,
  type UpstreamErrorDetails,
} from "@renewlet/shared/schemas/upstream";

export type UpstreamResponseCaptureOptions = {
  secrets?: readonly string[];
  bodyLimitBytes?: number;
};

type UpstreamResponseHeaders = {
  forEach(callback: (value: string, key: string) => void): void;
  get(name: string): string | null;
};

/** Workers fetch 与 WebDAV 的 fetch adapter 只需共享这组响应能力，不把任一运行时的完整 Response 类型泄漏给调用方。 */
export type UpstreamFetchResponse = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: UpstreamResponseHeaders;
  readonly body: unknown;
};

// 这个结构只在运行时内部保留 status/header/body 以便脱敏取 rawResponseText；公开 API 只暴露 shared 的 details.rawResponseText。
export type UpstreamProviderResponse = {
  status: number | null;
  statusText: string | null;
  headers: Record<string, string> | null;
  body: string | null;
  bodyTruncated: boolean;
};

const textEncoder = new TextEncoder();
// Provider errors may echo a key variant that is not byte-for-byte equal to the
// configured value (for example a test gateway appends a suffix).  Keep the
// generic token guard at the upstream boundary so raw pass-through never turns
// into credential disclosure.
const GENERIC_UPSTREAM_SECRET_PATTERN = /(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:api[_-]?key|authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token)["'\s:=]+[A-Za-z0-9._~+/=-]{8,})/gi;

// 上游错误需要沿 cause/errors 嵌套向外冒泡；details 只能随当前失败响应返回，不进入 cron history 或缓存状态。
export class UpstreamOperationError extends Error {
  constructor(message: string, readonly details?: UpstreamErrorDetails, readonly status?: number) {
    super(message);
    this.name = "UpstreamOperationError";
  }
}

/**
 * 上游已经返回 HTTP 响应时使用的透明错误。
 *
 * 该错误只承载当前响应，不经过 Renewlet 的产品 error envelope；调用方需要把上游
 * status/body/content-type 原样交付给前端，才能让 provider 的 type/code/message 保持可诊断。
 */
export class UpstreamResponseError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly headers: Record<string, string> | null = null,
    readonly statusText = "",
  ) {
    super(`Upstream HTTP ${status}`);
    this.name = "UpstreamResponseError";
  }

  toResponse(): Response {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.headers ?? {})) {
      // 只复制安全且不负责 body framing 的响应头；鉴权、Cookie、签名和压缩/长度头永远不能从 provider 回显。
      if (safeUpstreamHeaderName(name)) headers.set(name, value);
    }
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    const init: ResponseInit = {
      status: this.status,
      headers,
    };
    // exactOptionalPropertyTypes 要求可选字段“缺省”而不是显式写入 undefined。
    if (this.statusText) init.statusText = this.statusText;
    return new Response(this.body, init);
  }
}

export async function upstreamProviderResponseFromFetchResponse(
  response: UpstreamFetchResponse,
  options: UpstreamResponseCaptureOptions = {},
): Promise<UpstreamProviderResponse> {
  const body = await readUpstreamResponseBody(response, options.bodyLimitBytes);
  return upstreamProviderResponseFromBody(response, body.text, body.truncated, options.secrets ?? []);
}

export function upstreamProviderResponseFromBody(
  response: UpstreamFetchResponse,
  body: string,
  bodyTruncated: boolean,
  secrets: readonly string[] = [],
): UpstreamProviderResponse {
  return {
    status: response.status,
    statusText: response.statusText || null,
    headers: upstreamHeadersToObject(response.headers, secrets),
    body: body ? redactUpstreamSecrets(body, secrets) : null,
    bodyTruncated,
  };
}

export function upstreamProviderResponseFromUnknown(
  input: {
    status?: unknown;
    statusText?: unknown;
    headers?: unknown;
    body?: unknown;
    bodyTruncated?: unknown;
  },
  secrets: readonly string[] = [],
): UpstreamProviderResponse {
  const body = typeof input.body === "string" ? redactUpstreamSecrets(input.body, secrets) : "";
  return {
    status: typeof input.status === "number" && input.status >= 100 && input.status <= 599 ? input.status : null,
    statusText: typeof input.statusText === "string" && input.statusText.trim() ? input.statusText.trim() : null,
    headers: recordToUpstreamHeaders(input.headers, secrets),
    body: body || null,
    bodyTruncated: input.bodyTruncated === true,
  };
}

export function createUpstreamErrorDetails(input: {
  responseText?: string | null;
  providerResponse?: UpstreamProviderResponse | null;
  fallbackText?: string | null;
}): UpstreamErrorDetails | undefined {
  // rawResponseText 可承载 provider body 或脱敏后的请求诊断；完整结构仍不持久化，避免 headers/query/body 变成日志契约。
  const rawResponseText = input.providerResponse?.body || input.responseText || input.fallbackText || null;
  return rawResponseText ? upstreamErrorDetailsSchema.parse({ rawResponseText }) : undefined;
}

export function createUpstreamHTTPError(input: {
  provider: string;
  response: UpstreamFetchResponse;
  providerResponse: UpstreamProviderResponse;
  providerMessage?: string | null;
}): UpstreamOperationError {
  const providerMessage = input.providerMessage ?? providerMessageFromResponse(input.providerResponse);
  const message = providerMessage
    ? `${input.provider} HTTP ${input.response.status}: ${providerMessage}`
    : `${input.provider} HTTP ${input.response.status}`;
  return new UpstreamOperationError(
    message,
    createUpstreamErrorDetails({
      responseText: providerMessage,
      providerResponse: input.providerResponse,
    }),
    input.response.status,
  );
}

export function upstreamErrorDetailsFromError(error: unknown): UpstreamErrorDetails | undefined {
  const match = findUpstreamOperationError(error);
  return match?.details;
}

export function providerMessageFromResponse(response: UpstreamProviderResponse | null | undefined): string | null {
  return response?.body || response?.statusText || null;
}

export function upstreamHeadersToObject(headers: UpstreamResponseHeaders, secrets: readonly string[] = []): Record<string, string> | null {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    // response header 也可能带 Set-Cookie、签名或临时 token；只保留排障有用且不含凭据的 header。
    if (!safeUpstreamHeaderName(key)) return;
    const text = redactUpstreamSecrets(value.trim(), secrets);
    if (text) out[key] = text;
  });
  return Object.keys(out).length > 0 ? out : null;
}

export function recordToUpstreamHeaders(value: unknown, secrets: readonly string[] = []): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || !safeUpstreamHeaderName(key)) continue;
    const text = redactUpstreamSecrets(item.trim(), secrets);
    if (text) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function safeUpstreamHeaderName(key: string): boolean {
  const normalized = key.toLowerCase().trim();
  if (!normalized) return false;
  if (
    normalized === "authorization"
    || normalized === "proxy-authorization"
    || normalized === "cookie"
    || normalized === "set-cookie"
    || normalized === "content-length"
    || normalized === "content-encoding"
    || normalized === "transfer-encoding"
    || normalized === "connection"
    || normalized === "keep-alive"
    || normalized === "trailer"
    || normalized === "upgrade"
  ) return false;
  return !normalized.includes("secret")
    && !normalized.includes("token")
    && !normalized.includes("signature")
    && !normalized.includes("credential")
    && !normalized.includes("accesskey")
    && !normalized.includes("access-key")
    && !normalized.includes("api-key")
    && !normalized.includes("apikey")
    && !normalized.includes("auth-key")
    && !normalized.includes("authkey");
}

export function redactUpstreamSecrets(value: string, secrets: readonly string[] = []): string {
  let out = value.replace(GENERIC_UPSTREAM_SECRET_PATTERN, "[redacted]");
  for (const secret of normalizedUpstreamSecrets(secrets)) {
    // 同时替换原文和 URL 编码形态，覆盖 SendKey/API key 出现在 HTML、JSON 或签名 URL 里的常见返回。
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return redactSignedQueryValues(out);
}

// 协议库可能返回 Web Stream、Node stream 或空响应 Blob；统一有界读取，不能退回整包 response.text()。
export async function readUpstreamResponseBody(response: Pick<UpstreamFetchResponse, "body">, limitBytes = UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const limit = Math.max(0, Math.floor(limitBytes));
  if (response.body instanceof Blob) return await readWebReadableBody(response.body.stream(), limit);
  if (isWebReadableBody(response.body)) return await readWebReadableBody(response.body, limit);
  if (isAsyncIterableBody(response.body)) return await readAsyncIterableBody(response.body, limit);
  throw new Error("Unsupported upstream response body");
}

async function readWebReadableBody(body: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return {
    text: new TextDecoder().decode(concatUint8Arrays(chunks)),
    truncated,
  };
}

async function readAsyncIterableBody(body: AsyncIterable<unknown>, limit: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const value of body) {
    const chunk = upstreamBodyChunkBytes(value);
    const remaining = limit - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (chunk.byteLength > remaining) {
      chunks.push(chunk.slice(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return {
    text: new TextDecoder().decode(concatUint8Arrays(chunks)),
    truncated,
  };
}

function isWebReadableBody(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object"
    && value !== null
    && "getReader" in value
    && typeof value.getReader === "function";
}

function isAsyncIterableBody(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === "function";
}

function upstreamBodyChunkBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return textEncoder.encode(value);
  throw new Error("Unsupported upstream response body chunk");
}

export async function readUpstreamResponseTextUpToLimit(response: UpstreamFetchResponse, label: string, limitBytes: number): Promise<string> {
  const limit = Math.max(0, Math.floor(limitBytes));
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`${label} response too large`);
  }
  // registry/feed 响应属于不可信上游；复用统一 reader 后再把截断升级成硬失败，避免解析半截 JSON/XML。
  const body = await readUpstreamResponseBody(response, limit);
  if (body.truncated) throw new Error(`${label} response too large`);
  return body.text;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function normalizedUpstreamSecrets(secrets: readonly string[]): string[] {
  return Array.from(new Set(secrets.map((secret) => secret.trim()).filter((secret) => textEncoder.encode(secret).byteLength >= 4)));
}

function redactSignedQueryValues(value: string): string {
  return value.replace(
    /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|AWSAccessKeyId|Signature|sign|Expires|access_key|accessKey|api_key|apikey|token|sendkey|sendKey|key)=)[^&\s"'<>]+/gi,
    "$1[redacted]",
  );
}

function findUpstreamOperationError(error: unknown, seen = new WeakSet<object>()): UpstreamOperationError | null {
  if (!error || typeof error !== "object") return null;
  if (seen.has(error)) return null;
  seen.add(error);
  if (error instanceof UpstreamOperationError) return error;
  const cause = "cause" in error ? findUpstreamOperationError((error as { cause?: unknown }).cause, seen) : null;
  if (cause) return cause;
  const errors = "errors" in error ? (error as { errors?: unknown }).errors : undefined;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const match = findUpstreamOperationError(item, seen);
      if (match) return match;
    }
  }
  return null;
}
