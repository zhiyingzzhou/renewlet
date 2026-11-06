import { describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { translate } from "@/i18n/messages";
import { IMPORT_MESSAGE_CODES } from "@/modules/import-export/domain/import-export-model";
import { formatImportMessage, groupAIRecognitionWarnings } from "@/modules/import-export/domain/import-message-format";
import { aiDraftToSubscriptionFormState } from "./ai-recognition-form";
import { buildPreparedImportFromAIDrafts, type AIImportDraft } from "./ai-recognition-import";

const context = {
  config: DEFAULT_CUSTOM_CONFIG,
};

function draft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "Netflix",
    price: "9.99",
    currency: "USD",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: null,
    status: "active",
    paymentMethod: null,
    startDate: "2026-06-01",
    nextBillingDate: "2026-07-01",
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://netflix.com", source: "input" },
    notes: null,
    tags: [],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

function item(
  sourceDraft: AiRecognizedSubscriptionDraft = draft(),
  formOverrides: Partial<AIImportDraft["formData"]> = {},
  pendingConfirmationFields: AIImportDraft["pendingConfirmationFields"] = [],
): AIImportDraft {
  return {
    sourceDraft,
    formData: {
      ...aiDraftToSubscriptionFormState(sourceDraft, {
        settings: { ...DEFAULT_SETTINGS, defaultCurrency: "USD", notificationReminderDays: 5 },
      }),
      ...formOverrides,
    },
    pendingConfirmationFields,
  };
}

describe("AI recognition import mapping", () => {
  it("builds the standard import payload from editable form state", () => {
    const prepared = buildPreparedImportFromAIDrafts([item(draft(), {
      autoRenew: true,
      publicHidden: true,
    })], context);
    const subscription = prepared.payload.subscriptions[0];

    expect(prepared.payload.source).toBe("ai");
    expect(subscription?.extra.import).toMatchObject({ source: "ai", confidence: "high" });
    expect(subscription?.website).toBe("https://netflix.com/");
    expect(subscription?.reminderDays).toBe(-1);
    expect(subscription?.autoRenew).toBe(true);
    expect(subscription?.publicHidden).toBe(true);
    expect(prepared.assets).toEqual([]);
  });

  it("only includes balances explicitly entered in the manual editor", () => {
    expect(buildPreparedImportFromAIDrafts([item()], context).payload.subscriptions[0]?.balance).toBeUndefined();
    const subscription = buildPreparedImportFromAIDrafts([item(draft(), {
      balanceEnabled: true, balance: "0.000001", balanceCurrency: "EUR",
    })], context).payload.subscriptions[0];
    expect(subscription).toMatchObject({ balance: "0.000001", balanceCurrency: "EUR" });
  });

  it("keeps the immutable AI trial date outside the editable form state", () => {
    const subscription = buildPreparedImportFromAIDrafts([item(draft({
      status: "trial",
      trialEndDate: "2026-06-10",
    }))], context).payload.subscriptions[0];

    expect(subscription?.trialEndDate).toBe("2026-06-10");
  });

  it("clears an AI trial date when the editable status is no longer trial", () => {
    const subscription = buildPreparedImportFromAIDrafts([item(draft({
      status: "trial",
      trialEndDate: "2026-06-10",
    }), {
      status: "active",
    })], context).payload.subscriptions[0];

    expect(subscription?.trialEndDate).toBeNull();
  });

  it("carries equal and custom family-sharing members into preview", () => {
    const equal = buildPreparedImportFromAIDrafts([item(draft(), {
      costSharing: {
        enabled: true,
        splitMode: "equal",
        collectionReminder: { enabled: true, reminderDays: -1 },
        members: [{ id: "family", name: "家人", currency: "CNY", joinedDate: assertDateOnly("2026-06-01") }],
      },
    })], context).payload.subscriptions[0];
    const custom = buildPreparedImportFromAIDrafts([item(draft(), {
      costSharing: {
        enabled: true,
        splitMode: "custom",
        collectionReminder: { enabled: true, reminderDays: 2 },
        members: [{ id: "friend", name: "朋友", currency: "USD", customAmount: "3.33", joinedDate: assertDateOnly("2026-06-15") }],
      },
    })], context).payload.subscriptions[0];

    expect(equal?.costSharing).toEqual({
      enabled: true,
      splitMode: "equal",
      collectionReminder: { enabled: true, reminderDays: -1 },
      members: [{ id: "family", name: "家人", currency: "CNY", joinedDate: "2026-06-01" }],
    });
    expect(custom?.costSharing).toEqual({
      enabled: true,
      splitMode: "custom",
      collectionReminder: { enabled: true, reminderDays: 2 },
      members: [{ id: "friend", name: "朋友", currency: "USD", customAmount: "3.33", joinedDate: "2026-06-15" }],
    });
  });

  it("keeps private form fields out of the AI source id", () => {
    const first = buildPreparedImportFromAIDrafts([item(draft(), {
      autoRenew: false,
      publicHidden: false,
      costSharing: {
        enabled: true,
        splitMode: "equal",
        members: [{ id: "one", name: "成员 A" }],
      },
    })], context).payload.subscriptions[0]?.extra.import.sourceId;
    const second = buildPreparedImportFromAIDrafts([item(draft(), {
      autoRenew: true,
      publicHidden: true,
      costSharing: {
        enabled: true,
        splitMode: "custom",
        members: [{ id: "two", name: "成员 B", currency: "USD", customAmount: "2" }],
      },
    })], context).payload.subscriptions[0]?.extra.import.sourceId;

    expect(second).toBe(first);
  });

  it("normalizes one-time subscriptions through the standard form conversion", () => {
    const sourceDraft = draft({
      billingCycle: "one-time",
      startDate: "2026-06-01",
      nextBillingDate: null,
      autoCalculateNextBillingDate: false,
    });
    const subscription = buildPreparedImportFromAIDrafts([item(sourceDraft, {
      autoRenew: true,
      reminderType: "inherit",
      reminderDays: "-1",
      repeatReminderEnabled: true,
    })], context).payload.subscriptions[0];

    expect(subscription).toMatchObject({
      nextBillingDate: "2026-06-01",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
      reminderDays: -2,
      repeatReminderEnabled: false,
    });
  });

  it("keeps historical AI warnings out of the current import result", () => {
    const sourceDraft = draft({
      price: null,
      currency: null,
      billingCycle: null,
      startDate: null,
      nextBillingDate: "2026-07-01",
      autoCalculateNextBillingDate: false,
      warnings: ["AI_WARNING_PRICE_INVALID", "AI_WARNING_BILLING_CYCLE_INVALID"],
    });
    const sourceSnapshot = structuredClone(sourceDraft);
    const prepared = buildPreparedImportFromAIDrafts([item(sourceDraft, { price: "0" })], context);

    expect(prepared.payload.subscriptions[0]).toMatchObject({
      price: "0",
      currency: "USD",
      billingCycle: "monthly",
      startDate: null,
      nextBillingDate: "2026-07-01",
    });
    expect(prepared.warnings).toEqual([]);
    expect(sourceDraft).toEqual(sourceSnapshot);
  });

  it("uses the corrected 730-day cycle without carrying the model's invalid-cycle warning", () => {
    const sourceDraft = draft({
      billingCycle: "custom",
      customDays: null,
      customCycleUnit: null,
      warnings: ["AI_WARNING_CUSTOM_DAYS_INVALID", "AI_WARNING_CUSTOM_CYCLE_UNIT_INVALID"],
    });
    const prepared = buildPreparedImportFromAIDrafts([item(sourceDraft, {
      customDays: "730",
      customCycleUnit: "day",
    })], context);

    expect(prepared.payload.subscriptions[0]).toMatchObject({
      billingCycle: "custom",
      customDays: 730,
      customCycleUnit: "day",
    });
    expect(prepared.warnings).toEqual([]);
  });

  it("keeps useful suggested notes and source metadata", () => {
    const sourceDraft = draft({
      website: { value: "spotify.com", source: "suggested" },
      notes: { value: "Spotify 是音乐和播客流媒体服务。", source: "suggested" },
    });
    const prepared = buildPreparedImportFromAIDrafts([item(sourceDraft)], context);

    expect(prepared.payload.subscriptions[0]?.website).toBe("https://spotify.com/");
    expect(prepared.payload.subscriptions[0]?.notes).toBe("Spotify 是音乐和播客流媒体服务。");
    expect(prepared.payload.subscriptions[0]?.extra["ai"]).toEqual({
      websiteSource: "suggested",
      notesSource: "suggested",
    });
    expect(prepared.warnings).toContain(`IMPORT_WARNING_FOR_SUBSCRIPTION|Netflix|${IMPORT_MESSAGE_CODES.aiWebsiteSuggested}`);
  });

  it("does not persist inferred input fragments as notes", () => {
    const sourceDraft = draft({
      notes: { value: "HKG Tier1 - 1C1G - NetBird节点/Docker测试 NOTE: read the Terms first.", source: "input" },
    });
    const prepared = buildPreparedImportFromAIDrafts([item(sourceDraft)], context);

    expect(prepared.payload.subscriptions[0]?.notes).toBeNull();
    expect(prepared.payload.subscriptions[0]?.extra["ai"]).toEqual({ websiteSource: "input" });
  });

  it("does not persist unknown category or payment method before confirmation", () => {
    const sourceDraft = draft({ category: "Cloud lab", paymentMethod: "Personal card" });
    const pending = ["category", "paymentMethod"] as const;
    const unconfirmed = buildPreparedImportFromAIDrafts([item(sourceDraft, {}, pending)], context);

    expect(unconfirmed.payload.subscriptions[0]).toMatchObject({ category: "other", paymentMethod: null });
    expect(unconfirmed.payload.customConfig?.categories.some((entry) => entry.labels["zh-CN"] === "Cloud lab")).toBe(false);
    expect(unconfirmed.payload.customConfig?.paymentMethods.some((entry) => entry.labels["zh-CN"] === "Personal card")).toBe(false);

    const confirmed = buildPreparedImportFromAIDrafts([item(sourceDraft)], context);
    expect(confirmed.payload.customConfig?.categories.some((entry) => entry.labels["zh-CN"] === "Cloud lab")).toBe(true);
    expect(confirmed.payload.customConfig?.paymentMethods.some((entry) => entry.labels["zh-CN"] === "Personal card")).toBe(true);
  });

  it("drops process notes and removes Renewlet-facing advice", () => {
    const processDraft = draft({
      notes: { value: "输入没有提供官网或更多上下文，AI 未能高置信识别该服务。", source: "suggested" },
    });
    const usefulDraft = draft({
      notes: { value: "LOCVPS 提供 VPS、云服务器和服务器托管相关服务，适合记录主机或服务器套餐订阅。", source: "suggested" },
    });

    expect(buildPreparedImportFromAIDrafts([item(processDraft)], context).payload.subscriptions[0]?.notes).toBeNull();
    expect(buildPreparedImportFromAIDrafts([item(usefulDraft)], context).payload.subscriptions[0]?.notes)
      .toBe("LOCVPS 提供 VPS、云服务器和服务器托管服务");
  });

  it("formats AI provider warnings into localized review text", () => {
    const formatted = formatImportMessage(
      "IMPORT_WARNING_FOR_SUBSCRIPTION|Apple|AI_WARNING_SERVICE_UNSPECIFIED",
      (key, params) => translate("zh-CN", key, params),
    );
    expect(formatted).toBe("Apple：输入没有明确具体服务，AI 已按品牌生成基础信息，请确认是否正确。");
  });

  it("groups recognition warnings by the action the user needs to take", () => {
    expect(groupAIRecognitionWarnings([
      "AI_WARNING_PRICE_UNCERTAIN",
      "AI_WARNING_CONFIG_SUGGESTED",
      "AI_WARNING_BATCH_PARTIAL",
      "AI_WARNING_DATE_INVALID:startDate",
    ]).map((entry) => entry.group)).toEqual(["missing-facts", "suggestions", "batch", "format"]);
  });

  it("matches existing config values and creates only unknown options", () => {
    const matched = buildPreparedImportFromAIDrafts([item(draft({
      currency: "EUR",
      category: "Streaming",
      paymentMethod: "Crypto",
    }))], context);
    const created = buildPreparedImportFromAIDrafts([item(draft({
      category: "Streaming AI",
      paymentMethod: "Virtual Card",
    }), {}, [])], context);

    expect(matched.payload.subscriptions[0]).toMatchObject({ category: "streaming", paymentMethod: "crypto" });
    expect(matched.payload.customConfig?.currencies.some((configItem) => configItem.value === "EUR" && configItem.enabled)).toBe(true);
    expect(created.payload.customConfig?.categories.some((configItem) => configItem.labels["zh-CN"] === "Streaming AI")).toBe(true);
    expect(created.payload.customConfig?.paymentMethods.some((configItem) => configItem.labels["zh-CN"] === "Virtual Card")).toBe(true);
  });
});
