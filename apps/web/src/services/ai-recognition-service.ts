import { ApiError, apiFetch, apiFetchStream } from "@/lib/api-client";
import {
  aiModelListResponseSchema,
  aiRecognitionStreamEventSchema,
  aiRecognitionTestResponseSchema,
  aiRecognizeResponseSchema,
  type AiModelListRequest,
  type AiModelListResponse,
  type AiRecognitionSettings,
  type AiRecognitionStreamEvent,
  type AiRecognitionTestResponse,
  type AiRecognizeResponse,
  type AiThinkingControl,
} from "@/lib/api/schemas/ai-recognition";
import type { SecretMutation } from "@renewlet/shared/schemas/secrets";

/**
 * AI 识别订阅服务层。
 *
 * 这里是浏览器与 Go/Worker AI 代理的唯一入口；图片和文本只发送给用户在设置页配置的 provider，
 * 返回结果仍必须先转成导入 preview/apply，不允许服务层直接创建订阅。
 */
const AI_RECOGNITION_STREAM_RESPONSE_TIMEOUT_MS = 30_000;
const AI_RECOGNITION_STREAM_IDLE_TIMEOUT_MS = 120_000;

interface RecognizeSubscriptionsInput {
  text: string;
  images: File[];
  thinkingControl: AiThinkingControl | null;
}

interface RecognizeSubscriptionsStreamHandlers {
  onEvent?: (event: AiRecognitionStreamEvent) => void;
}

interface RecognizeSubscriptionsStreamOptions {
  signal?: AbortSignal;
}

export const aiRecognitionService = {
  async listModels(input: AiModelListRequest): Promise<AiModelListResponse> {
    // 模型列表由后端代理访问第三方 /models；前端不能带 API key 直连 provider。
    return await apiFetch("/api/app/ai/models/list", aiModelListResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: 20_000,
    });
  },

  async recognizeSubscriptions(input: RecognizeSubscriptionsInput): Promise<AiRecognizeResponse> {
    return await apiFetch("/api/app/ai/subscriptions/recognize", aiRecognizeResponseSchema, {
      method: "POST",
      body: createRecognizeSubscriptionsFormData(input),
      timeoutMs: 120_000,
    });
  },

  async recognizeSubscriptionsStream(
    input: RecognizeSubscriptionsInput,
    handlers: RecognizeSubscriptionsStreamHandlers = {},
    options: RecognizeSubscriptionsStreamOptions = {},
  ): Promise<AiRecognizeResponse> {
    return await apiFetchStream(
      "/api/app/ai/subscriptions/recognize/stream",
      {
        method: "POST",
        body: createRecognizeSubscriptionsFormData(input),
        timeoutMs: AI_RECOGNITION_STREAM_RESPONSE_TIMEOUT_MS,
        streamIdleTimeoutMs: AI_RECOGNITION_STREAM_IDLE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (response) => consumeRecognitionEventStream(response, handlers.onEvent),
    );
  },

  async testConnection(settings: AiRecognitionSettings, apiKey: SecretMutation): Promise<AiRecognitionTestResponse> {
    const { apiKey: _draftApiKey, ...publicSettings } = settings;
    return await apiFetch("/api/app/ai/subscriptions/test", aiRecognitionTestResponseSchema, {
      method: "POST",
      body: JSON.stringify({ settings: publicSettings, apiKey }),
      timeoutMs: 60_000,
    });
  },
};

function createRecognizeSubscriptionsFormData(input: RecognizeSubscriptionsInput): FormData {
  const formData = new FormData();
  formData.set("text", input.text);
  // 始终发送字段：null 表示本次明确使用模型默认，缺字段才表示沿用设置页默认 control。
  formData.set("thinkingControl", JSON.stringify(input.thinkingControl));
  for (const image of input.images) {
    formData.append("images[]", image, image.name);
  }
  return formData;
}

/**
 * 消费 AI 识别 SSE 流并返回最终结构化响应。
 *
 * progress/partial/text-delta 只用于界面状态反馈；只有 recognition/final 能成为后续导入草稿，
 * recognition/error 则保留后端脱敏后的 rawResponseText 给统一错误详情弹窗。
 */
async function consumeRecognitionEventStream(
  response: Response,
  onEvent: ((event: AiRecognitionStreamEvent) => void) | undefined,
): Promise<AiRecognizeResponse> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ApiError("Invalid stream response", response.status, undefined, "invalid_response");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: AiRecognizeResponse | null = null;

  const readFrame = (frame: string) => {
    const data = frame.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data) return;

    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new ApiError("Invalid stream response", response.status, data, "invalid_response", data);
    }
    const parsed = aiRecognitionStreamEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError("Invalid stream response", response.status, parsed.error.flatten(), "invalid_response", data);
    }
    const event = parsed.data;
    onEvent?.(event);
    if (event.type === "recognition/error") {
      // SSE 错误事件已经是后端脱敏后的产品错误；这里不要再包装丢失 details.rawResponseText。
      throw new ApiError(
        event.message,
        event.upstreamResponse?.status ?? response.status,
        event.details,
        event.code,
        event.upstreamResponse?.body ?? data,
      );
    }
    if (event.type === "recognition/final") {
      finalResponse = event.response;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        readFrame(frame);
        separator = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const tail = buffer.trim();
  if (tail) readFrame(tail);
  if (!finalResponse) {
    // 流中没有 final 说明 provider/代理中断，不能把进度事件或 partial 内容伪装成可导入结果。
    throw new ApiError("Invalid stream response", response.status, undefined, "invalid_response");
  }
  return finalResponse;
}
