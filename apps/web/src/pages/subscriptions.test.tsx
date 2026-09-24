import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
// 订阅页测试覆盖筛选、导入导出、分页与卡片交互，防止页面组合层绕过领域 hook 的缓存契约。
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api-client";
import { assertDateOnly } from "@/lib/time/date-only";
import type { SubscriptionListFilters } from "@/services/subscription-service";
import type { Subscription } from "@/types/subscription";
import type { SettingsReadModel } from "@/services/settings-service";
import {
  DEFAULT_SUBSCRIPTIONS_PAGE_SETTINGS,
  subscriptionFacetsQueryFixture,
  subscriptionIndexQueryFixture,
} from "./subscriptions.test-fixtures";
import Subscriptions from "./subscriptions";
import {
  installPointerCaptureMocks,
  manySubscriptions,
  mockMobileTagFilterMatch,
  renderSubscriptionsPage,
  subscription,
  visibleSubscriptionNames,
} from "./subscriptions.test-support";

type MockInfiniteSubscriptionsResult = {
  subscriptions?: Subscription[];
  total?: number;
  isPending: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => void;
  error?: unknown;
  refetch?: () => void;
};
type MockSettingsEnvelopeResult = { data?: SettingsReadModel };
type MockSubscriptionIndexResult = ReturnType<typeof subscriptionIndexQueryFixture>;
type MockSubscriptionFacetsResult = ReturnType<typeof subscriptionFacetsQueryFixture>;

const mocks = vi.hoisted(() => ({
  useInfiniteSubscriptions: vi.fn<() => MockInfiniteSubscriptionsResult>(),
  useSubscriptionIndex: vi.fn<(filters?: SubscriptionListFilters) => MockSubscriptionIndexResult>(),
  useSubscriptionFacets: vi.fn<() => MockSubscriptionFacetsResult>(),
  useSettingsEnvelope: vi.fn<() => MockSettingsEnvelopeResult>(), usePublicStatusPageStatus: vi.fn<() => { data?: { enabled: boolean }; isSuccess?: boolean }>(),
  handleDeleteSubscription: vi.fn(),
  handleEditSubscription: vi.fn(),
  handleTogglePinnedSubscription: vi.fn(),
  handleTogglePublicHiddenSubscription: vi.fn(),
  handleSaveSubscription: vi.fn(),
  handleEditDialogOpenChange: vi.fn(),
  exportToJSON: vi.fn(),
  exportToJSONWithSecrets: vi.fn(),
  exportToCSV: vi.fn(),
  renderHeaderActions: false,
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  prefetchSubscriptionDetail: vi.fn(),
  useInfiniteSubscriptions: () => {
    const result = mocks.useInfiniteSubscriptions();
    return { ...result, total: result.total ?? result.subscriptions?.length ?? 0 };
  },
  useSubscriptionIndex: mocks.useSubscriptionIndex,
  useSubscriptionFacets: mocks.useSubscriptionFacets,
  useSubscriptionDetail: (id: string | null) => ({
    data: id ? mocks.useInfiniteSubscriptions().subscriptions?.find((item) => item.id === id) : undefined,
    error: null,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettingsEnvelope: mocks.useSettingsEnvelope,
  useSettings: () => {
    const envelope = mocks.useSettingsEnvelope();
    return { ...envelope, data: envelope.data?.settings };
  },
}));

vi.mock("@/hooks/use-public-status-page", () => ({ usePublicStatusPageStatus: mocks.usePublicStatusPageStatus }));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: () => ({
    convert: (amount: number, from: string, to: string) => {
      if (from === to) return amount;
      if (from === "USD" && to === "CNY") return amount * 7;
      if (from === "CNY" && to === "USD") return amount / 7;
      return amount;
    },
    loading: false,
    sourceDate: "2026-08-01",
  }),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: [
        {
          id: "productivity",
          value: "productivity",
          labels: { "zh-CN": "生产力", "en-US": "Productivity" },
          color: "hsl(200 80% 50%)",
        },
        {
          id: "finance",
          value: "finance",
          labels: { "zh-CN": "财务", "en-US": "Finance" },
          color: "hsl(160 84% 45%)",
        },
      ],
      statuses: [
        {
          id: "active",
          value: "active",
          labels: { "zh-CN": "活跃", "en-US": "Active" },
          color: "hsl(160 84% 45%)",
        },
        {
          id: "expired",
          value: "expired",
          labels: { "zh-CN": "已过期", "en-US": "Expired" },
          color: "hsl(0 72% 51%)",
        },
      ],
      paymentMethods: [],
      currencies: [],
    },
    updateCategories: vi.fn(),
    updateStatuses: vi.fn(),
    updatePaymentMethods: vi.fn(),
    updateCurrencies: vi.fn(),
  }),
}));
vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: () => ({
    editingSubscription: undefined,
    editDialogOpen: false,
    cloningSubscription: null,
    cloneDialogOpen: false,
    handleAddSubscription: vi.fn(),
    handleDeleteSubscription: mocks.handleDeleteSubscription,
    handleCloneSubscription: vi.fn(),
    handleEditSubscription: mocks.handleEditSubscription,
    handleTogglePinnedSubscription: mocks.handleTogglePinnedSubscription,
    handleTogglePublicHiddenSubscription: mocks.handleTogglePublicHiddenSubscription,
    handleSaveSubscription: mocks.handleSaveSubscription,
    handleSaveClonedSubscription: vi.fn(),
    handleEditDialogOpenChange: mocks.handleEditDialogOpenChange,
    handleCloneDialogOpenChange: vi.fn(),
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-export", () => ({
  useSubscriptionExport: () => ({
    exportToJSON: mocks.exportToJSON,
    exportToJSONWithSecrets: mocks.exportToJSONWithSecrets,
    exportToCSV: mocks.exportToCSV,
  }),
}));

vi.mock("@/components/import-data-dialog", () => ({
  ImportDataDialogContent: ({ open }: { open: boolean }) => <div data-testid="import-dialog-state">{String(open)}</div>,
}));

vi.mock("@/components/header", () => ({
  Header: ({ subscriptionActions }: { subscriptionActions?: ReactNode }) => (
    <header data-testid="header">
      {mocks.renderHeaderActions ? subscriptionActions : null}
    </header>
  ),
}));

vi.mock("@/components/ai-recognize-subscription-dialog", () => ({
  AIRecognizeSubscriptionDialogContent: ({ open }: { open: boolean }) => (
    <div data-testid="ai-recognition-dialog">
      {String(open)}
    </div>
  ),
}));

vi.mock("@/components/subscription-card", () => ({
  SubscriptionCard: ({
    subscription,
    inheritedReminderDays,
    priceReferenceCurrency,
    onTogglePinned,
    onTogglePublicHidden,
    onViewDetails,
  }: {
    subscription: Subscription;
    inheritedReminderDays: number;
    priceReferenceCurrency: string | null;
    onTogglePinned?: (id: string) => void;
    onTogglePublicHidden?: (id: string) => void;
    onViewDetails?: (id: string) => void;
  }) => (
    <article data-testid="subscription-card">
      {subscription.name}
      <span data-testid="subscription-card-reminder">{inheritedReminderDays}</span>
      <span data-testid="subscription-card-reference">{priceReferenceCurrency ?? "off"}</span>
      <button type="button" onClick={() => onViewDetails?.(subscription.id)}>
        查看 {subscription.name} 的详情
      </button>
      <button type="button" onClick={() => onTogglePinned?.(subscription.id)}>
        置顶 {subscription.name}
      </button>
      <button type="button" onClick={() => onTogglePublicHidden?.(subscription.id)}>
        公开切换 {subscription.name}
      </button>
    </article>
  ),
}));

vi.mock("@/components/subscription-detail-dialog", () => ({
  SubscriptionDetailDialog: ({
    open,
    subscription,
    priceReferenceCurrency,
    onEditSubscription,
  }: {
    open: boolean;
    subscription: Subscription | null;
    priceReferenceCurrency: string | null;
    onEditSubscription?: (subscription: Subscription) => void;
  }) => (
    <div data-testid="subscription-detail-dialog">
      {open && subscription ? (
        <>
          <span>{subscription.name} 详情 {priceReferenceCurrency ?? "off"}</span>
          <button type="button" onClick={() => onEditSubscription?.(subscription)}>
            编辑详情 {subscription.name}
          </button>
        </>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/add-subscription-dialog", () => ({
  AddSubscriptionDialog: ({ trigger }: { trigger?: ReactNode }) => trigger ?? null,
}));

vi.mock("@/components/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: () => null,
}));

vi.mock("@/components/subscription-dialog", () => ({
  SubscriptionDialog: () => null,
}));

function mockSubscriptionsPageSettings(timezone = DEFAULT_SUBSCRIPTIONS_PAGE_SETTINGS.settings.timezone) {
  mocks.useSettingsEnvelope.mockReturnValue({
    data: {
      ...DEFAULT_SUBSCRIPTIONS_PAGE_SETTINGS,
      settings: { ...DEFAULT_SUBSCRIPTIONS_PAGE_SETTINGS.settings, timezone },
    },
  });
}

beforeEach(() => {
  mocks.renderHeaderActions = false; mocks.usePublicStatusPageStatus.mockReturnValue({ data: { enabled: true }, isSuccess: true });
  mocks.useSubscriptionIndex.mockImplementation((filters) => subscriptionIndexQueryFixture(mocks.useInfiniteSubscriptions().subscriptions ?? [], filters));
  mocks.useSubscriptionFacets.mockImplementation(() => subscriptionFacetsQueryFixture(mocks.useInfiniteSubscriptions().subscriptions ?? []));
});

describe("Subscriptions page sorting", () => {
  beforeAll(installPointerCaptureMocks);

  beforeEach(() => {
    mockMobileTagFilterMatch(false);
    mockSubscriptionsPageSettings();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [
        subscription({ id: "annual-usd", name: "Annual USD", price: "120", currency: "USD", billingCycle: "annual" }),
        subscription({ id: "monthly-cny", name: "Monthly CNY", price: "80", currency: "CNY", billingCycle: "monthly" }),
        subscription({ id: "quarterly-cny", name: "Quarterly CNY", price: "180", currency: "CNY", billingCycle: "quarterly" }),
      ],
      isPending: false,
    });
  });

  it("renders a page-isomorphic skeleton while the first subscription page is pending", () => {
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [],
      isPending: true,
    });

    renderSubscriptionsPage();

    expect(screen.getByTestId("subscriptions-skeleton")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("subscriptions-skeleton-list")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a recoverable error instead of an empty state when the first page fails", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [],
      isPending: false,
      error: new Error(),
      refetch,
    });

    renderSubscriptionsPage();

    expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请稍后重试");
    expect(screen.queryByText("没有找到订阅")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("offers adding the first subscription when the collection is empty", () => {
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [],
      isPending: false,
    });

    renderSubscriptionsPage();

    expect(screen.getByRole("heading", { name: "还没有订阅" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加第一个订阅" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除筛选" })).not.toBeInTheDocument();
  });

  it("offers clearing filters instead of adding when no subscriptions match", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    await user.type(screen.getByRole("searchbox"), "no-match");

    expect(await screen.findByRole("heading", { name: "没有匹配结果" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "清除筛选" })).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "添加第一个订阅" })).not.toBeInTheDocument();
  });

  it("preserves the structured collection-limit error when index search fails", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.useSubscriptionIndex.mockReturnValue({
      ...subscriptionIndexQueryFixture([]),
      error: new ApiError(
        "Invalid request parameters",
        422,
        { limit: 5000 },
        "SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED",
      ),
      refetch,
    });

    renderSubscriptionsPage();
    await user.type(screen.getByRole("searchbox"), "layout");

    expect(await screen.findByRole("alert")).toHaveTextContent("结果超过可处理上限，请缩小搜索或筛选范围");
    expect(screen.queryByText("没有找到订阅")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  it("enters public visibility management without creating a public visibility filter", async () => { renderSubscriptionsPage(["/subscriptions?publicVisibility=manage"]); expect(await screen.findByRole("button", { name: "退出管理" })).toBeInTheDocument(); expect(screen.queryByText("公开页可见")).not.toBeInTheDocument(); });
  it("hides public visibility management when the public page is disabled", () => { mocks.usePublicStatusPageStatus.mockReturnValue({ data: { enabled: false }, isSuccess: true }); renderSubscriptionsPage(); expect(screen.queryByRole("button", { name: "批量管理公开可见性" })).not.toBeInTheDocument(); });
  it("resets collection queries when the account timezone changes", async () => {
    const rendered = renderSubscriptionsPage();
    const resetQueries = vi.spyOn(rendered.queryClient, "resetQueries");
    mockSubscriptionsPageSettings("America/Los_Angeles");
    rendered.rerenderSubscriptionsPage();
    await waitFor(() => expect(resetQueries).toHaveBeenNthCalledWith(1, { queryKey: ["subscriptions", "collections", "page"] }));
    expect(resetQueries).toHaveBeenNthCalledWith(2, { queryKey: ["subscriptions", "collections", "index"] });
  });

  it("does not commit a temporary UTC boundary while settings are still loading", async () => {
    mocks.useSettingsEnvelope.mockReturnValue({});
    const rendered = renderSubscriptionsPage();
    const resetQueries = vi.spyOn(rendered.queryClient, "resetQueries");

    expect(rendered.queryClient.getQueryData(["subscriptions", "collection-boundary"])).toBeUndefined();
    mockSubscriptionsPageSettings("Asia/Shanghai");
    rendered.rerenderSubscriptionsPage();
    await waitFor(() => expect(rendered.queryClient.getQueryData<string>(["subscriptions", "collection-boundary"])).toMatch(/^Asia\/Shanghai:\d{4}-\d{2}-\d{2}$/u));
    expect(resetQueries).not.toHaveBeenCalled();
  });

  it("keeps sort-only out of filter feedback and preserves sorting when filters are cleared", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    expect(visibleSubscriptionNames()).toEqual(["Annual USD", "Monthly CNY", "Quarterly CNY"]);

    await user.click(screen.getByRole("combobox", { name: "排序" }));
    await user.click(await screen.findByRole("option", { name: "月成本最高" }));
    expect(screen.getByRole("combobox", { name: "排序" }).compareDocumentPosition(screen.getByRole("button", { name: "更多筛选" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByTestId("desktop-filter-feedback")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("desktop-filter-toolbar")).queryByRole("button", { name: "清除筛选" })).not.toBeInTheDocument();
    await waitFor(() => expect(visibleSubscriptionNames()).toEqual(["Monthly CNY", "Annual USD", "Quarterly CNY"]));
    expect(screen.queryByText(/从 3 个中筛选/)).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "Annual");
    expect(await screen.findByTestId("desktop-filter-feedback")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(visibleSubscriptionNames()).toEqual(["Monthly CNY", "Annual USD", "Quarterly CNY"]));
    expect(screen.getByRole("combobox", { name: "排序" })).toHaveTextContent("月成本最高");
  });

  it("keeps pinned subscriptions ahead and wires the pin action", async () => {
    const user = userEvent.setup();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [
        subscription({ id: "regular", name: "Regular Service", price: "999" }),
        subscription({ id: "pinned", name: "Pinned Service", price: "1", pinned: true }),
      ],
      isPending: false,
    });

    renderSubscriptionsPage();

    expect(visibleSubscriptionNames()).toEqual(["Pinned Service", "Regular Service"]);

    await user.click(screen.getByRole("button", { name: "置顶 Regular Service" }));

    expect(mocks.handleTogglePinnedSubscription).toHaveBeenCalledWith("regular");
  });

  it("wires public visibility toggles from subscription cards", async () => {
    const user = userEvent.setup();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [subscription({ id: "public-toggle", name: "Public Toggle" })],
      isPending: false,
    });

    renderSubscriptionsPage();

    await user.click(screen.getByRole("button", { name: "公开切换 Public Toggle" }));

    expect(mocks.handleTogglePublicHiddenSubscription).toHaveBeenCalledWith("public-toggle");
  });

  it("opens the read-only detail view from a subscription card and edits from that detail view", async () => {
    const user = userEvent.setup();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [subscription({ id: "readable", name: "Readable Service" })],
      isPending: false,
    });

    renderSubscriptionsPage();

    await user.click(screen.getByRole("button", { name: "查看 Readable Service 的详情" }));

    expect(screen.getByText(/Readable Service 详情/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑详情 Readable Service" }));

    expect(mocks.handleEditSubscription).toHaveBeenCalledWith("readable");
  });

  it("shows the back-to-top float button when the app root is scrolled", async () => {
    renderSubscriptionsPage();
    const root = document.getElementById("root");
    if (!root) throw new Error("Expected #root test scroll container");
    // jsdom 不会按卡片内容计算 #root 的真实滚动高度；这里手动设置，专门验证页面接线是否监听了正确容器。
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 800 });
    root.scrollTop = 420;

    fireEvent.scroll(root);

    expect(await screen.findByRole("button", { name: "回到顶部" })).toBeInTheDocument();
  });

  it("uses the shared H5 page shell and native search metadata on mobile", () => {
    mockMobileTagFilterMatch(true, 390);
    const { container } = renderSubscriptionsPage();

    expect(container.querySelector(".app-page")).toBeInTheDocument();
    expect(container.querySelector("main.app-main")).toBeInTheDocument();
    const searchInput = screen.getByPlaceholderText("搜索订阅、标签或备注...");
    expect(searchInput).toHaveAttribute("type", "search");
    expect(searchInput).toHaveAttribute("name", "subscription-search");
    expect(searchInput).toHaveAttribute("enterkeyhint", "search");
    expect(within(screen.getByTestId("mobile-payment-type-sort-row")).getByRole("combobox", { name: "排序" }).compareDocumentPosition(within(screen.getByTestId("mobile-advanced-tag-row")).getByRole("button", { name: "更多筛选" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the AI add shortcut accessible, compact, and wired to the recognition dialog", async () => {
    mocks.renderHeaderActions = true;
    const user = userEvent.setup();
    renderSubscriptionsPage();

    const aiButton = screen.getByRole("button", { name: "AI 识别添加" });
    expect(aiButton).toHaveClass("h-12", "w-12", "sm:h-10", "sm:w-10", "text-primary");
    expect(aiButton).not.toHaveAttribute("title");

    await user.click(aiButton);

    expect(await screen.findByTestId("ai-recognition-dialog")).toHaveTextContent("true");
  });

  it("keeps import as a dedicated action next to the export menu", async () => {
    const user = userEvent.setup();
    mocks.exportToJSON.mockClear();
    mocks.exportToJSONWithSecrets.mockClear();
    mocks.exportToCSV.mockClear();
    renderSubscriptionsPage();

    await user.click(screen.getByRole("button", { name: "导出订阅" }));
    expect(screen.queryByRole("menuitem", { name: "导入数据" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "导出备份 ZIP" }));
    expect(mocks.exportToJSON).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "导出订阅" }));
    await user.click(await screen.findByRole("menuitem", { name: "导出备份 ZIP（含通知密钥）" }));
    expect(mocks.exportToJSONWithSecrets).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "导出订阅" }));
    await user.click(await screen.findByRole("menuitem", { name: "导出 CSV" }));
    expect(mocks.exportToCSV).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "导入数据" }));
    expect(await screen.findByTestId("import-dialog-state")).toHaveTextContent("true");
  });

  it("filters by expired using the effective status of legacy overdue subscriptions", async () => {
    const user = userEvent.setup();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [
        subscription({ id: "legacy-overdue", name: "Legacy Overdue", status: "active", nextBillingDate: assertDateOnly("2000-05-15") }),
        subscription({ id: "active-future", name: "Active Future", status: "active", nextBillingDate: assertDateOnly("2099-05-20") }),
      ],
      isPending: false,
    });

    renderSubscriptionsPage();

    const statusFilter = screen
      .getAllByRole("combobox")
      .find((element) => element.textContent?.includes("所有状态"));
    expect(statusFilter).toBeDefined();

    await user.click(statusFilter!);
    await user.click(await screen.findByRole("option", { name: "已过期" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Legacy Overdue"]);
    });
    expect(screen.queryByText("Active Future")).not.toBeInTheDocument();
  });
});

describe("Subscriptions page desktop tag filters", () => {
  beforeAll(installPointerCaptureMocks);

  beforeEach(() => {
    mockMobileTagFilterMatch(false);
    mockSubscriptionsPageSettings();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [
        subscription({ id: "cloud", name: "Tagged Cloud", tags: ["工作", "云服务", "Security"] }),
        subscription({ id: "docs", name: "Docs Notes", tags: ["Docs", "Planning"] }),
        subscription({ id: "design", name: "Design Suite", tags: ["Design"] }),
        subscription({ id: "plain", name: "Plain Service", tags: [] }),
      ],
      isPending: false,
    });
  });

  it("collapses desktop tags into a searchable popover and clears selections", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    const desktopTagFilter = screen.getByTestId("desktop-tag-filter");
    expect(within(desktopTagFilter).getByRole("button", { name: "标签" })).toBeInTheDocument();
    expect(screen.queryByText("标签:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Security" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-selected-tags")).not.toBeInTheDocument();

    await user.click(within(desktopTagFilter).getByRole("button", { name: "标签" }));
    await user.type(await screen.findByPlaceholderText("搜索标签..."), "Doc");
    expect(screen.queryByRole("button", { name: "Security" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Docs" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Docs Notes"]);
    });
    expect(within(desktopTagFilter).getByRole("button", { name: "标签(1)" })).toBeInTheDocument();
    expect(screen.getByTestId("desktop-selected-tags")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清空标签" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Tagged Cloud", "Docs Notes", "Design Suite", "Plain Service"]);
    });
    expect(within(desktopTagFilter).getByRole("button", { name: "标签" })).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-selected-tags")).not.toBeInTheDocument();
  });

  it("removes selected desktop tag pills without opening the full tag wall", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    const desktopTagFilter = screen.getByTestId("desktop-tag-filter");
    await user.click(within(desktopTagFilter).getByRole("button", { name: "标签" }));
    await user.click(await screen.findByRole("button", { name: "Design" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Design Suite"]);
    });
    await user.click(screen.getByRole("button", { name: "移除标签 Design" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Tagged Cloud", "Docs Notes", "Design Suite", "Plain Service"]);
    });
    expect(within(desktopTagFilter).getByRole("button", { name: "标签" })).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-selected-tags")).not.toBeInTheDocument();
  });
});

describe("Subscriptions page mobile tag filters", () => {
  beforeAll(installPointerCaptureMocks);

  beforeEach(() => {
    mockMobileTagFilterMatch(true);
    mockSubscriptionsPageSettings();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [
        subscription({ id: "cloud", name: "Tagged Cloud", tags: ["工作", "云服务", "Security"] }),
        subscription({ id: "docs", name: "Docs Notes", tags: ["Docs", "Planning"] }),
        subscription({ id: "design", name: "Design Suite", tags: ["Design"] }),
        subscription({ id: "plain", name: "Plain Service", tags: [] }),
      ],
      isPending: false,
    });
  });

  it("keeps tags compact on mobile and applies drawer selections", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    expect(screen.getByTestId("mobile-tag-filter")).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-tag-filter")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Security" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-selected-tags")).not.toBeInTheDocument();
    const paymentTypeSortRow = screen.getByTestId("mobile-payment-type-sort-row");
    const advancedTagRow = screen.getByTestId("mobile-advanced-tag-row");
    const mobileSelects = screen.getAllByRole("combobox");
    expect(mobileSelects[0]).toHaveTextContent("所有状态");
    expect(mobileSelects[1]).toHaveTextContent("所有付费类型");
    expect(within(paymentTypeSortRow).getByRole("combobox", { name: "排序" })).toHaveTextContent("默认顺序");
    expect(within(advancedTagRow).getByRole("button", { name: "标签" })).toBeInTheDocument();
    expect(visibleSubscriptionNames()).toEqual(["Tagged Cloud", "Docs Notes", "Design Suite", "Plain Service"]);
    await user.click(within(advancedTagRow).getByRole("button", { name: "标签" }));
    const drawer = await screen.findByRole("dialog", { name: "筛选标签" });
    expect(drawer).toHaveClass("h5-drawer-panel", "overflow-hidden");
    expect(drawer).not.toHaveClass("min-h-[52dvh]");
    expect(screen.queryByRole("button", { name: "清空标签" })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("搜索标签..."), "Doc");
    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(visibleSubscriptionNames()).toEqual(["Tagged Cloud", "Docs Notes", "Design Suite", "Plain Service"]);
    await user.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => {
      expect(drawer).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "标签(1)" })).toBeInTheDocument();
    expect(screen.getByTestId("mobile-selected-tags")).toBeInTheDocument();
    expect(within(screen.getByTestId("mobile-filter-feedback")).getByRole("button", { name: "清除筛选" })).toBeInTheDocument();
    expect(within(advancedTagRow).queryByRole("button", { name: "清除筛选" })).not.toBeInTheDocument();
    expect(visibleSubscriptionNames()).toEqual(["Docs Notes"]);
  });

  it("removes selected mobile tag chips and clears drawer tags immediately", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    await user.click(screen.getByRole("button", { name: "标签" }));
    await user.click(await screen.findByRole("button", { name: "Docs" }));
    await user.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Docs Notes"]);
    });
    await user.click(screen.getByRole("button", { name: "移除标签 Docs" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Tagged Cloud", "Docs Notes", "Design Suite", "Plain Service"]);
    });
    expect(screen.getByRole("button", { name: "标签" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "标签" }));
    await user.click(await screen.findByRole("button", { name: "Design" }));
    await user.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Design Suite"]);
    });
    await user.click(screen.getByRole("button", { name: "标签(1)" }));
    const drawer = await screen.findByRole("dialog", { name: "筛选标签" });
    await user.click(screen.getByRole("button", { name: "清空标签" }));

    await waitFor(() => {
      expect(drawer).not.toBeInTheDocument();
      expect(visibleSubscriptionNames()).toEqual(["Tagged Cloud", "Docs Notes", "Design Suite", "Plain Service"]);
    });
    expect(screen.getByRole("button", { name: "标签" })).toBeInTheDocument();
  });
});

describe("Subscriptions page virtualization", () => {
  beforeAll(installPointerCaptureMocks);

  beforeEach(() => {
    mockMobileTagFilterMatch(false, 1280);
    mockSubscriptionsPageSettings();
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: manySubscriptions(90),
      isPending: false,
    });
  });

  it("uses one virtualized list model while preserving sorting and filtering", async () => {
    const user = userEvent.setup();
    renderSubscriptionsPage();

    expect(screen.getByTestId("virtualized-subscription-list")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId("subscription-card").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByTestId("subscription-card").length).toBeLessThan(90);
    expect(visibleSubscriptionNames()[0]).toBe("Service 000");
    expect(screen.getAllByTestId("subscription-card-reminder")[0]).toHaveTextContent("5");
    expect(screen.getAllByTestId("subscription-card-reference")[0]).toHaveTextContent("USD");

    await user.click(screen.getByRole("combobox", { name: "排序" }));
    await user.click(await screen.findByRole("option", { name: "名称 Z-A" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()[0]).toBe("Service 089");
    });

    await user.type(screen.getByPlaceholderText("搜索订阅、标签或备注..."), "Service 042");

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Service 042"]);
    });
    expect(screen.getByTestId("virtualized-subscription-list")).toBeInTheDocument();
  });

  it("keeps the same virtualized list model when loading more subscriptions", async () => {
    const user = userEvent.setup();
    const firstPageSubscriptions = manySubscriptions(50);
    const nextPageSubscriptions = manySubscriptions(100);
    const fetchNextPage = vi.fn();
    let queryState = {
      subscriptions: firstPageSubscriptions,
      isPending: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
    };
    mocks.useInfiniteSubscriptions.mockImplementation(() => queryState);
    const { rerenderSubscriptionsPage } = renderSubscriptionsPage();
    const virtualizedList = screen.getByTestId("virtualized-subscription-list");
    const loadMoreRow = screen.getByTestId("subscriptions-load-more-row");

    expect(virtualizedList).toBeInTheDocument();
    expect(loadMoreRow.className).toContain("[overflow-anchor:none]");
    expect(screen.getAllByTestId("subscription-card").length).toBeLessThan(50);

    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    queryState = {
      ...queryState,
      subscriptions: nextPageSubscriptions,
      isFetchingNextPage: false,
    };
    rerenderSubscriptionsPage();

    expect(screen.getByTestId("virtualized-subscription-list")).toBe(virtualizedList);
    expect(screen.getAllByTestId("subscription-card").length).toBeLessThan(100);
  });

  it("does not re-read settings when virtualized rows change on scroll", async () => {
    renderSubscriptionsPage();
    const root = document.getElementById("root");
    if (!root) throw new Error("Expected #root test scroll container");

    await waitFor(() => {
      expect(screen.getAllByTestId("subscription-card").length).toBeGreaterThan(0);
    });
    const settingsCallsAfterMount = mocks.useSettingsEnvelope.mock.calls.length;

    root.scrollTop = 1200;
    fireEvent.scroll(root);

    await waitFor(() => {
      expect(screen.getAllByTestId("subscription-card").length).toBeGreaterThan(0);
    });
    expect(mocks.useSettingsEnvelope).toHaveBeenCalledTimes(settingsCallsAfterMount);
  });
});
