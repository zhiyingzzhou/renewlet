import { describe, expect, it } from "vitest";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { aiDraftToSubscriptionFormState, getInitialAIDraftConfirmationFields } from "./ai-recognition-form";

function draft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "DMIT",
    price: "15",
    currency: "CNY",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "hosting_domains",
    status: "active",
    paymentMethod: "alipay",
    startDate: "2026-06-01",
    nextBillingDate: "2026-07-01",
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://www.dmit.io/", source: "suggested" },
    notes: { value: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。", source: "suggested" },
    tags: ["VPS", "Hosting"],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

const context = {
  settings: { ...DEFAULT_SETTINGS, defaultCurrency: "USD", notificationReminderDays: 5 },
};

describe("AI recognition form mapping", () => {
  it("initializes every visible subscription field in the editable form state", () => {
    const formData = aiDraftToSubscriptionFormState(draft({
      price: "12.5",
      currency: null,
      billingCycle: "custom",
      customDays: 45,
      customCycleUnit: "day",
      status: "trial",
      paymentMethod: "crypto",
      autoCalculateNextBillingDate: false,
      trialEndDate: "2026-06-15",
      reminderDays: 11,
      repeatReminderEnabled: true,
      repeatReminderInterval: "6h",
      repeatReminderWindow: "48h",
    }), { settings: context.settings });

    expect(formData).toMatchObject({
      name: "DMIT",
      price: "12.5",
      currency: "USD",
      billingCycle: "custom",
      customDays: "45",
      customCycleUnit: "day",
      category: "hosting_domains",
      status: "trial",
      publicHidden: false,
      paymentMethod: "crypto",
      startDate: "2026-06-01",
      nextBillingDate: "2026-07-01",
      autoRenew: false,
      autoCalculate: false,
      reminderType: "inherit",
      reminderDays: "-1",
      customReminderDays: "",
      repeatReminderEnabled: false,
      repeatReminderInterval: "1h",
      repeatReminderWindow: "72h",
      costSharing: undefined,
      website: "https://www.dmit.io/",
      notes: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。",
      tags: ["VPS", "Hosting"],
    });
  });

  it("keeps one-time normalization in the reusable form model", () => {
    const term = aiDraftToSubscriptionFormState(draft({
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
    }), { settings: context.settings });
    const buyout = aiDraftToSubscriptionFormState(draft({
      billingCycle: "one-time",
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
    }), { settings: context.settings });

    expect(term).toMatchObject({ oneTimeMode: "term", oneTimeTermCount: "2", oneTimeTermUnit: "year", reminderType: "inherit" });
    expect(buyout).toMatchObject({ oneTimeMode: "buyout", reminderType: "disabled", reminderDays: "-2", repeatReminderEnabled: false });
  });

  it("infers active status for a fixed paid term that covers today", () => {
    const fixedTerm = draft({
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
      status: null,
      startDate: "2026-01-06",
      nextBillingDate: null,
    });

    expect(aiDraftToSubscriptionFormState(fixedTerm, { settings: context.settings })).toMatchObject({
      status: "active",
      nextBillingDate: "2028-01-06",
    });
    expect(getInitialAIDraftConfirmationFields(fixedTerm, DEFAULT_CUSTOM_CONFIG, context.settings.timezone)).not.toContain("status");
  });

  it("keeps future fixed terms and buyouts explicitly confirmable", () => {
    const futureTerm = draft({
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
      status: null,
      startDate: "2027-01-06",
      nextBillingDate: null,
    });
    const buyout = draft({
      billingCycle: "one-time",
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
      status: null,
      startDate: "2026-01-06",
      nextBillingDate: null,
    });
    const expiredTerm = draft({
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
      status: null,
      startDate: "2023-01-06",
      nextBillingDate: null,
    });

    expect(getInitialAIDraftConfirmationFields(futureTerm, DEFAULT_CUSTOM_CONFIG, context.settings.timezone)).toContain("status");
    expect(getInitialAIDraftConfirmationFields(buyout, DEFAULT_CUSTOM_CONFIG, context.settings.timezone)).toContain("status");
    expect(aiDraftToSubscriptionFormState(expiredTerm, { settings: context.settings }).status).toBe("expired");
    expect(getInitialAIDraftConfirmationFields(expiredTerm, DEFAULT_CUSTOM_CONFIG, context.settings.timezone)).not.toContain("status");
  });

  it("tracks model defaults that still require explicit user confirmation", () => {
    expect(getInitialAIDraftConfirmationFields(draft(), DEFAULT_CUSTOM_CONFIG)).toEqual([]);
    expect(getInitialAIDraftConfirmationFields(draft({
      price: null,
      currency: null,
      billingCycle: null,
    }), DEFAULT_CUSTOM_CONFIG)).toEqual(["price", "currency", "billingCycle"]);
    expect(getInitialAIDraftConfirmationFields(draft({ category: null }), DEFAULT_CUSTOM_CONFIG)).toContain("category");
    expect(getInitialAIDraftConfirmationFields(draft({ paymentMethod: null }), DEFAULT_CUSTOM_CONFIG)).toContain("paymentMethod");
  });
});
