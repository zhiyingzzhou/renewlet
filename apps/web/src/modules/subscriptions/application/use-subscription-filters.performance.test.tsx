import { act, renderHook } from "@testing-library/react";
import { subscriptionPerformanceFixture } from "@renewlet/shared/contract-fixtures";
import { describe, expect, it, vi } from "vitest";
import { subscriptionService } from "@/services/subscription-service";
import { subscriptionPerformanceCollectionItems, subscriptionPerformanceItems } from "@/test/subscription-performance-fixture";
import * as filtersDomain from "../domain/subscription-filters";
import { useSubscriptionFilters } from "./use-subscription-filters";

const filterOptions = { today: "2026-09-07", defaultCurrency: "CNY" };

describe.each(subscriptionPerformanceFixture.scenarios)("subscription sorting work: $size", ({ size }) => {
  it("sorts only the selected index and performs no eager page work over ten samples", () => {
    const subscriptions = subscriptionPerformanceCollectionItems(size);
    const page = subscriptions.slice(0, subscriptionService.pageSize);
    // spy 透传真实领域函数，只记录入参规模；不重写排序，也不把 Hook 契约测试冒充整页主线程归因。
    const sort = vi.spyOn(filtersDomain, "sortSubscriptions");
    const samples: { eagerRows: number[]; displayRows: number[]; elapsedMs: number }[] = [];

    for (let sample = 0; sample < 10; sample += 1) {
      const { result, unmount } = renderHook(() => useSubscriptionFilters(filterOptions));
      expect(result.current.needsCollectionIndex).toBe(false);
      act(() => result.current.setSortOption("name_asc"));
      expect(result.current.needsCollectionIndex).toBe(true);
      sort.mockClear();

      const startedAt = performance.now();
      act(() => result.current.setSortOption("monthly_cost_asc"));
      const eagerRows = sort.mock.calls.map(([items]) => items.length);
      expect(eagerRows).toEqual([]);
      sort.mockClear();
      const displayed = result.current.sortSubscriptionsForDisplay(subscriptions);
      const elapsedMs = performance.now() - startedAt;
      const displayRows = sort.mock.calls.map(([items]) => items.length);
      expect(displayed).toHaveLength(size);
      expect(new Set(displayed.map(({ id }) => id))).toEqual(new Set(subscriptions.map(({ id }) => id)));
      expect(displayRows).toEqual([size]);
      samples.push({ eagerRows, displayRows, elapsedMs });
      unmount();
    }

    // 与归档的优化前样本对照工作量，不保留旧运行时接口来制造第二套实现。
    console.info(`[perf] subscription_sort ${JSON.stringify({ size, loaded: page.length, samples })}`);
  });

  it("keeps export selection on complete detail data rather than the loaded page", () => {
    const subscriptions = subscriptionPerformanceItems(size);
    const target = subscriptions.at(-1);
    if (!target) throw new Error("shared performance fixture must not be empty");
    const page = subscriptions.slice(0, subscriptionService.pageSize);
    const { result } = renderHook(() => useSubscriptionFilters(filterOptions));
    act(() => result.current.setSearchQuery(target.name));

    // 导出接收完整详情，而不是分页或轻量索引；本断言只覆盖稳定后的搜索，不能冒充 deferred 中间态验证。
    expect(result.current.selectSubscriptionsForExport(subscriptions)).toEqual([target]);
    if (size > subscriptionService.pageSize) {
      expect(result.current.selectSubscriptionsForExport(page)).toEqual([]);
    }
  });
});
