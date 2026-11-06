import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { assertDateOnly, compareDateOnly, todayDateOnlyInTimeZone, type DateOnly } from "@/lib/time/date-only";
import { normalizeWebsite } from "@/modules/import-export/domain/import-export-model";
import { calculateOneTimeTermEndDate } from "@renewlet/shared/subscription-billing";
import type { CustomConfig } from "@/types/config";
import {
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  type AppSettings,
} from "@/types/subscription";
import { createSubscriptionFormState, type SubscriptionFormState } from "@/types/subscription-form";

interface AIDraftFormContext {
  settings: AppSettings;
}

export const AI_DRAFT_CONFIRMATION_FIELDS = ["price", "currency", "billingCycle", "status", "category", "paymentMethod"] as const;
export type AIDraftConfirmationField = typeof AI_DRAFT_CONFIRMATION_FIELDS[number];

// AI 草稿复用订阅表单状态，保证用户确认前走同一套日期、提醒和分类校验，而不是绕过导入链路直写。
export function aiDraftToSubscriptionFormState(
  draft: AiRecognizedSubscriptionDraft,
  context: AIDraftFormContext,
): SubscriptionFormState {
  const isOneTimeBuyout = draft.billingCycle === "one-time" && !draft.oneTimeTermCount;
  const fixedTermEndDate = draft.nextBillingDate ?? deriveFixedTermEndDate(draft);
  const inferredStatus = inferFixedTermStatus(draft, context.settings.timezone, fixedTermEndDate);
  // 买断/长期有效没有下一次提醒语义，AI 返回的提醒字段也不能覆盖该业务规则。
  const reminderState = isOneTimeBuyout
    ? disabledReminderState()
    : inheritedReminderState();
  return createSubscriptionFormState({
    name: draft.name,
    logo: undefined,
    price: draft.price === null ? "" : String(draft.price),
    currency: draft.currency ?? context.settings.defaultCurrency,
    billingCycle: draft.billingCycle ?? "monthly",
    customDays: draft.customDays === null ? "" : String(draft.customDays),
    customCycleUnit: draft.customCycleUnit ?? "day",
    oneTimeMode: isOneTimeBuyout ? "buyout" : "term",
    oneTimeTermCount: draft.oneTimeTermCount === null ? "1" : String(draft.oneTimeTermCount),
    oneTimeTermUnit: draft.oneTimeTermUnit ?? "month",
    // 缺失分类统一落到“其他”，并保留待确认状态；不能把用户配置第一项冒充模型识别结果。
    category: draft.category ?? "other",
    status: draft.status ?? inferredStatus ?? "active",
    publicHidden: false,
    paymentMethod: draft.paymentMethod ?? "",
    startDate: toFormDate(draft.startDate),
    nextBillingDate: toFormDate(fixedTermEndDate),
    autoRenew: false,
    autoCalculate: draft.autoCalculateNextBillingDate === true || (
      !draft.nextBillingDate
      && Boolean(draft.startDate)
      && isRecurringCycleWithAnchor(draft)
    ),
    reminderType: reminderState.reminderType,
    reminderDays: reminderState.reminderDays,
    customReminderDays: reminderState.customReminderDays,
    costSharing: undefined,
    website: normalizeWebsite(draft.website?.value, []) ?? draft.website?.value ?? "",
    notes: draft.notes?.value ?? "",
    tags: draft.tags,
  });
}

export function getInitialAIDraftConfirmationFields(
  draft: AiRecognizedSubscriptionDraft,
  config: CustomConfig,
  timezone = "UTC",
): AIDraftConfirmationField[] {
  const inferredStatus = inferFixedTermStatus(draft, timezone, draft.nextBillingDate ?? deriveFixedTermEndDate(draft));
  // 缺失字段会先显示可编辑默认值，但“有可用值”不等于“用户认可该值”，因此确认状态必须独立于表单合法性保存。
  return AI_DRAFT_CONFIRMATION_FIELDS.filter((field) => {
    if (field === "price") return draft.price === null;
    if (field === "currency") return !draft.currency?.trim();
    if (field === "billingCycle") return draft.billingCycle === null;
    if (field === "status") return draft.status === null && inferredStatus === null;
    if (field === "category") return draft.category === null || !isAIDraftConfigValueKnown(draft.category, config.categories);
    return draft.paymentMethod === null || !isAIDraftConfigValueKnown(draft.paymentMethod, config.paymentMethods);
  });
}

/**
 * 固定服务期的购买日与期限/结束日是状态证据。日期区间内直接视为 active，结束日之后视为 expired；
 * 开始日前仍保持未确认，避免把未来订单提前标记为生效。
 */
function inferFixedTermStatus(
  draft: AiRecognizedSubscriptionDraft,
  timezone?: string,
  fixedTermEndDate: string | null = draft.nextBillingDate ?? deriveFixedTermEndDate(draft),
): NonNullable<AiRecognizedSubscriptionDraft["status"]> | null {
  if (draft.status !== null || draft.billingCycle !== "one-time" || !draft.startDate) return null;
  if (!fixedTermEndDate) return null;
  // getInitialAIDraftConfirmationFields 没有 settings 参数时，使用稳定的 UTC 日期；
  // 运行时映射始终传入账号时区，测试和恢复路径也因此不会依赖本地机器时区。
  const today = todayDateOnlyInTimeZone(new Date(), timezone ?? "UTC");
  if (compareDateOnly(today, draft.startDate) < 0) return null;
  return compareDateOnly(today, fixedTermEndDate) <= 0 ? "active" : "expired";
}

function deriveFixedTermEndDate(draft: AiRecognizedSubscriptionDraft): DateOnly | null {
  if (draft.billingCycle !== "one-time" || !draft.startDate || !draft.oneTimeTermCount || !draft.oneTimeTermUnit) return null;
  try {
    return calculateOneTimeTermEndDate(draft.startDate, draft.oneTimeTermCount, draft.oneTimeTermUnit);
  } catch {
    return null;
  }
}

export function isAIDraftConfigValueKnown(value: string | null, options: readonly { value: string; labels: Record<string, string> }[]): boolean {
  if (!value) return false;
  const key = configMatchKey(value);
  return options.some((option) => [option.value, option.labels["zh-CN"], option.labels["en-US"]]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .some((candidate) => configMatchKey(candidate) === key));
}

export function canConfirmAIDraftDefaultValue(
  draft: AiRecognizedSubscriptionDraft,
  formData: SubscriptionFormState,
  field: AIDraftConfirmationField,
  config: CustomConfig,
): boolean {
  if (field === "billingCycle") {
    // 月付只是表单可编辑占位值；缺失周期会改变账单语义，必须由用户在周期控件中明确选择。
    return false;
  }
  if (field === "price" || field === "currency" || field === "status") {
    return draft[field] === null && Boolean(String(formData[field]).trim());
  }
  if (field === "category") {
    return draft.category === null
      && Boolean(formData.category)
      && isAIDraftConfigValueKnown(formData.category, config.categories);
  }
  return draft.paymentMethod === null
    && Boolean(formData.paymentMethod.trim())
    && isAIDraftConfigValueKnown(formData.paymentMethod, config.paymentMethods);
}

export function canConfirmAIDraftField(
  draft: AiRecognizedSubscriptionDraft,
  formData: SubscriptionFormState,
  field: AIDraftConfirmationField,
  config: CustomConfig,
): boolean {
  if (canConfirmAIDraftDefaultValue(draft, formData, field, config)) return true;
  // 未知分类/支付方式只能由这一次明确操作确认添加；空值不能消费待确认状态。
  if (field === "category") return Boolean(formData.category.trim());
  if (field === "paymentMethod") return Boolean(formData.paymentMethod.trim());
  if (field === "billingCycle") return draft.billingCycle === null && Boolean(formData.billingCycle.trim());
  return false;
}

function isRecurringCycleWithAnchor(draft: AiRecognizedSubscriptionDraft): boolean {
  if (!draft.billingCycle || draft.billingCycle === "one-time") return false;
  if (draft.billingCycle !== "custom") return true;
  return draft.customDays !== null && draft.customCycleUnit !== null;
}

function configMatchKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-—–/\\|&+，,、.。:：()（）[\]【】]+/g, "");
}

function disabledReminderState(): Pick<SubscriptionFormState, "reminderType" | "reminderDays" | "customReminderDays"> {
  return { reminderType: "disabled", reminderDays: String(DISABLED_REMINDER_DAYS), customReminderDays: "" };
}

function inheritedReminderState(): Pick<SubscriptionFormState, "reminderType" | "reminderDays" | "customReminderDays"> {
  return { reminderType: "inherit", reminderDays: String(INHERIT_REMINDER_DAYS), customReminderDays: "" };
}

function toFormDate(value: string | null): DateOnly | undefined {
  return value ? assertDateOnly(value) : undefined;
}
