import { APICallError } from "ai";
import {
  type UpstreamProviderResponse as AiProviderResponse,
  UpstreamOperationError,
  UpstreamResponseError,
  upstreamProviderResponseFromBody,
  upstreamProviderResponseFromUnknown,
} from "./upstream-response";

type APICallErrorLike = {
  statusCode?: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  cause?: unknown;
  errors?: unknown;
};

// AI SDK 会把 provider 响应藏在 APICallError/cause/errors 不同层级；这里统一转成上游 helper 的内部形状再取 rawResponseText。
export function providerResponseFromFetchResponse(response: Response, body: string, bodyTruncated = false, secrets: readonly string[] = []): AiProviderResponse {
  return upstreamProviderResponseFromBody(response, body, bodyTruncated, secrets);
}

export function providerResponseFromError(error: unknown, secrets: readonly string[] = []): AiProviderResponse | null {
  const apiError = findAPICallError(error);
  if (!apiError) return null;
  return upstreamProviderResponseFromUnknown({
    status: apiError.statusCode,
    statusText: null,
    headers: apiError.responseHeaders,
    body: apiError.responseBody,
    bodyTruncated: false,
  }, secrets);
}

/** APICallError 只要带有上游 status，就必须在 HTTP 边界保持原状态和原 body。 */
export function upstreamResponseErrorFromError(error: unknown, secrets: readonly string[] = []): UpstreamResponseError | null {
  return findUpstreamResponseError(error, secrets);
}

function findUpstreamResponseError(error: unknown, secrets: readonly string[], seen = new WeakSet<object>()): UpstreamResponseError | null {
  if (!error || typeof error !== "object" || seen.has(error)) return null;
  seen.add(error);
  if (error instanceof UpstreamResponseError) return error;

  const response = providerResponseFromError(error, secrets);
  if (response?.status) return new UpstreamResponseError(response.status, response.body ?? "", response.headers, response.statusText ?? "");
  if (error instanceof UpstreamOperationError && error.status) {
    return new UpstreamResponseError(error.status, error.details?.rawResponseText ?? "");
  }

  if ("cause" in error) {
    const cause = findUpstreamResponseError((error as { cause?: unknown }).cause, secrets, seen);
    if (cause) return cause;
  }
  if ("errors" in error && Array.isArray((error as { errors?: unknown }).errors)) {
    for (const nested of (error as { errors: unknown[] }).errors) {
      const match = findUpstreamResponseError(nested, secrets, seen);
      if (match) return match;
    }
  }
  return null;
}

function findAPICallError(error: unknown, seen = new WeakSet<object>()): APICallErrorLike | null {
  if (!error || typeof error !== "object") return null;
  if (seen.has(error)) return null;
  seen.add(error);
  let fallback: APICallErrorLike | null = null;
  if (isAPICallError(error)) {
    // 优先返回带 responseBody 的层级；只有 status/header 的外层错误不应该遮住真正 provider body。
    if (hasProviderResponseBody(error)) return error;
    fallback = error;
  }
  if ("cause" in error) {
    const causeMatch = findAPICallError((error as { cause?: unknown }).cause, seen);
    if (causeMatch && hasProviderResponseBody(causeMatch)) return causeMatch;
    fallback ??= causeMatch;
  }
  if ("errors" in error) {
    const nestedErrors = (error as { errors?: unknown }).errors;
    if (Array.isArray(nestedErrors)) {
      for (const item of nestedErrors) {
        const itemMatch = findAPICallError(item, seen);
        if (itemMatch && hasProviderResponseBody(itemMatch)) return itemMatch;
        fallback ??= itemMatch;
      }
    }
  }
  return fallback;
}

function isAPICallError(error: unknown): error is APICallErrorLike {
  if (APICallError.isInstance(error)) return true;
  return Boolean(
    error
      && typeof error === "object"
      && (
        "responseBody" in error
          || "responseHeaders" in error
          || "statusCode" in error
      ),
  );
}

function hasProviderResponseBody(error: APICallErrorLike): boolean {
  return typeof error.responseBody === "string" && error.responseBody.length > 0;
}
