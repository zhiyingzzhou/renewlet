import { importPayloadSchema, type ImportSubscription } from "@/lib/api/schemas/import-export";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { toSubscriptionFormSubmission } from "@/lib/subscription-form";
import {
  IMPORT_MESSAGE_CODES,
  importMessage,
  makeConfigItem,
  mergeConfigItem,
  normalizeWebsite,
  stableHash,
  type PreparedImport,
} from "@/modules/import-export/domain/import-export-model";
import {
  normalizeAIRecognitionGeneratedInputNotes,
  normalizeAIRecognitionInputNotes,
  normalizeAIRecognitionUsefulNotes,
} from "@renewlet/shared/ai-recognition-notes";
import type { ConfigItem, CustomConfig } from "@/types/config";
import type { SubscriptionFormState } from "@/types/subscription-form";
import type { AIDraftConfirmationField } from "./ai-recognition-form";

interface AIImportContext {
  config: CustomConfig;
}

export interface AIImportDraft {
  sourceDraft: AiRecognizedSubscriptionDraft;
  formData: SubscriptionFormState;
  pendingConfirmationFields: readonly AIDraftConfirmationField[];
}

interface AIImportBuildState extends AIImportContext {
  warnings: string[];
  sourceIdCounts: Map<string, number>;
}

/** AI 识别元数据保持不可变，用户补充的全部订阅字段只从 formData 进入标准导入契约。 */
export function buildPreparedImportFromAIDrafts(
  drafts: readonly AIImportDraft[],
  context: AIImportContext,
): PreparedImport {
  const state: AIImportBuildState = {
    config: context.config,
    warnings: [],
    sourceIdCounts: new Map(),
  };
  const subscriptions = drafts.map((draft) => buildAIImportSubscription(draft, state));
  return {
    payload: importPayloadSchema.parse({
      source: "ai",
      subscriptions,
      customConfig: state.config,
    }),
    assets: [],
    warnings: state.warnings,
  };
}

function buildAIImportSubscription(item: AIImportDraft, state: AIImportBuildState): ImportSubscription {
  const { sourceDraft, formData } = item;
  const submission = toSubscriptionFormSubmission(formData);
  if (!submission) throw new Error("AI_RECOGNITION_DRAFT_INVALID");

  // sourceDraft 的 warning 只记录模型当时的识别证据；标准导入提示必须从用户已确认的当前表单重新计算。
  const warnings: string[] = [];
  const websiteWarnings: string[] = [];
  const website = normalizeWebsite(formData.website, websiteWarnings);
  const websiteSource = editedWebsiteSource(formData.website, sourceDraft.website);
  const notesSource = editedTextSource(formData.notes, sourceDraft.notes);
  const notesWasEdited = sourceDraft.notes?.value !== formData.notes.trim();
  const notes = notesSource === "input"
    ? (notesWasEdited
      ? normalizeAIRecognitionInputNotes(formData.notes)
      : normalizeAIRecognitionGeneratedInputNotes(formData.notes))
    : normalizeAIRecognitionUsefulNotes(formData.notes);
  warnings.push(...websiteWarnings);
  if (websiteSource === "suggested" && website) warnings.push(IMPORT_MESSAGE_CODES.aiWebsiteSuggested);
  pushPreparedWarnings(state, formData.name, warnings);

  const pendingConfirmationFields = item.pendingConfirmationFields;
  const category = resolveConfigValue("category", formData.category, state, !pendingConfirmationFields.includes("category")) ?? "other";
  const paymentMethod = resolveConfigValue("payment", formData.paymentMethod || null, state, !pendingConfirmationFields.includes("paymentMethod"));
  ensureCurrency(formData.currency, state);

  return {
    name: submission.name,
    logo: submission.logo ?? null,
    price: submission.price,
    currency: submission.currency,
    balance: submission.balance,
    balanceCurrency: submission.balanceCurrency,
    billingCycle: submission.billingCycle,
    customDays: submission.billingCycle === "custom" ? submission.customDays : null,
    customCycleUnit: submission.billingCycle === "custom" ? submission.customCycleUnit : null,
    oneTimeTermCount: submission.billingCycle === "one-time" ? submission.oneTimeTermCount ?? null : null,
    oneTimeTermUnit: submission.billingCycle === "one-time" ? submission.oneTimeTermUnit ?? null : null,
    category,
    status: submission.status,
    pinned: false,
    publicHidden: submission.publicHidden,
    paymentMethod,
    startDate: submission.startDate,
    nextBillingDate: submission.nextBillingDate,
    autoRenew: submission.billingCycle === "one-time" ? false : submission.autoRenew,
    autoCalculateNextBillingDate: submission.autoCalculateNextBillingDate,
    // 试用结束日是不可编辑的识别事实；普通表单不拥有该字段，只有 AI import 能从原始草稿写入。
    trialEndDate: submission.status === "trial" ? sourceDraft.trialEndDate : null,
    website: website ?? null,
    notes,
    tags: submission.tags,
    reminderDays: submission.reminderDays,
    repeatReminderEnabled: submission.repeatReminderEnabled,
    repeatReminderInterval: submission.repeatReminderInterval,
    repeatReminderWindow: submission.repeatReminderWindow,
    costSharing: submission.costSharing ?? null,
    extra: {
      import: {
        source: "ai",
        sourceId: nextAISourceId(formData, state),
        confidence: sourceDraft.confidence,
      },
      ai: {
        ...(website && websiteSource ? { websiteSource } : {}),
        ...(notes && notesSource ? { notesSource } : {}),
      },
    },
  };
}

function editedWebsiteSource(
  value: string,
  source: AiRecognizedSubscriptionDraft["website"],
): "input" | "suggested" | null {
  // 只有原样保留的建议值才能继承 suggested 来源；用户改写后必须降为 input，避免继续展示过期的 AI 建议提示。
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!source) return "input";
  const normalizedSource = normalizeWebsite(source.value, []) ?? source.value;
  return normalizedSource === trimmed ? source.source : "input";
}

function editedTextSource(
  value: string,
  source: AiRecognizedSubscriptionDraft["notes"],
): "input" | "suggested" | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return source?.value === trimmed ? source.source : "input";
}

function ensureCurrency(value: string, state: AIImportBuildState): void {
  const currency = value.trim().toUpperCase();
  state.config = {
    ...state.config,
    currencies: mergeConfigItem(state.config.currencies, { ...makeConfigItem(currency, currency), enabled: true }),
  };
}

function resolveConfigValue(kind: "category" | "payment", value: string | null, state: AIImportBuildState, allowCreate: boolean): string | null {
  const items = kind === "category" ? state.config.categories : state.config.paymentMethods;
  const fallback = kind === "category"
    ? items.find((item) => configMatchKey(item.value) === "other")?.value ?? items[0]?.value ?? "other"
    : null;
  const text = value?.trim();
  if (!text) return fallback;
  const matched = findConfigItem(items, text);
  if (matched) return matched.value;
  // 未知配置只有在草稿待确认项已被用户消费后才允许进入 customConfig，避免模型建议污染用户配置。
  if (!allowCreate || (kind === "category" && configMatchKey(text) === "other")) return fallback;
  const nextValue = `${kind === "category" ? "category" : "payment"}_${stableHash(text)}`;
  const configItem = makeConfigItem(nextValue, text);
  state.config = kind === "category"
    ? { ...state.config, categories: mergeConfigItem(state.config.categories, configItem) }
    : { ...state.config, paymentMethods: mergeConfigItem(state.config.paymentMethods, configItem) };
  return nextValue;
}

function findConfigItem(items: readonly ConfigItem[], text: string): ConfigItem | null {
  const normalized = configMatchKey(text);
  return items.find((item) => (
    configMatchKey(item.value) === normalized
    || configMatchKey(item.labels["zh-CN"]) === normalized
    || configMatchKey(item.labels["en-US"]) === normalized
  )) ?? null;
}

function configMatchKey(value: string | undefined): string {
  // AI 可能输出中英文、全角标点或用户自定义标签原文；匹配只压缩书写差异，不翻译或猜测业务含义。
  return value
    ? value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-—–/\\|&+，,、.。:：()（）[\]【】]+/g, "")
    : "";
}

function nextAISourceId(formData: SubscriptionFormState, state: AIImportBuildState): string {
  // 幂等键只描述可识别的订阅身份；家庭成员、公开开关等私人配置不得因用户补录而改变 sourceId。
  const hash = stableHash(JSON.stringify({
    name: formData.name,
    price: formData.price,
    currency: formData.currency,
    billingCycle: formData.billingCycle,
    website: formData.website,
  }));
  const count = (state.sourceIdCounts.get(hash) ?? 0) + 1;
  state.sourceIdCounts.set(hash, count);
  // 同批近似订阅追加稳定序号，避免互相覆盖，同时不扩大身份字段集合。
  return count === 1 ? hash : `${hash}-${count}`;
}

function pushPreparedWarnings(state: AIImportBuildState, name: string, warnings: readonly string[]): void {
  for (const warning of warnings) {
    state.warnings.push(importMessage("IMPORT_WARNING_FOR_SUBSCRIPTION", name, warning));
  }
}
