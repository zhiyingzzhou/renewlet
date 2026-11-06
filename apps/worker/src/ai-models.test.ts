// Worker AI 模型列表测试保护认证代理、provider 形状归一和原始错误回显，避免请求 API key 进入响应 headers。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { listAIModels } from "./ai-models";
import type { Env } from "./types";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getSettings: authMocks.getSettings };
});

const authUser = {
  id: "usr_models",
  email: "models@example.com",
  name: "Model User",
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

function requestFor(body: unknown): Request {
  return new Request("https://renewlet.test/api/app/ai/models/list", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-renewlet-locale": "zh-CN",
    },
    body: JSON.stringify(body),
  });
}

describe("Cloudflare AI model list proxy", () => {
  beforeEach(() => {
    vi.useRealTimers();
    authMocks.requireAuth.mockReset();
    authMocks.requireAuth.mockResolvedValue({ user: authUser, session: { id: "ses" } });
    const defaults = createDefaultAppSettings();
    authMocks.getSettings.mockReset().mockResolvedValue({
      ...defaults,
      aiRecognition: { ...defaults.aiRecognition, apiKey: "sk-test-secret" },
    });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads and normalizes OpenAI shape models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "gpt-5.1", created: 1780000000, owned_by: "openai" },
        { id: "gpt-5.1", created: 1780000000, owned_by: "openai" },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await listAIModels(requestFor({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "keep" },
    }), envFixture());
    const body = await readSuccessData<{ models: Array<{ id: string; ownedBy: string | null }>; truncated: boolean }>(response);

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
      method: "GET",
      headers: expect.any(Headers),
    }));
    expect((fetchMock.mock.calls[0]?.[1] as { headers: Headers }).headers.get("authorization")).toBe("Bearer sk-test-secret");
    expect(body.models).toEqual([expect.objectContaining({ id: "gpt-5.1", ownedBy: "openai" })]);
    expect(body.truncated).toBe(false);
  });

  it("uses Gemini model ids and filters non generateContent models", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [
        {
          name: "models/gemini-2.5-pro",
          baseModelId: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent"],
          thinking: true,
        },
        {
          name: "models/text-embedding",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    }), { status: 200 })));

    const response = await listAIModels(requestFor({
      providerType: "gemini",
      baseUrl: "",
      apiKey: { action: "set", value: "AIza-test-secret" },
    }), envFixture());
    const body = await readSuccessData<{ models: Array<{ id: string; displayName: string | null; inputTokenLimit: number | null; capabilities: { thinking: boolean | null } }> }>(response);

    expect(body.models).toEqual([expect.objectContaining({
      id: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      inputTokenLimit: 1048576,
      capabilities: expect.objectContaining({ thinking: true }),
    })]);
  });

  it("loads Claude models with Anthropic headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-01-01T00:00:00Z", type: "model" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await listAIModels(requestFor({
      providerType: "anthropic",
      baseUrl: "",
      apiKey: { action: "set", value: "sk-ant-test-secret" },
    }), envFixture());
    const body = await readSuccessData<{ models: Array<{ id: string; displayName: string | null }> }>(response);
    const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Headers }).headers;

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models");
    expect(headers.get("x-api-key")).toBe("sk-ant-test-secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(body.models[0]).toMatchObject({ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" });
  });

  it("supports OpenAI compatible lists without requiring an API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "custom-model" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await listAIModels(requestFor({
      providerType: "openai-compatible",
      baseUrl: "https://llm.example.com/v1/",
      apiKey: { action: "clear" },
    }), envFixture());
    const body = await readSuccessData<{ models: Array<{ id: string }> }>(response);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://llm.example.com/v1/models");
    expect((fetchMock.mock.calls[0]?.[1] as { headers: Headers }).headers.get("authorization")).toBeNull();
    expect(body.models[0]?.id).toBe("custom-model");
  });

  it("returns raw provider response body for model list errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid sk-test-secret", {
      status: 401,
      headers: { "content-type": "text/plain" },
    })));

    await expect(listAIModels(requestFor({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "set", value: "sk-test-secret" },
    }), envFixture())).rejects.toMatchObject({
      status: 401,
      body: "invalid [redacted]",
    });
  });

  it("passes through provider rate limits for display", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));

    await expect(listAIModels(requestFor({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "set", value: "sk-test-secret" },
    }), envFixture())).rejects.toMatchObject({
      status: 429,
      body: "slow down",
    });
  });

  it("passes through provider server errors for display", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider down", { status: 503 })));

    await expect(listAIModels(requestFor({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "set", value: "sk-test-secret" },
    }), envFixture())).rejects.toMatchObject({
      status: 503,
      body: "provider down",
    });
  });

  it("returns bad request for invalid provider JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await expect(listAIModels(requestFor({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "set", value: "sk-test-secret" },
    }), envFixture())).rejects.toMatchObject({
      status: 400,
      code: "AI_MODEL_LIST_INVALID_JSON",
      message: "not-json",
      details: {
        rawResponseText: "not-json",
      },
    });
  });

  it("returns payload too large for oversized provider responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat((1 << 20) + 1), { status: 200 })));

    await expect(listAIModels(requestFor({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "set", value: "sk-test-secret" },
    }), envFixture())).rejects.toMatchObject({
      status: 413,
      code: "AI_MODEL_LIST_RESPONSE_TOO_LARGE",
      details: { rawResponseText: "response_too_large" },
    });
  });

  it("returns a readable timeout error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const caughtPromise = listAIModels(requestFor({
      providerType: "gemini",
      baseUrl: "",
      apiKey: { action: "set", value: "AIza-test-secret" },
    }), envFixture()).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);
    const caught = await caughtPromise;

    expect(caught).toMatchObject({
      status: 408,
      code: "AI_MODEL_LIST_TIMEOUT",
      details: {
        rawResponseText: expect.stringContaining("gemini models GET request to https://generativelanguage.googleapis.com/v1beta/models timed out after 15s before response headers"),
      },
    });
    expect(JSON.stringify(caught)).not.toContain("AIza-test-secret");
  });
});
