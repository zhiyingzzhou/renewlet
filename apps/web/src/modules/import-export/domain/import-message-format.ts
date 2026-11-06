import type { MessageKey } from "@/i18n/messages";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const IMPORT_MESSAGE_KEYS: Record<string, MessageKey> = {
  BILLING_CYCLE_INVALID: "import.error.billingCycleInvalid",
  IMPORT_CONFIDENCE_INVALID: "import.error.confidenceInvalid",
  IMPORT_ERROR_FILE_TOO_LARGE: "import.fileTooLarge",
  IMPORT_ERROR_UNRECOGNIZED_FILE: "import.error.unrecognizedFile",
  IMPORT_ERROR_WALLOS_TABLE_TOO_LARGE: "import.error.wallosTableTooLarge",
  IMPORT_ERROR_WORKER_PARSE_FAILED: "import.error.workerParseFailed",
  IMPORT_KEY_REQUIRED: "import.error.keyRequired",
  IMPORT_SKIP_INDEX_INVALID: "import.error.skipIndexInvalid",
  IMPORT_SOURCE_ID_DUPLICATE: "import.error.sourceIdDuplicate",
  IMPORT_SOURCE_ID_INVALID: "import.error.sourceIdInvalid",
  IMPORT_SOURCE_INVALID: "import.error.sourceInvalid",
  IMPORT_SUBSCRIPTION_INVALID: "import.error.subscriptionInvalid",
  SUBSCRIPTION_STATUS_INVALID: "import.error.statusInvalid",
  IMPORT_WARNING_CURRENCY_SYMBOL_AMBIGUOUS: "import.warning.currencySymbolAmbiguous",
  IMPORT_WARNING_INVALID_WEBSITE: "import.warning.invalidWebsite",
  IMPORT_WARNING_LOW_CONFIDENCE_KEY: "import.warning.lowConfidenceKey",
  IMPORT_WARNING_LOW_CONFIDENCE_NAME_MATCHED: "import.warning.lowConfidenceNameMatched",
  IMPORT_WARNING_WALLOS_CURRENCY_ID_ONLY: "import.warning.wallosCurrencyIdOnly",
  IMPORT_WARNING_WALLOS_DISPLAY_LOW_CONFIDENCE: "import.warning.wallosDisplayLowConfidence",
  IMPORT_WARNING_WALLOS_EXTERNAL_LOGO: "import.warning.wallosExternalLogo",
  IMPORT_WARNING_WALLOS_MISSING_LOGO_FILE: "import.warning.wallosMissingLogoFile",
  IMPORT_WARNING_WALLOS_NOTIFY_DISABLED: "import.warning.wallosNotifyDisabled",
  IMPORT_WARNING_WALLOS_ONE_TIME: "import.warning.wallosOneTime",
  IMPORT_WARNING_WALLOS_UNKNOWN_CYCLE: "import.warning.wallosUnknownCycle",
  IMPORT_WARNING_AI_WEBSITE_SUGGESTED: "import.warning.aiWebsiteSuggested",
};

const AI_RECOGNITION_WARNING_KEYS: Record<string, MessageKey> = {
  AI_WARNING_AUTO_CALCULATE_DISABLED: "import.warning.aiDateUncertain",
  AI_WARNING_BATCH_PARTIAL: "import.warning.aiBatchPartial",
  AI_WARNING_BILLING_CYCLE_INVALID: "import.warning.aiBillingCycleInvalid",
  AI_WARNING_BILLING_CYCLE_UNCERTAIN: "import.warning.aiBillingCycleUncertain",
  AI_WARNING_CATEGORY_UNCERTAIN: "import.warning.aiCategoryUncertain",
  AI_WARNING_CONFIG_SUGGESTED: "import.warning.aiConfigSuggested",
  AI_WARNING_CURRENCY_INVALID: "import.warning.aiCurrencyInvalid",
  AI_WARNING_CURRENCY_UNCERTAIN: "import.warning.aiCurrencyUncertain",
  AI_WARNING_CUSTOM_CYCLE_UNIT_INVALID: "import.warning.aiCustomCycleInvalid",
  AI_WARNING_CUSTOM_DAYS_INVALID: "import.warning.aiCustomCycleInvalid",
  AI_WARNING_CUSTOM_CYCLE_UNCERTAIN: "import.warning.aiCustomCycleInvalid",
  AI_WARNING_CYCLE_UNCERTAIN: "import.warning.aiBillingCycleUncertain",
  AI_WARNING_DATE_UNCERTAIN: "import.warning.aiDateUncertain",
  AI_WARNING_EMPTY_SUBSCRIPTION_SKIPPED: "import.warning.aiEmptySubscriptionSkipped",
  AI_WARNING_LOW_CONFIDENCE: "import.warning.aiLowConfidence",
  AI_WARNING_ONE_TIME_TERM_COUNT_INVALID: "import.warning.aiOneTimeTermInvalid",
  AI_WARNING_ONE_TIME_TERM_UNIT_INVALID: "import.warning.aiOneTimeTermInvalid",
  AI_WARNING_PRICE_INVALID: "import.warning.aiPriceInvalid",
  AI_WARNING_PRICE_UNCERTAIN: "import.warning.aiPriceUncertain",
  AI_WARNING_PAYMENT_METHOD_UNCERTAIN: "import.warning.aiPaymentMethodUncertain",
  AI_WARNING_REMINDER_DAYS_INVALID: "import.warning.aiReminderInvalid",
  AI_WARNING_REPEAT_INTERVAL_INVALID: "import.warning.aiRepeatReminderInvalid",
  AI_WARNING_REPEAT_WINDOW_INVALID: "import.warning.aiRepeatReminderInvalid",
  AI_WARNING_SERVICE_UNSPECIFIED: "import.warning.aiServiceUnspecified",
  AI_WARNING_STATUS_INVALID: "import.warning.aiStatusInvalid",
  AI_WARNING_STATUS_UNCERTAIN: "import.warning.aiStatusUncertain",
  AI_WARNING_TOO_MANY_SUBSCRIPTIONS_TRUNCATED: "import.warning.aiTooManySubscriptionsTruncated",
  AI_WARNING_WEBSITE_UNCERTAIN: "import.warning.aiWebsiteUncertain",
};

export type AIRecognitionWarningGroup = "missing-facts" | "suggestions" | "batch" | "format";

export const AI_RECOGNITION_WARNING_GROUP_LABELS: Record<AIRecognitionWarningGroup, MessageKey> = {
  "missing-facts": "import.warning.aiGroupMissingFacts",
  suggestions: "import.warning.aiGroupSuggestions",
  batch: "import.warning.aiGroupBatch",
  format: "import.warning.aiGroupFormat",
};

/** 把稳定 warning code 映射到用户能快速处理的四类，避免审阅区展示模型内部诊断。 */
export function groupAIRecognitionWarnings(
  warnings: readonly string[],
): Array<{ group: AIRecognitionWarningGroup; warnings: string[] }> {
  const grouped: Record<AIRecognitionWarningGroup, string[]> = {
    "missing-facts": [],
    suggestions: [],
    batch: [],
    format: [],
  };
  for (const warning of warnings) {
    // 服务简介是可选元数据；历史运行面可能仍返回旧的 NOTES_MISSING code，前端不再把它展示成待修复问题。
    if (warning === "AI_WARNING_NOTES_MISSING") continue;
    grouped[classifyAIRecognitionWarning(warning)].push(warning);
  }
  return (Object.keys(grouped) as AIRecognitionWarningGroup[])
    .map((group) => ({ group, warnings: grouped[group] }))
    .filter((entry) => entry.warnings.length > 0);
}

function classifyAIRecognitionWarning(warning: string): AIRecognitionWarningGroup {
  if (warning === "AI_WARNING_BATCH_PARTIAL") return "batch";
  if (warning === "AI_WARNING_AUTO_CALCULATE_DISABLED") return "missing-facts";
  if (warning.includes("_INVALID") || warning.includes("EMPTY_SUBSCRIPTION") || warning.includes("TOO_MANY_SUBSCRIPTIONS")) return "format";
  if (warning.includes("_UNCERTAIN") || warning === "AI_WARNING_LOW_CONFIDENCE") return "missing-facts";
  return "suggestions";
}

const IMPORT_DATE_FIELD_KEYS: Record<string, MessageKey> = {
  wallosDueDate: "import.field.wallosDueDate",
  wallosStartDate: "import.field.wallosStartDate",
};

/**
 * formatImportMessage 将导入 warning/error code 转成本地化文案。
 *
 * 导入 payload 和服务端响应只保存稳定 code；这里是唯一展示翻译边界，避免解析层直接依赖 UI 文案。
 */
export function formatImportMessage(message: string, t: Translate): string {
  const parts = message.split("|");
  const code = parts[0] ?? "";
  if (code === "IMPORT_WARNING_FOR_SUBSCRIPTION") {
    const name = parts[1] ?? "";
    const nested = parts.slice(2).join("|");
    return t("import.warning.forSubscription", {
      name,
      warning: nested ? formatImportMessage(nested, t) : "",
    });
  }
  if (code === "IMPORT_WARNING_DATE_INVALID") {
    const fieldKey = parts[1] ?? "";
    const fieldMessageKey = IMPORT_DATE_FIELD_KEYS[fieldKey];
    const field = fieldMessageKey ? t(fieldMessageKey) : fieldKey;
    return t("import.warning.dateInvalid", { field, fallback: parts[2] ?? "" });
  }
  if (code === "IMPORT_WARNING_CURRENCY_SYMBOL_AMBIGUOUS") {
    return t("import.warning.currencySymbolAmbiguous", { symbol: parts[1] ?? "", currency: parts[2] ?? "" });
  }
  const aiRecognitionKey = AI_RECOGNITION_WARNING_KEYS[code];
  if (aiRecognitionKey) return t(aiRecognitionKey);
  if (code.startsWith("AI_WARNING_DATE_INVALID")) return t("import.warning.aiDateInvalid");
  if (code.startsWith("AI_WARNING_")) return t("import.warning.aiGeneric");
  const key = IMPORT_MESSAGE_KEYS[code];
  if (!key && code.startsWith("IMPORT_SUBSCRIPTION_INVALID:")) {
    return t("import.error.subscriptionInvalid");
  }
  return key ? t(key) : message;
}
