import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { recognizeSubscriptions } from "./ai-recognition";
import { generatedDraft } from "./ai-recognition.test-utils";
import type { Env } from "./types";

const authMocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
const dbMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCustomConfig: vi.fn(),
  listSubscriptionTags: vi.fn(),
}));
const aiMocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  isStepCount: vi.fn(() => () => false),
  outputObject: vi.fn((options: unknown) => options),
  wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
  isNoObjectGeneratedError: vi.fn(() => false),
  isAPICallError: vi.fn(() => false),
}));

vi.mock("./auth", () => ({ requireAuth: authMocks.requireAuth }));
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
  Output: { object: aiMocks.outputObject },
  wrapLanguageModel: aiMocks.wrapLanguageModel,
  NoObjectGeneratedError: { isInstance: aiMocks.isNoObjectGeneratedError },
  APICallError: { isInstance: aiMocks.isAPICallError },
}));
vi.mock("@ai-sdk/openai", () => ({
  openai: { tools: { webSearch: vi.fn(() => ({ type: "provider-defined" })) } },
  createOpenAI: vi.fn(() => Object.assign(
    vi.fn(() => ({ provider: "openai.responses" })),
    { chat: vi.fn(() => ({ provider: "openai.chat" })), responses: vi.fn(() => ({ provider: "openai.responses" })) },
  )),
}));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({ provider: "gemini" }))) }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic" }))) }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: vi.fn(() => vi.fn(() => ({ provider: "openai-compatible" }))) }));

const authUser = {
  id: "usr_ai", email: "ai@example.com", name: "AI User", role: "admin" as const, banned: 0, ban_reason: "",
  password_hash: "hash", reset_token_hash: null, reset_token_expires_at: null,
  created_at: "2026-06-05T00:00:00.000Z", updated_at: "2026-06-05T00:00:00.000Z",
};
function envFixture(): Env { return { DB: {} as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket }; }
function requestForText(text: string): Request {
  const form = new FormData();
  form.set("text", text);
  return new Request("https://renewlet.test/api/app/ai/subscriptions/recognize", {
    method: "POST",
    headers: { authorization: "Bearer test", "x-renewlet-locale": "zh-CN", "x-client-time-zone": "Asia/Shanghai" },
    body: form,
  });
}

beforeEach(() => {
  authMocks.requireAuth.mockReset(); dbMocks.getSettings.mockReset(); dbMocks.getCustomConfig.mockReset(); dbMocks.listSubscriptionTags.mockReset();
  aiMocks.generateObject.mockReset(); aiMocks.generateText.mockReset();
  aiMocks.generateText.mockImplementation(async (...args: unknown[]) => {
    const result = await aiMocks.generateObject(...args);
    return result && typeof result === "object" && "object" in result
      ? { ...result, output: (result as { object: unknown }).object }
      : result;
  });
  aiMocks.streamText.mockReset();
  authMocks.requireAuth.mockResolvedValue({ user: authUser, session: { id: "ses" } });
  dbMocks.getSettings.mockResolvedValue({ aiRecognition: { providerType: "openai", transportProtocol: "openai-responses", model: "gpt-5.1", modelInputMode: "select", baseUrl: "", apiKey: "sk-test", defaultThinkingControl: null }, timezone: "Asia/Shanghai", defaultCurrency: "CNY" });
  dbMocks.getCustomConfig.mockResolvedValue({ categories: [], statuses: [], paymentMethods: [], currencies: [] });
  dbMocks.listSubscriptionTags.mockResolvedValue(["VPS", "云服务器"]);
});
afterEach(() => { vi.useRealTimers(); });

describe("Cloudflare AI recognition notes", () => {
  it("drops recognition process notes from provider output", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "unknown app",
          price: 12,
          currency: "CNY",
          billingCycle: "monthly",
          website: null,
          notes: { value: "输入没有提供官网或更多上下文，AI 未能高置信识别该服务。", source: "suggested" },
          confidence: "low",
          warnings: ["AI_WARNING_WEBSITE_UNCERTAIN"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("unknown app 12 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(body.subscriptions[0]?.notes).toBeNull();
    expect(body.subscriptions[0]?.warnings).toContain("AI_WARNING_WEBSITE_UNCERTAIN");
  });

  it("removes Renewlet-facing advice from service notes", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "locvps",
          website: { value: "https://locvps.com/", source: "suggested" },
          price: 15,
          currency: "CNY",
          billingCycle: "monthly",
          notes: { value: "LOCVPS 提供 VPS、云服务器和服务器托管相关服务，适合记录主机或服务器套餐订阅。", source: "suggested" },
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("locvps 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: { value: string; source: string } | null }> }>(response);

    expect(body.subscriptions[0]?.notes).toEqual({
      value: "LOCVPS 提供 VPS、云服务器和服务器托管服务",
      source: "suggested",
    });
  });

  it("keeps high-confidence public service descriptions from the provider", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "youtube",
          price: "15刀",
          currency: "USD",
          billingCycle: "1年",
          website: { value: "https://www.youtube.com/", source: "suggested" },
          notes: { value: "YouTube 是 Google 旗下的视频分享和流媒体平台。", source: "suggested" },
          tags: ["视频", "流媒体", "Google"],
          confidence: "high",
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("youtube 15刀 1年"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: { value: string; source: string } | null; warnings: string[] }> }>(response);

    expect(body.subscriptions[0]?.notes).toEqual({
      value: "YouTube 是 Google 旗下的视频分享和流媒体平台。",
      source: "suggested",
    });
    expect(body.subscriptions[0]?.warnings).not.toContain("AI_WARNING_NOTES_MISSING");
  });

  it("repairs a missing service description without replacing billing facts", async () => {
    aiMocks.generateObject
      .mockResolvedValueOnce({
        object: {
          subscriptions: [generatedDraft({
            name: "DMIT",
            price: "159.88",
            billingCycle: "one-time",
            oneTimeTermCount: 2,
            oneTimeTermUnit: "year",
            startDate: "2026-01-06",
            nextBillingDate: null,
            status: null,
            website: null,
            notes: { value: null, source: "none" },
            tags: [],
            confidence: "low",
          })],
          warnings: ["AI_WARNING_STATUS_UNCERTAIN"],
        },
      })
      .mockResolvedValueOnce({
        object: {
          subscriptions: [generatedDraft({
            name: "DMIT",
            price: "1",
            billingCycle: "monthly",
            status: "cancelled",
            website: null,
            notes: { value: "DMIT provides VPS and cloud hosting services.", source: "suggested" },
            tags: [],
          })],
          warnings: [],
        },
      });

    const response = await recognizeSubscriptions(requestForText("DMIT 159.88 USD purchased 2026-01-06 valid for 2 years"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ price: string; billingCycle: string; status: string; nextBillingDate: string | null; notes: { value: string; source: string } | null }> }>(response);

    expect(body.subscriptions[0]).toMatchObject({
      price: "159.88",
      billingCycle: "one-time",
      status: "active",
      nextBillingDate: "2028-01-06",
      notes: { value: "DMIT provides VPS and cloud hosting services.", source: "suggested" },
    });
    expect(aiMocks.generateObject).toHaveBeenCalledTimes(2);
  });

  it("keeps a provider-generated service description without requiring a website field", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "locvps",
          website: null,
          notes: { value: "LOCVPS 提供 VPS 和云服务器服务。", source: "suggested" },
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("locvps 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(body.subscriptions[0]?.notes).toEqual({
      value: "LOCVPS 提供 VPS 和云服务器服务。",
      source: "suggested",
    });
    expect(body.subscriptions[0]?.warnings).not.toContain("AI_WARNING_NOTES_MISSING");
  });

  it("keeps a provider-generated service description without requiring a website field", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "locvps",
          website: null,
          notes: { value: "LOCVPS 提供 VPS 和云服务器服务。", source: "suggested" },
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("locvps 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(body.subscriptions[0]?.notes).toEqual({
      value: "LOCVPS 提供 VPS 和云服务器服务。",
      source: "suggested",
    });
    expect(body.subscriptions[0]?.warnings).not.toContain("AI_WARNING_NOTES_MISSING");
  });

});
