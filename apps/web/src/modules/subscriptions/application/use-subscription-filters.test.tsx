import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moneyToNumber } from "@renewlet/shared/money";
import { subscriptionPerformanceCollectionItems, subscriptionPerformanceItems } from "@/test/subscription-performance-fixture";
import * as domain from "../domain/subscription-filters";
import { useSubscriptionFilters } from "./use-subscription-filters";

const options = {
  today: "2026-09-07", defaultCurrency: "CNY", locale: "zh-CN" as const,
  convert: (amount: number | string, from: string, to: string) => moneyToNumber(amount) * (from === to ? 1 : 7),
};

afterEach(() => vi.restoreAllMocks());

describe("subscription filtering ownership", () => {
  it.each(domain.SUBSCRIPTION_SORT_OPTIONS)("preserves %s ordering for both page and index input without mutating either", (sortOption) => {
    const index = subscriptionPerformanceCollectionItems(100);
    const page = index.slice(0, 50);
    const before = structuredClone(index);
    const { result } = renderHook(() => useSubscriptionFilters(options), { reactStrictMode: true });
    act(() => result.current.setSortOption(sortOption));

    for (const items of [page, index]) {
      expect(result.current.sortSubscriptionsForDisplay(items)).toEqual(domain.sortSubscriptions(items, { ...options, sortOption }));
    }
    expect(index).toEqual(before);
    expect(result.current.needsCollectionIndex).toBe(sortOption !== "default");
    expect(result.current).not.toHaveProperty("filteredSubscriptions");
  });

  it("keeps stable ties in the selected input order", () => {
    const originals = subscriptionPerformanceCollectionItems(10);
    const first = originals[0];
    if (!first) throw new Error("Expected a nonempty shared fixture");
    const items = originals.map(({ id }) => ({ ...first, id, name: "same" })).reverse();
    const { result } = renderHook(() => useSubscriptionFilters(options));
    act(() => result.current.setSortOption("name_asc"));
    expect(result.current.sortSubscriptionsForDisplay(items).map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it("does no sorting when filter state changes before a display source is selected", () => {
    const sort = vi.spyOn(domain, "sortSubscriptions");
    const { result } = renderHook(() => useSubscriptionFilters(options));
    act(() => {
      result.current.setSearchQuery("subscription");
      result.current.setSelectedTags(["priority"]);
      result.current.setSortOption("monthly_cost_desc");
    });
    expect(sort).not.toHaveBeenCalled();
  });

  it("exports the immediate input even while the committed list still has deferred filters", () => {
    const subscriptions = subscriptionPerformanceItems(100);
    const target = subscriptions.at(-1);
    if (!target) throw new Error("Expected a nonempty shared fixture");
    const observations: { input: string; query: string | undefined; exported: string[] }[] = [];
    const { result } = renderHook(() => {
      const filters = useSubscriptionFilters(options);
      // 观察真实 commit 中 urgent/deferred 的差异，不 mock React 调度或用延时猜测中间态。
      useLayoutEffect(() => {
        observations.push({ input: filters.searchQuery, query: filters.subscriptionListFilters?.q,
          exported: filters.selectSubscriptionsForExport(subscriptions).map((item) => item.id) });
      });
      return filters;
    });
    act(() => result.current.setSearchQuery(target.name));
    expect(observations).toContainEqual({ input: target.name, query: undefined, exported: [target.id] });
    expect(result.current.subscriptionListFilters?.q).toBe(target.name);
    expect(result.current.selectSubscriptionsForExport(subscriptions.slice(0, 50))).toEqual([]);
  });

  it("applies combined controls to complete export details and clears filters without resetting sort", () => {
    const subscriptions = subscriptionPerformanceItems(100);
    const target = subscriptions.filter((item) => item.status === "paused").at(-1);
    if (!target) throw new Error("Expected a nonempty shared fixture");
    const { result } = renderHook(() => useSubscriptionFilters(options));
    act(() => {
      result.current.setSearchQuery(target.name);
      result.current.setSelectedCategories([target.category]);
      result.current.setStatusFilter(target.status);
      result.current.setSelectedTags(target.tags);
      result.current.setAdvancedFilters({ ...domain.DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS, selectedCurrencies: [target.currency] });
      result.current.setSortOption("price_desc");
    });
    expect(result.current.selectSubscriptionsForExport(subscriptions)).toEqual([target]);
    act(() => result.current.clearFilters());
    expect(result.current.hasActiveFilters).toBe(false);
    expect(result.current.subscriptionListFilters).toBeUndefined();
    expect(result.current.sortOption).toBe("price_desc");
    expect(result.current.selectSubscriptionsForExport(subscriptions)).toEqual(domain.sortSubscriptions(subscriptions, { ...options, sortOption: "price_desc" }));
  });
});
