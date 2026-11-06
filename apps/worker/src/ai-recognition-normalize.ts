/**
 * Worker AI 输出归一化层。
 *
 * 第三方模型输出先经过 generated schema，再在这里收敛到 shared RecognizeResponse；任何字段进入导入预览前都必须经过这层。
 */
import {
  AI_RECOGNITION_MAX_SUBSCRIPTIONS,
  aiRecognizePayloadSchema,
  canonicalAIRecognitionTransportProtocol,
  type AiGeneratedRecognizeObject,
  type AiGeneratedSubscriptionDraft,
  type AiRecognizedSubscriptionDraft,
  type AiRecognitionDiagnostics,
  type AiRecognitionSettings,
  type AiRecognizeResponse,
} from "@renewlet/shared/schemas/ai-recognition";
import {
  type AIRecognitionPromptConfigContext,
  type AIRecognitionPromptConfigOption,
} from "@renewlet/shared/ai-recognition-prompt";
import {
  normalizeAIRecognitionGeneratedInputNotes,
  normalizeAIRecognitionUsefulNotes,
} from "@renewlet/shared/ai-recognition-notes";
import { customConfigSchema, type ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
import { moneyFromNumber } from "@renewlet/shared/money";
import { calculateOneTimeTermEndDate } from "@renewlet/shared/subscription-billing";
import {
  BILLING_CYCLES,
  MAX_REMINDER_DAYS,
  normalizeCustomCycleUnit,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
} from "@renewlet/shared/runtime";
import { type AppLocale } from "./server-i18n";
import { localizedConfigLabel } from "./custom-config-labels";
import { calendarFeedBuiltInCategoryLabelKey, calendarFeedBuiltInPaymentMethodLabelKey } from "./calendar-feed-built-in-labels";
import type { ServerI18nKey } from "./server-i18n-catalog";

const BILLING_CYCLE_SET = new Set<string>(BILLING_CYCLES);
// 生成态字段是宽字符串；白名单显式绑定到最终草稿联合类型，避免归一化后又退化成 string。
type RecognizedCustomCycleUnit = NonNullable<AiRecognizedSubscriptionDraft["customCycleUnit"]>;
type RecognizedSubscriptionStatus = NonNullable<AiRecognizedSubscriptionDraft["status"]>;
const STATUS_SET: ReadonlySet<RecognizedSubscriptionStatus> = new Set<RecognizedSubscriptionStatus>(SUBSCRIPTION_STATUSES);

export function normalizeGeneratedAIRecognizeObject(
  raw: AiGeneratedRecognizeObject,
  providerType: AiRecognitionSettings["providerType"],
  transportProtocol: AiRecognitionSettings["transportProtocol"],
  model: string,
  diagnostics: AiRecognitionDiagnostics,
  configContext: AIRecognitionPromptConfigContext,
  currentDate?: string,
): AiRecognizeResponse {
  const warnings = compactAIWarnings(raw.warnings, 20);
  const subscriptions: AiRecognizedSubscriptionDraft[] = [];
  const drafts = raw.subscriptions.slice(0, AI_RECOGNITION_MAX_SUBSCRIPTIONS);
  for (const draft of drafts) {
    const normalized = normalizeGeneratedSubscriptionDraft(draft, configContext, currentDate);
    if (normalized) {
      subscriptions.push(normalized);
    } else {
      warnings.push("AI_WARNING_EMPTY_SUBSCRIPTION_SKIPPED");
    }
  }
  if (raw.subscriptions.length > AI_RECOGNITION_MAX_SUBSCRIPTIONS) {
    warnings.push("AI_WARNING_TOO_MANY_SUBSCRIPTIONS_TRUNCATED");
  }
  // 固定服务期已经由购买日和期限确定状态时，不能继续把模型的通用状态不确定提示显示为全局警告。
  if (!subscriptions.some((subscription) => subscription.warnings.includes("AI_WARNING_STATUS_UNCERTAIN"))) {
    removeAIWarning(warnings, "AI_WARNING_STATUS_UNCERTAIN");
  }
  return aiRecognizePayloadSchema.parse({
    providerType,
    transportProtocol: canonicalAIRecognitionTransportProtocol(providerType),
    model,
    subscriptions,
    warnings: compactAIWarnings(warnings, 20),
    diagnostics,
  });
}

/** 对有非空服务名但备注为空的草稿执行一次有界 provider 补全；身份是否明确交给模型判定。 */
export function missingDescribableNoteNames(subscriptions: readonly AiRecognizedSubscriptionDraft[]): string[] {
  return subscriptions
    .filter((draft) => !draft.notes && isDescribableForAINotes(draft))
    .map((draft) => draft.name)
    .slice(0, 20);
}

function isDescribableForAINotes(draft: AiRecognizedSubscriptionDraft): boolean {
  const name = draft.name.trim().toLowerCase();
  return name.length > 0 && !/^(?:unknown(?:\s+(?:app|service|subscription))?|unnamed|n\/?a|none|未知(?:服务|应用)?|未命名(?:服务|应用)?)$/u.test(name);
}

/**
 * 补全响应只拥有备注写权限；账单字段继续使用首轮归一化结果，避免二次模型调用覆盖事实。
 */
export function mergeRecognizedAIRecognitionNotes(
  response: AiRecognizeResponse,
  repaired: AiRecognizeResponse,
): AiRecognizeResponse {
  const used = new Set<number>();
  const subscriptions = response.subscriptions.map((draft, index) => {
    const sameIndex = repaired.subscriptions[index];
    const candidate = sameIndex && sameIndex.name.trim().toLowerCase() === draft.name.trim().toLowerCase()
      ? sameIndex
      : repaired.subscriptions.find((item, candidateIndex) => (
        !used.has(candidateIndex)
        && item.name.trim().toLowerCase() === draft.name.trim().toLowerCase()
      ));
    const candidateIndex = candidate ? repaired.subscriptions.indexOf(candidate) : -1;
    if (candidateIndex >= 0) used.add(candidateIndex);
    return candidate?.notes ? { ...draft, notes: candidate.notes } : draft;
  });
  return { ...response, subscriptions };
}

function normalizeGeneratedSubscriptionDraft(
  draft: AiGeneratedSubscriptionDraft,
  configContext: AIRecognitionPromptConfigContext,
  currentDate?: string,
): AiRecognizedSubscriptionDraft | null {
  const name = trimMax(draft.name, 120);
  if (!name) return null;
  const warnings = compactAIWarnings(draft.warnings, 12);
  const confidence = draft.confidence === "high" ? "high" : "low";
  const price = normalizeGeneratedPrice(draft.price, warnings);
  // Go 运行面先处理这两个宽松数字字段，再进入标准字段归一化；保持 warning 顺序和缺失语义一致。
  const customDays = normalizeGeneratedPositiveInteger(draft.customDays, MAX_REMINDER_DAYS, "AI_WARNING_CUSTOM_DAYS_INVALID", warnings);
  const oneTimeTermCount = normalizeGeneratedPositiveInteger(draft.oneTimeTermCount, MAX_REMINDER_DAYS, "AI_WARNING_ONE_TIME_TERM_COUNT_INVALID", warnings);
  const currency = normalizeGeneratedCurrency(draft.currency, warnings);
  const billingCycle = normalizeGeneratedBillingCycle(draft.billingCycle, warnings);
  const customCycleUnit = normalizeGeneratedCycleUnit(draft.customCycleUnit, "AI_WARNING_CUSTOM_CYCLE_UNIT_INVALID", warnings);
  const oneTimeTermUnit = normalizeGeneratedCycleUnit(draft.oneTimeTermUnit, "AI_WARNING_ONE_TIME_TERM_UNIT_INVALID", warnings);
  const category = normalizeGeneratedConfigValue(draft.category, configContext.categories);
  const paymentMethod = normalizeGeneratedConfigValue(draft.paymentMethod, configContext.paymentMethods);
  const startDate = normalizeGeneratedDate(draft.startDate, "startDate", warnings);
  const nextBillingDate = normalizeGeneratedDate(draft.nextBillingDate, "nextBillingDate", warnings);
  const trialEndDate = normalizeGeneratedDate(draft.trialEndDate, "trialEndDate", warnings);
  const fixedTermEndDate = nextBillingDate ?? (billingCycle === "one-time"
    ? deriveFixedTermEndDate(startDate, oneTimeTermCount, oneTimeTermUnit)
    : null);
  const status = normalizeGeneratedStatus(draft.status, billingCycle, startDate, fixedTermEndDate, currentDate, warnings);
  if (status !== null) removeAIWarning(warnings, "AI_WARNING_STATUS_UNCERTAIN");
  // 先规范化周期和锚点，再决定是否自动计算；无效值不能把 true 传入表单日期链路。
  const autoCalculateNextBillingDate = normalizeAutoCalculateNextBillingDate({
    billingCycle,
    startDate,
    autoCalculateNextBillingDate: draft.autoCalculateNextBillingDate,
  }, warnings);
  const website = normalizeGeneratedSuggestedField(draft.website);
  const notes = normalizeGeneratedNotesField(draft.notes);
  const tags = normalizeGeneratedTags(draft.tags, draft.name, configContext.tags);
  if (price === null) warnings.push("AI_WARNING_PRICE_UNCERTAIN");
  if (currency === null) warnings.push("AI_WARNING_CURRENCY_UNCERTAIN");
  if (billingCycle === null) warnings.push("AI_WARNING_CYCLE_UNCERTAIN");
  if (startDate === null && nextBillingDate === null) warnings.push("AI_WARNING_DATE_UNCERTAIN");
  if (status === null) warnings.push("AI_WARNING_STATUS_UNCERTAIN");
  if (paymentMethod === null) warnings.push("AI_WARNING_PAYMENT_METHOD_UNCERTAIN");
  if (category === null) warnings.push("AI_WARNING_CATEGORY_UNCERTAIN");
  if (category !== null && !findAIRecognitionConfigOption(configContext.categories, category)) warnings.push("AI_WARNING_CONFIG_SUGGESTED");
  if (paymentMethod !== null && !findAIRecognitionConfigOption(configContext.paymentMethods, paymentMethod)) warnings.push("AI_WARNING_CONFIG_SUGGESTED");
  if (confidence === "low") warnings.push("AI_WARNING_LOW_CONFIDENCE");
  return {
    name,
    price,
    currency,
    billingCycle,
    customDays,
    customCycleUnit,
    oneTimeTermCount,
    oneTimeTermUnit,
    category,
    status,
    paymentMethod,
    startDate,
    // 固定服务期的结束日由已识别的购买日和期限确定；写入草稿后，前端、导入和 Docker 运行面共享同一事实。
    nextBillingDate: nextBillingDate ?? fixedTermEndDate,
    autoCalculateNextBillingDate,
    trialEndDate,
    website,
    notes,
    tags,
    // 提醒属于用户设置，不接受模型推断；表单会从当前账号设置生成默认值。
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence,
    warnings: compactAIWarnings(warnings, 12),
  };
}

function deriveFixedTermEndDate(
  startDate: string | null,
  count: number | null,
  unit: AiRecognizedSubscriptionDraft["oneTimeTermUnit"],
): string | null {
  if (!startDate || !count || !unit) return null;
  try {
    return calculateOneTimeTermEndDate(startDate, count, unit);
  } catch {
    return null;
  }
}

function normalizeGeneratedStatus(
  value: string | null | undefined,
  billingCycle: AiRecognizedSubscriptionDraft["billingCycle"],
  startDate: string | null,
  nextBillingDate: string | null,
  currentDate: string | undefined,
  warnings: string[],
): AiRecognizedSubscriptionDraft["status"] {
  const explicit = normalizeGeneratedEnum(value, STATUS_SET, "AI_WARNING_STATUS_INVALID", warnings);
  if (explicit !== null || !currentDate || billingCycle !== "one-time" || !startDate || !nextBillingDate) return explicit;
  // 固定服务期的购买日与期限（或明确结束日）是订阅状态的直接证据：区间内 active，结束后 expired。
  // 只有 recurring、买断或缺少完整期限证据时才继续要求用户选择，避免把“已付款”误当成生效状态。
  if (currentDate < startDate) return null;
  return currentDate <= nextBillingDate ? "active" : "expired";
}

function removeAIWarning(warnings: string[], warning: string): void {
  for (let index = warnings.length - 1; index >= 0; index -= 1) {
    if (warnings[index] === warning) warnings.splice(index, 1);
  }
}

function normalizeAutoCalculateNextBillingDate(
  draft: Pick<AiGeneratedSubscriptionDraft, "billingCycle" | "startDate" | "autoCalculateNextBillingDate">,
  warnings: string[],
): boolean | null {
  if (draft.billingCycle === "one-time") return false;
  if (!draft.autoCalculateNextBillingDate) return draft.autoCalculateNextBillingDate ?? null;
  if (!draft.startDate || !draft.billingCycle) {
    warnings.push("AI_WARNING_AUTO_CALCULATE_DISABLED");
    return false;
  }
  return true;
}

function normalizeGeneratedPrice(value: AiGeneratedSubscriptionDraft["price"], warnings: string[]): string | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const parsed = parseGeneratedNumber(value);
  if (parsed === null) {
    warnings.push("AI_WARNING_PRICE_INVALID");
    return null;
  }
  if (parsed < 0 || parsed > 1_000_000_000) {
    warnings.push("AI_WARNING_PRICE_INVALID");
    return null;
  }
  return moneyFromNumber(parsed);
}

function normalizeGeneratedCurrency(value: string | null | undefined, warnings: string[]): string | null {
  const text = stringValue(value).toUpperCase();
  if (!text) return null;
  const mapped = text === "元" || text === "人民币" || text === "RMB" || text === "YUAN" || text === "￥" || text === "¥"
    ? "CNY"
    : text;
  if (/^[A-Z]{3}$/.test(mapped)) return mapped;
  warnings.push("AI_WARNING_CURRENCY_INVALID");
  return null;
}

function normalizeGeneratedBillingCycle(value: string | null | undefined, warnings: string[]): AiRecognizedSubscriptionDraft["billingCycle"] {
  const text = stringValue(value).toLowerCase();
  if (!text) return null;
  if (BILLING_CYCLE_SET.has(text)) return text as AiRecognizedSubscriptionDraft["billingCycle"];
  const compact = text.replace(/\s+/g, "");
  // 固定服务期/买断不是 recurring；只有带有明确固定期限语义的上下文才允许映射为 one-time，
  // 裸的“2 years/1 month”仍按周期词处理，避免把多年预付误判成买断。
  const fixedTerm = /(?:validfor|serviceterm|fixedterm|duration|term|有效期|服务期|期限|买断|一次性|lifetime)/i.test(compact);
  if (fixedTerm && !/(?:every|each|per|renew|recurr|每|续费|续订)/i.test(compact)) return "one-time";
  const mapped = compact.includes("week") || compact.includes("周") ? "weekly"
    : compact.includes("quarter") || compact.includes("季") ? "quarterly"
      : compact.includes("semi") || compact.includes("half") || compact.includes("半年") ? "semi-annual"
        : compact.includes("year") || compact.includes("annual") || compact.includes("年") ? "annual"
          : compact.includes("month") || compact.includes("月") ? "monthly"
            : compact.includes("one-time") || compact.includes("lifetime") || compact.includes("一次") || compact.includes("买断") ? "one-time"
              : null;
  if (mapped) return mapped as AiRecognizedSubscriptionDraft["billingCycle"];
  warnings.push("AI_WARNING_BILLING_CYCLE_INVALID");
  return null;
}

function normalizeGeneratedPositiveInteger(
  value: AiGeneratedSubscriptionDraft["customDays"],
  max: number,
  warning: string,
  warnings: string[],
): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const parsed = parseGeneratedInteger(value);
  if (parsed === null) {
    warnings.push(warning);
    return null;
  }
  if (parsed <= 0 || parsed > max) {
    warnings.push(warning);
    return null;
  }
  return parsed;
}

function normalizeGeneratedEnum<T extends string>(
  value: string | null | undefined,
  allowed: ReadonlySet<T>,
  warning: string,
  warnings: string[],
): T | null {
  const text = stringValue(value);
  if (!text) return null;
  if (isAllowedGeneratedEnumValue(allowed, text)) return text;
  warnings.push(warning);
  return null;
}

function normalizeGeneratedCycleUnit(
  value: string | null | undefined,
  warning: string,
  warnings: string[],
): RecognizedCustomCycleUnit | null {
  const text = stringValue(value);
  if (!text) return null;
  const normalized = normalizeCustomCycleUnit(text);
  if (normalized) return normalized;
  warnings.push(warning);
  return null;
}

function isAllowedGeneratedEnumValue<T extends string>(allowed: ReadonlySet<T>, value: string): value is T {
  // 逐项比较让运行时字符串先由白名单成员收窄为 T，再返回给草稿 schema；不把未知字符串强转成业务枚举。
  for (const candidate of allowed) {
    if (candidate === value) return true;
  }
  return false;
}

function normalizeGeneratedOptionalText(value: string | null | undefined, maxLength: number): string | null {
  return trimMax(stringValue(value), maxLength) || null;
}

function normalizeGeneratedConfigValue(
  value: string | null | undefined,
  options: readonly AIRecognitionPromptConfigOption[],
): string | null {
  const text = normalizeGeneratedOptionalText(value, 80);
  if (!text) return null;
  const matched = findAIRecognitionConfigOption(options, text);
  return matched?.value ?? text;
}

function normalizeGeneratedDate(value: string | null | undefined, field: string, warnings: string[]): string | null {
  const text = stringValue(value);
  if (!text) return null;
  if (isValidDateOnly(text)) return text;
  warnings.push(`AI_WARNING_DATE_INVALID:${field}`);
  return null;
}

function normalizeGeneratedSuggestedField(value: AiGeneratedSubscriptionDraft["website"]): AiRecognizedSubscriptionDraft["website"] {
  if (!value) return null;
  const text = trimMax(value.value ?? "", 5000);
  if (!text) return null;
  return { value: text, source: value.source === "input" ? "input" : "suggested" };
}

function normalizeGeneratedNotesField(
  value: AiGeneratedSubscriptionDraft["notes"],
): AiRecognizedSubscriptionDraft["notes"] {
  if (!value || value.source === "none") return null;
  const text = value.source === "input"
    ? normalizeAIRecognitionGeneratedInputNotes(value.value)
    : normalizeAIRecognitionUsefulNotes(value.value);
  if (!text) return null;
  return { value: text, source: value.source === "input" ? "input" : "suggested" };
}

function normalizeGeneratedTags(tags: readonly string[], subscriptionName: string, existingTags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const existing = existingTagMap(existingTags);
  const serviceKey = tagMatchKey(subscriptionName);
  for (const tag of tags) {
    const value = trimMax(tag, 40);
    const key = tagMatchKey(value);
    if (!value || seen.has(key)) continue;
    const existingValue = existing.get(key);
    const nextValue = existingValue ?? value;
    if (!existingValue && !isUsefulGeneratedTag(value, key, serviceKey)) continue;
    // AI 生成标签只允许稳定复用维度；价格、套餐、机房等一次性属性不能污染用户长期筛选。
    seen.add(key);
    out.push(nextValue);
    if (out.length >= 3) break;
  }
  return out;
}

function existingTagMap(tags: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of tags) {
    const value = trimMax(tag, 40);
    const key = tagMatchKey(value);
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

function tagMatchKey(value: string): string {
  return configMatchKey(value);
}

function isUsefulGeneratedTag(value: string, key: string, serviceKey: string): boolean {
  if (!key || (serviceKey && key === serviceKey)) return false;
  const length = [...value.trim()].length;
  const lower = value.trim().toLowerCase();
  if (length < 2 || length > 20) return false;
  if (lower.includes("://") || lower.startsWith("www.") || ["#", "(", ")", "（", "）", "[", "]", "【", "】", "/", "\\", "|", ":", "："].some((separator) => value.includes(separator))) return false;
  if (/\p{Number}/u.test(value) || looksLikeBillingTag(lower) || looksLikeOrderAttributeTag(lower)) return false;
  if (isShortHanTag(value)) return false;
  return true;
}

function looksLikeBillingTag(value: string): boolean {
  return ["usd", "cny", "rmb", "eur", "gbp", "jpy", "¥", "￥", "$", "月", "年", "weekly", "monthly", "annual", "账单", "价格", "付款", "支付", "扣费", "续费"]
    .some((fragment) => value.includes(fragment));
}

function looksLikeOrderAttributeTag(value: string): boolean {
  return ["special", "promo", "promotion", "plan", "套餐", "促销", "机房", "节点", "区域", "地区", "线路", "location", "region", "datacenter"]
    .some((fragment) => value.includes(fragment));
}

function isShortHanTag(value: string): boolean {
  const chars = [...value.trim()];
  return chars.length > 0 && chars.length <= 2 && chars.every((char) => /\p{Script=Han}/u.test(char));
}

function parseGeneratedNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = stringValue(value).replace(/,/g, "");
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGeneratedInteger(value: number | string | null | undefined): number | null {
  const parsed = parseGeneratedNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function compactAIWarnings(warnings: readonly string[], maxCount: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const warning of warnings) {
    const value = trimMax(warning, 240);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= maxCount) break;
  }
  return out;
}

function trimMax(value: string, maxLength: number): string {
  return [...value.trim()].slice(0, maxLength).join("");
}

function stringValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function aiRecognitionConfigContext(rawConfig: unknown, locale: AppLocale, tags: readonly string[] = []): AIRecognitionPromptConfigContext {
  const parsed = customConfigSchema.safeParse(rawConfig);
  const config = parsed.success ? parsed.data : { categories: [], paymentMethods: [], statuses: [], currencies: [] };
  return {
    categories: config.categories.map((item) => aiRecognitionConfigOption(item, locale, calendarFeedBuiltInCategoryLabelKey)),
    paymentMethods: config.paymentMethods.map((item) => aiRecognitionConfigOption(item, locale, calendarFeedBuiltInPaymentMethodLabelKey)),
    tags,
  };
}

function aiRecognitionConfigOption(
  item: ApiCustomConfig["categories"][number],
  locale: AppLocale,
  builtInLabelKey: (value: string) => ServerI18nKey | undefined,
): AIRecognitionPromptConfigOption {
  return {
    value: item.value,
    label: localizedConfigLabel(item.labels, locale, builtInLabelKey(item.value)),
    zhCN: item.labels["zh-CN"],
    enUS: item.labels["en-US"],
  };
}

function findAIRecognitionConfigOption(
  options: readonly AIRecognitionPromptConfigOption[],
  text: string,
): AIRecognitionPromptConfigOption | null {
  const key = configMatchKey(text);
  if (!key) return null;
  return options.find((option) => (
    configMatchKey(option.value) === key
    || configMatchKey(option.label) === key
    || configMatchKey(option.zhCN) === key
    || configMatchKey(option.enUS) === key
  )) ?? null;
}

function configMatchKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-—–/\\|&+，,、.。:：()（）[\]【】]+/g, "");
}
