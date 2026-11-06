import { describe, expect, it } from "vitest";
import {
  aiRecognitionNormalizationFixtures,
  type AIRecognitionNormalizationFixture,
} from "@renewlet/shared/contract-fixtures";
import type {
  AiGeneratedRecognizeObject,
  AiRecognitionDiagnostics,
} from "@renewlet/shared/schemas/ai-recognition";
import type { AIRecognitionPromptConfigContext } from "@renewlet/shared/ai-recognition-prompt";
import { normalizeGeneratedAIRecognizeObject } from "./ai-recognition-normalize";

function fixtureDiagnostics(): AiRecognitionDiagnostics {
  return {
    schemaVersion: "1",
    promptVersion: "fixture",
    schemaName: "renewlet_ai_subscription_recognition",
    prompt: {
      system: { value: "fixture", truncated: false },
      user: { value: "fixture", truncated: false },
    },
    output: {
      rawModelText: null,
      rawObjectJson: null,
    },
    request: {
      providerType: "openai",
      transportProtocol: "openai-responses",
      model: "gpt-5.1",
      thinkingControl: null,
      maxOutputTokens: 1024,
      textCharCount: 0,
      images: [],
    },
    response: {
      usage: null,
      finishReason: null,
      providerMetadata: null,
    },
  };
}

function normalizeFixture(fixture: AIRecognitionNormalizationFixture) {
  const response = normalizeGeneratedAIRecognizeObject(
    fixture.input as unknown as AiGeneratedRecognizeObject,
    "openai",
    "openai-responses",
    "gpt-5.1",
    fixtureDiagnostics(),
    fixture.config as unknown as AIRecognitionPromptConfigContext,
  );
  return {
    providerType: response.providerType,
    transportProtocol: response.transportProtocol,
    model: response.model,
    subscriptions: response.subscriptions,
    warnings: response.warnings,
  };
}

describe("AI recognition normalization fixtures", () => {
  it.each(aiRecognitionNormalizationFixtures)("matches $name", (fixture) => {
    expect(normalizeFixture(fixture)).toEqual(fixture.expected);
  });

  it("drops inferred input fragments and billing-field summaries", () => {
    const response = normalizeGeneratedAIRecognizeObject({
      subscriptions: [{
        name: "LAX Pro",
        price: "36.9",
        currency: "USD",
        billingCycle: "annual",
        customDays: null,
        customCycleUnit: null,
        oneTimeTermCount: null,
        oneTimeTermUnit: null,
        category: null,
        status: null,
        paymentMethod: null,
        startDate: null,
        nextBillingDate: null,
        autoCalculateNextBillingDate: false,
        trialEndDate: null,
        website: null,
        notes: { value: "HKG Tier1 - 1C1G - NetBird节点/Docker测试", source: "input" },
        tags: [],
        reminderDays: null,
        repeatReminderEnabled: null,
        repeatReminderInterval: null,
        repeatReminderWindow: null,
        confidence: "high",
        warnings: [],
      }],
      warnings: [],
    }, "openai", "openai-responses", "gpt-5.1", fixtureDiagnostics(), { categories: [], paymentMethods: [], tags: [] });

    expect(response.subscriptions[0]?.notes).toBeNull();

    const billingOnly = normalizeGeneratedAIRecognizeObject({
      subscriptions: [{
        name: "DMIT",
        price: "159.88",
        currency: "USD",
        billingCycle: "one-time",
        customDays: null,
        customCycleUnit: null,
        oneTimeTermCount: "730天",
        oneTimeTermUnit: "天",
        category: null,
        status: null,
        paymentMethod: null,
        startDate: "2026-01-06",
        nextBillingDate: null,
        autoCalculateNextBillingDate: false,
        trialEndDate: null,
        website: null,
        notes: { value: "DMIT-w4vnZS2F21 - Debian 12 x64 - 2026-01-06至2028-01-05 - $159.88 USD", source: "input" },
        tags: [],
        reminderDays: null,
        repeatReminderEnabled: null,
        repeatReminderInterval: null,
        repeatReminderWindow: null,
        confidence: "high",
        warnings: [],
      }],
      warnings: [],
    }, "openai", "openai-responses", "gpt-5.1", fixtureDiagnostics(), { categories: [], paymentMethods: [], tags: [] });
    expect(billingOnly.subscriptions[0]?.notes).toBeNull();
  });

  it("infers fixed-term status from the purchase date and term when the model omits an end date", () => {
    const response = normalizeGeneratedAIRecognizeObject({
      subscriptions: [{
        name: "DMIT",
        price: "159.88",
        currency: "USD",
        billingCycle: "one-time",
        customDays: null,
        customCycleUnit: null,
        oneTimeTermCount: 2,
        oneTimeTermUnit: "year",
        category: null,
        status: null,
        paymentMethod: null,
        startDate: "2026-01-06",
        nextBillingDate: null,
        autoCalculateNextBillingDate: false,
        trialEndDate: null,
        website: null,
        notes: { value: "DMIT 提供 VPS、云服务器和网络线路服务。", source: "suggested" },
        tags: [],
        reminderDays: null,
        repeatReminderEnabled: null,
        repeatReminderInterval: null,
        repeatReminderWindow: null,
        confidence: "high",
        warnings: [],
      }],
      warnings: ["AI_WARNING_STATUS_UNCERTAIN"],
    }, "openai", "openai-responses", "gpt-5.1", fixtureDiagnostics(), { categories: [], paymentMethods: [], tags: [] }, "2026-11-05");

    expect(response.subscriptions[0]?.status).toBe("active");
    expect(response.subscriptions[0]?.nextBillingDate).toBe("2028-01-06");
    expect(response.subscriptions[0]?.warnings).not.toContain("AI_WARNING_STATUS_UNCERTAIN");
    expect(response.warnings).not.toContain("AI_WARNING_STATUS_UNCERTAIN");
  });
});
