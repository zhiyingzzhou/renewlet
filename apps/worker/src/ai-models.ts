/**
 * Cloudflare AI 模型列表代理只服务“用户主动刷新”场景。
 *
 * 这里复用 shared provider endpoint 作为请求事实源，Worker 只负责认证、超时、响应限额和错误回显；
 * 模型候选不会入库，避免把第三方账号能力或请求 API key 变成 Renewlet 的持久化数据。
 */
import {
  AI_RECOGNITION_MAX_MODEL_LIST_MODELS,
  aiModelListErrorDetailsSchema,
  aiModelListPayloadSchema,
  aiModelListRequestSchema,
  type AiModelListItem,
  type AiModelListRequest,
  type AiRecognitionTransportProtocol,
} from "@renewlet/shared/schemas/ai-recognition";
import { resolveAIProviderEndpoint, type AIModelListResponseShape } from "@renewlet/shared/ai-provider-endpoints";
import { requireAuth } from "./auth";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { serverText, type AppLocale } from "./server-i18n";
import type { Env } from "./types";
import { providerResponseFromFetchResponse } from "./ai-provider-response";
import { UpstreamResponseError, type UpstreamProviderResponse as AiProviderResponse } from "./upstream-response";
import { UpstreamRequestError, sendUpstreamRequest } from "./upstream-http";
import { resolveSecretMutation } from "@renewlet/shared/schemas/secrets";
import { getSettings } from "./db";

const AI_MODEL_LIST_TIMEOUT_MS = 15_000;
const AI_MODEL_LIST_RESPONSE_BYTES = 1 << 20;

type ModelListEndpoint = {
  url: string;
  headers: Headers;
  secrets: readonly string[];
  modelListShape: AIModelListResponseShape;
  providerType: AiModelListRequest["providerType"];
  transportProtocol: AiRecognitionTransportProtocol;
};

type NormalizedModelList = {
  models: AiModelListItem[];
  truncated: boolean;
};

type AIModelListResponseText = {
  text: string;
  truncated: boolean;
};

/**
 * listAIModels 是用户显式刷新模型列表的认证代理。
 *
 * 请求 API key 只在 Worker 内用于第三方 `/models` 请求，不入库、不回显，也不由前端直连 provider。
 */
export async function listAIModels(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, aiModelListRequestSchema, locale);
  const current = await getSettings(env, auth.user.id);
  const input = normalizeAIModelListRequest({
    ...body,
    apiKey: resolveSecretMutation(body.apiKey, current.aiRecognition.apiKey),
  });
  assertAIModelListRequest(input, locale);

  try {
    const endpoint = buildAIModelListEndpoint(input);
    const raw = await fetchAIModelListJSON(endpoint, locale);
    const normalized = normalizeAIModelList(endpoint.modelListShape, raw);
    return successJson(aiModelListPayloadSchema.parse({
      providerType: endpoint.providerType,
      transportProtocol: endpoint.transportProtocol,
      models: normalized.models,
      truncated: normalized.truncated,
    }));
  } catch (error) {
    if (error instanceof HttpError || error instanceof UpstreamResponseError) throw error;
    const details = aiModelListErrorDetails("provider_failed", error);
    throw new HttpError(
      400,
      details.rawResponseText,
      "AI_MODEL_LIST_FAILED",
      details,
    );
  }
}

type ResolvedAIModelListRequest = Omit<AiModelListRequest, "apiKey"> & { apiKey: string };

function normalizeAIModelListRequest(input: ResolvedAIModelListRequest): ResolvedAIModelListRequest {
  return {
    providerType: input.providerType,
    baseUrl: input.baseUrl.trim(),
    apiKey: input.apiKey.trim(),
  };
}

function assertAIModelListRequest(input: ResolvedAIModelListRequest, locale: AppLocale): void {
  const endpoint = resolveAIProviderEndpoint(input);
  if (endpoint.baseUrlRequired && !input.baseUrl) {
    throw new HttpError(400, serverText(locale, "aiRecognition.baseUrlRequired"), "AI_MODEL_LIST_BASE_URL_REQUIRED");
  }
  if (endpoint.apiKeyRequired && !input.apiKey) {
    throw new HttpError(400, serverText(locale, "aiRecognition.apiKeyRequired"), "AI_MODEL_LIST_API_KEY_REQUIRED");
  }
}

function buildAIModelListEndpoint(input: ResolvedAIModelListRequest): ModelListEndpoint {
  const headers = new Headers({ accept: "application/json" });
  const endpoint = resolveAIProviderEndpoint(input);
  // 鉴权头由 shared resolver 按协议生成；Worker 只补模型列表代理自己的 Accept。
  for (const [key, value] of Object.entries(endpoint.authHeaders)) {
    headers.set(key, value);
  }
  return {
    url: endpoint.modelsUrl,
    headers,
    secrets: input.apiKey ? [input.apiKey] : [],
    modelListShape: endpoint.modelListShape,
    providerType: endpoint.providerType,
    transportProtocol: endpoint.transportProtocol,
  };
}

async function fetchAIModelListJSON(endpoint: ModelListEndpoint, locale: AppLocale): Promise<unknown> {
  let response: Response;
  try {
    // 这是用户显式点击刷新后才触发的第三方请求；请求 API key 只在 Worker 侧使用，不回显、不持久化。
    response = await sendUpstreamRequest(endpoint.url, {
      method: "GET",
      headers: endpoint.headers,
    }, {
      provider: `${endpoint.providerType} models`,
      secrets: endpoint.secrets,
      timeoutMs: AI_MODEL_LIST_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof UpstreamRequestError && error.timedOut) {
      throw new HttpError(
        408,
        serverText(locale, "aiRecognition.modelListTimeout"),
        "AI_MODEL_LIST_TIMEOUT",
        aiModelListErrorDetails("timeout", error),
      );
    }
    throw error;
  }

  const body = await readAIModelListResponseText(response, locale);
  if (!response.ok) {
    const providerResponse = providerResponseFromFetchResponse(response, body.text, body.truncated, endpoint.secrets);
    throw new UpstreamResponseError(
      response.status,
      providerResponse.body ?? "",
      providerResponse.headers,
      providerResponse.statusText ?? response.statusText,
    );
  }

  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    const details = aiModelListErrorDetails("invalid_json", body.text, providerResponseFromFetchResponse(response, body.text, body.truncated, endpoint.secrets));
    throw new HttpError(
      400,
      details.rawResponseText,
      "AI_MODEL_LIST_INVALID_JSON",
      details,
    );
  }
}

async function readAIModelListResponseText(response: Response, locale: AppLocale): Promise<AIModelListResponseText> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > AI_MODEL_LIST_RESPONSE_BYTES) {
      // 第三方模型接口不应返回海量正文；超限直接取消 reader，避免 Worker 内存被 provider 错误页放大。
      await reader.cancel().catch(() => undefined);
      throw new HttpError(
        413,
        serverText(locale, "common.requestBodyTooLarge"),
        "AI_MODEL_LIST_RESPONSE_TOO_LARGE",
        aiModelListErrorDetails("response_too_large", null),
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
}

function normalizeAIModelList(shape: AIModelListResponseShape, raw: unknown): NormalizedModelList {
  const models = shape === "gemini"
    ? normalizeGeminiModels(raw)
    : shape === "anthropic"
      ? normalizeAnthropicModels(raw)
      : normalizeOpenAIShapeModels(raw);
  const deduped = dedupeModels(models);
  return {
    // 截断只影响候选展示，用户仍可手输模型 ID；列表不能成为超大 provider 响应的搬运通道。
    models: deduped.slice(0, AI_RECOGNITION_MAX_MODEL_LIST_MODELS),
    truncated: deduped.length > AI_RECOGNITION_MAX_MODEL_LIST_MODELS,
  };
}

function normalizeOpenAIShapeModels(raw: unknown): AiModelListItem[] {
  const data = arrayField(record(raw), "data");
  return data.map((item) => {
    const model = record(item);
    const id = stringField(model, "id");
    if (!id) return null;
    return modelItem({
      id,
      displayName: stringField(model, "display_name") || stringField(model, "displayName"),
      createdAt: epochSecondsToISO(numberField(model, "created")),
      ownedBy: stringField(model, "owned_by") || stringField(model, "ownedBy"),
    });
  }).filter((item): item is AiModelListItem => item !== null);
}

function normalizeGeminiModels(raw: unknown): AiModelListItem[] {
  const models = arrayField(record(raw), "models");
  return models.map((item) => {
    const model = record(item);
    const methods = stringArrayField(model, "supportedGenerationMethods");
    if (methods.length > 0 && !methods.includes("generateContent")) return null;
    const name = stringField(model, "name");
    const id = stringField(model, "baseModelId") || stripGeminiModelPrefix(name);
    if (!id) return null;
    const thinking = model["thinking"];
    return modelItem({
      id,
      displayName: stringField(model, "displayName"),
      inputTokenLimit: numberField(model, "inputTokenLimit"),
      outputTokenLimit: numberField(model, "outputTokenLimit"),
      capabilities: {
        textInput: true,
        imageInput: null,
        structuredOutput: null,
        thinking: typeof thinking === "boolean" ? thinking : thinking == null ? null : true,
      },
    });
  }).filter((item): item is AiModelListItem => item !== null);
}

function normalizeAnthropicModels(raw: unknown): AiModelListItem[] {
  const data = arrayField(record(raw), "data");
  return data.map((item) => {
    const model = record(item);
    const id = stringField(model, "id");
    if (!id) return null;
    const capabilities = record(model["capabilities"]);
    return modelItem({
      id,
      displayName: stringField(model, "display_name") || stringField(model, "displayName"),
      createdAt: stringField(model, "created_at") || stringField(model, "createdAt"),
      ownedBy: stringField(model, "type"),
      capabilities: {
        textInput: booleanField(capabilities, "text") ?? null,
        imageInput: booleanField(capabilities, "vision") ?? null,
        structuredOutput: null,
        thinking: booleanField(capabilities, "thinking") ?? null,
      },
    });
  }).filter((item): item is AiModelListItem => item !== null);
}

function modelItem(input: {
  id: string;
  displayName?: string | null;
  createdAt?: string | null;
  ownedBy?: string | null;
  inputTokenLimit?: number | null;
  outputTokenLimit?: number | null;
  capabilities?: Partial<AiModelListItem["capabilities"]>;
}): AiModelListItem {
  return {
    id: input.id,
    displayName: input.displayName || null,
    createdAt: input.createdAt || null,
    ownedBy: input.ownedBy || null,
    inputTokenLimit: input.inputTokenLimit ?? null,
    outputTokenLimit: input.outputTokenLimit ?? null,
    capabilities: {
      textInput: input.capabilities?.textInput ?? null,
      imageInput: input.capabilities?.imageInput ?? null,
      structuredOutput: input.capabilities?.structuredOutput ?? null,
      thinking: input.capabilities?.thinking ?? null,
    },
  };
}

function dedupeModels(models: readonly AiModelListItem[]): AiModelListItem[] {
  const out: AiModelListItem[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? Math.trunc(field) : null;
}

function booleanField(value: Record<string, unknown>, key: string): boolean | null {
  const field = value[key];
  return typeof field === "boolean" ? field : null;
}

function epochSecondsToISO(value: number | null): string | null {
  return value && value > 0 ? new Date(value * 1000).toISOString() : null;
}

function stripGeminiModelPrefix(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^models\//, "");
}

function aiModelListErrorDetails(reason: string, providerMessage: unknown, providerResponse: AiProviderResponse | null = null) {
  const message = providerMessage instanceof Error
    ? providerMessage.message
    : typeof providerMessage === "string"
      ? providerMessage
      : null;
  return aiModelListErrorDetailsSchema.parse({
    rawResponseText: providerResponse?.body || providerResponse?.statusText || message || reason,
  });
}
