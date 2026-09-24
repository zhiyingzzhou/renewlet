import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  preloadInitialRoute,
  preloadRoute,
  routeFallbackForPathname,
} from "./route-resources";

const mocks = vi.hoisted(() => ({
  dashboardModuleLoads: 0,
  adminUsersModuleLoads: 0,
  privateShellModuleLoads: 0,
  readProductSession: vi.fn(),
  fetchSubscriptionPage: vi.fn(async (_pageParam?: string | null) => ({ subscriptions: [], nextCursor: null, total: 0 })),
  fetchSubscriptionAnalytics: vi.fn(async () => []),
  fetchSubscriptionFacets: vi.fn(async () => ({ categories: [], tags: [], categoryCounts: {}, visibleCount: 0, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 })),
  fetchSettings: vi.fn(async () => ({ defaultCurrency: "CNY" })),
}));

vi.mock("@/components/private-app-shell", () => {
  mocks.privateShellModuleLoads += 1;
  return { default: () => null };
});
vi.mock("@/pages/dashboard", () => {
  mocks.dashboardModuleLoads += 1;
  return { default: () => null };
});
vi.mock("@/pages/subscriptions", () => ({ default: () => null }));
vi.mock("@/pages/calendar", () => ({ default: () => null }));
vi.mock("@/pages/statistics", () => ({ default: () => null }));
vi.mock("@/pages/settings", () => ({ default: () => null }));
vi.mock("@/pages/setup", () => ({ default: () => null }));
vi.mock("@/pages/login", () => ({ default: () => null }));
vi.mock("@/pages/privacy", () => ({ default: () => null }));
vi.mock("@/pages/terms", () => ({ default: () => null }));
vi.mock("@/pages/public-status", () => ({ default: () => null }));
vi.mock("@/pages/admin/users", () => {
  mocks.adminUsersModuleLoads += 1;
  return { default: () => null };
});
vi.mock("@/pages/forgot-password", () => ({ default: () => null }));
vi.mock("@/pages/reset-password", () => ({ default: () => null }));
vi.mock("@/pages/not-found", () => ({ default: () => null }));

vi.mock("@/services/product-session", () => ({
  readProductSession: mocks.readProductSession,
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  subscriptionsInfiniteQueryOptions: () => ({
    queryKey: ["subscriptions", "collections", "page", {}],
    initialPageParam: null,
    queryFn: ({ pageParam }: { pageParam: string | null }) => mocks.fetchSubscriptionPage(pageParam),
    getNextPageParam: () => undefined,
    staleTime: 60_000,
  }),
  subscriptionAnalyticsQueryOptions: () => ({
    queryKey: ["subscriptions", "collections", "analytics"],
    queryFn: mocks.fetchSubscriptionAnalytics,
    staleTime: 60_000,
  }),
  subscriptionFacetsQueryOptions: () => ({
    queryKey: ["subscriptions", "collections", "facets"],
    queryFn: mocks.fetchSubscriptionFacets,
    staleTime: 60_000,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  settingsQueryOptions: () => ({
    queryKey: ["settings"],
    queryFn: mocks.fetchSettings,
    staleTime: Infinity,
  }),
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

describe("route resources", () => {
  beforeEach(() => {
    mocks.readProductSession.mockReset();
    mocks.fetchSubscriptionPage.mockClear();
    mocks.fetchSubscriptionAnalytics.mockClear();
    mocks.fetchSubscriptionFacets.mockClear();
    mocks.fetchSettings.mockClear();
  });

  it("dedupes concurrent route preloads and prefetches route data once", async () => {
    mocks.readProductSession.mockReturnValue({
      session: { expiresAt: "2026-07-01T00:00:00.000Z" },
      user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "admin", banned: false },
    });
    const queryClient = createQueryClient();

    await Promise.all([
      preloadRoute("/", queryClient),
      preloadRoute("/", queryClient),
    ]);

    expect(mocks.dashboardModuleLoads).toBe(1);
    expect(mocks.privateShellModuleLoads).toBe(1);
    expect(mocks.fetchSubscriptionAnalytics).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSubscriptionFacets).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1);
  });

  it("loads the route module without prefetching private data when no session exists", async () => {
    mocks.readProductSession.mockReturnValue(null);
    const queryClient = createQueryClient();

    await preloadRoute("/statistics", queryClient);

    expect(mocks.fetchSubscriptionPage).not.toHaveBeenCalled();
    expect(mocks.fetchSubscriptionAnalytics).not.toHaveBeenCalled();
    expect(mocks.fetchSubscriptionFacets).not.toHaveBeenCalled();
    expect(mocks.fetchSettings).not.toHaveBeenCalled();
  });

  it("does not warm private initial-route modules without a product session", async () => {
    mocks.readProductSession.mockReturnValue(null);

    await preloadInitialRoute("/admin/users", createQueryClient());

    expect(mocks.adminUsersModuleLoads).toBe(0);
    expect(mocks.fetchSettings).not.toHaveBeenCalled();
  });

  it("keeps the initial private route preload alive as the owner of settings", async () => {
    mocks.readProductSession.mockReturnValue({
      session: { expiresAt: "2026-07-01T00:00:00.000Z" },
      user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "admin", banned: false },
    });

    await preloadInitialRoute("/admin/users", createQueryClient());

    expect(mocks.adminUsersModuleLoads).toBe(1);
    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1);
  });

  it("returns the route-specific skeleton from the shared registry", () => {
    render(routeFallbackForPathname("/settings"));

    expect(screen.getByTestId("settings-page-skeleton")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("dashboard-page-skeleton")).not.toBeInTheDocument();
  });
});
