import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_RECOGNITION_MAX_IMAGES } from "@renewlet/shared/schemas/ai-recognition";
import { readSuccessData } from "./api-test-helpers";
import { recognizeSubscriptions } from "./ai-recognition";
import { buildAIRecognitionMessages } from "./ai-recognition-runtime";
import { generatedDraft } from "./ai-recognition.test-utils";
import type { Env } from "./types";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCustomConfig: vi.fn(),
  listSubscriptionTags: vi.fn(),
}));

const aiMocks = vi.hoisted(() => {
  const generateObject = vi.fn();
  const generateText = vi.fn();
  return {
    generateObject,
    generateText,
    streamText: vi.fn(),
    isStepCount: vi.fn(() => () => false),
    outputObject: vi.fn((options: unknown) => options),
    wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
    isNoObjectGeneratedError: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "__noObjectGenerated" in error)),
    isAPICallError: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "__apiCallError" in error)),
  };
});

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", () => ({
  getSettings: dbMocks.getSettings,
  getCustomConfig: dbMocks.getCustomConfig,
  listSubscriptionTags: dbMocks.listSubscriptionTags,
}));

vi.mock("ai", () => ({
  generateObject: aiMocks.generateObject,
  generateText: aiMocks.generateText,
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

function requestForImages(count: number): Request {
  const form = new FormData();
  form.set("text", "dmit 15元 1个月");
  for (let index = 0; index < count; index += 1) {
    // fixture 用最小 PNG 头触发 Worker 的文件头嗅探；不能只信 Blob.type。
    form.append("images[]", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), `image-${index + 1}.png`);
  }
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

beforeEach(() => {
  authMocks.requireAuth.mockReset();
  dbMocks.getSettings.mockReset();
  dbMocks.getCustomConfig.mockReset();
  dbMocks.listSubscriptionTags.mockReset();
  aiMocks.generateObject.mockReset();
  aiMocks.generateText.mockReset();
  aiMocks.generateText.mockImplementation(async (...args: unknown[]) => {
    const result = await aiMocks.generateObject(...args);
    if (result && typeof result === "object" && "object" in result) {
      return { ...result, output: (result as { object: unknown }).object };
    }
    return result;
  });
  aiMocks.streamText.mockReset();
  aiMocks.outputObject.mockClear();
  aiMocks.wrapLanguageModel.mockClear();
  aiMocks.isNoObjectGeneratedError.mockClear();
  aiMocks.isAPICallError.mockClear();
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
    categories: [],
    statuses: [],
    paymentMethods: [],
    currencies: [],
  });
  dbMocks.listSubscriptionTags.mockResolvedValue(["VPS", "云服务器"]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Cloudflare AI recognition image inputs", () => {
  it("requests high image detail only on native OpenAI Responses", () => {
    const input = {
      text: "dmit 15元 1个月",
      images: [{ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
    };
    const nativeMessage = buildAIRecognitionMessages(input, "prompt", {
      providerType: "openai",
      transportProtocol: "openai-responses",
    });
    const nativeMessagePart = nativeMessage[0];
    if (!nativeMessagePart) throw new Error("native AI recognition message is missing");
    const nativeImage = (nativeMessagePart.content as Array<{ type: string; providerOptions?: unknown }>)[1];
    expect(nativeImage?.providerOptions).toEqual({ openai: { imageDetail: "high" } });

    const compatibleMessage = buildAIRecognitionMessages(input, "prompt", {
      providerType: "openai-compatible",
      transportProtocol: "openai-chat",
    });
    const compatibleMessagePart = compatibleMessage[0];
    if (!compatibleMessagePart) throw new Error("compatible AI recognition message is missing");
    const compatibleImage = (compatibleMessagePart.content as Array<{ type: string; providerOptions?: unknown }>)[1];
    expect(compatibleImage?.providerOptions).toBeUndefined();
  });

  it("keeps image payloads out of diagnostics", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft()],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForImages(1), envFixture());
    const body = await readSuccessData<{
      diagnostics: { request: { images: Array<{ mediaType: string; sizeBytes: number }> } };
    }>(response);
    const text = JSON.stringify(body.diagnostics);

    expect(body.diagnostics.request.images).toEqual([{ mediaType: "image/png", sizeBytes: 4 }]);
    expect(text).not.toContain("base64");
    expect(text).not.toContain("iVBOR");
  });

  it("accepts five images and rejects additional image uploads", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft()],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForImages(AI_RECOGNITION_MAX_IMAGES), envFixture());
    const body = await readSuccessData<{
      diagnostics: { request: { images: Array<{ mediaType: string; sizeBytes: number }> } };
    }>(response);

    expect(body.diagnostics.request.images).toHaveLength(5);
    await expect(
      recognizeSubscriptions(requestForImages(AI_RECOGNITION_MAX_IMAGES + 1), envFixture()),
    ).rejects.toMatchObject({
      status: 413,
      code: "BODY_TOO_LARGE",
    });
  });
});
