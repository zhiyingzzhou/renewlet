/**
 * Worker AI SDK runtime adapter。
 *
 * 这里把 shared provider endpoint 转成 AI SDK language model，并通过 middleware 捕获 raw text/usage，供 diagnostics 脱敏后返回。
 */
import { generateText, wrapLanguageModel, type JSONValue, type ModelMessage, type UserContent } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { openai as defaultOpenAI, createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  aiRecognitionSettingsSchema,
  type AiRecognitionSettings,
  type AiThinkingControl,
} from "@renewlet/shared/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import { extractAIModelText, finishReasonText } from "./ai-recognition-diagnostics";
import { UpstreamRequestError, sendUpstreamRequest } from "./upstream-http";

const AI_RECOGNITION_TEST_TEXT = "Reply with OK.";
export const AI_RECOGNITION_PROVIDER_TIMEOUT_MS = 90_000;
const AI_RECOGNITION_NETWORK_RETRY_DELAY_MS = 150;

/** Provider 适配器只依赖 Fetch 标准字段，禁止把 Cloudflare Request 的 cf 泛型带入重试边界。 */
type AIRecognitionRequestSource = {
  url: string;
  method: string;
  headers: Headers;
  body: Body["body"];
  redirect: string;
  signal: AbortSignal;
};

function normalizeAIRecognitionRequestRedirect(value: string | undefined): RequestRedirect | undefined {
  if (value === "follow" || value === "error" || value === "manual") return value;
  return undefined;
}

export type AIRecognitionRuntimeInput = {
  text: string;
  images: Array<{ data: Uint8Array; mediaType: string }>;
};

/** 捕获 provider 响应事实供 diagnostics 使用；这里不保存 API key、请求头或图片原文。 */
export type AIRecognitionCapture = {
  rawModelText: string | null;
  usage: unknown | null;
  finishReason: string | null;
  providerMetadata: unknown | null;
};

/** 创建带 capture middleware 的模型实例；调用方负责在响应前统一脱敏 capture 内容。 */
export function createAIRecognitionModel(settings: AiRecognitionSettings, capture: AIRecognitionCapture) {
  const canonicalSettings = aiRecognitionSettingsSchema.parse(settings);
  const endpoint = resolveAIProviderEndpoint(canonicalSettings);
  const model = createAIRecognitionLanguageModel(canonicalSettings, endpoint.runtimeBaseUrl);

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({ doGenerate }) {
        const result = await doGenerate();
        // capture 只记录 provider 事实，真正返回前仍会经过 diagnostics 脱敏；不要在这里拼用户可见错误。
        capture.rawModelText = extractAIModelText(result.content) ?? capture.rawModelText;
        capture.usage = result.usage ?? capture.usage;
        capture.finishReason = finishReasonText(result.finishReason) ?? capture.finishReason;
        capture.providerMetadata = result.providerMetadata ?? capture.providerMetadata;
        return result;
      },
    },
  });
}

/** 按 canonical transport 选择 AI SDK provider，避免 providerType 与 transportProtocol 历史错配。 */
export function createAIRecognitionLanguageModel(settings: AiRecognitionSettings, runtimeBaseUrl: string) {
  const upstreamFetch = createAIRecognitionUpstreamFetch(settings);
  if (settings.transportProtocol === "anthropic-messages") {
    return createAnthropic({
      apiKey: settings.apiKey,
      baseURL: runtimeBaseUrl,
      fetch: upstreamFetch,
    })(settings.model);
  }
  if (settings.transportProtocol === "gemini-generate-content") {
    return createGoogleGenerativeAI({
      apiKey: settings.apiKey,
      baseURL: runtimeBaseUrl,
      fetch: upstreamFetch,
    })(settings.model);
  }
  if (settings.providerType === "openai") {
    return createOpenAI({ apiKey: settings.apiKey, baseURL: runtimeBaseUrl, fetch: upstreamFetch }).responses(settings.model);
  }
  return createOpenAICompatible({
    name: settings.providerType,
    baseURL: runtimeBaseUrl,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    supportsStructuredOutputs: true,
    fetch: upstreamFetch,
  })(settings.model);
}

/** connection test 只验证最小文本生成能力，不触发订阅 schema、图片输入或草稿归一化链路。 */
export async function runAIRecognitionConnectionTest(
  settings: AiRecognitionSettings,
  thinkingControl: AiThinkingControl | null = settings.defaultThinkingControl,
  abortSignal?: AbortSignal,
): Promise<void> {
  const canonicalSettings = aiRecognitionSettingsSchema.parse(settings);
  const providerOptions = providerOptionsForThinking(canonicalSettings, thinkingControl);
  // 连接测试绕开 schema/草稿归一化，但必须验证设置页选中的 thinking control 也能被当前模型接受。
  await generateText({
    model: createAIRecognitionLanguageModel(canonicalSettings, resolveAIProviderEndpoint(canonicalSettings).runtimeBaseUrl),
    prompt: AI_RECOGNITION_TEST_TEXT,
    maxOutputTokens: 16,
    maxRetries: 0,
    ...(abortSignal ? { abortSignal } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    timeout: { totalMs: AI_RECOGNITION_PROVIDER_TIMEOUT_MS },
  });
}

function createAIRecognitionUpstreamFetch(settings: AiRecognitionSettings): typeof globalThis.fetch {
  const secrets = settings.apiKey ? [settings.apiKey] : [];
  const provider = aiRecognitionProviderLabel(settings);
  // AI SDK 的单步 timeout 不能覆盖批量与工具步骤；provider 网络请求统一落在 custom fetch，确保共享总 deadline。
  return async (input, init = {}) => {
    // AI SDK 与 Workers 的 Request 带有不同的 cf 泛型；在 provider 适配边界只保留上游 HTTP
    // 真正需要的 URL/方法/headers/body/signal，避免把平台元数据类型带入通用请求出口。
    const sourceRequest: AIRecognitionRequestSource | undefined = typeof input === "string" || input instanceof URL ? undefined : input;
    const requestTarget: string | URL = typeof input === "string" || input instanceof URL ? input : input.url;
    const upstreamInit: RequestInit = {};
    const method = init.method !== undefined ? init.method : sourceRequest?.method;
    const headers = init.headers !== undefined ? init.headers : sourceRequest?.headers;
    const body = init.body !== undefined ? init.body : sourceRequest?.body;
    const redirect = normalizeAIRecognitionRequestRedirect(init.redirect ?? sourceRequest?.redirect);
    const signal = init.signal !== undefined ? init.signal : sourceRequest?.signal;
    if (method !== undefined) upstreamInit.method = method;
    if (headers !== undefined) upstreamInit.headers = headers;
    if (body !== undefined) upstreamInit.body = body;
    if (redirect !== undefined) upstreamInit.redirect = redirect;
    if (signal !== undefined) upstreamInit.signal = signal;
    // 请求体通常是字符串；只有已经是流的 Request 才提前 clone。这样网络级重试使用独立 body，
    // 同时避免每次成功请求都因为无条件 tee 流而额外缓存整份图片/JSON payload。
    const hasStreamBody = typeof ReadableStream !== "undefined" && upstreamInit.body instanceof ReadableStream;
    const replayableRequest = hasStreamBody ? new Request(requestTarget, upstreamInit) : null;
    const retryRequest = replayableRequest?.clone() ?? null;
    const send = (requestInit: RequestInit = upstreamInit) => sendUpstreamRequest(requestTarget, requestInit, {
      provider,
      secrets,
      timeoutMs: AI_RECOGNITION_PROVIDER_TIMEOUT_MS,
    });
    const sendReplayable = (request: AIRecognitionRequestSource) => {
      // Cloudflare Request 带有平台专属 cf 泛型，不能直接作为 shared RequestInfo 传播；这里只提取
      // 上游 HTTP 所需字段，确保重试仍复用同一 signal 和独立 body stream。
      const requestInit: RequestInit = {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      };
      const redirect = normalizeAIRecognitionRequestRedirect(request.redirect);
      if (redirect !== undefined) requestInit.redirect = redirect;
      if (request.body) requestInit.body = request.body;
      return send(requestInit);
    };
    try {
      return await (replayableRequest ? sendReplayable(replayableRequest) : send());
    } catch (error) {
      // 只对首个网络层错误做一次短退避重试；超时、取消、HTTP/结构化错误交给上层统一处理。
      const retrySignal = replayableRequest?.signal ?? signal;
      const canReplay = replayableRequest ? retryRequest !== null : !hasStreamBody;
      if (!(error instanceof UpstreamRequestError) || error.timedOut || !canReplay || retrySignal?.aborted) throw error;
      await waitForAIRecognitionRetry(retrySignal);
      return await (replayableRequest && retryRequest ? sendReplayable(retryRequest) : send());
    }
  };
}

async function waitForAIRecognitionRetry(signal: AbortSignal | null | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    timer = setTimeout(finish, AI_RECOGNITION_NETWORK_RETRY_DELAY_MS);
    if (!signal) return;
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function aiRecognitionProviderLabel(settings: AiRecognitionSettings): string {
  if (settings.transportProtocol === "anthropic-messages") return "Anthropic";
  if (settings.transportProtocol === "gemini-generate-content") return "Gemini";
  if (settings.providerType === "openai") return "OpenAI";
  return `${settings.providerType} AI`;
}

/** 判断 thinking control 是否属于当前 provider；错配值只能丢弃，不能跨 provider 复用。 */
export function thinkingControlMatchesSettings(settings: AiRecognitionSettings, control: AiThinkingControl): boolean {
  if (settings.transportProtocol === "openai-responses") return settings.providerType === "openai" && control.provider === "openai";
  if (settings.transportProtocol === "anthropic-messages") return settings.providerType === "anthropic" && control.provider === "anthropic";
  return settings.providerType === "gemini" && control.provider === "gemini";
}

export function providerOptionsForThinking(settings: AiRecognitionSettings, control: AiThinkingControl | null): Record<string, Record<string, JSONValue>> | undefined {
  // thinking options 是 provider 私有协议；不匹配当前设置时直接丢弃，避免 AI SDK 把无效参数发给第三方。
  if (!control) return undefined;
  if (control.provider === "openai") {
    if (settings.providerType !== "openai" || settings.transportProtocol !== "openai-responses") return undefined;
    // AI SDK 把 null 解释为“省略 reasoning.summary”，从而阻止显式 effort 自动开启详细摘要；Go SDK 不能复制这个 null wire 值。
    return { openai: { reasoningEffort: control.effort, reasoningSummary: null } };
  }
  if (control.provider === "gemini") {
    if (settings.providerType !== "gemini" || settings.transportProtocol !== "gemini-generate-content") return undefined;
    if (control.mode === "off") return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    if (control.mode === "dynamic") return { google: { thinkingConfig: { thinkingBudget: -1 } } };
    if (control.mode === "budget") return { google: { thinkingConfig: { thinkingBudget: control.budget } } };
    return { google: { thinkingConfig: { thinkingLevel: control.level } } };
  }
  if (settings.providerType !== "anthropic" || settings.transportProtocol !== "anthropic-messages") return undefined;
  if (control.mode === "effort") {
    return { anthropic: { effort: control.effort } };
  }
  return { anthropic: { thinking: { type: "enabled", budgetTokens: control.budgetTokens } } };
}

/** 原生 Responses 才允许使用内置 web search；兼容 Chat provider 不伪造联网能力。 */
export function openAIRecognitionTools(settings: AiRecognitionSettings) {
  if (settings.providerType !== "openai" || settings.transportProtocol !== "openai-responses") return undefined;
  return {
    webSearch: defaultOpenAI.tools.webSearch({ searchContextSize: "low" }),
  };
}

/** 将文本和图片组合成 AI SDK message；图片二进制只在本次请求中进入第三方 provider，不进入 diagnostics。 */
export function buildAIRecognitionMessages(
  input: AIRecognitionRuntimeInput,
  userPrompt: string,
  settings: Pick<AiRecognitionSettings, "providerType" | "transportProtocol">,
): ModelMessage[] {
  // 原生 Responses 使用跨模型都支持的 high 细节级别，保留账单小字 OCR；
  // compatible provider 不一定理解该扩展，因此只把 OpenAI 专属参数发给 canonical Responses。
  const imageProviderOptions = settings.providerType === "openai" && settings.transportProtocol === "openai-responses"
    ? { openai: { imageDetail: "high" as const } }
    : undefined;
  const content: UserContent = [
    { type: "text", text: userPrompt },
    ...input.images.map((image) => ({
      type: "image" as const,
      image: image.data,
      mediaType: image.mediaType,
      ...(imageProviderOptions ? { providerOptions: imageProviderOptions } : {}),
    })),
  ];
  return [{ role: "user", content }];
}

/** 识别提示词使用用户时区中的 date-only today，避免 UTC 日期让续费日推断偏一天。 */
export function todayDateOnly(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}
