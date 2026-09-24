import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionFacets } from "@/services/subscription-service";
import type { SettingsReadState } from "./settings-read-state";
import { usePublicStatusPageSettingsController } from "./use-public-status-page-settings-controller";

const mocks = vi.hoisted(() => ({
  status: {
    data: { enabled: true, pageUrl: "https://example.com/status/token", showPrices: false, hideExpired: false, hideLifetime: false },
    error: null as Error | null,
    isFetched: true,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  create: { isPending: false, mutateAsync: vi.fn() },
  update: { isPending: false, mutateAsync: vi.fn() },
  remove: { isPending: false, mutateAsync: vi.fn() },
  bulkMutateAsync: vi.fn(),
  t: vi.fn((key: string) => key),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-public-status-page", () => ({
  usePublicStatusPageStatus: () => mocks.status,
  useCreatePublicStatusPage: () => mocks.create,
  useUpdatePublicStatusPage: () => mocks.update,
  useDeletePublicStatusPage: () => mocks.remove,
}));

vi.mock("@/hooks/use-bulk-public-visibility", () => ({
  // 每次渲染返回新的 observer 外壳，模拟 TanStack mutation 状态更新；mutateAsync 本身保持稳定。
  useBulkPublicVisibility: () => ({ mutateAsync: mocks.bulkMutateAsync }),
}));

vi.mock("@/components/ui/sonner", () => ({ toast: mocks.toast }));
vi.mock("@/i18n/I18nProvider", () => ({ useI18n: () => ({ t: mocks.t }) }));

const facets: SettingsReadState<SubscriptionFacets> = {
  data: {
    total: 2,
    categoryCounts: {},
    tags: [],
    visibleCount: 2,
    hiddenCount: 0,
    expiredCount: 1,
    lifetimeCount: 1,
  },
  hasData: true,
  error: null,
  isInitialLoading: false,
  isRefreshing: false,
  retry: vi.fn().mockResolvedValue(undefined),
};

describe("usePublicStatusPageSettingsController bulk visibility", () => {
  beforeEach(() => {
    mocks.bulkMutateAsync.mockReset().mockResolvedValue({
      matchedCount: 1,
      changedCount: 1,
      skippedCount: 0,
      failedIds: [],
    });
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
  });

  it("keeps the preview command stable when the mutation observer rerenders", async () => {
    const { result, rerender } = renderHook(() => usePublicStatusPageSettingsController(facets));
    const initialCommand = result.current.bulkPublicVisibility;

    rerender();

    expect(result.current.bulkPublicVisibility).toBe(initialCommand);
    await act(async () => {
      await result.current.bulkPublicVisibility(["expired"], true, true);
    });
    expect(mocks.bulkMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.bulkMutateAsync).toHaveBeenCalledWith({
      selection: { categories: ["expired"] },
      publicHidden: true,
      dryRun: true,
    });
  });
});
