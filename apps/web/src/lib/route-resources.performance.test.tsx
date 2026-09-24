import { subscriptionPerformanceFixture } from "@renewlet/shared/contract-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preloadRoute } from "./route-resources";

const mocks = vi.hoisted(() => ({
  loadedPrivateRoutes: [] as string[],
  privateShellModuleLoads: 0,
  readProductSession: vi.fn(),
  fetchSubscriptionPage: vi.fn(async () => ({ subscriptions: [], nextCursor: null, total: 0 })),
  fetchSubscriptionFacets: vi.fn(async () => ({ categories: [], tags: [], categoryCounts: {}, visibleCount: 0, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 })),
  fetchSettings: vi.fn(async () => ({ defaultCurrency: "CNY" })),
}));

vi.mock("@/components/private-app-shell", () => {
  mocks.privateShellModuleLoads += 1;
  return { default: () => null };
});
vi.mock("@/pages/dashboard", () => {
  mocks.loadedPrivateRoutes.push("/");
  return { default: () => null };
});
vi.mock("@/pages/subscriptions", () => {
  mocks.loadedPrivateRoutes.push("/subscriptions");
  return { default: () => null };
});
vi.mock("@/pages/calendar", () => {
  mocks.loadedPrivateRoutes.push("/calendar");
  return { default: () => null };
});
vi.mock("@/pages/statistics", () => {
  mocks.loadedPrivateRoutes.push("/statistics");
  return { default: () => null };
});
vi.mock("@/pages/settings", () => {
  mocks.loadedPrivateRoutes.push("/settings");
  return { default: () => null };
});
vi.mock("@/pages/setup", () => ({ default: () => null }));
vi.mock("@/pages/login", () => ({ default: () => null }));
vi.mock("@/pages/privacy", () => ({ default: () => null }));
vi.mock("@/pages/terms", () => ({ default: () => null }));
vi.mock("@/pages/public-status", () => ({ default: () => null }));
vi.mock("@/pages/admin/users", () => ({ default: () => null }));
vi.mock("@/pages/forgot-password", () => ({ default: () => null }));
vi.mock("@/pages/reset-password", () => ({ default: () => null }));
vi.mock("@/pages/not-found", () => ({ default: () => null }));

vi.mock("@/services/product-session", () => ({ readProductSession: mocks.readProductSession }));

vi.mock("@/hooks/use-subscriptions", () => ({
  subscriptionsInfiniteQueryOptions: () => ({
    queryKey: ["subscriptions", "collections", "page", {}],
    initialPageParam: null,
    queryFn: mocks.fetchSubscriptionPage,
    getNextPageParam: () => undefined,
    staleTime: 60_000,
  }),
  subscriptionFacetsQueryOptions: () => ({
    queryKey: ["subscriptions", "collections", "facets"],
    queryFn: mocks.fetchSubscriptionFacets,
    staleTime: 60_000,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  settingsQueryOptions: () => ({ queryKey: ["settings"], queryFn: mocks.fetchSettings, staleTime: Infinity }),
}));

describe("authenticated route preload performance budget", () => {
  beforeEach(() => {
    mocks.loadedPrivateRoutes.length = 0;
    mocks.fetchSubscriptionPage.mockClear();
    mocks.fetchSubscriptionFacets.mockClear();
    mocks.fetchSettings.mockClear();
    mocks.readProductSession.mockReturnValue({ user: { id: "subscription-perf-owner" } });
  });

  it("loads no private route while idle and keeps a single intent-driven collection cache", async () => {
    const budget = subscriptionPerformanceFixture.webBudget;
    const requestIdleCallback = vi.fn();
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: requestIdleCallback });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const startedAt = performance.now();

    await Promise.resolve();
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(mocks.loadedPrivateRoutes).toHaveLength(budget.authenticatedIdleRoutePreloads);

    await preloadRoute("/subscriptions", queryClient);
    expect(mocks.loadedPrivateRoutes).toEqual(["/subscriptions"]);
    expect(mocks.privateShellModuleLoads).toBe(1);
    expect(mocks.fetchSubscriptionPage).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSubscriptionFacets).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1);
    expect(
      mocks.fetchSubscriptionPage.mock.calls.length
      + mocks.fetchSubscriptionFacets.mock.calls.length
      + mocks.fetchSettings.mock.calls.length,
    ).toBe(budget.dataRequests);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["subscriptions", "collections"] }))
      .toHaveLength(budget.subscriptionCollectionCacheEntries);
    console.info(`[perf] web intent_preload elapsed_ms=${(performance.now() - startedAt).toFixed(2)}`);

    queryClient.clear();
  });
});
