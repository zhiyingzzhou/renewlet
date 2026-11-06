import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readSuccessData } from "./api-test-helpers";
import { recognizeSubscriptions, testAIRecognitionConnection } from "./ai-recognition";
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

const aiMocks = vi.hoisted(() => {
  const generateObject = vi.fn();
  const generateText = vi.fn();
  return {
    // 识别运行时使用 generateText + Output.object；旧测试仍通过 generateObject 配置模型结果，
    // 适配器只把旧 fixture 的 object 映射到 AI SDK 的 output，不改变生产路径。
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

function requestForText(text: string, locale = "zh-CN"): Request {
  const form = new FormData();
  form.set("text", text);
  return new Request("https://renewlet.test/api/app/ai/subscriptions/recognize", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "x-renewlet-locale": locale,
      "x-client-time-zone": "Asia/Shanghai",
    },
    body: form,
  });
}

function requestForTextWithThinking(text: string, thinkingControl: string): Request {
  const form = new FormData();
  form.set("text", text);
  form.set("thinkingControl", thinkingControl);
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

function testConnectionRequestFor(
  settings: Record<string, unknown>,
  apiKeyMutation?: { action: "keep" | "clear" } | { action: "set"; value: string },
): Request {
  const { apiKey, ...publicSettings } = settings;
  const mutation = apiKeyMutation ?? (
    typeof apiKey === "string" && apiKey.length > 0
      ? { action: "set" as const, value: apiKey }
      : { action: "clear" as const }
  );
  return new Request("https://renewlet.test/api/app/ai/subscriptions/test", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-renewlet-locale": "zh-CN",
    },
    body: JSON.stringify({ settings: publicSettings, apiKey: mutation }),
  });
}


function noObjectGeneratedErrorWithText(text: string): Error {
  return Object.assign(new Error("No object generated: response did not match schema."), {
    __noObjectGenerated: true,
    text,
    usage: { inputTokens: 10, outputTokens: 20 },
    finishReason: "stop",
  });
}

describe("Cloudflare AI recognition", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    dbMocks.getSettings.mockReset();
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
    vi.mocked(createOpenAI).mockClear();
    vi.mocked(createGoogleGenerativeAI).mockClear();
    vi.mocked(createAnthropic).mockClear();
    vi.mocked(createOpenAICompatible).mockClear();
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

  it("normalizes complete AI SDK objects into strict API drafts", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "dmit",
          price: "15元",
          currency: "元",
          billingCycle: "1个月",
          category: "域名与托管",
          paymentMethod: "Crypto",
          website: { value: "https://www.dmit.io/", source: "suggested" },
          notes: { value: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。", source: "suggested" },
          tags: ["云服务", "云服务", "VPS"],
        })],
        warnings: [],
      },
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      finishReason: "stop",
      providerMetadata: { openai: { responseId: "resp_test" } },
    });

    const response = await recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture());
    const body = await readSuccessData<{
      providerType: string;
      transportProtocol: string;
      model: string;
      subscriptions: Array<{
        name: string;
        price: number;
        currency: string;
        billingCycle: string;
        category: string;
        paymentMethod: string;
        website: { value: string; source: string } | null;
        notes: { value: string; source: string } | null;
        tags: string[];
        warnings: string[];
      }>;
      diagnostics: {
        schemaName: string;
        prompt: { system: { value: string }; user: { value: string } };
        output: { rawObjectJson: { value: string } | null; rawModelText: { value: string } | null };
        request: { providerType: string; transportProtocol: string; model: string; textCharCount: number; images: Array<{ mediaType: string; sizeBytes: number }> };
        response: { usage: unknown; finishReason: string | null; providerMetadata: unknown };
      };
    }>(response);

    expect(response.status).toBe(200);
    expect(body.providerType).toBe("openai");
    expect(body.transportProtocol).toBe("openai-responses");
    expect(body.model).toBe("gpt-5.1");
    expect(body.subscriptions[0]).toMatchObject({
      name: "dmit",
      price: "15",
      currency: "CNY",
      billingCycle: "monthly",
      category: "hosting_domains",
      paymentMethod: "crypto",
      website: { value: "https://www.dmit.io/", source: "suggested" },
      notes: { value: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。", source: "suggested" },
      tags: ["云服务", "VPS"],
      warnings: expect.arrayContaining([
        "AI_WARNING_AUTO_CALCULATE_DISABLED",
        "AI_WARNING_DATE_UNCERTAIN",
      ]),
    });
    expect(body.diagnostics.schemaName).toBe("renewlet_ai_subscription_recognition");
    expect(body.diagnostics.prompt.system.value).toContain("Return exactly one strict JSON object");
    expect(body.diagnostics.prompt.system.value).toContain("Billing facts come only from input/image");
    expect(body.diagnostics.prompt.system.value).toContain("Examples:");
    expect(body.diagnostics.prompt.user.value).toContain("dmit 15元 1个月");
    expect(body.diagnostics.prompt.user.value).toContain("Runtime context:");
    expect(body.diagnostics.prompt.user.value).toContain("- User locale: zh-CN");
    expect(body.diagnostics.prompt.user.value).toContain("User context:");
    expect(body.diagnostics.prompt.user.value).toContain("Task:");
    expect(body.diagnostics.prompt.system.value).toContain("Examples:");
    expect(aiMocks.generateObject).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
    expect(vi.mocked(createOpenAI).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      apiKey: "sk-test",
      fetch: expect.any(Function),
    }));
    expect(body.diagnostics.prompt.user.value).toContain("<<<renewlet-user-input");
    expect(body.diagnostics.prompt.user.value).toContain("value=hosting_domains");
    expect(body.diagnostics.prompt.user.value).toContain("value=crypto");
    expect(body.diagnostics.prompt.user.value).toContain("Existing user tags:");
    expect(body.diagnostics.prompt.user.value).toContain("- VPS");
    expect(body.diagnostics.prompt.user.value).not.toContain("https://www.apple.com/");
    expect(body.diagnostics.prompt.user.value).not.toContain("YouTube 是 Google 旗下的视频分享和流媒体平台。");
    expect(body.diagnostics.prompt.user.value).not.toContain("LOCVPS 是面向 VPS、云服务器和服务器托管的主机服务商。");
    expect(body.diagnostics.prompt.user.value).not.toContain("DMIT 是提供 VPS、云服务器和网络线路服务的主机商。");
    expect(body.diagnostics.output.rawObjectJson?.value).toContain("\"name\": \"dmit\"");
    expect(body.diagnostics.request).toMatchObject({ providerType: "openai", transportProtocol: "openai-responses", model: "gpt-5.1", textCharCount: 12, images: [] });
    expect(body.diagnostics.response.finishReason).toBe("stop");
  });

  it("splits long text into ordered provider chunks and merges the drafts", async () => {
    let calls = 0;
    aiMocks.generateObject.mockImplementation(async () => {
      calls += 1;
      return {
        object: {
          subscriptions: [generatedDraft({ name: `chunk-${calls}` })],
          warnings: [],
        },
        finishReason: "stop",
      };
    });
    const text = Array.from({ length: 26 }, (_, index) => `service-${index + 1} 10 CNY`).join("\n");

    const response = await recognizeSubscriptions(requestForText(text), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ name: string }>; warnings: string[] }>(response);

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(body.subscriptions.map((draft) => draft.name)).toEqual(["chunk-1", "chunk-2"]);
    expect(body.warnings).not.toContain("AI_WARNING_BATCH_PARTIAL");
  });

  it("keeps successful chunks when another provider chunk fails", async () => {
    let calls = 0;
    aiMocks.generateObject.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary chunk failure");
      return {
        object: {
          subscriptions: [generatedDraft({ name: "successful-chunk" })],
          warnings: [],
        },
        finishReason: "stop",
      };
    });
    const text = Array.from({ length: 26 }, (_, index) => `service-${index + 1} 10 CNY`).join("\n");

    const response = await recognizeSubscriptions(requestForText(text), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ name: string }>; warnings: string[] }>(response);

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(body.subscriptions.map((draft) => draft.name)).toEqual(["successful-chunk"]);
    expect(body.warnings).toContain("AI_WARNING_BATCH_PARTIAL");
  });

  it("includes locale-first language rules in English recognition diagnostics", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          currency: "USD",
          notes: { value: "DMIT is a hosting provider for VPS and cloud server services.", source: "suggested" },
          tags: ["VPS", "Cloud hosting"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("dmit 2 months 15dollar", "en-US"), envFixture());
    const body = await readSuccessData<{
      diagnostics: { prompt: { system: { value: string }; user: { value: string } } };
    }>(response);

    expect(response.status).toBe(200);
    expect(body.diagnostics.prompt.user.value).toContain("- User locale: en-US");
    expect(body.diagnostics.prompt.user.value).toContain("Generate notes.value (source=suggested) in English");
    expect(body.diagnostics.prompt.system.value).toContain("Generated user-facing metadata must use English (US)");
    expect(body.diagnostics.prompt.system.value).toContain("Generated user-facing metadata follows the user locale");
    expect(body.diagnostics.prompt.system.value).toContain("source=input text and existing labels/tags stay unchanged");
  });

  it("disables automatic dates after cycle or anchor normalization fails", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          billingCycle: "unreadable cycle",
          startDate: "2026-99-99",
          nextBillingDate: null,
          autoCalculateNextBillingDate: true,
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("unknown service"), envFixture());
    const body = await readSuccessData<{
      subscriptions: Array<{ billingCycle: string | null; startDate: string | null; autoCalculateNextBillingDate: boolean | null; warnings: string[] }>;
    }>(response);

    expect(body.subscriptions[0]).toMatchObject({
      billingCycle: null,
      startDate: null,
      autoCalculateNextBillingDate: false,
    });
    expect(body.subscriptions[0]?.warnings).toContain("AI_WARNING_AUTO_CALCULATE_DISABLED");
  });

  it("includes Russian language rules in Russian recognition diagnostics", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: { subscriptions: [generatedDraft({ currency: "RUB" })], warnings: [] },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("sample service 15 руб. в месяц", "ru-RU"), envFixture());
    const body = await readSuccessData<{ diagnostics: { prompt: { system: { value: string }; user: { value: string } } } }>(response);

    expect(response.status).toBe(200);
    expect(body.diagnostics.prompt.user.value).toContain("- User locale: ru-RU");
    expect(body.diagnostics.prompt.user.value).toContain("Поле notes.value (source=suggested) должно быть написано на русском языке");
    expect(body.diagnostics.prompt.system.value).toContain("Generated user-facing metadata must use Russian (русский язык)");
    expect(body.diagnostics.prompt.system.value).toContain("Generated user-facing metadata follows the user locale");
    expect(body.diagnostics.prompt.system.value).toContain("source=input text and existing labels/tags stay unchanged");
  });

  it("applies the saved default thinking when the multipart field is absent", async () => {
    dbMocks.getSettings.mockResolvedValue({
      aiRecognition: {
        providerType: "openai",
        transportProtocol: "openai-responses",
        model: "gpt-5.1",
        modelInputMode: "select",
        baseUrl: "",
        apiKey: "sk-test",
        defaultThinkingControl: { provider: "openai", effort: "high" },
      },
      timezone: "Asia/Shanghai",
      defaultCurrency: "CNY",
    });
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft()],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture());
    const body = await readSuccessData<{ diagnostics: { request: { thinkingControl: unknown } } }>(response);
    const call = aiMocks.generateText.mock.calls[0]?.[0] as { providerOptions?: unknown };

    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "high", reasoningSummary: null } });
    expect(body.diagnostics.request.thinkingControl).toEqual({ provider: "openai", effort: "high" });
  });

  it("passes explicit thinking controls to provider options and diagnostics", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft()],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(
      requestForTextWithThinking("dmit 15元 1个月", JSON.stringify({ provider: "openai", effort: "high" })),
      envFixture(),
    );
    const body = await readSuccessData<{ diagnostics: { request: { thinkingControl: unknown } } }>(response);
    const call = aiMocks.generateText.mock.calls[0]?.[0] as { providerOptions?: unknown };

    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "high", reasoningSummary: null } });
    expect(body.diagnostics.request.thinkingControl).toEqual({ provider: "openai", effort: "high" });
  });

  it("tests provider connection with a minimal text request and no recognition chain", async () => {
    aiMocks.generateText.mockResolvedValue({ text: "OK" });

    const response = await testAIRecognitionConnection(testConnectionRequestFor({
      providerType: "openai",
      transportProtocol: "openai-responses",
      model: "gpt-5.1",
      modelInputMode: "select",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: { provider: "openai", effort: "high" },
    }, { action: "keep" }), envFixture());
    const body = await readSuccessData<{ providerType: string; transportProtocol: string; model: string }>(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({ providerType: "openai", transportProtocol: "openai-responses", model: "gpt-5.1" });
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "openai.responses" },
      prompt: "Reply with OK.",
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
      timeout: { totalMs: 90_000 },
    }));
    expect(vi.mocked(createOpenAI).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      apiKey: "sk-test",
      fetch: expect.any(Function),
    }));
    expect(aiMocks.generateObject).not.toHaveBeenCalled();
    expect(aiMocks.wrapLanguageModel).not.toHaveBeenCalled();
  });

  it("returns raw provider response details when connection test fails", async () => {
    aiMocks.generateText.mockRejectedValue(Object.assign(new Error("invalid key sk-test-secret"), {
      __apiCallError: true,
      statusCode: 401,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{\"code\":\"INVALID_API_KEY\",\"message\":\"bad sk-test-secret\"}",
    }));

    await expect(testAIRecognitionConnection(testConnectionRequestFor({
      providerType: "openai",
      transportProtocol: "openai-responses",
      model: "gpt-5.1",
      modelInputMode: "select",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: null,
    }), envFixture())).rejects.toMatchObject({
      status: 401,
      body: "{\"code\":\"INVALID_API_KEY\",\"message\":\"bad [redacted]\"}",
    });
  });

  it("canonicalizes mismatched compatible protocol to OpenAI chat runtime", async () => {
    aiMocks.generateText.mockResolvedValue({ text: "OK" });

    const response = await testAIRecognitionConnection(testConnectionRequestFor({
      providerType: "openai-compatible",
      transportProtocol: "anthropic-messages",
      model: "claude-compatible",
      modelInputMode: "manual",
      baseUrl: "https://gateway.example.com/anthropic/v1",
      apiKey: "",
      defaultThinkingControl: null,
    }), envFixture());
    const body = await readSuccessData<{ providerType: string; transportProtocol: string }>(response);

    expect(body).toMatchObject({ providerType: "openai-compatible", transportProtocol: "openai-chat" });
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "openai-compatible" },
    }));
  });

  it("rejects invalid thinking control fields", async () => {
    await expect(
      recognizeSubscriptions(requestForTextWithThinking("dmit 15元 1个月", "{bad json"), envFixture()),
    ).rejects.toMatchObject({
      status: 400,
      code: "AI_THINKING_CONTROL_INVALID",
    });
  });

  it("reuses existing tags and filters one-off generated attributes", async () => {
    dbMocks.listSubscriptionTags.mockResolvedValue(["VPS", "云服务器"]);
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "HostDZire IN CloudVPS #5 (FAT32 Special)",
          tags: ["vps", "孟买", "Debian 12"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("HostDZire IN CloudVPS #5 FAT32 Special Debian 12 Mumbai"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ tags: string[] }> }>(response);

    expect(body.subscriptions[0]?.tags).toEqual(["VPS"]);
  });

  it("drops one-off generated attributes when they are not existing tags", async () => {
    dbMocks.listSubscriptionTags.mockResolvedValue([]);
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "HostDZire IN CloudVPS #5 (FAT32 Special)",
          tags: ["孟买", "Debian 12", "FAT32 Special"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("HostDZire IN CloudVPS #5 FAT32 Special Debian 12 Mumbai"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ tags: string[] }> }>(response);

    expect(body.subscriptions[0]?.tags).toEqual([]);
  });

  it("keeps stable generated tags when no existing tags fit", async () => {
    dbMocks.listSubscriptionTags.mockResolvedValue([]);
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "dmit",
          tags: ["VPS", "云服务器", "Debian 12"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ tags: string[] }> }>(response);

    expect(body.subscriptions[0]?.tags).toEqual(["VPS", "云服务器"]);
  });

  it("makes one bounded notes repair attempt without adding a warning", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "HostDZire CloudVPS",
          website: { value: "https://hostdzire.com/", source: "suggested" },
          notes: { value: null, source: "none" },
          tags: ["VPS", "云主机"],
          confidence: "high",
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("HostDZire CloudVPS 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(aiMocks.generateObject).toHaveBeenCalledTimes(2);
    expect(body.subscriptions[0]?.notes).toBeNull();
    expect(body.subscriptions[0]?.warnings).not.toContain("AI_WARNING_NOTES_MISSING");
  });

  it("keeps unknown low-confidence services without notes", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "unknown app",
          website: null,
          notes: { value: null, source: "none" },
          tags: [],
          confidence: "low",
          warnings: ["AI_WARNING_WEBSITE_UNCERTAIN", "AI_WARNING_LOW_CONFIDENCE"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("unknown app 12 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(aiMocks.generateObject).toHaveBeenCalledTimes(1);
    expect(body.subscriptions[0]?.notes).toBeNull();
    expect(body.subscriptions[0]?.warnings).toEqual(expect.arrayContaining(["AI_WARNING_WEBSITE_UNCERTAIN", "AI_WARNING_LOW_CONFIDENCE"]));
  });

  it("recovers non-stream drafts from raw JSON when structured output rejects nullable website values", async () => {
    const rawObject = {
      subscriptions: [generatedDraft({
        name: "LocVPS",
        website: { value: null, source: "suggested" },
        notes: { value: "LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。", source: "suggested" },
        tags: ["VPS", "云主机"],
      })],
      warnings: [],
    };
    aiMocks.generateObject.mockRejectedValue(noObjectGeneratedErrorWithText([
      "```json",
      JSON.stringify(rawObject, null, 2),
      "```",
      "sk-raw-secret123",
    ].join("\n")));

    const response = await recognizeSubscriptions(requestForText("locvps 20元 1个月"), envFixture());
    const body = await readSuccessData<{
      subscriptions: Array<{ name: string; website: unknown }>;
      diagnostics: { output: { rawModelText: { value: string } | null; rawObjectJson: { value: string } | null } };
    }>(response);
    const payload = JSON.stringify(body);

    expect(body.subscriptions[0]).toMatchObject({ name: "LocVPS", website: null });
    expect(body.diagnostics.output.rawObjectJson?.value).toContain("\"name\": \"LocVPS\"");
    expect(payload).not.toContain("sk-raw-secret123");
    expect(payload).toContain("[redacted]");
  });

  it("returns an actionable error when the provider object cannot be parsed", async () => {
    const providerError = Object.assign(new Error("No object generated: response did not match schema."), {
      __noObjectGenerated: true,
      text: "not json sk-test-secret",
      usage: { inputTokens: 10, outputTokens: 3 },
      finishReason: "stop",
    });
    aiMocks.generateObject.mockRejectedValue(providerError);

    await expect(recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture())).rejects.toMatchObject({
      status: 400,
      code: "AI_RECOGNITION_SCHEMA_MISMATCH",
      message: "AI 返回内容无法整理成订阅草稿，请换用更强的模型或补充更明确的价格、周期和名称。",
      details: {
        rawResponseText: expect.stringContaining("No object generated"),
      },
    });
  });

  it("returns raw provider response details when non-stream recognition provider call fails", async () => {
    aiMocks.generateObject.mockRejectedValue(Object.assign(new Error("provider rejected sk-test-secret"), {
      __apiCallError: true,
      statusCode: 403,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{\"error\":\"forbidden sk-test-secret\"}",
    }));

    await expect(recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture())).rejects.toMatchObject({
      status: 403,
      body: "{\"error\":\"forbidden [redacted]\"}",
    });
  });

  it("keeps an upstream adapter response when diagnostics wrap the provider failure", async () => {
    aiMocks.generateObject.mockRejectedValue(new UpstreamOperationError(
      "gateway rejected the request",
      { rawResponseText: "{\"error\":\"gateway detail\"}" },
      502,
    ));

    await expect(recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture())).rejects.toMatchObject({
      status: 502,
      body: "{\"error\":\"gateway detail\"}",
    });
  });

});
