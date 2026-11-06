import { describe, expect, it } from "vitest";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { aiDraftToSubscriptionFormState, getInitialAIDraftConfirmationFields } from "./ai-recognition-form";
import { getAIDraftBlockingIssues, hasAIDraftBlockingIssues } from "./ai-draft-preflight";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";

function draft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "Service",
    price: "12",
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
    website: null,
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

function input(sourceDraft: AiRecognizedSubscriptionDraft) {
  return {
    formData: aiDraftToSubscriptionFormState(sourceDraft, {
      settings: DEFAULT_SETTINGS,
    }),
    pendingConfirmationFields: getInitialAIDraftConfirmationFields(sourceDraft, DEFAULT_CUSTOM_CONFIG),
  };
}

describe("AI draft preflight", () => {
  it("does not block complete form states", () => {
    const complete = input(draft({ category: "other", paymentMethod: "alipay" }));
    expect(getAIDraftBlockingIssues(complete)).toEqual([]);
    expect(hasAIDraftBlockingIssues(complete)).toBe(false);
  });

  it("layers unconfirmed model defaults before common validation and deduplicates fields", () => {
    expect(getAIDraftBlockingIssues(input(draft({
      price: null,
      currency: null,
      billingCycle: null,
      startDate: null,
      nextBillingDate: null,
    }))).map((issue) => issue.code)).toEqual([
      "aiPriceUnconfirmed",
      "aiCurrencyUnconfirmed",
      "aiBillingCycleUnconfirmed",
      "aiCategoryUnconfirmed",
      "aiPaymentMethodUnconfirmed",
      "startDateRequiredForAutoCalculate",
    ]);
  });

  it("derives custom-cycle and date issues from common subscription validation", () => {
    expect(getAIDraftBlockingIssues(input(draft({
      billingCycle: "custom",
      customDays: null,
      customCycleUnit: "day",
    }))).map((issue) => issue.code)).toEqual([
      "aiCategoryUnconfirmed",
      "aiPaymentMethodUnconfirmed",
      "customCycleInvalid",
    ]);

    expect(getAIDraftBlockingIssues(input(draft({
      startDate: null,
      nextBillingDate: null,
      autoCalculateNextBillingDate: true,
    }))).map((issue) => issue.code)).toEqual([
      "aiCategoryUnconfirmed",
      "aiPaymentMethodUnconfirmed",
      "startDateRequiredForAutoCalculate",
    ]);
  });

  it("requires a purchase date for one-time subscriptions", () => {
    expect(getAIDraftBlockingIssues(input(draft({
      billingCycle: "one-time",
      startDate: null,
      nextBillingDate: null,
      autoCalculateNextBillingDate: false,
    }))).map((issue) => issue.code)).toEqual([
      "aiCategoryUnconfirmed",
      "aiPaymentMethodUnconfirmed",
      "purchaseDateRequired",
    ]);
  });
});
