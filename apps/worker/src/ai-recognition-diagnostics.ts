/**
 * Cloudflare AI 识别 diagnostics 构造与脱敏。
 *
 * diagnostics 只允许随当前认证响应返回；prompt、raw 输出、usage/provider metadata 必须在这里截断和脱敏。
 */
import { NoObjectGeneratedError } from "ai";
import {
  AI_RECOGNITION_DIAGNOSTIC_JSON_MAX_CHARS,
  AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS,
  aiRecognitionDiagnosticsSchema,
  aiRecognitionErrorDetailsSchema,
  type AiRecognitionDiagnostics,
  type AiRecognitionErrorDetails,
  type AiRecognitionSettings,
  type AiThinkingControl,
} from "@renewlet/shared/schemas/ai-recognition";
import {
  AI_RECOGNITION_PROMPT_VERSION,
  AI_RECOGNITION_SCHEMA_NAME,
} from "@renewlet/shared/ai-recognition-prompt";
import { UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS } from "@renewlet/shared/schemas/upstream";
import { providerResponseFromError } from "./ai-provider-response";
import { upstreamErrorDetailsFromError, type UpstreamProviderResponse } from "./upstream-response";

const AI_SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:api[_-]?key|authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token)["'\s:=]+[A-Za-z0-9._~+/=-]{8,})/gi;

interface AIRecognitionDiagnosticsInput {
  text: string;
  images: Array<{ mediaType: string; data: Uint8Array }>;
}

export function buildAIRecognitionDiagnostics({
  settings,
  input,
  thinkingControl,
  maxOutputTokens,
  systemPrompt,
  userPrompt,
  rawModelText,
  rawObject,
  usage,
  finishReason,
  providerMetadata,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionDiagnosticsInput;
  thinkingControl: AiThinkingControl | null;
  maxOutputTokens: number;
  systemPrompt: string;
  userPrompt: string;
  rawModelText: string | null;
  rawObject: unknown;
  usage: unknown;
  finishReason: string | null;
  providerMetadata: unknown;
}): AiRecognitionDiagnostics {
  // diagnostics 只进入当前 API 响应，不能入库；这里集中截断/脱敏，避免模型平台原文泄漏密钥。
  return aiRecognitionDiagnosticsSchema.parse({
    schemaVersion: "1",
    promptVersion: AI_RECOGNITION_PROMPT_VERSION,
    schemaName: AI_RECOGNITION_SCHEMA_NAME,
    prompt: {
      system: diagnosticText(systemPrompt, AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS),
      user: diagnosticText(userPrompt, AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS),
    },
    output: {
      rawModelText: rawModelText === null ? null : diagnosticText(rawModelText, AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS),
      rawObjectJson: rawObject === null ? null : diagnosticText(safeJsonStringify(rawObject), AI_RECOGNITION_DIAGNOSTIC_JSON_MAX_CHARS),
    },
    request: {
      providerType: settings.providerType,
      transportProtocol: settings.transportProtocol,
      model: settings.model,
      thinkingControl,
      maxOutputTokens,
      textCharCount: [...input.text].length,
      // 图片诊断只暴露类型和大小，绝不返回 bytes/data URL，避免浏览器日志保存用户上传原图。
      images: input.images.map((image) => ({ mediaType: image.mediaType, sizeBytes: image.data.byteLength })),
    },
    response: {
      usage: sanitizeDiagnosticJson(usage),
      finishReason,
      providerMetadata: sanitizeDiagnosticJson(providerMetadata),
    },
  });
}

export function safeAIRecognitionError(error: unknown): string {
  return redactAIRecognitionSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function aiRecognitionErrorDetails(
  reason: string,
  error: unknown,
  _diagnostics: AiRecognitionDiagnostics,
  providerResponse: UpstreamProviderResponse | null = providerResponseFromError(error),
) {
  // AI SDK 与自有 upstream adapter 可能分别把同一响应放在 responseBody 或 details.rawResponseText；
  // diagnostics 包装不能覆盖后者，否则用户最终只能看到泛化的错误消息而失去上游排障事实。
  const upstreamDetails = upstreamErrorDetailsFromError(error);
  const responseText = providerResponseText(providerResponse);
  const providerBody = upstreamDetails?.rawResponseText
    ? boundedRawResponseText(upstreamDetails.rawResponseText)
    : responseText
      ? boundedRawResponseText(responseText)
      : "";
  return aiRecognitionErrorDetailsSchema.parse({
    rawResponseText: providerBody || (error === null ? reason : safeAIRecognitionError(error)),
  });
}

/** provider 直接失败且尚未形成完整 diagnostics 时，仍优先回显已脱敏的上游响应。 */
export function rawAIRecognitionErrorDetails(error: unknown): AiRecognitionErrorDetails | undefined {
  const upstreamDetails = upstreamErrorDetailsFromError(error);
  if (upstreamDetails?.rawResponseText) {
    return aiRecognitionErrorDetailsSchema.parse({
      rawResponseText: boundedRawResponseText(upstreamDetails.rawResponseText),
    });
  }
  const providerResponse = providerResponseFromError(error);
  const responseText = providerResponseText(providerResponse);
  if (!responseText) return undefined;
  return aiRecognitionErrorDetailsSchema.parse({
    rawResponseText: boundedRawResponseText(responseText),
  });
}

function providerResponseText(response: UpstreamProviderResponse | null): string | null {
  return response?.body || response?.statusText || null;
}

function boundedRawResponseText(value: string): string {
  const redacted = redactAIRecognitionSecrets(value);
  return [...redacted].slice(0, UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS).join("");
}

export function noObjectGeneratedText(error: unknown): string | null {
  return NoObjectGeneratedError.isInstance(error) && typeof error.text === "string" ? error.text : null;
}

export function noObjectGeneratedUsage(error: unknown): unknown | null {
  return NoObjectGeneratedError.isInstance(error) ? error.usage ?? null : null;
}

export function noObjectGeneratedFinishReason(error: unknown): string | null {
  return NoObjectGeneratedError.isInstance(error) ? finishReasonText(error.finishReason) : null;
}

export function finishReasonText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (isDiagnosticRecord(value)) {
    const unified = value["unified"];
    if (typeof unified === "string" && unified.trim()) return unified;
    const raw = value["raw"];
    if (typeof raw === "string" && raw.trim()) return raw;
  }
  return null;
}

export function extractAIModelText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const text = content.map((part) => {
    if (!isDiagnosticRecord(part) || part["type"] !== "text") return "";
    const value = part["text"];
    return typeof value === "string" ? value : "";
  }).join("");
  return text || null;
}

function diagnosticText(value: string, maxChars: number) {
  const safe = redactAIRecognitionSecrets(value);
  const chars = [...safe];
  return {
    value: chars.slice(0, maxChars).join(""),
    truncated: chars.length > maxChars,
  };
}

function sanitizeDiagnosticJson(value: unknown): unknown | null {
  if (value === undefined || value === null) return null;
  const text = diagnosticText(safeJsonStringify(value), AI_RECOGNITION_DIAGNOSTIC_JSON_MAX_CHARS);
  if (text.truncated) return text;
  try {
    return JSON.parse(text.value) as unknown;
  } catch {
    return text;
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    }, 2);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function redactAIRecognitionSecrets(value: string): string {
  return value.replace(AI_SECRET_PATTERN, "[redacted]");
}

function isDiagnosticRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
