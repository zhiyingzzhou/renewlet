// Worker AI SSE 测试保护 final-only 草稿事实源、diagnostics 脱敏和流式事件契约。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRecognitionStreamEvent } from "@renewlet/shared/schemas/ai-recognition";
import { createOpenAI } from "@ai-sdk/openai";
import { recognizeSubscriptionsStream } from "./ai-recognition";
import { generatedDraft } from "./ai-recognition.test-utils";
import type { Env } from "./types";
import { UpstreamOperationError } from "./upstream-response";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCustomConfig: vi.fn(),
  listSubscriptionTags: vi.fn(),
}));

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  isStepCount: vi.fn(() => () => false),
  outputObject: vi.fn((options: unknown) => options),
  wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
  isNoObjectGeneratedError: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "__noObjectGenerated" in error)),
  isAPICallError: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "__apiCallError" in error)),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", () => ({
  getSettings: dbMocks.getSettings,
  getCustomConfig: dbMocks.getCustomConfig,
  listSubscriptionTags: dbMocks.listSubscriptionTags,
}));

vi.mock("ai", () => ({
  streamText: aiMocks.streamText,
  isStepCount: aiMocks.isStepCount,
  Output: {
    object: aiMocks.outputObject,
  },
  wrapLanguageModel: aiMocks.wrapLanguageModel,
  NoObjectGeneratedError: {
    isInstance: aiMocks.isNoObjectGeneratedError,
  },
  APICallError: {
    isInstance: aiMocks.isAPICallError,
  },
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: { tools: { webSearch: vi.fn(() => ({ type: "provider-defined" })) } },
  createOpenAI: vi.fn(() => Object.assign(
    vi.fn(() => ({ provider: "openai.responses" })),
    {
      chat: vi.fn(() => ({ provider: "openai.chat" })),
      responses: vi.fn(() => ({ provider: "openai.responses" })),
    },
  )),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({ provider: "gemini" }))),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic" }))),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => vi.fn(() => ({ provider: "openai-compatible" }))),
}));

const authUser = {
  id: "usr_ai",
  email: "ai@example.com",
  name: "AI User",
  role: "admin" as const,
  banned: 0,
  ban_reason: "",
  password_hash: "hash",
  reset_token_hash: null,
  reset_token_expires_at: null,
  created_at: "2026-06-05T00:00:00.000Z",
  updated_at: "2026-06-05T00:00:00.000Z",
};

function envFixture(): Env {
  return { DB: {} as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket };
}

function requestForText(text: string): Request {
  const form = new FormData();
  form.set("text", text);
  return new Request("https://renewlet.test/api/app/ai/subscriptions/recognize", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "x-renewlet-locale": "zh-CN",
      "x-client-time-zone": "Asia/Shanghai",
    },
    body: form,
  });
}

function streamTextResult({
  object = {
    subscriptions: [generatedDraft()],
    warnings: [],
  },
  outputError,
  fullStream = [],
  partialOutputStream = [],
}: {
  object?: unknown;
  outputError?: unknown;
  fullStream?: unknown[];
  partialOutputStream?: unknown[];
}) {
  return {
    output: outputError ? Promise.reject(outputError) : Promise.resolve(object),
    fullStream: asyncIterable(fullStream),
    partialOutputStream: asyncIterable(partialOutputStream),
    usage: Promise.resolve({ inputTokens: 5, outputTokens: 7, totalTokens: 12 }),
    finishReason: Promise.resolve("stop"),
    providerMetadata: Promise.resolve({ openai: { responseId: "resp_stream" } }),
  };
}

function noObjectGeneratedErrorWithText(text: string): Error {
  return Object.assign(new Error("No object generated: response did not match schema."), {
    __noObjectGenerated: true,
    text,
    usage: { inputTokens: 10, outputTokens: 20 },
    finishReason: "stop",
  });
}

async function* asyncIterable(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

async function readSSEEvents(response: Response): Promise<AiRecognitionStreamEvent[]> {
  const text = await response.text();
  // 只解析 SSE 的 data frame；heartbeat/comment 等控制帧不能进入 shared schema，避免把传输层噪声当业务事件。
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const data = frame.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data;
    })
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as AiRecognitionStreamEvent);
}

describe("Cloudflare AI recognition stream", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    dbMocks.getSettings.mockReset();
    dbMocks.getCustomConfig.mockReset();
    dbMocks.listSubscriptionTags.mockReset();
    aiMocks.streamText.mockReset();
    aiMocks.outputObject.mockClear();
    aiMocks.wrapLanguageModel.mockClear();
    aiMocks.isNoObjectGeneratedError.mockClear();
    aiMocks.isAPICallError.mockClear();
    vi.mocked(createOpenAI).mockClear();
    authMocks.requireAuth.mockResolvedValue({ user: authUser, session: { id: "ses" } });
    dbMocks.getSettings.mockResolvedValue({
      aiRecognition: {
        providerType: "openai",
        transportProtocol: "openai-responses",
        model: "gpt-5.1",
        modelInputMode: "select",
        baseUrl: "",
        apiKey: "sk-test",
        defaultThinkingControl: null,
      },
      timezone: "Asia/Shanghai",
      defaultCurrency: "CNY",
    });
    dbMocks.getCustomConfig.mockResolvedValue({
      categories: [{
        id: "cat_hosting",
        value: "hosting_domains",
        labels: { "zh-CN": "域名与托管", "en-US": "Domains & Hosting" },
      }],
      statuses: [],
      paymentMethods: [{
        id: "pay_crypto",
        value: "crypto",
        labels: { "zh-CN": "加密货币", "en-US": "Crypto" },
      }],
      currencies: [],
    });
    dbMocks.listSubscriptionTags.mockResolvedValue(["VPS", "云服务器"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams progress, partial counts, real deltas and final drafts", async () => {
    aiMocks.streamText.mockReturnValue(streamTextResult({
      object: {
        subscriptions: [generatedDraft()],
        warnings: [],
      },
      fullStream: [
        { type: "reasoning-delta", delta: "checking input" },
        { type: "text-delta", delta: "{\"subscriptions\"" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 7 }, providerMetadata: { openai: { responseId: "resp_stream" } } },
      ],
      partialOutputStream: [
        { subscriptions: [generatedDraft()], warnings: ["AI_WARNING_LOW_CONFIDENCE"] },
      ],
    }));

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const events = await readSSEEvents(response);
    const types = events.map((event) => event.type);
    const final = events.find((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/final" }> => event.type === "recognition/final");

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(types).toContain("recognition/progress");
    expect(types).toContain("recognition/partial");
    expect(types).toContain("recognition/text-delta");
    expect(types).not.toContain("recognition/reasoning-delta");
    expect(types.at(-1)).toBe("recognition/final");
    expect(aiMocks.streamText).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
      timeout: { totalMs: 90_000, chunkMs: 30_000 },
    }));
    expect(vi.mocked(createOpenAI).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      apiKey: "sk-test",
      fetch: expect.any(Function),
    }));
    expect(events).toContainEqual({ type: "recognition/progress", stage: "input-read" });
    expect(events).toContainEqual({ type: "recognition/progress", stage: "model-start" });
    expect(events).toContainEqual({ type: "recognition/partial", subscriptionsSeen: 1, warningsSeen: 1 });
    expect(JSON.stringify(events)).not.toContain("checking input");
    expect(final?.response.subscriptions[0]?.name).toBe("dmit");
    expect(JSON.stringify(events)).not.toContain("sk-test");
    expect(aiMocks.outputObject).toHaveBeenCalledWith(expect.objectContaining({ name: "renewlet_ai_subscription_recognition" }));
  });

  it("streams final drafts from recovered raw JSON when structured output rejects nullable website values", async () => {
    const rawObject = {
      subscriptions: [
        generatedDraft({ name: "Apple Music", website: { value: "https://music.apple.com", source: "suggested" } }),
        generatedDraft({ name: "DMIT" }),
        generatedDraft({
          name: "LocVPS",
          website: { value: null, source: "suggested" },
          notes: { value: "LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。", source: "suggested" },
          tags: ["VPS", "云主机"],
        }),
      ],
      warnings: [],
    };
    aiMocks.streamText.mockReturnValue(streamTextResult({
      outputError: noObjectGeneratedErrorWithText(`prefix\n${JSON.stringify(rawObject, null, 2)}\nsk-stream-secret123`),
      partialOutputStream: [
        { subscriptions: [generatedDraft({ name: "Apple Music" })], warnings: [] },
        { subscriptions: [generatedDraft({ name: "Apple Music" }), generatedDraft({ name: "DMIT" }), generatedDraft({ name: "LocVPS" })], warnings: [] },
      ],
    }));

    const response = await recognizeSubscriptionsStream(requestForText("apple music 15刀 一个月\ndmit 10元 一个月\nlocvps 20元 一个月"), envFixture());
    const events = await readSSEEvents(response);
    const final = events.find((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/final" }> => event.type === "recognition/final");
    const payload = JSON.stringify(events);

    expect(final?.response.subscriptions).toHaveLength(3);
    expect(final?.response.subscriptions[2]).toMatchObject({ name: "LocVPS", website: null });
    expect(events.some((event) => event.type === "recognition/error")).toBe(false);
    expect(payload).not.toContain("sk-stream-secret123");
    expect(payload).toContain("[redacted]");
  });

  it("dedupes repeated stream partial counts and skips empty partials", async () => {
    aiMocks.streamText.mockReturnValue(streamTextResult({
      object: {
        subscriptions: [generatedDraft()],
        warnings: ["AI_WARNING_LOW_CONFIDENCE"],
      },
      partialOutputStream: [
        {},
        { subscriptions: [], warnings: [] },
        { subscriptions: [generatedDraft()], warnings: [] },
        { subscriptions: [generatedDraft()], warnings: [] },
        { subscriptions: [generatedDraft()], warnings: ["AI_WARNING_LOW_CONFIDENCE"] },
      ],
    }));

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const events = await readSSEEvents(response);
    const partials = events.filter((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/partial" }> => event.type === "recognition/partial");

    expect(partials).toEqual([
      { type: "recognition/partial", subscriptionsSeen: 1, warningsSeen: 0 },
      { type: "recognition/partial", subscriptionsSeen: 1, warningsSeen: 1 },
    ]);
  });

  it("streams a sanitized timeout error from the worker deadline", async () => {
    vi.useFakeTimers();
    aiMocks.streamText.mockImplementation((options: unknown) => {
      const signal = options && typeof options === "object" && "abortSignal" in options
        ? (options as { abortSignal?: AbortSignal }).abortSignal
        : undefined;
      const output = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return {
        output,
        fullStream: asyncIterable([]),
        partialOutputStream: asyncIterable([]),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 0, totalTokens: 5 }),
        finishReason: Promise.resolve("error"),
        providerMetadata: Promise.resolve({ openai: { responseId: "resp_timeout" } }),
      };
    });

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const eventsPromise = readSSEEvents(response);
    await vi.advanceTimersByTimeAsync(90_000);
    const events = await eventsPromise;
    const error = events.find((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/error" }> => event.type === "recognition/error");
    const payload = JSON.stringify(events);

    expect(error?.code).toBe("AI_RECOGNITION_TIMEOUT");
    expect(payload).not.toContain("sk-test");
  });

  it("preserves a provider body when the local deadline observes the provider error", async () => {
    vi.useFakeTimers();
    aiMocks.streamText.mockImplementation((options: unknown) => {
      const signal = options && typeof options === "object" && "abortSignal" in options
        ? (options as { abortSignal?: AbortSignal }).abortSignal
        : undefined;
      const output = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("provider timeout"), {
          __apiCallError: true,
          statusCode: 504,
          responseHeaders: { "content-type": "application/json" },
          responseBody: "{\"error\":\"upstream timeout\"}",
        })), { once: true });
      });
      return {
        output,
        fullStream: asyncIterable([]),
        partialOutputStream: asyncIterable([]),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 0, totalTokens: 5 }),
        finishReason: Promise.resolve("error"),
        providerMetadata: Promise.resolve(null),
      };
    });

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const eventsPromise = readSSEEvents(response);
    await vi.advanceTimersByTimeAsync(90_000);
    const events = await eventsPromise;
    const error = events.find((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/error" }> => event.type === "recognition/error");

    expect(error?.code).toBe("AI_RECOGNITION_TIMEOUT");
    expect(error?.message).toBe("{\"error\":\"upstream timeout\"}");
    expect(error?.details?.rawResponseText).toBe("{\"error\":\"upstream timeout\"}");
  });

  it("aborts the provider when the SSE reader is cancelled", async () => {
    let providerSignal: AbortSignal | undefined;
    aiMocks.streamText.mockImplementation((options: unknown) => {
      providerSignal = options && typeof options === "object" && "abortSignal" in options
        ? (options as { abortSignal?: AbortSignal }).abortSignal
        : undefined;
      const output = new Promise<never>((_resolve, reject) => {
        providerSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return {
        output,
        fullStream: asyncIterable([]),
        partialOutputStream: asyncIterable([]),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 0, totalTokens: 5 }),
        finishReason: Promise.resolve("error"),
        providerMetadata: Promise.resolve(null),
      };
    });

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();

    expect(providerSignal?.aborted).toBe(true);
  });

  it("streams raw provider response details when provider streaming fails", async () => {
    aiMocks.streamText.mockReturnValue(streamTextResult({
      outputError: Object.assign(new Error("provider failed sk-stream-secret123"), {
        __apiCallError: true,
        statusCode: 401,
        responseHeaders: { "content-type": "application/json" },
        responseBody: "{\"code\":\"INVALID_API_KEY\",\"message\":\"bad sk-stream-secret123\"}",
      }),
      fullStream: [],
      partialOutputStream: [],
    }));

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const events = await readSSEEvents(response);
    const error = events.find((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/error" }> => event.type === "recognition/error");
    const payload = JSON.stringify(events);

    expect(response.status).toBe(200);
    expect(error?.code).toBe("UPSTREAM_HTTP_ERROR");
    expect(error?.message).toBe("{\"code\":\"INVALID_API_KEY\",\"message\":\"bad [redacted]\"}");
    expect(error?.details?.rawResponseText).toBe("{\"code\":\"INVALID_API_KEY\",\"message\":\"bad [redacted]\"}");
    expect(payload).not.toContain("sk-test");
    expect(payload).not.toContain("sk-stream-secret123");
  });

  it("prefers full stream provider response body over structured output wrapper errors", async () => {
    aiMocks.streamText.mockReturnValue(streamTextResult({
      outputError: new Error("No object generated: response did not match schema."),
      fullStream: [{
        type: "error",
        error: Object.assign(new Error("Invalid API key"), {
          url: "https://sub-api.3623211.xyz/v1/messages",
          requestBodyValues: {
            model: "claude-sonnet-4-6",
            stream: true,
          },
          statusCode: 401,
          responseHeaders: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": "94e04705-c718-498c-ae12-bb9af83647bb",
          },
          responseBody: "{\"code\":\"INVALID_API_KEY\",\"message\":\"Invalid API key\"}",
          isRetryable: false,
        }),
      }],
      partialOutputStream: [],
    }));

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const events = await readSSEEvents(response);
    const error = events.find((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/error" }> => event.type === "recognition/error");
    const payload = JSON.stringify(events);

    expect(response.status).toBe(200);
    expect(error?.code).toBe("UPSTREAM_HTTP_ERROR");
    expect(error?.message).toBe("{\"code\":\"INVALID_API_KEY\",\"message\":\"Invalid API key\"}");
    expect(error?.details?.rawResponseText).toBe("{\"code\":\"INVALID_API_KEY\",\"message\":\"Invalid API key\"}");
    expect(payload).not.toContain("requestBodyValues");
    expect(payload).not.toContain("claude-sonnet-4-6");
  });

  it("keeps upstream adapter response when stream tasks fail through a non SDK wrapper", async () => {
    aiMocks.streamText.mockReturnValue(streamTextResult({
      outputError: new Error("No object generated: response did not match schema."),
      fullStream: [{
        type: "error",
        error: new UpstreamOperationError(
          "gateway rejected the request",
          { rawResponseText: "{\"error\":\"gateway detail\"}" },
          502,
        ),
      }],
      partialOutputStream: [],
    }));

    const response = await recognizeSubscriptionsStream(requestForText("dmit 15元 1个月"), envFixture());
    const events = await readSSEEvents(response);
    const error = events.find((event): event is Extract<AiRecognitionStreamEvent, { type: "recognition/error" }> => event.type === "recognition/error");

    expect(error?.code).toBe("UPSTREAM_HTTP_ERROR");
    expect(error?.message).toBe("{\"error\":\"gateway detail\"}");
    expect(error?.details?.rawResponseText).toBe("{\"error\":\"gateway detail\"}");
  });
});
