import {
  aiRecognitionErrorDetailsSchema,
  aiRecognitionStreamEventSchema,
  type AiGeneratedRecognizeObject,
  type AiRecognitionDiagnostics,
  type AiRecognitionSettings,
  type AiRecognitionStreamEvent,
  type AiRecognitionStreamStage,
  type AiThinkingControl,
  type AiRecognizeResponse,
} from "@renewlet/shared/schemas/ai-recognition";
import { UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS } from "@renewlet/shared/schemas/upstream";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import {
  buildAIRecognitionRepairUserPrompt,
  buildAIRecognitionSystemPrompt,
  buildAIRecognitionUserPrompt,
  type AIRecognitionPromptConfigContext,
} from "@renewlet/shared/ai-recognition-prompt";
import { HttpError } from "./http";
import { serverText, type AppLocale } from "./server-i18n";
import {
  mergeRecognizedAIRecognitionNotes,
  missingDescribableNoteNames,
  normalizeGeneratedAIRecognizeObject,
} from "./ai-recognition-normalize";
import {
  aiRecognitionErrorDetails,
  buildAIRecognitionDiagnostics,
  noObjectGeneratedFinishReason,
  noObjectGeneratedText,
  noObjectGeneratedUsage,
  rawAIRecognitionErrorDetails,
} from "./ai-recognition-diagnostics";
import { providerResponseFromError, upstreamResponseErrorFromError } from "./ai-provider-response";
import {
  AIRecognitionGenerationError,
  appendAIRecognitionWarning,
  diagnosticsFromGeneration,
  generateAIRecognitionObject,
  generateAIRecognitionObjectStream,
  mergeAIRecognitionResponses,
  outputTokenBudgetForChunk,
  recoverAIRecognitionGenerationFromRawText,
  splitAIRecognitionInput,
} from "./ai-recognition-runner-internals";
import {
  AI_RECOGNITION_PROVIDER_TIMEOUT_MS,
  providerOptionsForThinking,
  todayDateOnly,
  type AIRecognitionCapture,
} from "./ai-recognition-runtime";

export type AIRecognitionInput = {
  text: string;
  images: Array<{ data: Uint8Array; mediaType: string }>;
  thinkingControl: AiThinkingControl | null;
};

export type AIRecognitionGeneration = AIRecognitionCapture & {
  object: AiGeneratedRecognizeObject;
};

export type AIRecognitionStreamSink = {
  emit: (event: AiRecognitionStreamEvent) => void;
};

class AIRecognitionRunError extends Error {
  constructor(
    readonly causeError: unknown,
    readonly diagnostics: AiRecognitionDiagnostics,
  ) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = "AIRecognitionRunError";
  }
}

/**
 * 执行非流式 AI 识别并返回结构化导入草稿。
 *
 * 模型输出会经过“生成 -> 原文 JSON 恢复 -> 最终规范化”链路；失败时只返回脱敏 diagnostics。
 */
export async function runAIRecognition(args: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  timezone: string;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  abortSignal?: AbortSignal;
}): Promise<AiRecognizeResponse> {
  if (!args.abortSignal) {
    // 非 HTTP 调用方也必须拥有同一条绝对运行预算；否则多块批量会把每次 provider timeout 叠加成无界总时长。
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_RECOGNITION_PROVIDER_TIMEOUT_MS);
    try {
      return await runAIRecognition({ ...args, abortSignal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
  const chunks = splitAIRecognitionInput(args.input);
  const singleChunk = chunks.length === 1 ? chunks[0] : undefined;
  if (singleChunk) return runAIRecognitionSingle({ ...args, input: singleChunk });
  const responses: AiRecognizeResponse[] = [];
  const failures: Array<unknown | undefined> = Array.from({ length: chunks.length });
  for (let index = 0; index < chunks.length; index += 2) {
    const batch = chunks.slice(index, index + 2);
    const results = await Promise.all(batch.map(async (input, batchIndex) => {
      try {
        return await runAIRecognitionSingle({ ...args, input });
      } catch (error) {
        if (args.abortSignal?.aborted) throw error;
        failures[index + batchIndex] = error;
        return null;
      }
    }));
    responses.push(...results.filter((response): response is AiRecognizeResponse => Boolean(response)));
  }
  const firstFailure = failures.find((failure): failure is unknown => failure !== undefined);
  if (responses.length === 0) throw firstFailure ?? new Error("AI_RECOGNITION_BATCH_EMPTY");
  const merged = mergeAIRecognitionResponses(responses);
  if (failures.some((failure) => failure !== undefined)) merged.warnings = appendAIRecognitionWarning(merged.warnings, "AI_WARNING_BATCH_PARTIAL");
  return merged;
}

async function runAIRecognitionSingle({
  settings,
  input,
  locale,
  timezone,
  configContext,
  thinkingControl,
  abortSignal,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  timezone: string;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  abortSignal?: AbortSignal;
}): Promise<AiRecognizeResponse> {
  const maxOutputTokens = outputTokenBudgetForChunk(input, thinkingControl);
  const providerOptions = providerOptionsForThinking(settings, thinkingControl);
  const systemPrompt = buildAIRecognitionSystemPrompt(locale);
  const userPrompt = buildAIRecognitionUserPrompt({
    text: input.text,
    timezone,
    currentDate: todayDateOnly(timezone),
    imageCount: input.images.length,
    locale,
    configContext,
  });
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };
  const generateForPrompt = (nextUserPrompt: string) => generateAIRecognitionObject({
    settings,
    input,
    systemPrompt,
    userPrompt: nextUserPrompt,
    providerOptions,
    maxOutputTokens,
    ...(abortSignal ? { abortSignal } : {}),
  });

  try {
    const initialGeneration = await generateAIRecognitionObject({
      settings,
      input,
      systemPrompt,
      userPrompt,
      providerOptions,
      maxOutputTokens,
      ...(abortSignal ? { abortSignal } : {}),
    });
    return await finalizeAIRecognitionGeneration({
      settings,
      input,
      locale,
      configContext,
      thinkingControl,
      maxOutputTokens,
      currentDate: todayDateOnly(timezone),
      systemPrompt,
      originalUserPrompt: userPrompt,
      initialGeneration,
      generateForPrompt,
    });
  } catch (error) {
    // 绝对 deadline 或客户端取消一旦触发，不能再用已截断的 raw text 做恢复，避免超时请求在边界外继续产出草稿。
    if (abortSignal?.aborted) throw error;
    const cause = error instanceof AIRecognitionGenerationError ? error.causeError : error;
    const errorCapture = error instanceof AIRecognitionGenerationError ? error.capture : capture;
    const rawModelText = noObjectGeneratedText(cause) ?? errorCapture.rawModelText;
    const recoveredGeneration = recoverAIRecognitionGenerationFromRawText(rawModelText, {
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    if (recoveredGeneration) {
      try {
        return await finalizeAIRecognitionGeneration({
          settings,
          input,
          locale,
          configContext,
          thinkingControl,
          maxOutputTokens,
          currentDate: todayDateOnly(timezone),
          systemPrompt,
          originalUserPrompt: userPrompt,
          initialGeneration: recoveredGeneration,
          generateForPrompt,
        });
      } catch {
        // raw text 恢复只把可解析 JSON 带回同一条最终校验链路；校验失败仍走原始模型错误诊断。
      }
    }
    const diagnostics = buildAIRecognitionDiagnostics({
      settings,
      input,
      thinkingControl,
      maxOutputTokens,
      systemPrompt,
      userPrompt,
      rawModelText,
      rawObject: null,
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    throw new AIRecognitionRunError(cause, diagnostics);
  }
}

/**
 * 执行流式 AI 识别。
 *
 * SSE 中的 progress/partial/text/reasoning 只服务前端进度面板，最终草稿仍只来自 recognition/final 的结构化对象。
 */
export async function runAIRecognitionStream(args: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  timezone: string;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  abortSignal: AbortSignal;
  sink: AIRecognitionStreamSink;
}): Promise<AiRecognizeResponse> {
  const chunks = splitAIRecognitionInput(args.input);
  const singleChunk = chunks.length === 1 ? chunks[0] : undefined;
  if (singleChunk) return runAIRecognitionStreamSingle({ ...args, input: singleChunk });
  const responses: Array<AiRecognizeResponse | null> = Array.from({ length: chunks.length }, () => null);
  const failures: Array<unknown | undefined> = Array.from({ length: chunks.length });
  let subscriptionOffset = 0;
  let warningOffset = 0;
  // 分块 provider 请求最多两块并发；事件先按块缓存再按原始顺序刷出，避免 JSON/text delta 交错污染进度预览。
  for (let index = 0; index < chunks.length; index += 2) {
    const batch = chunks.slice(index, index + 2);
    const results = await Promise.all(batch.map(async (input, batchIndex) => {
      const events: AiRecognitionStreamEvent[] = [];
      try {
        const response = await runAIRecognitionStreamSingle({
          ...args,
          input,
          sink: { emit: (event) => events.push(event) },
        });
        return { index: index + batchIndex, response, error: undefined, events };
      } catch (error) {
        if (args.abortSignal.aborted) throw error;
        return { index: index + batchIndex, response: null, error, events };
      }
    }));
    for (const result of results.sort((left, right) => left.index - right.index)) {
      if (result.response) {
        flushAIRecognitionStreamEvents(result.events, args.sink, subscriptionOffset, warningOffset);
        responses[result.index] = result.response;
        subscriptionOffset += result.response.subscriptions.length;
        warningOffset = Math.min(20, warningOffset + result.response.warnings.length);
      } else {
        failures[result.index] = result.error;
      }
    }
  }
  const successfulResponses = responses.filter((response): response is AiRecognizeResponse => response !== null);
  if (successfulResponses.length === 0) throw failures.find((failure): failure is unknown => failure !== undefined) ?? new Error("AI_RECOGNITION_BATCH_EMPTY");
  const merged = mergeAIRecognitionResponses(successfulResponses);
  if (failures.some((failure) => failure !== undefined)) merged.warnings = appendAIRecognitionWarning(merged.warnings, "AI_WARNING_BATCH_PARTIAL");
  return merged;
}

function flushAIRecognitionStreamEvents(
  events: readonly AiRecognitionStreamEvent[],
  sink: AIRecognitionStreamSink,
  subscriptionOffset: number,
  warningOffset: number,
): void {
  for (const event of events) {
    if (event.type === "recognition/partial") {
      sink.emit({
        ...event,
        subscriptionsSeen: Math.min(100, subscriptionOffset + event.subscriptionsSeen),
        warningsSeen: Math.min(20, warningOffset + event.warningsSeen),
      });
      continue;
    }
    sink.emit(event);
  }
}

async function runAIRecognitionStreamSingle({
  settings,
  input,
  locale,
  timezone,
  configContext,
  thinkingControl,
  abortSignal,
  sink,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  timezone: string;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  abortSignal: AbortSignal;
  sink: AIRecognitionStreamSink;
}): Promise<AiRecognizeResponse> {
  const maxOutputTokens = outputTokenBudgetForChunk(input, thinkingControl);
  const providerOptions = providerOptionsForThinking(settings, thinkingControl);
  const systemPrompt = buildAIRecognitionSystemPrompt(locale);
  const userPrompt = buildAIRecognitionUserPrompt({
    text: input.text,
    timezone,
    currentDate: todayDateOnly(timezone),
    imageCount: input.images.length,
    locale,
    configContext,
  });
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };
  const generateForPrompt = (nextUserPrompt: string) => generateAIRecognitionObjectStream({
    settings,
    input,
    systemPrompt,
    userPrompt: nextUserPrompt,
    providerOptions,
    maxOutputTokens,
    abortSignal,
    sink,
  });

  try {
    sink.emit({ type: "recognition/progress", stage: "model-start" });
    const initialGeneration = await generateAIRecognitionObjectStream({
      settings,
      input,
      systemPrompt,
      userPrompt,
      providerOptions,
      maxOutputTokens,
      abortSignal,
      sink,
    });
    return await finalizeAIRecognitionGeneration({
      settings,
      input,
      locale,
      configContext,
      thinkingControl,
      maxOutputTokens,
      currentDate: todayDateOnly(timezone),
      systemPrompt,
      originalUserPrompt: userPrompt,
      initialGeneration,
      emitProgress: (stage) => sink.emit({ type: "recognition/progress", stage }),
      generateForPrompt,
    });
  } catch (error) {
    // 绝对 deadline 或 SSE 断开后立即终止恢复链，避免取消请求仍在边界外完成 normalize/final。
    if (abortSignal.aborted) throw error;
    const cause = error instanceof AIRecognitionGenerationError ? error.causeError : error;
    const errorCapture = error instanceof AIRecognitionGenerationError ? error.capture : capture;
    const rawModelText = noObjectGeneratedText(cause) ?? errorCapture.rawModelText;
    const recoveredGeneration = recoverAIRecognitionGenerationFromRawText(rawModelText, {
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    if (recoveredGeneration) {
      try {
        return await finalizeAIRecognitionGeneration({
          settings,
          input,
          locale,
          configContext,
          thinkingControl,
          maxOutputTokens,
          currentDate: todayDateOnly(timezone),
          systemPrompt,
          originalUserPrompt: userPrompt,
          initialGeneration: recoveredGeneration,
          emitProgress: (stage) => sink.emit({ type: "recognition/progress", stage }),
          generateForPrompt,
        });
      } catch {
        // raw text 恢复只把可解析 JSON 带回同一条最终校验链路；校验失败仍走原始模型错误诊断。
      }
    }
    const diagnostics = buildAIRecognitionDiagnostics({
      settings,
      input,
      thinkingControl,
      maxOutputTokens,
      systemPrompt,
      userPrompt,
      rawModelText,
      rawObject: null,
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    throw new AIRecognitionRunError(cause, diagnostics);
  }
}

async function finalizeAIRecognitionGeneration({
  settings,
  input,
  locale,
  configContext,
  thinkingControl,
  maxOutputTokens,
  currentDate,
  systemPrompt,
  originalUserPrompt,
  initialGeneration,
  emitProgress,
  generateForPrompt,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  maxOutputTokens: number;
  currentDate: string;
  systemPrompt: string;
  originalUserPrompt: string;
  initialGeneration: AIRecognitionGeneration;
  emitProgress?: (stage: AiRecognitionStreamStage) => void;
  generateForPrompt: (userPrompt: string) => Promise<AIRecognitionGeneration>;
}): Promise<AiRecognizeResponse> {
  emitProgress?.("validating");
  let diagnostics = diagnosticsFromGeneration(settings, input, thinkingControl, maxOutputTokens, systemPrompt, originalUserPrompt, initialGeneration);
  let response = normalizeGeneratedAIRecognizeObject(initialGeneration.object, settings.providerType, settings.transportProtocol, settings.model, diagnostics, configContext, currentDate);
  const missingNames = missingDescribableNoteNames(response.subscriptions);
  if (missingNames.length > 0) {
    const repairPrompt = buildAIRecognitionRepairUserPrompt({
      originalUserPrompt,
      previousObject: initialGeneration.object,
      missingNoteNames: missingNames,
      locale,
    });
    try {
      const repairedGeneration = await generateForPrompt(repairPrompt);
      const repairedDiagnostics = diagnosticsFromGeneration(settings, input, thinkingControl, maxOutputTokens, systemPrompt, repairPrompt, repairedGeneration);
      const repairedResponse = normalizeGeneratedAIRecognizeObject(repairedGeneration.object, settings.providerType, settings.transportProtocol, settings.model, repairedDiagnostics, configContext, currentDate);
      response = mergeRecognizedAIRecognitionNotes(response, repairedResponse);
      diagnostics = repairedDiagnostics;
    } catch {
      // 首轮账单事实仍然可用；补全请求失败不能覆盖首轮结果，也不能拼接本地推断备注。
    }
    response = { ...response, diagnostics };
  }
  emitProgress?.("finalizing");
  return response;
}

/** 校验用户设置中的模型、base URL 和 API key；真正的 provider 请求只在通过后才会发出。 */
export function assertAIRecognitionSettings(settings: AiRecognitionSettings, locale: AppLocale): void {
  if (!settings.model.trim()) {
    throw new HttpError(400, serverText(locale, "aiRecognition.modelRequired"), "AI_MODEL_REQUIRED");
  }
  const endpoint = resolveAIProviderEndpoint(settings);
  if (endpoint.baseUrlRequired && !settings.baseUrl.trim()) {
    throw new HttpError(400, serverText(locale, "aiRecognition.baseUrlRequired"), "AI_BASE_URL_REQUIRED");
  }
  if (endpoint.apiKeyRequired && !settings.apiKey.trim()) {
    throw new HttpError(400, serverText(locale, "aiRecognition.apiKeyRequired"), "AI_API_KEY_REQUIRED");
  }
}

/** 把运行面错误装进 shared SSE event；provider 原文优先进入 message/details，不能被本地文案覆盖。 */
export function aiRecognitionStreamErrorEvent(locale: AppLocale, error: unknown, secrets: readonly string[] = []): AiRecognitionStreamEvent {
  if (error instanceof HttpError) {
    const parsedDetails = aiRecognitionErrorDetailsSchema.safeParse(error.details);
    return aiRecognitionStreamEventSchema.parse({
      type: "recognition/error",
      message: error.message,
      code: error.code ?? "AI_RECOGNITION_FAILED",
      ...(parsedDetails.success ? { details: parsedDetails.data } : {}),
    });
  }
  const diagnostics = aiRecognitionDiagnosticsFromError(error);
  const cause = aiRecognitionCauseFromError(error);
  const upstream = providerResponseFromError(cause, secrets);
  const upstreamResponseError = upstreamResponseErrorFromError(cause, secrets);
  if (upstreamResponseError) {
    const rawBody = upstream?.body ?? upstreamResponseError.body;
    const body = rawBody.slice(0, UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS);
    const bodyTruncated = upstream?.bodyTruncated === true || rawBody.length > body.length;
    return aiRecognitionStreamEventSchema.parse({
      type: "recognition/error",
      message: body || upstream?.statusText || `Upstream HTTP ${upstreamResponseError.status}`,
      code: "UPSTREAM_HTTP_ERROR",
      upstreamResponse: {
        status: upstreamResponseError.status,
        statusText: upstream?.statusText ?? null,
        headers: upstream?.headers ?? null,
        body: body || null,
        bodyTruncated,
      },
      ...(body ? { details: { rawResponseText: body } } : {}),
    });
  }
  const upstreamDetails = rawAIRecognitionErrorDetails(cause);
  if (diagnostics && isAIRecognitionSchemaMismatch(error)) {
    return aiRecognitionStreamEventSchema.parse({
      type: "recognition/error",
      message: upstreamDetails?.rawResponseText ?? serverText(locale, "aiRecognition.schemaMismatch"),
      code: "AI_RECOGNITION_SCHEMA_MISMATCH",
      details: aiRecognitionErrorDetails("schema_mismatch", cause, diagnostics),
    });
  }
  const details = diagnostics
    ? aiRecognitionErrorDetails("provider_failed", cause, diagnostics)
    : upstreamDetails;
  return aiRecognitionStreamEventSchema.parse({
    type: "recognition/error",
    message: upstreamDetails?.rawResponseText ?? serverText(locale, "aiRecognition.failed"),
    code: "AI_RECOGNITION_FAILED",
    ...(details ? { details } : {}),
  });
}

/** 超时只标记本地 deadline；如果 provider 已返回正文，正文仍优先透传。 */
export function aiRecognitionStreamTimeoutErrorEvent(locale: AppLocale, error: unknown, secrets: readonly string[] = []): AiRecognitionStreamEvent {
  const diagnostics = aiRecognitionDiagnosticsFromError(error);
  const cause = aiRecognitionCauseFromError(error);
  const upstream = providerResponseFromError(cause, secrets);
  const upstreamResponseError = upstreamResponseErrorFromError(cause, secrets);
  const upstreamDetails = rawAIRecognitionErrorDetails(cause);
  const rawBody = upstream?.body ?? upstreamResponseError?.body ?? upstreamDetails?.rawResponseText ?? null;
  const body = rawBody?.slice(0, UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS) ?? null;
  const bodyTruncated = upstream?.bodyTruncated === true || (rawBody !== null && body !== null && rawBody.length > body.length);
  const details = diagnostics
    ? aiRecognitionErrorDetails("provider_failed", cause, diagnostics)
    : body ? { rawResponseText: body } : upstreamDetails;
  return aiRecognitionStreamEventSchema.parse({
    type: "recognition/error",
    message: body ?? upstream?.statusText ?? serverText(locale, "aiRecognition.failed"),
    code: "AI_RECOGNITION_TIMEOUT",
    ...(details ? { details } : {}),
    ...(upstreamResponseError ? {
      upstreamResponse: {
        status: upstreamResponseError.status,
        statusText: upstream?.statusText ?? null,
        headers: upstream?.headers ?? null,
        body,
        bodyTruncated,
      },
    } : {}),
  });
}

/** schema mismatch 是“模型没有产出可用对象”的用户可诊断失败，不等同于 Worker 内部错误。 */
export function isAIRecognitionSchemaMismatch(error: unknown): boolean {
  const cause = aiRecognitionCauseFromError(error);
  const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
  return message.includes("no object generated")
    || message.includes("did not match schema")
    || message.includes("schema validation")
    || message.includes("invalid object");
}

/** 只从内部 run error 取 diagnostics，避免任意外部异常伪造调试信息进入响应。 */
export function aiRecognitionDiagnosticsFromError(error: unknown): AiRecognitionDiagnostics | null {
  return error instanceof AIRecognitionRunError ? error.diagnostics : null;
}

/** 解除内部错误包装，供脱敏层读取真实 provider/schema 失败原因。 */
export function aiRecognitionCauseFromError(error: unknown): unknown {
  if (error instanceof AIRecognitionRunError || error instanceof AIRecognitionGenerationError) return error.causeError;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
