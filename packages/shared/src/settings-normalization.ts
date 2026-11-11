import { cleanBuiltInIconSourceSettingsPatch, mergeBuiltInIconSourceSettings } from "./built-in-icons";
import { moneyFromUnknown } from "./money";
import { cleanOnlineIconSourceSettingsPatch, mergeOnlineIconSourceSettings } from "./online-icon-sources";
import {
  appSettingsSchema,
  DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH,
  DINGTALK_TITLE_TEMPLATE_MAX_LENGTH,
  persistedAppSettingsSchema,
  settingsUpdateBodySchema,
  type ApiAppSettings,
} from "./schemas/settings";
import {
  aiRecognitionProviderTypeSchema,
  aiRecognitionSettingsSchema,
  aiThinkingControlSchema,
  canonicalAIRecognitionTransportProtocol,
  normalizeLegacyAIRecognitionSettingsInput,
} from "./schemas/ai-recognition";
import type { z } from "zod";

export type ApiAppSettingsPatch = z.infer<typeof settingsUpdateBodySchema>;

export function normalizeStoredSettingsPatch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // 写入 API 仍严格拒绝非法值；这里仅修复历史/手改 settings JSON 的已知脏字段，避免单个坏字段拖垮整份设置。
  const telegramMessageFormat = value["telegramMessageFormat"];
  const dingtalkMessageType = value["dingtalkMessageType"];
  const dingtalkTitleTemplate = value["dingtalkTitleTemplate"];
  const dingtalkContentTemplate = value["dingtalkContentTemplate"];
  const subscriptionPriceReferenceCurrency = value["subscriptionPriceReferenceCurrency"];
  const monthlyBudget = moneyFromUnknown(value["monthlyBudget"]);
  const aiRecognition = normalizeLegacyAIRecognitionSettings(value["aiRecognition"]);
  return {
    ...value,
    ...(aiRecognition ? { aiRecognition } : {}),
    ...(monthlyBudget ? { monthlyBudget } : {}),
    ...(
      subscriptionPriceReferenceCurrency === undefined
      || subscriptionPriceReferenceCurrency === "default"
      || (typeof subscriptionPriceReferenceCurrency === "string" && /^[A-Z]{3}$/.test(subscriptionPriceReferenceCurrency))
        ? {}
        : { subscriptionPriceReferenceCurrency: "default" }
    ),
    ...(
      telegramMessageFormat === undefined || telegramMessageFormat === "plain" || telegramMessageFormat === "html"
        ? {}
        : { telegramMessageFormat: "plain" }
    ),
    ...(
      dingtalkMessageType === undefined || dingtalkMessageType === "markdown" || dingtalkMessageType === "text"
        ? {}
        : { dingtalkMessageType: "markdown" }
    ),
    ...(
      typeof dingtalkTitleTemplate === "string" && codePointLength(dingtalkTitleTemplate) <= DINGTALK_TITLE_TEMPLATE_MAX_LENGTH
        ? {}
        : { dingtalkTitleTemplate: "" }
    ),
    ...(
      typeof dingtalkContentTemplate === "string" && codePointLength(dingtalkContentTemplate) <= DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH
        ? {}
        : { dingtalkContentTemplate: "" }
    ),
  };
}

/**
 * 历史 settings 只在读取边界归一化：保留凭据和用户选择，重建缺失字段，并把旧 OpenAI Chat 标记成 Responses canonical。
 * 归一化不写回数据库，下一次正常保存/备份导出才会持久化新形状，避免读取设置产生隐式副作用。
 */
export function normalizeLegacyAIRecognitionSettings(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const legacy = normalizeLegacyAIRecognitionSettingsInput(value);
  const parsed = aiRecognitionSettingsSchema.safeParse(legacy);
  if (parsed.success) return parsed.data;

  // 未知键属于契约漂移，必须继续交给 strict schema 抛错；只有已知字段的历史坏值才允许在读取边界降级。
  const canonical = isRecord(legacy) ? legacy : {};
  const knownKeys = new Set([
    "providerType",
    "transportProtocol",
    "model",
    "modelInputMode",
    "baseUrl",
    "defaultThinkingControl",
    "apiKey",
  ]);
  if (Object.keys(canonical).some((key) => !knownKeys.has(key))) {
    return aiRecognitionSettingsSchema.parse(legacy);
  }
  // nested thinking control 也属于严格契约；已知 effort/mode 的坏值可安全回到模型默认，未知键必须继续暴露漂移。
  if (hasUnknownLegacyThinkingControlKey(canonical["defaultThinkingControl"])) {
    return aiRecognitionSettingsSchema.parse(legacy);
  }
  // 历史坏值只允许在读取边界降级到安全空值；凭据、模型和手动模式仍保留，不能因一个 effort/base URL 让整份设置失效。
  const providerCandidate = canonical["providerType"];
  const providerResult = aiRecognitionProviderTypeSchema.safeParse(providerCandidate);
  const provider = providerResult.success ? providerResult.data : "openai";
  const thinking = aiThinkingControlSchema.safeParse(canonical["defaultThinkingControl"] ?? null);
  return {
    providerType: provider,
    transportProtocol: canonicalAIRecognitionTransportProtocol(provider),
    model: typeof canonical["model"] === "string" ? canonical["model"].trim() : "",
    modelInputMode: canonical["modelInputMode"] === "manual" ? "manual" : "select",
    baseUrl: normalizedAIBaseUrl(canonical["baseUrl"]),
    defaultThinkingControl: thinking.success ? thinking.data : null,
    apiKey: typeof canonical["apiKey"] === "string" ? canonical["apiKey"].trim() : "",
  };
}

function hasUnknownLegacyThinkingControlKey(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const knownKeys = new Set(["provider", "effort", "mode", "budget", "level", "budgetTokens"]);
  return Object.keys(value).some((key) => !knownKeys.has(key));
}

function normalizedAIBaseUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? text : "";
  } catch {
    return "";
  }
}

/** settings_json 的 nested 字段必须在同一处合并；调用方不能用浅拷贝覆盖来源开关或 AI 凭据对象。 */
export function mergeAppSettingsPatch(current: ApiAppSettings, patch: ApiAppSettingsPatch): ApiAppSettings {
  const cleanPatch = cleanSettingsPatch(patch);
  return appSettingsSchema.parse({
    ...current,
    ...cleanPatch,
    aiRecognition: {
      ...current.aiRecognition,
      ...(isRecord(cleanPatch.aiRecognition) ? cleanRecord(cleanPatch.aiRecognition) : {}),
    },
    builtInIconSources: mergeBuiltInIconSourceSettings(
      current.builtInIconSources,
      cleanBuiltInIconSourceSettingsPatch(cleanPatch.builtInIconSources),
    ),
    onlineIconSources: mergeOnlineIconSourceSettings(
      current.onlineIconSources,
      cleanOnlineIconSourceSettingsPatch(cleanPatch.onlineIconSources),
    ),
  });
}

export function normalizeSettingsValue(value: unknown, defaults: ApiAppSettings): ApiAppSettings {
  const patch = persistedAppSettingsSchema.parse(normalizeStoredSettingsPatch(value));
  // 持久化读取包含 write-only secret，不能复用浏览器 PATCH schema；嵌套来源配置仍按同一合并规则补历史默认值。
  return appSettingsSchema.parse({
    ...defaults,
    ...patch,
    aiRecognition: {
      ...defaults.aiRecognition,
      ...(patch.aiRecognition ?? {}),
    },
    builtInIconSources: mergeBuiltInIconSourceSettings(
      defaults.builtInIconSources,
      cleanBuiltInIconSourceSettingsPatch(patch.builtInIconSources),
    ),
    onlineIconSources: mergeOnlineIconSourceSettings(
      defaults.onlineIconSources,
      cleanOnlineIconSourceSettingsPatch(patch.onlineIconSources),
    ),
  });
}

function cleanSettingsPatch(patch: ApiAppSettingsPatch): ApiAppSettingsPatch {
  return cleanRecord(patch) as ApiAppSettingsPatch;
}

function cleanRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
