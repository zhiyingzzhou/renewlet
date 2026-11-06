import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AiRecognizeResponse } from "@/lib/api/schemas/ai-recognition";
import { aiRecognitionService } from "./ai-recognition-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiFetchStream: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
  apiFetchStream: mocks.apiFetchStream,
  ApiError: class ApiError extends Error {
    status: number;
    details: unknown;
    code: string | undefined;

    constructor(message: string, status: number, details?: unknown, code?: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.details = details;
      this.code = code;
    }
  },
}));

const response = {
  providerType: "openai",
  transportProtocol: "openai-responses",
  model: "gpt-5-mini",
  subscriptions: [],
  warnings: [],
  diagnostics: {
    schemaVersion: "1",
    promptVersion: "test",
    schemaName: "test",
    prompt: {
      system: { value: "", truncated: false },
      user: { value: "", truncated: false },
    },
    output: {
      rawModelText: null,
      rawObjectJson: null,
    },
    request: {
      providerType: "openai",
      transportProtocol: "openai-responses",
      model: "gpt-5-mini",
      thinkingControl: null,
      maxOutputTokens: 4096,
      textCharCount: 0,
      images: [],
    },
    response: {
      usage: null,
      finishReason: null,
      providerMetadata: null,
    },
  },
} satisfies AiRecognizeResponse;

describe("aiRecognitionService", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiFetchStream.mockReset();
    mocks.apiFetch.mockResolvedValue(response);
    mocks.apiFetchStream.mockImplementation(async (_input: string, _init: RequestInit, consume: (response: Response) => Promise<unknown>) => (
      await consume(new Response([
        `data: ${JSON.stringify({ type: "recognition/final", response })}`,
        "",
      ].join("\n")))
    ));
  });

  it("sends an explicit null when the current run selects the model default", async () => {
    await aiRecognitionService.recognizeSubscriptions({
      text: "github copilot 20刀 一个月",
      images: [],
      thinkingControl: null,
    });

    const init = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit;
    const body = init.body as FormData;
    expect(body.get("text")).toBe("github copilot 20刀 一个月");
    expect(body.get("thinkingControl")).toBe("null");
  });

  it("sends the selected thinkingControl in multipart requests", async () => {
    await aiRecognitionService.recognizeSubscriptions({
      text: "github copilot 20刀 一个月",
      images: [],
      thinkingControl: { provider: "openai", effort: "high" },
    });

    const init = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit;
    const body = init.body as FormData;
    expect(body.get("thinkingControl")).toBe(JSON.stringify({ provider: "openai", effort: "high" }));
  });

  it("sends prepared image files in multipart requests", async () => {
    const optimizedImage = new File([new Uint8Array(1536 * 1024)], "bill.webp", { type: "image/webp" });

    await aiRecognitionService.recognizeSubscriptions({
      text: "",
      images: [optimizedImage],
      thinkingControl: null,
    });

    const init = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit;
    const body = init.body as FormData;
    const image = body.get("images[]");
    expect(image).toBeInstanceOf(File);
    expect(image).toMatchObject({
      name: "bill.webp",
      type: "image/webp",
      size: 1536 * 1024,
    });
  });

  it("streams recognition events through the authenticated app API", async () => {
    const events: unknown[] = [];
    const controller = new AbortController();

    await expect(aiRecognitionService.recognizeSubscriptionsStream({
      text: "github copilot 20刀 一个月",
      images: [],
      thinkingControl: null,
    }, {
      onEvent: (event) => events.push(event),
    }, {
      signal: controller.signal,
    })).resolves.toEqual(response);

    expect(mocks.apiFetchStream.mock.calls[0]?.[0]).toBe("/api/app/ai/subscriptions/recognize/stream");
    const init = mocks.apiFetchStream.mock.calls[0]?.[1] as RequestInit & { timeoutMs: number; streamIdleTimeoutMs: number };
    expect(init).toMatchObject({ method: "POST", timeoutMs: 30_000, streamIdleTimeoutMs: 120_000 });
    expect(init.signal).toBe(controller.signal);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("text")).toBe("github copilot 20刀 一个月");
    expect(events).toEqual([{ type: "recognition/final", response }]);
  });

  it("ignores SSE comment heartbeats while parsing recognition events", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        controller.enqueue(encoder.encode(`event: recognition/final\ndata: ${JSON.stringify({ type: "recognition/final", response })}\n\n`));
        controller.close();
      },
    });
    mocks.apiFetchStream.mockImplementationOnce(async (_input: string, _init: RequestInit, consume: (response: Response) => Promise<unknown>) => (
      await consume(new Response(stream))
    ));
    const events: unknown[] = [];

    await expect(aiRecognitionService.recognizeSubscriptionsStream({
      text: "github copilot 20刀 一个月",
      images: [],
      thinkingControl: null,
    }, {
      onEvent: (event) => events.push(event),
    })).resolves.toEqual(response);

    expect(events).toEqual([{ type: "recognition/final", response }]);
  });

  it("parses split SSE chunks and surfaces stream errors", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "recognition/progress", stage: "model-start" })}\n\n`));
        controller.enqueue(encoder.encode("data: {\"type\":\"recognition/error\",\"message\":\"bad key\","));
        controller.enqueue(encoder.encode("\"code\":\"AI_RECOGNITION_FAILED\"}\n\n"));
        controller.close();
      },
    });
    mocks.apiFetchStream.mockImplementationOnce(async (_input: string, _init: RequestInit, consume: (response: Response) => Promise<unknown>) => (
      await consume(new Response(stream))
    ));
    const events: unknown[] = [];

    await expect(aiRecognitionService.recognizeSubscriptionsStream({
      text: "github copilot 20刀 一个月",
      images: [],
      thinkingControl: null,
    }, {
      onEvent: (event) => events.push(event),
    })).rejects.toMatchObject({
      message: "bad key",
      code: "AI_RECOGNITION_FAILED",
    });

    expect(events).toEqual([
      { type: "recognition/progress", stage: "model-start" },
      { type: "recognition/error", message: "bad key", code: "AI_RECOGNITION_FAILED" },
    ]);
  });

  it("keeps raw response details from stream errors", async () => {
    const details = {
      rawResponseText: "{\"code\":\"INVALID_API_KEY\",\"message\":\"Invalid API key\"}",
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "recognition/error",
          message: "AI 识别失败",
          code: "AI_RECOGNITION_FAILED",
          details,
        })}\n\n`));
        controller.close();
      },
    });
    mocks.apiFetchStream.mockImplementationOnce(async (_input: string, _init: RequestInit, consume: (response: Response) => Promise<unknown>) => (
      await consume(new Response(stream))
    ));

    await expect(aiRecognitionService.recognizeSubscriptionsStream({
      text: "github copilot 20刀 一个月",
      images: [],
      thinkingControl: null,
    })).rejects.toMatchObject({
      message: "AI 识别失败",
      code: "AI_RECOGNITION_FAILED",
      details: {
        rawResponseText: "{\"code\":\"INVALID_API_KEY\",\"message\":\"Invalid API key\"}",
      },
    });
  });

  it("loads provider models through the authenticated app API", async () => {
    const modelList = {
      providerType: "openai",
      transportProtocol: "openai-responses",
      models: [{
        id: "gpt-5.1",
        displayName: null,
        createdAt: null,
        ownedBy: "openai",
        inputTokenLimit: null,
        outputTokenLimit: null,
        capabilities: {
          textInput: null,
          imageInput: null,
          structuredOutput: null,
          thinking: null,
        },
      }],
      truncated: false,
    };
    mocks.apiFetch.mockResolvedValueOnce(modelList);

    await expect(aiRecognitionService.listModels({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "set", value: "sk-test" },
    })).resolves.toEqual(modelList);

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/ai/models/list");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ providerType: "openai", baseUrl: "", apiKey: { action: "set", value: "sk-test" } }),
      timeoutMs: 20_000,
    });
  });
});
