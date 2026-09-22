import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_INDEX_LIMIT, subscriptionBulkPublicVisibilityRequestSchema as requestSchema, subscriptionBulkPublicVisibilityResponseSchema as responseSchema } from "./subscriptions";

describe("bulk public visibility boundary", () => {
  it("accepts the full collection limit and normalizes IDs without dropping selection intent", () => {
    const ids = Array.from({ length: SUBSCRIPTION_INDEX_LIMIT }, (_, i) => `subscription-${i}`);
    expect(requestSchema.parse({ selection: { ids }, publicHidden: true })).toEqual({ selection: { ids }, publicHidden: true, dryRun: false });
    expect(requestSchema.parse({ selection: { ids: [" x ", "x"] }, publicHidden: false }).selection).toEqual({ ids: ["x", "x"] });
    expect(requestSchema.parse({ selection: { categories: ["expired", "lifetime"] }, publicHidden: true, dryRun: true }).dryRun).toBe(true);
  });

  it.each([
    { ids: [] }, { ids: [""] }, { ids: [" "] }, { ids: ["x".repeat(81)] },
    { ids: Array(SUBSCRIPTION_INDEX_LIMIT + 1).fill("x") },
    { ids: null }, { categories: null }, { categories: [] }, { categories: ["paused"] },
    { categories: ["expired", "expired", "lifetime"] },
    { ids: ["x"], categories: [] }, { ids: ["x"], categories: null },
    { ids: null, categories: ["expired"] }, { ids: ["x"], unknown: true },
    {}, null,
  ])("rejects invalid or ambiguous selection %j", (selection) => {
    expect(requestSchema.safeParse({ selection, publicHidden: true }).success).toBe(false);
  });

  it.each([
    {}, { publicHidden: null }, { publicHidden: "true" },
    { publicHidden: true, dryRun: null }, { publicHidden: true, unknown: 1 },
  ])("rejects invalid flags %j", (flags) => {
    expect(requestSchema.safeParse({ selection: { ids: ["x"] }, ...flags }).success).toBe(false);
  });

  it("requires typed counts and failure IDs in the success envelope", () => {
    const data = { matchedCount: 2, changedCount: 1, skippedCount: 1, failedIds: ["missing"] };
    expect(responseSchema.parse({ ok: true, data }).data).toEqual(data);
    for (const patch of [{ changedCount: -1 }, { matchedCount: 1.5 }, { skippedCount: "1" }, { failedIds: [1] }, { unknown: 1 }]) {
      expect(responseSchema.safeParse({ ok: true, data: { ...data, ...patch } }).success).toBe(false);
    }
  });
});
