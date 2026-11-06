import { z } from "zod";
import { apiEmptySuccess, apiSuccess } from "@renewlet/shared/schemas/api";
import { apiErrorResponseSchema } from "@renewlet/shared/schemas/errors";
import { DEFAULT_SERVER_I18N_LOCALE, requestLocale, serverText, type AppLocale } from "./server-i18n";
import { UpstreamOperationError, UpstreamResponseError } from "./upstream-response";

const JSON_LIMIT_BYTES = 1 << 20;
const EMPTY_BODY_LIMIT_BYTES = 1024;
export const SESSION_COOKIE_NAME = "renewlet_session";
export const CSRF_COOKIE_NAME = "renewlet_csrf";
export const CSRF_HEADER_NAME = "X-Renewlet-CSRF";

export { requestLocale, type AppLocale } from "./server-i18n";

/**
 * json 构造 Worker API 的统一 JSON 响应。
 *
 * 显式 nosniff 是因为同一路径既返回 JSON 又可能处理资产/ICS，浏览器不能根据内容猜测类型。
 */
export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}

/**
 * successJson 是产品 JSON API 成功响应的唯一出口。
 *
 * json() 仍保持裸 JSON，供错误 envelope、SSE/ICS/blob 例外和第三方 webhook adapter 使用。
 */
export function successJson(value: unknown, init: ResponseInit = {}): Response {
  return json(apiSuccess(value), init);
}

/** ok 是无额外字段的产品成功响应；需要业务状态时应使用 successJson(payload)。 */
export function ok(status = 200): Response {
  return json(apiEmptySuccess(), { status });
}

/** errorResponse 是 Worker 错误 wire contract 的唯一出口；不要在 handler 里手写扁平 message/code。 */
export function errorResponse(
  status: number,
  message: string,
  code?: string,
  details?: unknown,
  init: ResponseInit = {},
): Response {
  // 这里 parse shared schema 是运行时自检，防止 Worker 和 Go/前端约定的错误 envelope 悄悄漂移。
  const detailsRecord = details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : null;
  const requestId = typeof detailsRecord?.["requestId"] === "string" && detailsRecord["requestId"].trim().length > 0
    ? detailsRecord["requestId"]
    : crypto.randomUUID();
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return json(apiErrorResponseSchema.parse({
    error: {
      code: code ?? defaultErrorCodeForStatus(status),
      message,
      ...(details === undefined ? {} : { details }),
      requestId,
    },
  }), {
    ...init,
    status,
    headers,
  });
}

function defaultErrorCodeForStatus(status: number): string {
  if (status === 400) return "INVALID_PAYLOAD";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 405) return "METHOD_NOT_ALLOWED";
  if (status === 409) return "CONFLICT";
  if (status === 413) return "BODY_TOO_LARGE";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502) return "UPSTREAM_FAILED";
  return "INTERNAL_ERROR";
}

/** methodNotAllowed 使用服务端 catalog，保证未命中 route 的错误也跟随请求 locale。 */
export function methodNotAllowed(locale: AppLocale): Response {
  return errorResponse(405, serverText(locale, "common.methodNotAllowed"), "METHOD_NOT_ALLOWED");
}

/** privateShortCache 只用于带认证语义但可短暂复用的响应，不能套到公共 ICS 或私有资产读取上。 */
export function privateShortCache(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, max-age=300");
  // 浏览器 session 只走 cookie；短私有缓存必须按 Cookie 隔离，Public API bearer 不进入这里。
  headers.set("vary", "Cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** 从 Authorization header 提取 Public API bearer；浏览器产品 session 不再从这里读取。 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function sessionCookieToken(request: Request): string | null {
  return cookieValue(request, SESSION_COOKIE_NAME);
}

export function csrfHeaderToken(request: Request): string | null {
  const value = request.headers.get(CSRF_HEADER_NAME);
  return value?.trim() || null;
}

export function setSessionCookies(response: Response, request: Request, sessionToken: string, csrfToken: string, expiresAt: string): Response {
  const headers = new Headers(response.headers);
  const secure = cookieSecure(request);
  headers.append("set-cookie", serializeCookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
    maxAge: 30 * 24 * 60 * 60,
  }));
  headers.append("set-cookie", serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
    maxAge: 30 * 24 * 60 * 60,
  }));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function clearSessionCookies(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const secure = cookieSecure(request);
  for (const [name, httpOnly] of [[SESSION_COOKIE_NAME, true], [CSRF_COOKIE_NAME, false]] as const) {
    headers.append("set-cookie", serializeCookie(name, "", {
      httpOnly,
      secure,
      sameSite: "Lax",
      path: "/",
      expires: "Thu, 01 Jan 1970 00:00:00 GMT",
      maxAge: 0,
    }));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function requireSameOriginUnsafe(request: Request, locale: AppLocale): void {
  if (!isUnsafeMethod(request.method)) return;
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    if (sameOrigin(origin, expected)) return;
    throw new HttpError(403, serverText(locale, "auth.sessionExpired"), "CSRF_ORIGIN_MISMATCH");
  }
  const referer = request.headers.get("referer")?.trim();
  if (referer) {
    if (sameOrigin(referer, expected)) return;
    throw new HttpError(403, serverText(locale, "auth.sessionExpired"), "CSRF_REFERER_MISMATCH");
  }
  throw new HttpError(403, serverText(locale, "auth.sessionExpired"), "CSRF_ORIGIN_REQUIRED");
}

export function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName !== name) continue;
    const value = rest.join("=");
    return value ? decodeURIComponent(value) : "";
  }
  return null;
}

function sameOrigin(value: string, expected: string): boolean {
  try {
    return new URL(value).origin === expected;
  } catch {
    return false;
  }
}

function cookieSecure(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" || request.headers.get("x-forwarded-proto")?.trim().toLowerCase() === "https";
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean; sameSite: "Lax"; path: string; expires: string; maxAge: number },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `Expires=${new Date(options.expires).toUTCString()}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function pathSegments(url: URL, prefix = "/api/app"): string[] {
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  return path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

/**
 * 读取并校验 JSON 请求体。
 *
 * Worker 没有 Go decoder 的 DisallowUnknownFields，因此必须依赖传入的 strict Zod schema
 * 在边界拒绝未知字段，并用 1MiB 上限防止 JSON API 被大 body 拖垮。
 */
export async function readJson<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  locale: AppLocale,
): Promise<z.infer<Schema>> {
  return readJsonWithLimit(request, schema, locale, JSON_LIMIT_BYTES);
}

export async function readJsonWithLimit<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  locale: AppLocale,
  limitBytes: number,
): Promise<z.infer<Schema>> {
  return (await readJsonWithLimitAndSize(request, schema, locale, limitBytes)).data;
}

export async function readJsonWithLimitAndSize<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  locale: AppLocale,
  limitBytes: number,
): Promise<{ data: z.infer<Schema>; bodyBytes: number }> {
  const body = await readLimitedTextBodyWithLimit(request, locale, false, limitBytes);
  return { data: parseJsonText(body.text, schema, locale), bodyBytes: body.bytes };
}

function parseJsonText<Schema extends z.ZodType>(
  text: string,
  schema: Schema,
  locale: AppLocale,
): z.infer<Schema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, serverText(locale, "common.invalidJson"), "INVALID_JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // Worker API 与 Go API 一样拒绝脏 payload；前端表单错误需要 details.flatten 定位字段。
    throw new HttpError(400, serverText(locale, "common.invalidPayload"), "INVALID_PAYLOAD", result.error.flatten());
  }
  return result.data;
}

export async function readOptionalJson<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  locale: AppLocale,
): Promise<z.infer<Schema>> {
  // 手动运行通知等端点允许空 body；空值仍解析成 {}，让 schema 决定默认字段而不是 route 自己补。
  const text = await readLimitedText(request, locale, true);
  if (!text) return schema.parse({});
  return parseJsonText(text, schema, locale);
}

/** 显式无参数动作必须保持真正空 body，避免 `{}` 被误当成长期 API 形状。 */
export async function requireEmptyBody(request: Request, locale: AppLocale): Promise<void> {
  const text = await readLimitedTextWithLimit(request, locale, true, EMPTY_BODY_LIMIT_BYTES);
  if (text.length > 0) {
    throw new HttpError(400, serverText(locale, "common.invalidPayload"), "NON_EMPTY_BODY");
  }
}

async function readLimitedText(request: Request, locale: AppLocale, allowEmpty: boolean): Promise<string> {
  return readLimitedTextWithLimit(request, locale, allowEmpty, JSON_LIMIT_BYTES);
}

async function readLimitedTextWithLimit(request: Request, locale: AppLocale, allowEmpty: boolean, limitBytes: number): Promise<string> {
	return (await readLimitedTextBodyWithLimit(request, locale, allowEmpty, limitBytes)).text;
}

async function readLimitedTextBodyWithLimit(
  request: Request,
  locale: AppLocale,
  allowEmpty: boolean,
  limitBytes: number,
): Promise<{ text: string; bytes: number }> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
  }
  const body = await readRequestTextUpToLimit(request, locale, limitBytes);
  if (!allowEmpty && body.text.trim() === "") {
    throw new HttpError(400, serverText(locale, "common.emptyBody"), "EMPTY_BODY");
  }
  return body;
}

async function readRequestTextUpToLimit(request: Request, locale: AppLocale, limitBytes: number): Promise<{ text: string; bytes: number }> {
  const reader = request.body?.getReader();
  if (!reader) return { text: "", bytes: 0 };
  // 不能退回 request.text()：content-length 缺失时仍要边读边截断，避免大 body 把 Worker isolate 拖垮。
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), bytes: total };
}

/** 结构化 HTTP 错误；前端 ApiError 只读取 error.code/details 来定位字段或展示通用错误。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function toResponse(error: unknown, locale: AppLocale = DEFAULT_SERVER_I18N_LOCALE): Response {
  if (error instanceof UpstreamResponseError) return error.toResponse();
  // 未被业务层捕获的上游 HTTP 错误也保持原 status/body；只有没有真实响应的 transport 错误才进入产品 envelope。
  if (error instanceof UpstreamOperationError && error.status) {
    return new UpstreamResponseError(error.status, error.details?.rawResponseText ?? "").toResponse();
  }
  // 未知异常只作为 500 返回；真正的字段级错误必须在边界处抛 HttpError，避免泄漏内部堆栈。
  if (error instanceof HttpError) return errorResponse(error.status, error.message, error.code, error.details);
  return errorResponse(500, serverText(locale, "common.internalError"), "INTERNAL_ERROR");
}
