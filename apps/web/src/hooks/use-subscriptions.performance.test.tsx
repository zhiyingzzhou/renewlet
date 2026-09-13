import { Profiler, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { subscriptionPerformanceFixture } from "@renewlet/shared/contract-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionService, type SubscriptionPage } from "@/services/subscription-service";
import { subscriptionPerformanceCollectionItems } from "@/test/subscription-performance-fixture";
import { subscriptionsInfiniteQueryOptions, useInfiniteSubscriptions } from "./use-subscriptions";

const queryClients: QueryClient[] = [];
const queryKey = subscriptionsInfiniteQueryOptions().queryKey;

// Profiler 只观察真实 Hook 消费者；jsdom 的诊断耗时不与生产浏览器导航耗时混算。
function mountSubscriptions(total: number, reactStrictMode = false) {
  const page: SubscriptionPage = {
    subscriptions: subscriptionPerformanceCollectionItems(total).slice(0, subscriptionService.pageSize),
    nextCursor: total > subscriptionService.pageSize ? "next-page" : null,
    total,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  queryClient.setQueryData(queryKey, { pages: [page], pageParams: [null] });
  const commits: number[] = [];
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Profiler id="infinite-subscriptions" onRender={(_id, phase, duration) => {
          if (phase !== "mount") commits.push(duration);
        }}>
          {children}
        </Profiler>
      </QueryClientProvider>
    );
  }
  return { ...renderHook(() => useInfiniteSubscriptions(), { wrapper: Wrapper, reactStrictMode }), queryClient, page, commits };
}

beforeEach(() => {
  // 只驱动 Query 的零延迟通知，不跨过 staleTime，也不伪造 Profiler 使用的 performance 时钟。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
});

afterEach(() => {
  // 先卸载订阅再清缓存和定时器，防止上一样本的 observer 或 GC 通知污染下一组 commit。
  cleanup();
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(subscriptionPerformanceFixture.scenarios)("Query subscription work: $size", ({ size }) => {
  it("commits no consumer updates over ten unchanged background refreshes", async () => {
    const request = vi.spyOn(subscriptionService, "listPage");
    const { result, queryClient, page, commits } = mountSubscriptions(size);
    const visibleSubscriptions = result.current.subscriptions;
    const samples: { commits: number; actualDurationMs: number }[] = [];

    for (let sample = 0; sample < 10; sample += 1) {
      commits.length = 0;
      const complete = vi.fn<(value: SubscriptionPage) => void>();
      request.mockReturnValueOnce(new Promise<SubscriptionPage>((resolve) => complete.mockImplementation(resolve)));
      const refresh = queryClient.refetchQueries({ queryKey, exact: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(queryClient.isFetching({ queryKey })).toBe(1);
      expect(result.current.isPending).toBe(false);
      expect(result.current.subscriptions).toBe(visibleSubscriptions);
      expect(commits).toHaveLength(0);
      await act(async () => {
        // 模拟重新解析的相同响应，让 TanStack 自己做结构共享；直接返回缓存引用会掩盖这一边界。
        complete(structuredClone(page));
        await refresh;
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(queryClient.isFetching({ queryKey })).toBe(0);
      expect(result.current.subscriptions).toBe(visibleSubscriptions);
      expect(result.current.total).toBe(size);
      expect(result.current.hasNextPage).toBe(page.nextCursor !== null);
      expect(result.current.isFetchingNextPage).toBe(false);
      expect(result.current.error).toBeNull();
      expect(commits).toHaveLength(0);
      samples.push({ commits: commits.length, actualDurationMs: commits.reduce((sum, duration) => sum + duration, 0) });
    }

    expect(request).toHaveBeenCalledTimes(10);
    // 零更新只约束相同响应且分页状态不变的刷新；真实数据、错误和加载下一页仍必须通知页面。
    console.info(`[perf] query_subscription ${JSON.stringify({ size, loaded: page.subscriptions.length, samples })}`);
  });
});

it("keeps only the list contract and stable actions under StrictMode", async () => {
  const request = vi.spyOn(subscriptionService, "listPage");
  const { result, page, commits } = mountSubscriptions(10, true);
  const initial = result.current;
  expect(Object.keys(initial).sort()).toEqual([
    "subscriptions", "total", "isPending", "error", "hasNextPage", "isFetchingNextPage", "fetchNextPage", "refetch",
  ].sort());
  request.mockResolvedValueOnce(structuredClone(page));
  await act(async () => {
    await initial.refetch();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(commits).toHaveLength(0);
  expect(result.current.subscriptions).toBe(initial.subscriptions);
  expect(result.current.fetchNextPage).toBe(initial.fetchNextPage);
  expect(result.current.refetch).toBe(initial.refetch);
});

it("publishes next-page progress and appends the cursor result without replacing existing items", async () => {
  const complete = vi.fn<(value: SubscriptionPage) => void>();
  const request = vi.spyOn(subscriptionService, "listPage")
    .mockReturnValueOnce(new Promise<SubscriptionPage>((resolve) => complete.mockImplementation(resolve)));
  const { result, page } = mountSubscriptions(100);
  const visibleSubscriptions = result.current.subscriptions;
  const nextPage: SubscriptionPage = {
    subscriptions: subscriptionPerformanceCollectionItems(100).slice(subscriptionService.pageSize),
    nextCursor: null,
    total: 100,
  };
  const fetching = result.current.fetchNextPage();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  // 加载下一页仍是列表需要的局部反馈，不能与本轮移除的无关后台刷新订阅一起屏蔽。
  expect(result.current.isFetchingNextPage).toBe(true);
  expect(result.current.isPending).toBe(false);
  expect(result.current.subscriptions).toBe(visibleSubscriptions);
  expect(request).toHaveBeenCalledWith(page.nextCursor, subscriptionService.pageSize, undefined, expect.anything());
  await act(async () => {
    complete(nextPage);
    await fetching;
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.subscriptions).toEqual([...page.subscriptions, ...nextPage.subscriptions]);
  expect(result.current.subscriptions[0]).toBe(visibleSubscriptions[0]);
  expect(result.current.total).toBe(100);
  expect(result.current.hasNextPage).toBe(false);
  expect(result.current.isFetchingNextPage).toBe(false);
  expect(result.current.error).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it("still publishes changed data and background errors through the existing result", async () => {
  const request = vi.spyOn(subscriptionService, "listPage");
  const { result, queryClient, page } = mountSubscriptions(10);
  const changed: SubscriptionPage = {
    ...page,
    subscriptions: page.subscriptions.map((subscription) => ({ ...subscription, name: `${subscription.name} updated` })),
  };
  request.mockResolvedValueOnce(changed);
  await act(async () => {
    await queryClient.refetchQueries({ queryKey, exact: true });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.subscriptions).toEqual(changed.subscriptions);
  const lastSuccessfulData = result.current.subscriptions;
  const failure = new Error("background refresh failed");
  request.mockRejectedValueOnce(failure);
  await act(async () => {
    await queryClient.refetchQueries({ queryKey, exact: true });
    await vi.advanceTimersByTimeAsync(0);
  });
  // 后台错误必须可见，但不丢弃已提交内容；收窄订阅不能以吞错或退回首次 loading 换取较少 commit。
  expect(result.current.error).toBe(failure);
  expect(result.current.subscriptions).toBe(lastSuccessfulData);
  expect(result.current.isPending).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
});

it("releases the observer and ignores a late response after unmount", async () => {
  const complete = vi.fn<(value: SubscriptionPage) => void>();
  const request = vi.spyOn(subscriptionService, "listPage")
    .mockReturnValueOnce(new Promise<SubscriptionPage>((resolve) => complete.mockImplementation(resolve)));
  const { unmount, queryClient, page } = mountSubscriptions(10);
  const cached = queryClient.getQueryData(queryKey);
  const refresh = queryClient.refetchQueries({ queryKey, exact: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const signal = request.mock.calls[0]?.[3];
  expect(signal?.aborted).toBe(false);
  unmount();
  // Hook 已将 signal 交给 service；最后一个 observer 离开后的取消仍由 Query 所有，不另建取消状态。
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    complete({ ...page, subscriptions: [], total: 0 });
    await refresh;
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(queryClient.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(0);
  expect(queryClient.getQueryData(queryKey)).toBe(cached);
});
