import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { DEFAULT_SETTINGS, type Subscription } from "@/types/subscription";
import { appSettingsSecretStatus } from "@renewlet/shared/schemas/settings";
import type { SubscriptionListFilters } from "@/services/subscription-service";
import type { SettingsReadModel } from "@/services/settings-service";
import {
  subscriptionFacetsQueryFixture,
  subscriptionIndexQueryFixture,
} from "./subscriptions.test-fixtures";
import Subscriptions from "./subscriptions";

interface MockInfiniteSubscriptionsResult {
  subscriptions?: Subscription[];
  isPending: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => void;
}
type MockSettingsEnvelopeResult = { data?: SettingsReadModel };
type MockSubscriptionIndexResult = ReturnType<typeof subscriptionIndexQueryFixture>;
type MockSubscriptionFacetsResult = ReturnType<typeof subscriptionFacetsQueryFixture>;

const cloneSource = vi.hoisted<{ value: Subscription | null }>(() => ({
  value: null,
}));

const mocks = vi.hoisted(() => ({
  useInfiniteSubscriptions: vi.fn<() => MockInfiniteSubscriptionsResult>(),
  useSubscriptionIndex: vi.fn<(filters?: SubscriptionListFilters) => MockSubscriptionIndexResult>(),
  useSubscriptionFacets: vi.fn<() => MockSubscriptionFacetsResult>(),
  useSettingsEnvelope: vi.fn<() => MockSettingsEnvelopeResult>(),
  handleAddSubscription: vi.fn(),
  handleDeleteSubscription: vi.fn(),
  handleEditSubscription: vi.fn(),
  handleCloneSubscription: vi.fn(),
  handleTogglePinnedSubscription: vi.fn(),
  handleTogglePublicHiddenSubscription: vi.fn(),
  handleRenewSubscription: vi.fn(),
  handleSaveSubscription: vi.fn(),
  handleSaveClonedSubscription: vi.fn(),
  handleEditDialogOpenChange: vi.fn(),
  handleCloneDialogOpenChange: vi.fn(),
  cloneDialogOpen: false,
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  prefetchSubscriptionDetail: vi.fn(),
  useInfiniteSubscriptions: mocks.useInfiniteSubscriptions,
  useSubscriptionIndex: mocks.useSubscriptionIndex,
  useSubscriptionFacets: mocks.useSubscriptionFacets,
  useSubscriptionDetail: () => ({ data: undefined, error: null, isPending: false }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettingsEnvelope: mocks.useSettingsEnvelope,
  useSettings: () => {
    const envelope = mocks.useSettingsEnvelope();
    return { ...envelope, data: envelope.data?.settings };
  },
}));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: () => ({
    convert: (amount: number) => amount,
    loading: false,
    sourceDate: "2026-08-01",
  }),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: (query: string) => query.includes("min-width"),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: [],
      statuses: [],
      paymentMethods: [],
      currencies: [],
    },
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: () => ({
    editingSubscription: undefined,
    editDialogOpen: false,
    cloningSubscription: cloneSource.value,
    cloneDialogOpen: mocks.cloneDialogOpen,
    handleAddSubscription: mocks.handleAddSubscription,
    handleDeleteSubscription: mocks.handleDeleteSubscription,
    handleCloneSubscription: mocks.handleCloneSubscription,
    handleEditSubscription: mocks.handleEditSubscription,
    handleTogglePinnedSubscription: mocks.handleTogglePinnedSubscription,
    handleTogglePublicHiddenSubscription: mocks.handleTogglePublicHiddenSubscription,
    handleRenewSubscription: mocks.handleRenewSubscription,
    handleSaveSubscription: mocks.handleSaveSubscription,
    handleSaveClonedSubscription: mocks.handleSaveClonedSubscription,
    handleEditDialogOpenChange: mocks.handleEditDialogOpenChange,
    handleCloneDialogOpenChange: mocks.handleCloneDialogOpenChange,
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-export", () => ({
  useSubscriptionExport: () => ({
    exportToJSON: vi.fn(),
    exportToJSONWithSecrets: vi.fn(),
    exportToCSV: vi.fn(),
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-filters", () => ({
  useSubscriptionFilters: () => ({
    searchQuery: "",
    setSearchQuery: vi.fn(),
    selectedCategories: [],
    setSelectedCategories: vi.fn(),
    statusFilter: "all",
    setStatusFilter: vi.fn(),
    paymentTypeFilter: "all",
    setPaymentTypeFilter: vi.fn(),
    sortOption: "default",
    setSortOption: vi.fn(),
    selectedTags: [],
    setSelectedTags: vi.fn(),
    advancedFilters: {
      selectedBillingCycles: [],
      selectedPaymentMethods: [],
      selectedCurrencies: [],
      nextBillingFrom: "",
      nextBillingTo: "",
      pinnedFilter: "all",
      publicHiddenFilter: "all",
      reminderModeFilter: "all",
      repeatReminderFilter: "all",
    },
    setAdvancedFilters: vi.fn(),
    allTags: [],
    sortSubscriptionsForDisplay: (items: Subscription[]) => items,
    subscriptionListFilters: undefined,
    hasActiveFilters: false,
    hasActiveAdvancedFilters: false,
    hasCustomSort: false,
    needsCollectionIndex: false,
    toggleCategory: vi.fn(),
    clearSelectedCategories: vi.fn(),
    toggleTag: vi.fn(),
    clearFilters: vi.fn(),
  }),
}));

vi.mock("@/components/ui/virtualized-list", () => ({
  VirtualizedList: ({
    count,
    renderItem,
    testId,
  }: {
    count: number;
    renderItem: (index: number, virtualItem: { index: number }) => ReactNode;
    testId?: string;
  }) => (
    <div data-testid={testId}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>{renderItem(index, { index })}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/components/back-to-top-float-button", () => ({
  BackToTopFloatButton: () => null,
}));

vi.mock("@/components/subscription-category-filter", () => ({
  SubscriptionCategoryFilter: () => null,
}));

vi.mock("@/components/subscription-tag-filter-drawer", () => ({
  SelectedTagScroller: () => null,
  SubscriptionTagFilterDrawer: () => null,
  SubscriptionTagFilterPopover: () => null,
}));

vi.mock("@/components/subscription-card", () => ({
  SubscriptionCard: ({
    subscription,
    onClone,
  }: {
    subscription: Subscription;
    onClone?: (id: string) => void;
  }) => (
    <article data-testid="subscription-card">
      <button type="button" onClick={() => onClone?.(subscription.id)}>
        复制 {subscription.name}
      </button>
    </article>
  ),
}));

vi.mock("@/components/subscription-dialog", () => ({
  SubscriptionDialog: ({
    open,
    mode,
    initialSubscription,
  }: {
    open: boolean;
    mode: "create" | "edit";
    initialSubscription?: Subscription | null;
  }) => (
    <div data-testid="clone-dialog-state" data-mode={mode}>
      {open ? initialSubscription?.name ?? "no-source" : "closed"}
    </div>
  ),
}));

vi.mock("@/components/subscription-detail-dialog", () => ({
  SubscriptionDetailDialog: () => null,
}));

vi.mock("@/components/add-subscription-dialog", () => ({
  AddSubscriptionDialog: ({ trigger }: { trigger?: ReactNode }) => trigger ?? null,
}));

vi.mock("@/components/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: () => null,
}));

vi.mock("@/components/import-data-dialog", () => ({
  ImportDataDialogContent: () => null,
}));

vi.mock("@/components/ai-recognize-subscription-dialog", () => ({
  AIRecognizeSubscriptionDialogContent: () => null,
}));

function subscription(overrides: SubscriptionFixtureOverrides<Subscription> = {}): Subscription {
  return {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "USD",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    startDate: assertDateOnly("2026-01-01"),
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

function renderSubscriptionsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <div id="root">
      <QueryClientProvider client={queryClient}>
        <Subscriptions />
      </QueryClientProvider>
    </div>,
  );
}

beforeEach(() => {
  cloneSource.value = null;
  mocks.cloneDialogOpen = false;
  mocks.useSettingsEnvelope.mockReturnValue({
    data: {
      settings: DEFAULT_SETTINGS,
      secretStatus: appSettingsSecretStatus(DEFAULT_SETTINGS),
    },
  });
  mocks.useSubscriptionIndex.mockImplementation((filters) =>
    subscriptionIndexQueryFixture(mocks.useInfiniteSubscriptions().subscriptions ?? [], filters));
  mocks.useSubscriptionFacets.mockImplementation(() =>
    subscriptionFacetsQueryFixture(mocks.useInfiniteSubscriptions().subscriptions ?? []));
  mocks.useInfiniteSubscriptions.mockReturnValue({
    subscriptions: [subscription({ id: "copyable", name: "Copyable Service" })],
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
});

describe("Subscriptions page clone wiring", () => {
  it("wires subscription card clone actions to the CRUD controller", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    await user.click(screen.getByRole("button", { name: "复制 Copyable Service" }));

    expect(mocks.handleCloneSubscription).toHaveBeenCalledWith("copyable");
  });

  it("renders the clone create dialog with the selected subscription snapshot", () => {
    cloneSource.value = subscription({ id: "source", name: "Clone Source" });
    mocks.cloneDialogOpen = true;

    renderSubscriptionsPage();

    expect(screen.getByTestId("clone-dialog-state")).toHaveTextContent("Clone Source");
    expect(screen.getByTestId("clone-dialog-state")).toHaveAttribute("data-mode", "create");
  });
});
