import { generateText, isStepCount, Output, streamText, type JSONValue } from "ai";
import {
  aiGeneratedRecognizeObjectSchema,
  type AiGeneratedRecognizeObject,
  type AiRecognitionDiagnostics,
  type AiRecognitionSettings,
  type AiThinkingControl,
  type AiRecognizeResponse,
} from "@renewlet/shared/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import { AI_RECOGNITION_SCHEMA_NAME } from "@renewlet/shared/ai-recognition-prompt";
import { rawAIRecognitionErrorDetails, finishReasonText, buildAIRecognitionDiagnostics } from "./ai-recognition-diagnostics";
import {
  buildAIRecognitionMessages,
  AI_RECOGNITION_PROVIDER_TIMEOUT_MS,
  createAIRecognitionLanguageModel,
  createAIRecognitionModel,
  openAIRecognitionTools,
  type AIRecognitionCapture,
} from "./ai-recognition-runtime";
import {
  type AIRecognitionGeneration,
  type AIRecognitionInput,
  type AIRecognitionStreamSink,
} from "./ai-recognition-runner";

export class AIRecognitionGenerationError extends Error {
  constructor(
    readonly causeError: unknown,
    readonly capture: AIRecognitionCapture,
  ) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = "AIRecognitionGenerationError";
  }
}

const AI_RECOGNITION_CHUNK_MAX_ROWS = 25;
const AI_RECOGNITION_CHUNK_MAX_CHARS = 12_000;
const AI_RECOGNITION_ESTIMATED_RECORDS_PER_IMAGE = 4;

export function splitAIRecognitionInput(input: AIRecognitionInput): AIRecognitionInput[] {
  if (input.images.length > 0) return [input];
  const lines = input.text.replace(/\r\n/g, "\n").split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim());
  if (nonEmptyLines.length <= AI_RECOGNITION_CHUNK_MAX_ROWS && textLength(input.text) <= AI_RECOGNITION_CHUNK_MAX_CHARS) return [input];
  const header = detectDelimitedHeader(nonEmptyLines) ?? "";
  const chunks: AIRecognitionInput[] = [];
  let current: string[] = [];
  let currentChars = textLength(header);
  let headerSkipped = !header;
  let currentRows = 0;
  for (const line of lines) {
    // CSV/TSV 头部只复制到每个块；头部前的空行属于输入噪声，不伪造为首条记录。
    if (!headerSkipped) {
      if (!line.trim()) continue;
      headerSkipped = true;
      continue;
    }
    const nextChars = currentChars + textLength(line) + 1;
    if (line.trim() && (currentRows >= AI_RECOGNITION_CHUNK_MAX_ROWS || (currentRows > 0 && nextChars > AI_RECOGNITION_CHUNK_MAX_CHARS))) {
      chunks.push({ ...input, text: `${header}${current.join("\n")}` });
      current = [];
      currentChars = textLength(header);
      currentRows = 0;
    }
    // 单行可能本身超过字符预算；保留完整记录，避免把自然语言或 CSV 行切成两个伪订阅。
    current.push(line);
    currentChars += textLength(line) + 1;
    if (line.trim()) currentRows += 1;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push({ ...input, text: `${header}${current.join("\n")}` });
  return chunks;
}

function textLength(value: string): number {
  // Go 端按 Unicode 码点计数；Array.from 保持 emoji 等代理对不会让两端在 chunk 边界漂移。
  return Array.from(value).length;
}

function detectDelimitedHeader(lines: readonly string[]): string | null {
  const first = lines[0];
  const second = lines[1];
  if (!first || !second) return null;
  for (const delimiter of ["\t", ",", ";"] as const) {
    const firstColumns = first.split(delimiter).length;
    const secondColumns = second.split(delimiter).length;
    if (firstColumns > 1 && firstColumns === secondColumns && (delimiter === "\t" || isLikelyDelimitedHeader(first))) return `${first}\n`;
  }
  return null;
}

function isLikelyDelimitedHeader(line: string): boolean {
  return /(?:name|service|product|price|amount|currency|cycle|date|名称|服务|产品|价格|金额|币种|周期|日期)/i.test(line);
}

export function outputTokenBudgetForChunk(
  input: Pick<AIRecognitionInput, "text" | "images">,
  thinkingControl: AiThinkingControl | null,
): number {
  const lines = input.text.split(/\r?\n/).filter((line) => line.trim());
  const textRows = Math.max(0, lines.length - (detectDelimitedHeader(lines) ? 1 : 0));
  const imageRows = input.images.length * AI_RECOGNITION_ESTIMATED_RECORDS_PER_IMAGE;
  const rows = Math.max(1, Math.min(AI_RECOGNITION_CHUNK_MAX_ROWS, Math.max(textRows, imageRows)));
  // 显式 thinking 会消耗 max_output_tokens 中的推理 token；保留至少 4096 token 才能让模型完成
  // 结构化 JSON，避免 high/max 只得到截断的半个对象而默认档位正常。
  const base = rows >= AI_RECOGNITION_CHUNK_MAX_ROWS ? 7_000 : Math.max(1_024, 512 + rows * 220);
  return Math.min(7_000, Math.max(thinkingControl ? 4_096 : 1_024, base));
}

export function mergeAIRecognitionResponses(responses: readonly AiRecognizeResponse[]): AiRecognizeResponse {
  const first = responses[0];
  if (!first) throw new Error("AI_RECOGNITION_BATCH_EMPTY");
  const subscriptions = responses.flatMap((response) => response.subscriptions).slice(0, 100);
  const totalSubscriptions = responses.reduce((count, response) => count + response.subscriptions.length, 0);
  const warnings = [...new Set(responses.flatMap((response) => response.warnings))].slice(0, 20);
  const finalWarnings = totalSubscriptions > 100
    ? appendAIRecognitionWarning(warnings, "AI_WARNING_TOO_MANY_SUBSCRIPTIONS_TRUNCATED")
    : warnings;
  return {
    ...first,
    subscriptions,
    warnings: finalWarnings,
    diagnostics: first.diagnostics,
  };
}

export function appendAIRecognitionWarning(warnings: readonly string[], warning: string): string[] {
  if (warnings.includes(warning)) return [...warnings];
  return [...warnings.slice(0, 19), warning];
}

export function recoverAIRecognitionGenerationFromRawText(
  rawModelText: string | null,
  capture: Pick<AIRecognitionCapture, "usage" | "finishReason" | "providerMetadata">,
): AIRecognitionGeneration | null {
  if (!rawModelText) return null;
  const jsonText = extractFirstAIRecognitionJSONObject(rawModelText);
  if (!jsonText) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
  const parsed = aiGeneratedRecognizeObjectSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  // AI SDK 结构化输出失败时仍可能带完整 JSON 文本；恢复后必须回到同一条最终 normalize/schema 链路，不能把 raw/partial 当草稿。
  return {
    object: parsed.data,
    rawModelText,
    usage: capture.usage,
    finishReason: capture.finishReason,
    providerMetadata: capture.providerMetadata,
  };
}

function extractFirstAIRecognitionJSONObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export async function generateAIRecognitionObject({
  settings,
  input,
  systemPrompt,
  userPrompt,
  providerOptions,
  maxOutputTokens,
  abortSignal,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  systemPrompt: string;
  userPrompt: string;
  providerOptions: Record<string, Record<string, JSONValue>> | undefined;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}): Promise<AIRecognitionGeneration> {
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };
  const tools = openAIRecognitionTools(settings);
  try {
    const result = await generateText({
      model: createAIRecognitionModel(settings, capture),
      system: systemPrompt,
      messages: buildAIRecognitionMessages(input, userPrompt, settings),
      output: Output.object({ schema: aiGeneratedRecognizeObjectSchema, name: AI_RECOGNITION_SCHEMA_NAME }),
      maxOutputTokens,
      ...(tools ? { tools, stopWhen: isStepCount(2) } : { stopWhen: isStepCount(1) }),
      ...(providerOptions ? { providerOptions } : {}),
      maxRetries: 0,
      ...(abortSignal ? { abortSignal } : {}),
    });
    return {
      object: result.output,
      rawModelText: capture.rawModelText,
      usage: result.usage ?? capture.usage,
      finishReason: finishReasonText(result.finishReason) ?? capture.finishReason,
      providerMetadata: result.providerMetadata ?? capture.providerMetadata,
    };
  } catch (error) {
    throw new AIRecognitionGenerationError(error, capture);
  }
}

export async function generateAIRecognitionObjectStream({
  settings,
  input,
  systemPrompt,
  userPrompt,
  providerOptions,
  maxOutputTokens,
  abortSignal,
  sink,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  systemPrompt: string;
  userPrompt: string;
  providerOptions: Record<string, Record<string, JSONValue>> | undefined;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  sink: AIRecognitionStreamSink;
}): Promise<AIRecognitionGeneration> {
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };
  const tools = openAIRecognitionTools(settings);
  try {
    const result = streamText({
      model: createAIRecognitionLanguageModel(settings, resolveAIProviderEndpoint(settings).runtimeBaseUrl),
      system: systemPrompt,
      messages: buildAIRecognitionMessages(input, userPrompt, settings),
      output: Output.object({
        schema: aiGeneratedRecognizeObjectSchema,
        name: AI_RECOGNITION_SCHEMA_NAME,
      }),
      maxOutputTokens,
      ...(tools ? { tools, stopWhen: isStepCount(2) } : { stopWhen: isStepCount(1) }),
      abortSignal,
      timeout: { totalMs: AI_RECOGNITION_PROVIDER_TIMEOUT_MS, chunkMs: 30_000 },
      ...(providerOptions ? { providerOptions } : {}),
      maxRetries: 0,
    });
    const outputPromise = Promise.resolve(result.output);
    const object = await settleAIRecognitionStreamTasks([
      outputPromise,
      consumeAIRecognitionFullStream(result.fullStream, sink, capture),
      consumeAIRecognitionPartialStream(result.partialOutputStream, sink),
    ]);
    return {
      object,
      rawModelText: capture.rawModelText,
      usage: await Promise.resolve(result.usage).catch(() => capture.usage),
      finishReason: finishReasonText(await Promise.resolve(result.finishReason).catch(() => capture.finishReason)) ?? capture.finishReason,
      providerMetadata: await Promise.resolve(result.providerMetadata).catch(() => capture.providerMetadata),
    };
  } catch (error) {
    throw new AIRecognitionGenerationError(error, capture);
  }
}

async function settleAIRecognitionStreamTasks(tasks: [
  Promise<AiGeneratedRecognizeObject>,
  Promise<void>,
  Promise<void>,
]): Promise<AiGeneratedRecognizeObject> {
  // AI SDK 会在 output/fullStream 不同通道抛错；等待全部 settle 后优先保留带 HTTP body 的 provider 错误。
  const results = await Promise.allSettled(tasks);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) throw selectAIRecognitionStreamError(errors);
  const output = results[0];
  if (output.status === "fulfilled") return output.value;
  throw new Error("AI recognition stream output missing");
}

function selectAIRecognitionStreamError(errors: unknown[]): unknown {
  let providerError: unknown | null = null;
  for (const error of errors) {
    // 流式 output/fullStream 可能分别抛 AI SDK 错误或自有 upstream adapter 错误；
    // 统一按 rawResponseText 选择，避免有上游正文的错误被先到的 Abort/schema 包装遮住。
    const providerDetails = rawAIRecognitionErrorDetails(error);
    if (!providerDetails) continue;
    if (providerDetails.rawResponseText) return error;
    providerError ??= error;
  }
  return providerError ?? errors[0];
}

async function consumeAIRecognitionFullStream(
  fullStream: AsyncIterable<unknown>,
  sink: AIRecognitionStreamSink,
  capture: AIRecognitionCapture,
): Promise<void> {
  let rawModelText = "";
  for await (const part of fullStream) {
    if (!isRecord(part)) continue;
    switch (part["type"]) {
      case "text-delta": {
        const text = typeof part["delta"] === "string" ? part["delta"] : "";
        if (text) {
          rawModelText += text;
          capture.rawModelText = rawModelText;
          sink.emit({ type: "recognition/text-delta", delta: text });
          sink.emit({ type: "recognition/progress", stage: "model-stream" });
        }
        break;
      }
      case "reasoning-delta": {
        // 内部 reasoning 只用于模型质量，不进入 SSE，避免把 chain-of-thought 暴露给用户。
        break;
      }
      case "finish-step":
      case "finish": {
        capture.usage = part["usage"] ?? capture.usage;
        capture.finishReason = finishReasonText(part["finishReason"]) ?? capture.finishReason;
        capture.providerMetadata = part["providerMetadata"] ?? capture.providerMetadata;
        break;
      }
      case "error":
        throw part["error"];
    }
  }
}

async function consumeAIRecognitionPartialStream(
  partialOutputStream: AsyncIterable<unknown>,
  sink: AIRecognitionStreamSink,
): Promise<void> {
  let lastSubscriptionsSeen = 0;
  let lastWarningsSeen = 0;
  for await (const partial of partialOutputStream) {
    const { subscriptionsSeen, warningsSeen } = partialAIRecognitionCounts(partial);
    if (subscriptionsSeen === 0 && warningsSeen === 0) continue;
    if (subscriptionsSeen === lastSubscriptionsSeen && warningsSeen === lastWarningsSeen) continue;
    // partialOutputStream 会重复吐半成品对象；这里去噪只影响进度 UI，最终草稿仍只能来自 recognition/final。
    lastSubscriptionsSeen = subscriptionsSeen;
    lastWarningsSeen = warningsSeen;
    sink.emit({ type: "recognition/partial", subscriptionsSeen, warningsSeen });
  }
}

function partialAIRecognitionCounts(value: unknown): { subscriptionsSeen: number; warningsSeen: number } {
  if (!isRecord(value)) return { subscriptionsSeen: 0, warningsSeen: 0 };
  const subscriptions = value["subscriptions"];
  const warnings = value["warnings"];
  return {
    subscriptionsSeen: Array.isArray(subscriptions) ? subscriptions.length : 0,
    warningsSeen: Array.isArray(warnings) ? warnings.length : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function diagnosticsFromGeneration(
  settings: AiRecognitionSettings,
  input: AIRecognitionInput,
  thinkingControl: AiThinkingControl | null,
  maxOutputTokens: number,
  systemPrompt: string,
  userPrompt: string,
  generation: AIRecognitionGeneration,
): AiRecognitionDiagnostics {
  return buildAIRecognitionDiagnostics({
    settings,
    input,
    thinkingControl,
    maxOutputTokens,
    systemPrompt,
    userPrompt,
    rawModelText: generation.rawModelText,
    rawObject: generation.object,
    usage: generation.usage,
    finishReason: generation.finishReason,
    providerMetadata: generation.providerMetadata,
  });
}
