import {
  AI_RECOGNITION_MAX_IMAGES,
  AI_RECOGNITION_MAX_IMAGE_BYTES,
  AI_RECOGNITION_MAX_TEXT_CHARS,
  aiRecognizePayloadSchema,
  aiRecognitionTestPayloadSchema,
  aiRecognitionErrorDetailsSchema,
  aiRecognitionSettingsSchema,
  aiRecognitionStreamEventSchema,
  aiRecognitionTestRequestSchema,
  aiThinkingControlSchema,
  normalizeAIRecognitionThinkingControlForModel,
  type AiRecognitionSettings,
  type AiRecognitionStreamEvent,
  type AiThinkingControl,
} from "@renewlet/shared/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import type { AIRecognitionPromptConfigContext } from "@renewlet/shared/ai-recognition-prompt";
import { getCustomConfig, getSettings, listSubscriptionTags } from "./db";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { serverText, type AppLocale } from "./server-i18n";
import { requireAuth } from "./auth";
import type { Env } from "./types";
import { aiRecognitionConfigContext } from "./ai-recognition-normalize";
import { normalizeAIImageType } from "./ai-recognition-input";
import {
  aiRecognitionErrorDetails,
  redactAIRecognitionSecrets,
  rawAIRecognitionErrorDetails,
  safeAIRecognitionError,
} from "./ai-recognition-diagnostics";
import { providerResponseFromError, upstreamResponseErrorFromError } from "./ai-provider-response";
import { redactUpstreamSecrets, upstreamErrorDetailsFromError, UpstreamResponseError } from "./upstream-response";
import {
  AI_RECOGNITION_PROVIDER_TIMEOUT_MS,
  runAIRecognitionConnectionTest,
  thinkingControlMatchesSettings,
} from "./ai-recognition-runtime";
import {
  aiRecognitionCauseFromError,
  aiRecognitionDiagnosticsFromError,
  aiRecognitionStreamErrorEvent,
  aiRecognitionStreamTimeoutErrorEvent,
  assertAIRecognitionSettings,
  isAIRecognitionSchemaMismatch,
  runAIRecognition,
  runAIRecognitionStream,
} from "./ai-recognition-runner";
import { resolveSecretMutation } from "@renewlet/shared/schemas/secrets";

const AI_RECOGNITION_MULTIPART_OVERHEAD = 1024 * 1024;
const AI_RECOGNITION_MAX_BODY_BYTES =
  AI_RECOGNITION_MAX_TEXT_CHARS * 4
  + AI_RECOGNITION_MAX_IMAGES * AI_RECOGNITION_MAX_IMAGE_BYTES
  + AI_RECOGNITION_MULTIPART_OVERHEAD;
const AI_RECOGNITION_STREAM_HEARTBEAT_MS = 15_000;
type AIRecognitionInput = {
  text: string;
  images: Array<{ data: Uint8Array; mediaType: string }>;
  thinkingControl: AiThinkingControl | null;
  thinkingControlProvided: boolean;
};

type AIRecognitionRunContext = {
  locale: AppLocale;
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  thinkingControl: AiThinkingControl | null;
  timezone: string;
  configContext: AIRecognitionPromptConfigContext;
};

/**
 * recognizeSubscriptions 只返回 AI 草稿。
 *
 * 真正写库仍必须由前端把草稿转成 import payload 后走 preview/apply，避免第三方模型输出绕过用户确认。
 */
export async function recognizeSubscriptions(request: Request, env: Env): Promise<Response> {
  const runContext = await prepareAIRecognitionRun(request, env);
  const runAbort = createAIRecognitionRunAbortSignal(request.signal, AI_RECOGNITION_PROVIDER_TIMEOUT_MS);

  try {
    const response = await runAIRecognition({
      settings: runContext.settings,
      input: runContext.input,
      locale: runContext.locale,
      timezone: runContext.timezone,
      configContext: runContext.configContext,
      thinkingControl: runContext.thinkingControl,
      abortSignal: runAbort.signal,
    });
    if (response.subscriptions.length === 0) {
      throw new HttpError(400, serverText(runContext.locale, "aiRecognition.noSubscriptions"), "AI_RECOGNITION_EMPTY", aiRecognitionErrorDetails("empty", null, response.diagnostics));
    }
    return successJson(aiRecognizePayloadSchema.parse(response));
  } catch (error) {
    if (error instanceof HttpError || error instanceof UpstreamResponseError) throw error;
    const diagnostics = aiRecognitionDiagnosticsFromError(error);
    const cause = aiRecognitionCauseFromError(error);
    const upstreamResponseError = upstreamResponseErrorFromError(cause, [runContext.settings.apiKey]);
    if (upstreamResponseError) throw upstreamResponseError;
    const upstreamDetails = rawAIRecognitionErrorDetails(cause);
    if (isAIRecognitionSchemaMismatch(error)) {
      throw new HttpError(
        400,
        upstreamDetails?.rawResponseText ?? serverText(runContext.locale, "aiRecognition.schemaMismatch"),
        "AI_RECOGNITION_SCHEMA_MISMATCH",
        diagnostics ? aiRecognitionErrorDetails("schema_mismatch", cause, diagnostics) : upstreamDetails ?? safeAIRecognitionError(cause),
      );
    }
    throw new HttpError(
      400,
      upstreamDetails?.rawResponseText ?? serverText(runContext.locale, "aiRecognition.failed"),
      "AI_RECOGNITION_FAILED",
      diagnostics ? aiRecognitionErrorDetails("provider_failed", cause, diagnostics) : upstreamDetails ?? safeAIRecognitionError(cause),
    );
  } finally {
    runAbort.cleanup();
  }
}

export async function recognizeSubscriptionsStream(request: Request, env: Env): Promise<Response> {
  const runContext = await prepareAIRecognitionRun(request, env);
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let runAbort: ReturnType<typeof createAIRecognitionRunAbortSignal> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emitComment = (value: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: ${value}\n\n`));
      };
      const emit = (event: AiRecognitionStreamEvent) => {
        if (closed) return;
        // Worker 与 Go 必须发同构事件；每个事件先过 shared schema，防止调试原文或图片内容意外进入 SSE。
        const safeEvent = aiRecognitionStreamEventSchema.parse(event);
        controller.enqueue(encoder.encode(`event: ${safeEvent.type}\ndata: ${JSON.stringify(safeEvent)}\n\n`));
      };
      heartbeat = setInterval(() => {
        // SSE comment 只承担代理/浏览器链路保活，不进入 shared 事件契约，也不能携带诊断或 provider 原文。
        emitComment("keep-alive");
      }, AI_RECOGNITION_STREAM_HEARTBEAT_MS);
      const currentRunAbort = createAIRecognitionRunAbortSignal(request.signal, AI_RECOGNITION_PROVIDER_TIMEOUT_MS);
      runAbort = currentRunAbort;
      if (closed) {
        currentRunAbort.abort();
        currentRunAbort.cleanup();
        return;
      }
      void (async () => {
        try {
          emit({ type: "recognition/progress", stage: "input-read" });
          const response = await runAIRecognitionStream({
            ...runContext,
            abortSignal: currentRunAbort.signal,
            sink: { emit },
          });
          if (response.subscriptions.length === 0) {
            throw new HttpError(400, serverText(runContext.locale, "aiRecognition.noSubscriptions"), "AI_RECOGNITION_EMPTY", aiRecognitionErrorDetails("empty", null, response.diagnostics));
          }
          emit({ type: "recognition/final", response });
        } catch (error) {
          emit(currentRunAbort.didTimeout()
            ? aiRecognitionStreamTimeoutErrorEvent(runContext.locale, error, [runContext.settings.apiKey])
            : aiRecognitionStreamErrorEvent(runContext.locale, error, [runContext.settings.apiKey]));
        } finally {
          currentRunAbort.cleanup();
          runAbort = null;
          if (!closed) {
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            controller.close();
          }
        }
      })();
    },
    cancel() {
      closed = true;
      runAbort?.abort();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
    },
  });
}

function createAIRecognitionRunAbortSignal(externalSignal: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  abort: () => void;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  // Worker 没有 Go context deadline；用 AbortController 同时收拢浏览器断连和 provider 超时。
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromExternal = () => controller.abort();
  if (externalSignal.aborted) {
    abortFromExternal();
  } else {
    externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal.removeEventListener("abort", abortFromExternal);
    },
    didTimeout: () => timedOut,
  };
}

async function prepareAIRecognitionRun(request: Request, env: Env): Promise<AIRecognitionRunContext> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  assertAIRecognitionContentLength(request, locale);
  const settings = await getSettings(env, auth.user.id);
  const aiSettings = aiRecognitionSettingsSchema.parse(settings.aiRecognition);
  const input = await readAIRecognitionInput(request, locale);
  // 设置页保存的 control 是本次识别的默认运行参数；multipart 明确携带的 control 只覆盖当前一次。
  let thinkingControl = input.thinkingControlProvided ? input.thinkingControl : aiSettings.defaultThinkingControl;
  if (thinkingControl && !thinkingControlMatchesSettings(aiSettings, thinkingControl)) {
    // thinking control 来自 multipart 临时输入，必须绑定当前 provider，不能让旧设置跨模型复用。
    throw new HttpError(400, serverText(locale, "aiRecognition.thinkingProviderMismatch"), "AI_THINKING_PROVIDER_MISMATCH");
  }
  // 临时请求也必须按当前模型能力收敛；旧客户端可能仍发送 GPT-5 不支持的 effort，清空后交给模型默认值。
  thinkingControl = normalizeAIRecognitionThinkingControlForModel(aiSettings.model, thinkingControl);
  assertAIRecognitionSettings(aiSettings, locale);
  // 配置项只作为模型上下文和响应归一化依据；新增分类/支付方式仍必须走 import preview/apply 用户确认链路。
  const [customConfig, existingTags] = await Promise.all([
    getCustomConfig(env, auth.user.id),
    listSubscriptionTags(env, auth.user.id),
  ]);
  return {
    locale,
    settings: aiSettings,
    input,
    thinkingControl,
    timezone: settings.timezone,
    configContext: aiRecognitionConfigContext(customConfig, locale, existingTags),
  };
}

/** testAIRecognitionConnection 使用当前表单配置做一次最小文本调用；keep 只读已存 key，任何 mutation 都不会写入设置。 */
export async function testAIRecognitionConnection(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, aiRecognitionTestRequestSchema, locale);
  const current = await getSettings(env, auth.user.id);
  const settings = aiRecognitionSettingsSchema.parse({
    ...body.settings,
    apiKey: resolveSecretMutation(body.apiKey, current.aiRecognition.apiKey),
  });
  assertAIRecognitionSettings(settings, locale);
  try {
    await runAIRecognitionConnectionTest(settings, settings.defaultThinkingControl, request.signal);
    return successJson(aiRecognitionTestPayloadSchema.parse({
      providerType: settings.providerType,
      transportProtocol: settings.transportProtocol,
      model: settings.model,
    }));
  } catch (error) {
    if (error instanceof HttpError || error instanceof UpstreamResponseError) throw error;
    const upstreamResponseError = upstreamResponseErrorFromError(error, [settings.apiKey]);
    if (upstreamResponseError) throw upstreamResponseError;
    const upstreamDetails = upstreamErrorDetailsFromError(error);
    const rawDetails = rawAIRecognitionErrorDetails(error);
    const responseDetails = upstreamDetails ?? rawDetails;
    throw new HttpError(
      400,
      responseDetails?.rawResponseText ?? serverText(locale, "aiRecognition.testFailed"),
      "AI_RECOGNITION_TEST_FAILED",
      responseDetails ?? {
        rawResponseText: redactUpstreamSecrets(redactAIRecognitionSecrets(providerResponseFromError(error)?.body || ""), [settings.apiKey]) || safeAIRecognitionError(error),
      },
    );
  }
}

function assertAIRecognitionContentLength(request: Request, locale: AppLocale): void {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > AI_RECOGNITION_MAX_BODY_BYTES) {
    throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
  }
}

async function readAIRecognitionInput(
  request: Request,
  locale: AppLocale,
): Promise<AIRecognitionInput> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("too large") || message.includes("body size")) {
      throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
    }
    throw new HttpError(400, serverText(locale, "common.invalidPayload"), "AI_RECOGNITION_MULTIPART_INVALID");
  }
  for (const key of form.keys()) {
    if (key !== "text" && key !== "thinkingControl" && key !== "images" && key !== "images[]") {
      throw new HttpError(400, serverText(locale, "common.invalidPayload"), "AI_RECOGNITION_FIELD_INVALID");
    }
  }

  const textEntry = form.get("text");
  const text = typeof textEntry === "string" ? textEntry.trim() : "";
  if ([...text].length > AI_RECOGNITION_MAX_TEXT_CHARS) {
    throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
  }

  const thinkingEntry = form.get("thinkingControl");
  // 缺字段表示沿用设置页默认 control；显式 null 才表示本次请求使用模型默认。
  const thinkingControl = parseAIThinkingControl(thinkingEntry, locale);
  const imageEntries = [...form.getAll("images"), ...form.getAll("images[]")].filter((value): value is File => value instanceof File);
  if (imageEntries.length > AI_RECOGNITION_MAX_IMAGES) {
    throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
  }
  const images: AIRecognitionInput["images"] = [];
  for (const file of imageEntries) {
    if (file.size <= 0) continue;
    if (file.size > AI_RECOGNITION_MAX_IMAGE_BYTES) {
      throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
    }
    const data = new Uint8Array(await file.arrayBuffer());
    images.push({ data, mediaType: normalizeAIImageType(file.type, data, locale) });
  }
  if (!text && images.length === 0) {
    throw new HttpError(400, serverText(locale, "aiRecognition.inputRequired"), "AI_RECOGNITION_INPUT_REQUIRED");
  }
  const totalBytes = new TextEncoder().encode(text).byteLength + images.reduce((sum, image) => sum + image.data.byteLength, 0);
  if (totalBytes > AI_RECOGNITION_MAX_BODY_BYTES) {
    throw new HttpError(413, serverText(locale, "common.requestBodyTooLarge"), "BODY_TOO_LARGE");
  }
  return { text, images, thinkingControl, thinkingControlProvided: thinkingEntry !== null };
}

function parseAIThinkingControl(
  value: FormDataEntryValue | null,
  locale: AppLocale,
): AiThinkingControl | null {
  if (value === null) return null;
  if (value instanceof File) {
    throw new HttpError(400, serverText(locale, "common.invalidPayload"), "AI_THINKING_CONTROL_INVALID");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  let jsonValue: unknown;
  try {
    jsonValue = JSON.parse(trimmed) as unknown;
  } catch {
    throw new HttpError(400, serverText(locale, "common.invalidPayload"), "AI_THINKING_CONTROL_INVALID");
  }
  const parsed = aiThinkingControlSchema.safeParse(jsonValue);
  if (!parsed.success) {
    throw new HttpError(400, serverText(locale, "common.invalidPayload"), "AI_THINKING_CONTROL_INVALID", parsed.error.flatten());
  }
  return parsed.data;
}
