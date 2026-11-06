// CRUD 控制器测试保护页面级快捷动作语义，避免字段级操作退回完整订阅快照 PATCH。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type {
  Subscription,
  SubscriptionCollectionItem,
  SubscriptionFormSubmission,
} from "@/types/subscription";
import { useSubscriptionCrud } from "./use-subscription-crud";

const mocks = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  patchMutate: vi.fn(),
  renewMutateAsync: vi.fn(),
  deleteMutate: vi.fn(),
  prefetchDetail: vi.fn(),
  detailById: new Map<string, Subscription>(),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  prefetchSubscriptionDetail: mocks.prefetchDetail,
  useCreateSubscription: () => ({ mutateAsync: mocks.createMutate }),
  useUpdateSubscription: () => ({ mutateAsync: mocks.updateMutate }),
  usePatchSubscription: () => ({ mutate: mocks.patchMutate }),
  useRenewSubscription: () => ({
    mutateAsync: mocks.renewMutateAsync,
    reset: vi.fn(),
    error: null,
    isPending: false,
  }),
  useDeleteSubscription: () => ({ mutate: mocks.deleteMutate }),
  useSubscriptionDetail: (id: string | null) => ({
    data: id === null ? undefined : mocks.detailById.get(id),
    error: null,
    isPending: false,
  }),
}));

function formSubmission(): SubscriptionFormSubmission {
  return {
    name: "Codex Pro",
    logo: undefined,
    price: "20",
    currency: "USD",
    billingCycle: "monthly",
    category: "productivity",
    status: "active",
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
  };
}

function subscription(): Subscription {
  return {
    ...formSubmission(),
    id: "sub-1",
    pinned: false,
    trialEndDate: undefined,
    extra: {},
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper: Wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detailById.clear();
});

describe("useSubscriptionCrud", () => {
  it("builds create and update commands from form submissions", () => {
    const { wrapper } = createWrapper();
    const submission = formSubmission();
    const { result } = renderHook(() => useSubscriptionCrud([subscription()]), { wrapper });

    act(() => {
      result.current.handleAddSubscription(submission);
      result.current.handleEditSubscription("sub-1");
    });
    act(() => {
      result.current.handleSaveSubscription(submission);
    });

    expect(mocks.createMutate).toHaveBeenCalledWith({ ...submission, pinned: false });
    expect(mocks.updateMutate).toHaveBeenCalledWith({ id: "sub-1", changes: submission });
  });

  it("prefetches the complete detail model on interaction intent", () => {
    const { queryClient, wrapper } = createWrapper();
    const { result } = renderHook(() => useSubscriptionCrud([subscription()]), { wrapper });

    act(() => {
      result.current.handlePrefetchSubscription("sub-1");
    });

    expect(mocks.prefetchDetail).toHaveBeenCalledWith(queryClient, "sub-1");
  });

  it("keeps collection previews with edit, clone, and renew sessions", () => {
    const { wrapper } = createWrapper();
    const collectionItem = subscription();
    const { result } = renderHook(() => useSubscriptionCrud([collectionItem]), { wrapper });

    act(() => {
      result.current.handleEditSubscription(collectionItem.id);
      result.current.handleCloneSubscription(collectionItem.id);
      result.current.handleRenewSubscription(collectionItem.id);
    });

    expect(result.current.editingCollectionItem).toBe(collectionItem);
    expect(result.current.cloningCollectionItem).toBe(collectionItem);
    expect(result.current.renewingCollectionItem).toBe(collectionItem);
  });

  it("keeps intent previews when the collection changes during open sessions", () => {
    const { wrapper } = createWrapper();
    const collectionItem = subscription();
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly SubscriptionCollectionItem[] }) => useSubscriptionCrud(items),
      {
        initialProps: { items: [collectionItem] },
        wrapper,
      },
    );

    act(() => {
      result.current.handleEditSubscription(collectionItem.id);
      result.current.handleCloneSubscription(collectionItem.id);
      result.current.handleRenewSubscription(collectionItem.id);
    });
    rerender({ items: [] });

    expect(result.current.editingCollectionItem).toBe(collectionItem);
    expect(result.current.cloningCollectionItem).toBe(collectionItem);
    expect(result.current.renewingCollectionItem).toBe(collectionItem);
  });

  it("uses field-level patch mutations for card quick actions", () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSubscriptionCrud([subscription()]), { wrapper });

    act(() => {
      result.current.handleTogglePinnedSubscription("sub-1");
      result.current.handleTogglePublicHiddenSubscription("sub-1");
    });

    expect(mocks.patchMutate).toHaveBeenNthCalledWith(1, { id: "sub-1", patch: { pinned: true } });
    expect(mocks.patchMutate).toHaveBeenNthCalledWith(2, { id: "sub-1", patch: { publicHidden: true } });
    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(result.current).not.toHaveProperty("setEditDialogOpen");
  });
});
