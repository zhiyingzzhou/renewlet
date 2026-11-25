import { subscriptionCollectionContractFixture } from "@renewlet/shared/contract-fixtures";
import { describe, expect, it } from "vitest";
import { fromApiSubscriptionCollectionItem } from "@/services/subscription-service";
import { buildSubscriptionGridRows } from "./subscription-grid-rows";

const template = fromApiSubscriptionCollectionItem(subscriptionCollectionContractFixture.collectionItems[0]);

describe("buildSubscriptionGridRows", () => {
  it.each([1, 2, 3] as const)("keeps 5000 subscriptions in category order across %i-column rows", (columns) => {
    const categories = ["legacy-z", "finance", "legacy-a", "productivity"];
    const items = Array.from({ length: 5000 }, (_, index) => ({
      ...template, id: String(index), category: categories[index % categories.length]!,
    }));
    const rows = buildSubscriptionGridRows(items, columns, ["productivity", "unused", "finance"]);
    const expectedOrder = ["productivity", "finance", "legacy-a", "legacy-z"];
    const expectedRows = expectedOrder.flatMap((category) => {
      const ids = items.filter((item) => item.category === category).map((item) => item.id);
      const cards: string[][] = [];
      for (let start = 0; start < ids.length; start += columns) cards.push(ids.slice(start, start + columns));
      return [[category, ids.length], ...cards];
    });
    expect(rows.map((row) => row.kind === "heading" ? [row.category, row.count] : row.items.map((item) => item.id)))
      .toEqual(expectedRows);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("removes an emptied group when a subscription changes category", () => {
    const items = [{ ...template, id: "first", category: "finance" }, { ...template, id: "last", category: "music" }];
    const order = ["music", "finance"];
    expect(buildSubscriptionGridRows(items, 3, order).filter((row) => row.kind === "heading")).toHaveLength(2);
    const moved = items.map((item) => ({ ...item, category: "finance" }));
    expect(buildSubscriptionGridRows(moved, 3, order)).toMatchObject([
      { kind: "heading", category: "finance", count: 2 },
      { kind: "cards", items: [{ id: "first" }, { id: "last" }] },
    ]);
  });
});
