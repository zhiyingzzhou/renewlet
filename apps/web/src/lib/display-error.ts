/**
 * 浏览器端错误展示工具。
 *
 * 目标：
 * - 普通业务错误尽量展示后端给出的可行动原因。
 * - 登录等敏感认证场景使用泛化文案，避免账号枚举。
 */
import { ApiError } from "@/lib/api-client";
import { getApiLocale } from "@/i18n/api-locale";
import { translate, type MessageKey } from "@/i18n/messages";

export const genericLoginErrorMessage = translate(getApiLocale(), "error.loginGeneric");

const ERROR_CODE_MESSAGES: Record<string, MessageKey> = {
  SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED: "error.code.SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED",
  SUBSCRIPTION_NAME_REQUIRED: "error.code.SUBSCRIPTION_NAME_REQUIRED",
  SUBSCRIPTION_NAME_TOO_LONG: "error.code.SUBSCRIPTION_NAME_TOO_LONG",
  CURRENCY_CODE_INVALID: "error.code.CURRENCY_CODE_INVALID",
  SUBSCRIPTION_PRICE_NEGATIVE: "error.code.SUBSCRIPTION_PRICE_NEGATIVE",
  CUSTOM_DAYS_REQUIRED: "error.code.CUSTOM_DAYS_REQUIRED",
  CUSTOM_DAYS_NEGATIVE: "error.code.CUSTOM_DAYS_NEGATIVE",
  START_DATE_DATE_FORMAT: "error.code.START_DATE_DATE_FORMAT",
  START_DATE_DATE_INVALID: "error.code.START_DATE_DATE_INVALID",
  NEXT_BILLING_DATE_DATE_FORMAT: "error.code.NEXT_BILLING_DATE_DATE_FORMAT",
  NEXT_BILLING_DATE_DATE_INVALID: "error.code.NEXT_BILLING_DATE_DATE_INVALID",
  NEXT_BILLING_DATE_BEFORE_START_DATE: "error.code.NEXT_BILLING_DATE_BEFORE_START_DATE",
  TRIAL_END_DATE_DATE_FORMAT: "error.code.TRIAL_END_DATE_DATE_FORMAT",
  TRIAL_END_DATE_DATE_INVALID: "error.code.TRIAL_END_DATE_DATE_INVALID",
  LOGO_URL_INVALID: "error.code.LOGO_URL_INVALID",
  LOGO_URL_SCHEME_INVALID: "error.code.LOGO_URL_SCHEME_INVALID",
  WEBSITE_URL_INVALID: "error.code.WEBSITE_URL_INVALID",
  WEBSITE_URL_SCHEME_INVALID: "error.code.WEBSITE_URL_SCHEME_INVALID",
  TAGS_MUST_BE_STRING_ARRAY: "error.code.TAGS_MUST_BE_STRING_ARRAY",
  TAGS_TOO_MANY: "error.code.TAGS_TOO_MANY",
  TAG_TOO_LONG: "error.code.TAG_TOO_LONG",
  REMINDER_DAYS_OUT_OF_RANGE: "error.code.REMINDER_DAYS_OUT_OF_RANGE",
  COST_SHARING_COLLECTION_ANCHOR_REQUIRED: "error.code.COST_SHARING_COLLECTION_ANCHOR_REQUIRED",
  COST_SHARING_MEMBER_JOINED_DATE_OUT_OF_RANGE: "error.code.COST_SHARING_MEMBER_JOINED_DATE_OUT_OF_RANGE",
  SUBSCRIPTION_RENEW_COST_SHARING_INVALID: "error.code.SUBSCRIPTION_RENEW_COST_SHARING_INVALID",
  COST_SHARING_COLLECTION_REMINDER_ONE_TIME_BUYOUT_INVALID: "error.code.COST_SHARING_COLLECTION_REMINDER_ONE_TIME_BUYOUT_INVALID",
  SETTINGS_JSON_INVALID: "error.code.SETTINGS_JSON_INVALID",
  CUSTOM_CONFIG_JSON_INVALID: "error.code.CUSTOM_CONFIG_JSON_INVALID",
  CUSTOM_CONFIG_GROUP_NOT_ARRAY: "error.code.CUSTOM_CONFIG_GROUP_NOT_ARRAY",
  CUSTOM_CONFIG_GROUP_TOO_LARGE: "error.code.CUSTOM_CONFIG_GROUP_TOO_LARGE",
  CUSTOM_CONFIG_ITEM_INVALID: "error.code.CUSTOM_CONFIG_ITEM_INVALID",
  CONFIG_ITEM_LABELS_REQUIRED: "error.code.CONFIG_ITEM_LABELS_REQUIRED",
  CONFIG_ITEM_LABELS_INVALID: "error.code.CONFIG_ITEM_LABELS_INVALID",
  CONFIG_ITEM_REQUIRED_FIELDS: "error.code.CONFIG_ITEM_REQUIRED_FIELDS",
  CONFIG_ITEM_FIELDS_TOO_LONG: "error.code.CONFIG_ITEM_FIELDS_TOO_LONG",
  CONFIG_ITEM_COLOR_NOT_STRING: "error.code.CONFIG_ITEM_COLOR_NOT_STRING",
  CONFIG_ITEM_ICON_NOT_STRING: "error.code.CONFIG_ITEM_ICON_NOT_STRING",
  CONFIG_ITEM_ENABLED_NOT_BOOLEAN: "error.code.CONFIG_ITEM_ENABLED_NOT_BOOLEAN",
  BUILT_IN_ICON_SOURCE_REQUIRED: "error.code.BUILT_IN_ICON_SOURCE_REQUIRED",
  ASSET_KIND_INVALID: "error.code.ASSET_KIND_INVALID",
  ASSET_FILE_TOO_MANY: "error.code.ASSET_FILE_TOO_MANY",
  ASSET_FILE_SIZE_INVALID: "error.code.ASSET_FILE_SIZE_INVALID",
  ASSET_FILE_TYPE_INVALID: "error.code.ASSET_FILE_TYPE_INVALID",
  ASSET_FILE_READ_FAILED: "error.code.ASSET_FILE_READ_FAILED",
  NOTIFICATION_LOCAL_DATE_DATE_FORMAT: "error.code.NOTIFICATION_LOCAL_DATE_DATE_FORMAT",
  NOTIFICATION_LOCAL_DATE_DATE_INVALID: "error.code.NOTIFICATION_LOCAL_DATE_DATE_INVALID",
  NOTIFICATION_LOCAL_TIME_INVALID: "error.code.NOTIFICATION_LOCAL_TIME_INVALID",
  NOTIFICATION_TIMEZONE_INVALID: "error.code.NOTIFICATION_TIMEZONE_INVALID",
  NOTIFICATION_UTC_TIME_INVALID: "error.code.NOTIFICATION_UTC_TIME_INVALID",
  NOTIFICATION_ATTEMPTS_NEGATIVE: "error.code.NOTIFICATION_ATTEMPTS_NEGATIVE",
  USER_NAME_REQUIRED: "error.code.USER_NAME_REQUIRED",
  USER_NAME_TOO_LONG: "error.code.USER_NAME_TOO_LONG",
  USER_EMAIL_INVALID: "error.code.USER_EMAIL_INVALID",
  USER_PASSWORD_INVALID: "error.code.USER_PASSWORD_INVALID",
  INVALID_JSON: "error.code.INVALID_JSON",
  EMPTY_BODY: "error.code.EMPTY_BODY",
  BODY_TOO_LARGE: "error.code.BODY_TOO_LARGE",
  INVALID_PAYLOAD: "error.code.INVALID_PAYLOAD",
  IMPORT_PREVIEW_FAILED: "error.code.IMPORT_PREVIEW_FAILED",
  IMPORT_SKIP_INDEX_INVALID: "error.code.IMPORT_SKIP_INDEX_INVALID",
  IMPORT_CONFLICT_MODE_INVALID: "error.code.IMPORT_CONFLICT_MODE_INVALID",
  IMPORT_SOURCE_INVALID: "error.code.IMPORT_SOURCE_INVALID",
  IMPORT_TOO_MANY_SUBSCRIPTIONS: "error.code.IMPORT_TOO_MANY_SUBSCRIPTIONS",
  IMPORT_SETTINGS_INVALID: "error.code.IMPORT_SETTINGS_INVALID",
  IMPORT_KEY_REQUIRED: "error.code.IMPORT_KEY_REQUIRED",
  IMPORT_SOURCE_ID_INVALID: "error.code.IMPORT_SOURCE_ID_INVALID",
  IMPORT_CONFIDENCE_INVALID: "error.code.IMPORT_CONFIDENCE_INVALID",
  IMPORT_SOURCE_MISMATCH: "error.code.IMPORT_SOURCE_MISMATCH",
  IMPORT_SOURCE_ID_DUPLICATE: "error.code.IMPORT_SOURCE_ID_DUPLICATE",
  TURNSTILE_CONFIG_INCOMPLETE: "error.code.TURNSTILE_CONFIG_INCOMPLETE",
  TURNSTILE_REQUIRED: "error.code.TURNSTILE_REQUIRED",
  TURNSTILE_TEST_FAILED: "error.code.TURNSTILE_TEST_FAILED",
  AI_MODEL_REQUIRED: "error.code.AI_MODEL_REQUIRED",
  AI_BASE_URL_REQUIRED: "error.code.AI_BASE_URL_REQUIRED",
  AI_API_KEY_REQUIRED: "error.code.AI_API_KEY_REQUIRED",
  AI_RECOGNITION_INPUT_REQUIRED: "error.code.AI_RECOGNITION_INPUT_REQUIRED",
  AI_THINKING_PROVIDER_MISMATCH: "error.code.AI_THINKING_PROVIDER_MISMATCH",
  AI_IMAGE_TYPE_INVALID: "error.code.AI_IMAGE_TYPE_INVALID",
  AI_RECOGNITION_EMPTY: "error.code.AI_RECOGNITION_EMPTY",
  AI_RECOGNITION_FAILED: "error.code.AI_RECOGNITION_FAILED",
  AI_RECOGNITION_SCHEMA_MISMATCH: "error.code.AI_RECOGNITION_SCHEMA_MISMATCH",
  AI_RECOGNITION_TEST_FAILED: "error.code.AI_RECOGNITION_TEST_FAILED",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringFromRecord(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function localizeErrorCode(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const segments = trimmed.split(":").map((segment) => segment.trim()).filter(Boolean);
  const concreteCode = segments.length > 1 ? segments[segments.length - 1] : trimmed;

  const direct = ERROR_CODE_MESSAGES[concreteCode ?? trimmed];
  if (direct) return translate(getApiLocale(), direct);

  for (const [code, key] of Object.entries(ERROR_CODE_MESSAGES).sort((a, b) => b[0].length - a[0].length)) {
    if (trimmed.includes(code)) return translate(getApiLocale(), key);
  }
  return null;
}

function responseFromError(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error)) return null;
  const response = error["response"];
  return isRecord(response) ? response : null;
}

function localizedFromRecord(error: Record<string, unknown>): string | null {
  // API message 由服务端 catalog 本地化；前端只把稳定 code 映射到自己的 Lingui 文案。
  const code = stringFromRecord(error, ["code"]);
  const codeMessage = localizeErrorCode(code);
  // 通用校验 envelope 可能包着更具体的领域错误码；不能先用“参数无效”遮住可修正的原因。
  if (code === "INVALID_PAYLOAD" || code === "VALIDATION_ERROR") {
    const message = stringFromRecord(error, ["detail", "message"]);
    if (message) return localizeErrorCode(message) ?? message;
  }
  if (codeMessage) return codeMessage;

  const direct = stringFromRecord(error, ["detail", "message", "error", "title"]);
  const directMessage = localizeErrorCode(direct);
  if (directMessage) return directMessage;

  const response = responseFromError(error);
  if (response) return localizedFromRecord(response);
  return null;
}

/** 普通业务场景：优先展示后端已经整理过的可读错误。 */
export function getDisplayErrorMessage(error: unknown, fallback = translate(getApiLocale(), "error.generic")): string {
  if (typeof error === "string") return localizeErrorCode(error) ?? (error.trim() || fallback);
  if (isRecord(error)) {
    const localized = localizedFromRecord(error);
    if (localized) return localized;
  }
  if (error instanceof ApiError) return localizeErrorCode(error.code) ?? localizeErrorCode(error.message) ?? (error.message || fallback);
  if (error instanceof Error) return localizeErrorCode(error.message) ?? (error.message || fallback);
  if (isRecord(error)) {
    return stringFromRecord(error, ["detail", "message", "error", "title"]) ?? fallback;
  }
  return fallback;
}

/**
 * 登录失败展示。
 *
 * PocketBase 客户端会返回普通对象，里面可能有 code/message/status。
 * 这里只根据非敏感状态给出可行动文案，其余一律使用泛化登录失败原因。
 */
export function getAuthDisplayMessage(error: unknown, fallback = translate(getApiLocale(), "error.loginGeneric")): string {
  if (error instanceof ApiError && error.code === "TURNSTILE_REQUIRED") return translate(getApiLocale(), "error.turnstileRequired");
  if (error instanceof ApiError && error.code === "TURNSTILE_FAILED") return translate(getApiLocale(), "error.turnstileFailed");
  if (!isRecord(error)) return fallback;

  const status = typeof error["status"] === "number"
    ? error["status"]
    : typeof error["statusCode"] === "number"
      ? error["statusCode"]
      : undefined;

  if (status === 429) return translate(getApiLocale(), "error.tooManyAttempts");
  if (typeof status === "number" && status >= 500) return translate(getApiLocale(), "error.loginUnavailable");

  return fallback;
}
