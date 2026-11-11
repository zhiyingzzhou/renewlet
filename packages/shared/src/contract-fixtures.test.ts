// 契约 fixture smoke test 确保 JSON 先经过 shared schema，再被 Go/Worker/前端测试消费。
import { describe, expect, it } from "vitest";
import {
  notificationScheduleFixtures,
  aiRecognitionNormalizationFixtures,
  outboundUrlPolicyFixtures,
  subscriptionCollectionContractFixture,
  subscriptionNormalizationFixtures,
  subscriptionPerformanceFixture,
} from "./contract-fixtures";
import { SUBSCRIPTION_INDEX_LIMIT } from "./schemas/subscriptions";

describe("contract fixtures", () => {
  it("loads notification schedule fixtures", () => {
    expect(notificationScheduleFixtures.length).toBeGreaterThan(0);
  });

  it("loads subscription normalization fixtures", () => {
    expect(subscriptionNormalizationFixtures.length).toBeGreaterThan(0);
  });

  it("loads AI recognition normalization fixtures", () => {
    expect(aiRecognitionNormalizationFixtures.length).toBeGreaterThan(0);
  });

  it("loads outbound URL policy fixtures", () => {
    expect(outboundUrlPolicyFixtures.length).toBeGreaterThan(0);
  });

  it("loads subscription performance fixtures", () => {
    expect(subscriptionPerformanceFixture.scenarios.map(({ size }) => size)).toEqual([10, 100, 1000, 5000]);
  });

  it("loads the subscription collection boundary fixture", () => {
    expect(subscriptionCollectionContractFixture.collectionLimit).toBe(SUBSCRIPTION_INDEX_LIMIT);
    expect(subscriptionCollectionContractFixture.detailOnlyFields).not.toContain("name");
    expect(subscriptionCollectionContractFixture.collectionItems.map((item) => [
      item.billingCycle,
      item.oneTimeTermCount ?? null,
      item.autoCalculateNextBillingDate,
    ])).toEqual([
      ["monthly", null, true],
      ["custom", null, true],
      ["one-time", null, false],
      ["one-time", 6, false],
    ]);
  });
});
