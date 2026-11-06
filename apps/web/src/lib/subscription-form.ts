import {
  MAX_SUBSCRIPTION_TAG_LENGTH,
  MAX_SUBSCRIPTION_TAGS,
  type SubscriptionFormSubmission,
} from "@/types/subscription";
import {
  costSharingCollectionAnchorsAreSatisfied,
  costSharingCustomAmountsAreValid,
  isValidCostSharingCollectionReminderDays,
  costSharingMemberJoinedDatesWithinRange,
  resolveCostSharingMemberJoinedDateRange,
  type CostSharingMemberJoinedDateRange,
} from "@renewlet/shared/cost-sharing";
import type { SubscriptionFormState } from "@/types/subscription-form";
import {
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  MAX_REMINDER_DAYS,
} from "@renewlet/shared/runtime";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import type { MessageKey, MessageParams } from "@/i18n/messages";
import { compareDateOnly } from "@/lib/time/date-only";
import { calculateOneTimeTermEndDate } from "@/lib/subscription-billing";
import { canonicalizeMoneyString } from "@renewlet/shared/money";

const MAX_PRICE = 1_000_000_000;
const MAX_DAYS = MAX_REMINDER_DAYS;
const TAG_SEPARATOR_PATTERN = /[、，,;；\n]+/g;
type SubscriptionFormSubmissionBase = Omit<
  SubscriptionFormSubmission,
  "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit"
>;

export type SubscriptionFormErrorField =
  | "name"
  | "price"
  | "currency"
  | "balance"
  | "balanceCurrency"
  | "billingCycle"
  | "dates"
  | "customDays"
  | "oneTimeTerm"
  | "reminderDays"
  | "costSharing"
  | "website"
  | "tags";

export type SubscriptionFormValidationIssueCode =
  | "nameRequired"
  | "amountInvalid"
  | "balanceRequired"
  | "balanceInvalid"
  | "balanceCurrencyInvalid"
  | SubscriptionDateValidationKind
  | "reminderInvalid"
  | "customCycleInvalid"
  | "oneTimeTermInvalid"
  | "costSharingCollectionReminderOneTimeBuyoutInvalid"
  | "costSharingCollectionReminderInvalid"
  | "costSharingCollectionReminderAnchorRequired"
  | "costSharingMemberJoinedDateRangeInvalid"
  | "costSharingInvalid"
  | "websiteInvalid"
  | "tagsTooMany"
  | "tagTooLong";

export interface SubscriptionFormValidationIssue {
  code: SubscriptionFormValidationIssueCode;
  field: SubscriptionFormErrorField;
  messageKey: MessageKey;
  params?: MessageParams | undefined;
}

export type SubscriptionFormErrors = Partial<Record<SubscriptionFormErrorField, string>>;

/** 严格解析金额输入，拒绝 `1e3` 和超过 6 位小数，返回跨 API/storage 的 canonical decimal string。 */
export function parseMoneyInput(input: string, _max = MAX_PRICE): string | null {
  const value = input.trim();
  if (value.startsWith(".")) return canonicalizeMoneyString(`0${value}`);
  return canonicalizeMoneyString(value);
}

/** 严格解析非负整数，避免 `01`、小数和单位后缀被隐式接受。 */
export function parseNonNegativeIntegerInput(input: string, max = MAX_DAYS): number | null {
  const value = input.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) return null;
  return parsed;
}

export function parseReminderDaysInput(input: string): number | null {
  if (input.trim() === String(DISABLED_REMINDER_DAYS)) return DISABLED_REMINDER_DAYS;
  if (input.trim() === String(INHERIT_REMINDER_DAYS)) return INHERIT_REMINDER_DAYS;
  return parseNonNegativeIntegerInput(input, MAX_DAYS);
}

/** 严格解析正整数；用于自定义扣费周期等必须大于 0 的输入。 */
export function parsePositiveIntegerInput(input: string, max = MAX_DAYS): number | null {
  const parsed = parseNonNegativeIntegerInput(input, max);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

/** 校验可选 URL：空值允许；非空时只接受 http(s)。 */
export function isOptionalHttpUrl(input: string | null | undefined): boolean {
  const value = input?.trim() ?? "";
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 将标签输入（分隔字符串）转换为标签数组。
 *
 * 注意：
 * - 兼容多种分隔符：顿号 `、` / 中文逗号 `，` / 英文逗号 `,` / 分号 `;；` / 换行
 * - 会 trim 并过滤空项（例如连续分隔符、首尾分隔符）
 */
export function normalizeTagsArray(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of tags) {
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

export function parseTagsInput(tags: string): string[] {
  if (!tags) return [];
  return normalizeTagsArray(tags.split(TAG_SEPARATOR_PATTERN));
}

export function getTagsValidationError(formDataTags: readonly string[]): string | null {
  const locale = getApiLocale();
  const issue = getTagsValidationIssue(formDataTags);
  return issue ? translate(locale, issue.messageKey, issue.params) : null;
}

function getTagsValidationIssue(formDataTags: readonly string[]): SubscriptionFormValidationIssue | null {
  const tags = normalizeTagsArray(formDataTags);
  if (tags.length > MAX_SUBSCRIPTION_TAGS) {
    return {
      code: "tagsTooMany",
      field: "tags",
      messageKey: "subscription.validation.tagsTooMany",
      params: { count: MAX_SUBSCRIPTION_TAGS },
    };
  }
  if (tags.some((tag) => Array.from(tag).length > MAX_SUBSCRIPTION_TAG_LENGTH)) {
    return {
      code: "tagTooLong",
      field: "tags",
      messageKey: "subscription.validation.tagTooLong",
      params: { count: MAX_SUBSCRIPTION_TAG_LENGTH },
    };
  }
  return null;
}

/**
 * 从表单状态计算 reminderDays（整数）。
 *
 * 规则：
 * - disabled：保存为 -2，由通知和日历 alarm 层识别为单订阅静默
 * - inherit：保存为 -1，由通知计算读取设置页全局提前天数
 * - preset：严格解析 reminderDays
 * - custom：严格解析 customReminderDays，空值回退为 3
 * - 类似 `3days` / `3.5` 的宽松输入会被拒绝，避免浏览器和后端解析口径不同。
 */
export function toReminderDays(formData: Pick<SubscriptionFormState, "reminderType" | "reminderDays" | "customReminderDays">): number {
  if (formData.reminderType === "disabled") {
    return DISABLED_REMINDER_DAYS;
  }
  if (formData.reminderType === "inherit") {
    return INHERIT_REMINDER_DAYS;
  }
  if (formData.reminderType === "custom") {
    return parseNonNegativeIntegerInput(formData.customReminderDays) ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  }
  return parseReminderDaysInput(formData.reminderDays) ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
}

/**
 * 订阅日期的跨字段不变量集中放在这里，确保弹窗校验和 draft 转换不会出现两套口径。
 * 使用 DateOnly 比较而不是 JS Date，避免运行时本地时区把业务日期推前/推后一天。
 */
export function isRenewalDateBeforeStartDate(
  formData: Pick<SubscriptionFormState, "startDate" | "nextBillingDate">,
): boolean {
  return Boolean(
    formData.startDate &&
    formData.nextBillingDate &&
    compareDateOnly(formData.nextBillingDate, formData.startDate) < 0,
  );
}

export type SubscriptionDateValidationKind =
  | "purchaseDateRequired"
  | "nextBillingDateRequired"
  | "startDateRequiredForAutoCalculate"
  | "dateOrderInvalid";

export function getSubscriptionDateValidationKind(formData: Pick<
  SubscriptionFormState,
  "billingCycle" | "oneTimeMode" | "startDate" | "nextBillingDate" | "autoCalculate"
>): SubscriptionDateValidationKind | null {
  const isOneTime = formData.billingCycle === "one-time";
  if (isOneTime && !formData.startDate) return "purchaseDateRequired";
  if (!isOneTime && formData.autoCalculate && !formData.startDate) {
    return "startDateRequiredForAutoCalculate";
  }
  if (!isOneTime && !formData.nextBillingDate) return "nextBillingDateRequired";
  if (!isOneTime && isRenewalDateBeforeStartDate(formData)) {
    return "dateOrderInvalid";
  }
  return null;
}

export function costSharingCollectionReminderIsAllowedForBillingCycle(formData: Pick<
  SubscriptionFormState,
  "billingCycle" | "oneTimeMode"
>): boolean {
  return !(formData.billingCycle === "one-time" && formData.oneTimeMode === "buyout");
}

export function resolveCostSharingJoinedDateRangeForForm(formData: Pick<
  SubscriptionFormState,
  "billingCycle" | "oneTimeMode" | "oneTimeTermCount" | "oneTimeTermUnit" | "startDate" | "nextBillingDate"
>): CostSharingMemberJoinedDateRange {
  return resolveCostSharingMemberJoinedDateRange(costSharingJoinedDateRangeInputForForm(formData));
}

export function costSharingJoinedDatesWithinFormRange(formData: Pick<
  SubscriptionFormState,
  "billingCycle" | "oneTimeMode" | "oneTimeTermCount" | "oneTimeTermUnit" | "startDate" | "nextBillingDate" | "costSharing"
>): boolean {
  return costSharingMemberJoinedDatesWithinRange(formData.costSharing, costSharingJoinedDateRangeInputForForm(formData));
}

function costSharingJoinedDateRangeInputForForm(formData: Pick<
  SubscriptionFormState,
  "billingCycle" | "oneTimeMode" | "oneTimeTermCount" | "oneTimeTermUnit" | "startDate" | "nextBillingDate"
>) {
  const oneTimeTermCount = formData.billingCycle === "one-time" && formData.oneTimeMode === "term"
    ? parsePositiveIntegerInput(formData.oneTimeTermCount)
    : null;
  const nextBillingDate = formData.billingCycle === "one-time" && formData.oneTimeMode === "term" && formData.startDate && oneTimeTermCount
    ? calculateOneTimeTermEndDate(formData.startDate, oneTimeTermCount, formData.oneTimeTermUnit)
    : formData.nextBillingDate;
  return {
    subscriptionStartDate: formData.startDate ?? null,
    nextBillingDate: nextBillingDate ?? null,
    billingCycle: formData.billingCycle,
    oneTimeTermCount,
    oneTimeTermUnit: formData.billingCycle === "one-time" && formData.oneTimeMode === "term" ? formData.oneTimeTermUnit : null,
  };
}

export function subscriptionDateValidationMessageKey(kind: SubscriptionDateValidationKind): MessageKey {
  switch (kind) {
    case "purchaseDateRequired":
      return "subscription.validation.purchaseDateRequired";
    case "nextBillingDateRequired":
      return "subscription.validation.nextBillingDateRequired";
    case "startDateRequiredForAutoCalculate":
      return "subscription.validation.startDateRequiredForAutoCalculate";
    case "dateOrderInvalid":
      return "subscription.validation.dateOrderInvalid";
  }
}

export function getSubscriptionFormValidationIssues(formData: SubscriptionFormState): SubscriptionFormValidationIssue[] {
  // 顺序化 issue 列表是普通提交、draft 转换和 AI preflight 的共同事实源；新增规则时必须保持“首错可直接操作”的顺序。
  const issues: SubscriptionFormValidationIssue[] = [];
  if (!formData.name.trim()) {
    issues.push({ code: "nameRequired", field: "name", messageKey: "subscription.validation.nameRequired" });
  }
  if (parseMoneyInput(formData.price) === null) {
    issues.push({ code: "amountInvalid", field: "price", messageKey: "subscription.validation.amountInvalid" });
  }
  if (formData.balanceEnabled) {
    if (!formData.balance.trim()) {
      issues.push({ code: "balanceRequired", field: "balance", messageKey: "subscription.validation.balanceRequired" });
    } else if (parseMoneyInput(formData.balance) === null) {
      issues.push({ code: "balanceInvalid", field: "balance", messageKey: "subscription.validation.balanceInvalid" });
    }
    if (!/^[A-Z]{3}$/.test(formData.balanceCurrency)) {
      issues.push({ code: "balanceCurrencyInvalid", field: "balanceCurrency", messageKey: "subscription.validation.balanceCurrencyInvalid" });
    }
  }
  const dateValidationKind = getSubscriptionDateValidationKind(formData);
  if (dateValidationKind) {
    issues.push({
      code: dateValidationKind,
      field: "dates",
      messageKey: subscriptionDateValidationMessageKey(dateValidationKind),
    });
  }
  const reminderInput = formData.reminderType === "custom" ? formData.customReminderDays : formData.reminderDays;
  const reminderValue = formData.billingCycle === "one-time" && formData.oneTimeMode === "buyout"
    ? DISABLED_REMINDER_DAYS
    : formData.reminderType === "disabled"
      ? DISABLED_REMINDER_DAYS
      : formData.reminderType === "inherit"
        ? INHERIT_REMINDER_DAYS
        : formData.reminderType === "custom"
          ? parseNonNegativeIntegerInput(reminderInput)
          : parseReminderDaysInput(reminderInput);
  if (reminderValue === null) {
    issues.push({ code: "reminderInvalid", field: "reminderDays", messageKey: "subscription.validation.reminderInvalid" });
  }
  if (formData.billingCycle === "custom" && parsePositiveIntegerInput(formData.customDays) === null) {
    issues.push({ code: "customCycleInvalid", field: "customDays", messageKey: "subscription.validation.customCycleInvalid" });
  }
  if (formData.billingCycle === "one-time" && formData.oneTimeMode === "term" && parsePositiveIntegerInput(formData.oneTimeTermCount) === null) {
    issues.push({ code: "oneTimeTermInvalid", field: "oneTimeTerm", messageKey: "subscription.validation.oneTimeTermInvalid" });
  }
  if (formData.costSharing?.enabled) {
    const price = parseMoneyInput(formData.price);
    const collectionReminder = formData.costSharing.collectionReminder;
    if (collectionReminder?.enabled) {
      if (!costSharingCollectionReminderIsAllowedForBillingCycle(formData)) {
        issues.push({
          code: "costSharingCollectionReminderOneTimeBuyoutInvalid",
          field: "costSharing",
          messageKey: "subscription.validation.costSharingCollectionReminderOneTimeBuyoutInvalid",
        });
      } else if (!isValidCostSharingCollectionReminderDays(collectionReminder.reminderDays)) {
        issues.push({
          code: "costSharingCollectionReminderInvalid",
          field: "costSharing",
          messageKey: "subscription.validation.costSharingCollectionReminderInvalid",
        });
      } else if (!costSharingCollectionAnchorsAreSatisfied(formData.costSharing, formData.startDate ?? null)) {
        issues.push({
          code: "costSharingCollectionReminderAnchorRequired",
          field: "costSharing",
          messageKey: "subscription.validation.costSharingCollectionReminderAnchorRequired",
        });
      }
    }
    // 家庭共享按“提醒语义 -> 成员日期范围 -> 金额/成员结构”逐层校验，同一字段只暴露首个可操作问题。
    if (!issues.some((issue) => issue.field === "costSharing") && !costSharingJoinedDatesWithinFormRange(formData)) {
      issues.push({
        code: "costSharingMemberJoinedDateRangeInvalid",
        field: "costSharing",
        messageKey: "subscription.validation.costSharingMemberJoinedDateRangeInvalid",
      });
    }
    if (
      !issues.some((issue) => issue.field === "costSharing") &&
      (
        price === null ||
        formData.costSharing.members.length === 0 ||
        !costSharingCustomAmountsAreValid(formData.costSharing)
      )
    ) {
      issues.push({ code: "costSharingInvalid", field: "costSharing", messageKey: "subscription.validation.costSharingInvalid" });
    }
  }
  if (!isOptionalHttpUrl(formData.website)) {
    issues.push({ code: "websiteInvalid", field: "website", messageKey: "subscription.validation.websiteInvalid" });
  }
  const tagsIssue = getTagsValidationIssue(formData.tags);
  if (tagsIssue) issues.push(tagsIssue);
  return issues;
}

export function subscriptionFormValidationIssuesToErrors(
  issues: readonly SubscriptionFormValidationIssue[],
  t: (key: MessageKey, params?: MessageParams) => string,
): SubscriptionFormErrors {
  // 字段 UI 只显示首个 issue，完整有序列表仍保留给 preflight、首错跳转和 draft 转换使用。
  const errors: SubscriptionFormErrors = {};
  for (const issue of issues) {
    if (!errors[issue.field]) errors[issue.field] = t(issue.messageKey, issue.params);
  }
  return errors;
}

/** 返回订阅草稿的首个阻塞性校验错误；用于提交前给用户明确反馈。 */
export function getSubscriptionFormValidationError(formData: SubscriptionFormState): string | null {
  const issue = getSubscriptionFormValidationIssues(formData)[0];
  return issue ? translate(getApiLocale(), issue.messageKey, issue.params) : null;
}

export function toSubscriptionFormSubmission(formData: SubscriptionFormState): SubscriptionFormSubmission | null {
  if (getSubscriptionFormValidationError(formData)) return null;

  const price = parseMoneyInput(formData.price);
  const reminderDays = formData.billingCycle === "one-time" && formData.oneTimeMode === "buyout"
    ? DISABLED_REMINDER_DAYS
    : toReminderDays(formData);
  const customDays = formData.billingCycle === "custom" ? parsePositiveIntegerInput(formData.customDays) : undefined;
  const oneTimeTermCount = formData.billingCycle === "one-time" && formData.oneTimeMode === "term"
    ? parsePositiveIntegerInput(formData.oneTimeTermCount)
    : undefined;
  const startDate = formData.startDate ?? null;
  const nextBillingDate = formData.billingCycle === "one-time"
    ? formData.oneTimeMode === "term" && formData.startDate && oneTimeTermCount
      ? calculateOneTimeTermEndDate(formData.startDate, oneTimeTermCount, formData.oneTimeTermUnit)
      : formData.startDate
    : formData.nextBillingDate;
  if (
    price === null ||
    reminderDays === null ||
    !nextBillingDate ||
    (formData.billingCycle === "one-time" && !formData.startDate) ||
    (formData.billingCycle !== "one-time" && formData.autoCalculate && !formData.startDate) ||
    (formData.billingCycle === "custom" && customDays === null) ||
    (formData.billingCycle === "one-time" && formData.oneTimeMode === "term" && oneTimeTermCount === null)
  ) {
    return null;
  }

  const repeatReminderEnabled = reminderDays === DISABLED_REMINDER_DAYS ? false : formData.repeatReminderEnabled;
  const base = {
    name: formData.name,
    logo: formData.logo,
    price,
    currency: formData.currency,
    // 关闭只影响提交命令，草稿仍保留；零不能通过真假判断退化为未记录。
    balance: formData.balanceEnabled ? parseMoneyInput(formData.balance) ?? undefined : undefined,
    balanceCurrency: formData.balanceEnabled ? formData.balanceCurrency : undefined,
    category: formData.category,
    status: formData.status,
    publicHidden: formData.publicHidden,
    paymentMethod: formData.paymentMethod || undefined,
    startDate,
    nextBillingDate,
    autoRenew: formData.billingCycle === "one-time" ? false : formData.autoRenew,
    autoCalculateNextBillingDate: formData.billingCycle === "one-time" ? false : formData.autoCalculate,
    reminderDays,
    repeatReminderEnabled,
    repeatReminderInterval: formData.repeatReminderInterval,
    repeatReminderWindow: formData.repeatReminderWindow,
    costSharing: formData.costSharing?.enabled ? formData.costSharing : undefined,
    website: formData.website || undefined,
    notes: formData.notes || undefined,
    tags: normalizeTagsArray(formData.tags),
  } satisfies SubscriptionFormSubmissionBase;
  if (formData.billingCycle === "custom") {
    if (typeof customDays !== "number") return null;
    return {
      ...base,
      billingCycle: "custom",
      customDays,
      customCycleUnit: formData.customCycleUnit,
    };
  }
  if (formData.billingCycle === "one-time") {
    if (formData.oneTimeMode === "term") {
      if (typeof oneTimeTermCount !== "number") return null;
      return {
        ...base,
        billingCycle: "one-time",
        oneTimeTermCount,
        oneTimeTermUnit: formData.oneTimeTermUnit,
        autoRenew: false,
        autoCalculateNextBillingDate: false,
      };
    }
    return {
      ...base,
      billingCycle: "one-time",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
    };
  }
  return {
    ...base,
    billingCycle: formData.billingCycle,
  };
}
