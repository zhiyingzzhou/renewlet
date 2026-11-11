/**
 * AI provider endpoint 解析器是前端设置页、Go 后端和 Cloudflare Worker 的共同网络契约。
 *
 * 它集中处理默认 base URL、显式 `#` 逃生阀、模型列表 URL 和鉴权头，避免各运行面拼出不同第三方请求。
 */
import {
  canonicalAIRecognitionTransportProtocol,
  type AiRecognitionProviderType,
  type AiRecognitionSettings,
  type AiRecognitionTransportProtocol,
} from "./schemas/ai-recognition";

export type AIModelListResponseShape = "openai" | "anthropic" | "gemini";

/**
 * ResolvedAIProviderEndpoint 是 AI provider 的运行时派生结果。
 *
 * 前端设置页、Go SDK client 和 Cloudflare Worker 共享这份解析逻辑，避免 base URL、鉴权头和模型列表 URL 分叉。
 */
export interface ResolvedAIProviderEndpoint {
  providerType: AiRecognitionProviderType;
  transportProtocol: AiRecognitionTransportProtocol;
  runtimeBaseUrl: string;
  modelsUrl: string;
  modelListShape: AIModelListResponseShape;
  authHeaders: Record<string, string>;
  baseUrlRequired: boolean;
  apiKeyRequired: boolean;
  autoVersionDisabled: boolean;
}

export type AIProviderEndpointSettings = Pick<AiRecognitionSettings, "providerType" | "baseUrl" | "apiKey"> & {
  transportProtocol?: AiRecognitionTransportProtocol;
};

const DEFAULT_BASE_URLS: Record<AiRecognitionTransportProtocol, string> = {
  "openai-responses": "https://api.openai.com/v1",
  "openai-chat": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
  "gemini-generate-content": "https://generativelanguage.googleapis.com/v1beta",
};

const OPENAI_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/responses",
  "/models",
  "/embeddings",
  "/images/generations",
  "/images/edits",
] as const;
const ANTHROPIC_ENDPOINT_SUFFIXES = ["/messages", "/models"] as const;
const VERSION_SEGMENT_PATTERN = /\/v\d+(?:alpha|beta)?(?=\/|$)/i;
const TRAILING_VERSION_SEGMENT_PATTERN = /\/v\d+(?:alpha|beta)?$/i;

/**
 * 解析 AI provider 的请求入口。
 *
 * transportProtocol 由 providerType canonical 派生；用户传入的 protocol 只作为历史数据形状存在，不能改变 SDK 分派。
 */
export function resolveAIProviderEndpoint(settings: AIProviderEndpointSettings): ResolvedAIProviderEndpoint {
  // 协议是跨 Go/Worker/前端的运行时派生字段，不是用户配置项；入口处覆盖错配值，避免平台和 SDK 分派漂移。
  const transportProtocol = canonicalAIRecognitionTransportProtocol(settings.providerType);
  const rawBaseUrl = settings.baseUrl.trim();
  const baseUrlRequired = isAIProviderBaseUrlRequired(settings.providerType);
  const apiKeyRequired = settings.providerType !== "openai-compatible";
  const runtimeBaseUrl = normalizeAIProviderBaseUrl(transportProtocol, rawBaseUrl || defaultBaseUrlForSettings(settings.providerType));
  const authHeaders = aiProviderAuthHeaders(transportProtocol, settings.apiKey.trim());
  return {
    providerType: settings.providerType,
    transportProtocol,
    runtimeBaseUrl,
    modelsUrl: appendAIProviderPath(runtimeBaseUrl, "/models"),
    modelListShape: modelListShapeForProtocol(transportProtocol),
    authHeaders,
    baseUrlRequired,
    apiKeyRequired,
    autoVersionDisabled: rawBaseUrl.endsWith("#"),
  };
}

export function isAIProviderBaseUrlRequired(providerType: AiRecognitionProviderType): boolean {
  return defaultBaseUrlForSettings(providerType) === "";
}

/**
 * 规范化第三方 API base URL。
 *
 * 末尾 `#` 是显式禁用自动补版本号的逃生阀，用于兼容私有网关或 OpenAI-compatible 转发层。
 */
export function normalizeAIProviderBaseUrl(
  transportProtocol: AiRecognitionTransportProtocol,
  baseUrl: string,
): string {
  if (transportProtocol === "anthropic-messages") {
    return normalizeVersionedAPIBase(baseUrl, "v1", ANTHROPIC_ENDPOINT_SUFFIXES);
  }
  if (transportProtocol === "gemini-generate-content") {
    return normalizeGeminiAPIBase(baseUrl, "v1beta");
  }
  return normalizeVersionedAPIBase(baseUrl, "v1", OPENAI_ENDPOINT_SUFFIXES);
}

function defaultBaseUrlForSettings(
  providerType: AiRecognitionProviderType,
): string {
  const transportProtocol = canonicalAIRecognitionTransportProtocol(providerType);
  if (providerType === "openai") return DEFAULT_BASE_URLS[transportProtocol];
  if (providerType === "anthropic") return DEFAULT_BASE_URLS[transportProtocol];
  if (providerType === "gemini") return DEFAULT_BASE_URLS[transportProtocol];
  return "";
}

function modelListShapeForProtocol(transportProtocol: AiRecognitionTransportProtocol): AIModelListResponseShape {
  if (transportProtocol === "anthropic-messages") return "anthropic";
  if (transportProtocol === "gemini-generate-content") return "gemini";
  return "openai";
}

function aiProviderAuthHeaders(
  transportProtocol: AiRecognitionTransportProtocol,
  apiKey: string,
): Record<string, string> {
  // 鉴权头由 canonical 协议决定；OpenAI-compatible 在 Renewlet 内固定走 OpenAI Chat，不再混发其它平台 header。
  if (transportProtocol === "anthropic-messages") {
    return {
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
    };
  }
  if (transportProtocol === "gemini-generate-content") {
    return apiKey ? { "x-goog-api-key": apiKey } : {};
  }
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function normalizeVersionedAPIBase(
  baseUrl: string,
  version: string,
  endpointSuffixes: readonly string[],
): string {
  const raw = baseUrl.trim();
  if (!raw) return "";
  const noAutoVersion = raw.endsWith("#");
  // 末尾 # 是设置页的显式逃生阀：保留用户自定义路径，但只移除具体 endpoint 后缀。
  const withoutMarker = noAutoVersion ? raw.slice(0, -1) : raw;
  const stripped = stripKnownEndpointSuffix(withoutMarker, endpointSuffixes);
  return formatVersionedAPIBase(stripped, version, !noAutoVersion);
}

function normalizeGeminiAPIBase(baseUrl: string, version: string): string {
  const raw = baseUrl.trim();
  if (!raw) return "";
  const noAutoVersion = raw.endsWith("#");
  // Gemini 网关常用自定义根路径；# 禁用自动补 /v1beta，避免把私有路由拼坏。
  const withoutMarker = noAutoVersion ? raw.slice(0, -1) : raw;
  const stripped = stripGeminiModelsPath(withoutMarker);
  if (noAutoVersion) return trimTrailingSlash(stripped);
  const withoutTrailingVersion = trimTrailingSlash(stripped).replace(TRAILING_VERSION_SEGMENT_PATTERN, "");
  return formatVersionedAPIBase(withoutTrailingVersion, version, true);
}

function formatVersionedAPIBase(baseUrl: string, version: string, autoVersion: boolean): string {
  const normalized = trimTrailingSlash(baseUrl.trim());
  if (!normalized) return "";
  if (!autoVersion || VERSION_SEGMENT_PATTERN.test(pathnameFromURLish(normalized))) {
    return trimTrailingSlash(normalized);
  }
  return `${normalized}/${version}`;
}

function stripKnownEndpointSuffix(baseUrl: string, endpointSuffixes: readonly string[]): string {
  const input = trimTrailingSlash(baseUrl.trim());
  if (!input) return "";
  const parsed = parseURL(input);
  if (parsed) {
    const path = trimTrailingSlash(parsed.pathname);
    const lowerPath = path.toLowerCase();
    for (const suffix of endpointSuffixes) {
      if (lowerPath.endsWith(suffix)) {
        parsed.pathname = path.slice(0, -suffix.length) || "/";
        parsed.search = "";
        parsed.hash = "";
        return trimTrailingSlash(parsed.toString());
      }
    }
    parsed.pathname = path || "/";
    parsed.search = "";
    parsed.hash = "";
    return trimTrailingSlash(parsed.toString());
  }
  const lower = input.toLowerCase();
  for (const suffix of endpointSuffixes) {
    if (lower.endsWith(suffix)) return input.slice(0, -suffix.length);
  }
  return input;
}

function stripGeminiModelsPath(baseUrl: string): string {
  const input = trimTrailingSlash(baseUrl.trim());
  if (!input) return "";
  const parsed = parseURL(input);
  if (parsed) {
    const path = trimTrailingSlash(parsed.pathname);
    const index = path.toLowerCase().indexOf("/models");
    parsed.pathname = index >= 0 ? path.slice(0, index) || "/" : path || "/";
    parsed.search = "";
    parsed.hash = "";
    return trimTrailingSlash(parsed.toString());
  }
  const index = input.toLowerCase().indexOf("/models");
  return index >= 0 ? input.slice(0, index) : input;
}

function appendAIProviderPath(baseUrl: string, path: string): string {
  const parsed = parseURL(baseUrl);
  if (!parsed) return `${trimTrailingSlash(baseUrl)}${path}`;
  parsed.pathname = `${trimTrailingSlash(parsed.pathname)}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function pathnameFromURLish(value: string): string {
  return parseURL(value)?.pathname ?? value;
}

function parseURL(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
