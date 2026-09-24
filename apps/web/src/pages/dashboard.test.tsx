// Dashboard 页面测试保护首页 hook 装配和统计入口，避免页面层绕过 domain 模型直接计算金额。
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import type {
  RecurringCycleSubscriptionCollectionItem,
  Subscription,
  SubscriptionCollectionItem,
} from "@/types/subscription";
import Dashboard from "./dashboard";

interface MockSubscriptionAnalyticsResult {
  data: SubscriptionCollectionItem[] | undefined;
  isPending: boolean;
  error?: unknown;
  refetch?: () => void;
}

interface MockSubscriptionDetailResult {
  data: Subscription | undefined;
  error: unknown | null;
  isPending: boolean;
}

const mocks = vi.hoisted(() => ({
  handleAddSubscription: vi.fn(),
  handleDeleteSubscription: vi.fn(),
  handleEditDialogOpenChange: vi.fn(),
  handleEditSubscription: vi.fn(),
  handleTogglePublicHiddenSubscription: vi.fn(),
  handleSaveSubscription: vi.fn(),
  ratesLoading: false,
  upcomingRenewalsCalls: [] as Array<{ count: number; today: string; notificationReminderDays: number }>,
  useSettings: vi.fn(),
  useSubscriptionAnalytics: vi.fn<() => MockSubscriptionAnalyticsResult>(),
  useSubscriptionDetail: vi.fn<(id: string | null) => MockSubscriptionDetailResult>(),
}));
const detailSubscriptions = new Map<string, Subscription>();

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/components/router-link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/loading-skeleton", () => ({
  DashboardPageSkeleton: () => <div data-testid="dashboard-skeleton" />,
}));

vi.mock("@/components/subscription-card", () => ({
  SubscriptionCard: ({
    subscription,
    today,
    inheritedReminderDays,
    priceReferenceCurrency,
    onTogglePublicHidden,
    onViewDetails,
  }: {
    subscription: SubscriptionCollectionItem;
    today: string;
    inheritedReminderDays: number;
    priceReferenceCurrency: string | null;
    onTogglePublicHidden?: (id: string) => void;
    onViewDetails?: (id: string) => void;
  }) => (
    <article data-testid="subscription-card">
      {subscription.name}
      <span data-testid="subscription-card-reminder">{inheritedReminderDays}</span>
      <span data-testid="subscription-card-reference">{priceReferenceCurrency ?? "off"}</span>
      <span data-testid="subscription-card-today">{today}</span>
      <button type="button" onClick={() => onViewDetails?.(subscription.id)}>
        查看 {subscription.name} 的详情
      </button>
      <button type="button" onClick={() => onTogglePublicHidden?.(subscription.id)}>
        公开切换 {subscription.name}
      </button>
    </article>
  ),
}));

vi.mock("@/components/subscription-detail-dialog", () => ({
  SubscriptionDetailDialog: ({ open, subscription, today, priceReferenceCurrency }: { open: boolean; subscription: Subscription | null; today: string; priceReferenceCurrency: string | null }) => (
    <div data-testid="subscription-detail-dialog">
      {open && subscription ? <span>{subscription.name} 详情 {priceReferenceCurrency ?? "off"} {today}</span> : null}
    </div>
  ),
}));

vi.mock("@/components/spending-chart-loader", () => ({
  DeferredSpendingChart: ({
    subscriptions,
    defaultCurrency,
    today,
    convert,
  }: {
    subscriptions: SubscriptionCollectionItem[];
    defaultCurrency: string;
    today: string;
    convert: (amount: number | string, fromCurrency: string, toCurrency: string) => number;
  }) => (
    <div data-testid="spending-chart">
      {subscriptions.length}:{defaultCurrency}:{today}:{convert("1", "USD", "CNY")}
    </div>
  ),
}));

vi.mock("@/components/upcoming-renewals", () => ({
  UpcomingRenewals: ({
    subscriptions,
    today,
    notificationReminderDays,
  }: {
    subscriptions: SubscriptionCollectionItem[];
    today: string;
    notificationReminderDays: number;
  }) => {
    mocks.upcomingRenewalsCalls.push({ count: subscriptions.length, today, notificationReminderDays });
    return <div data-testid="upcoming-renewals">{subscriptions.length}</div>;
  },
}));

vi.mock("@/components/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: () => null,
}));

vi.mock("@/components/add-subscription-dialog", () => ({
  AddSubscriptionDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

vi.mock("@/hooks/use-report-exchange-rates", () => ({
  useReportExchangeRates: () => ({
    convert: (amount: number | string, from: string, to: string) => {
      const value = typeof amount === "number" ? amount : Number(amount);
      if (from === to) return value;
      if (from === "USD" && to === "CNY") return value * 7;
      return value;
    },
    loading: mocks.ratesLoading,
    sourceDate: "2026-08-01",
    reportBasisStatus: { month: "2026-08", locked: true, sourceDate: "2026-08-01", capturedAt: "2026-08-06T00:00:00Z" },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: mocks.useSettings,
}));

vi.mock("@/hooks/use-zoned-today", () => ({
  useZonedToday: () => "2026-06-15",
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  prefetchSubscriptionDetail: vi.fn(),
  useSubscriptionAnalytics: mocks.useSubscriptionAnalytics,
  useSubscriptionDetail: mocks.useSubscriptionDetail,
  useSubscriptionFacets: () => ({
    data: { total: 1, categoryCounts: { productivity: 1 }, tags: [], visibleCount: 1, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 },
  }),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: DEFAULT_CUSTOM_CONFIG,
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: () => ({
    editingSubscription: undefined,
    editDialogOpen: false,
    handleAddSubscription: mocks.handleAddSubscription,
    handleDeleteSubscription: mocks.handleDeleteSubscription,
    handleEditDialogOpenChange: mocks.handleEditDialogOpenChange,
    handleEditSubscription: mocks.handleEditSubscription,
    handleTogglePublicHiddenSubscription: mocks.handleTogglePublicHiddenSubscription,
    handleSaveSubscription: mocks.handleSaveSubscription,
  }),
}));

function subscription(
  overrides: Partial<RecurringCycleSubscriptionCollectionItem> = {},
): RecurringCycleSubscriptionCollectionItem {
  // 页面装配测试不验证过期规则；远期扣费日避免真实系统时间把公共夹具判为过期。
  return {
    id: "codex-pro",
    name: "Codex Pro",
    logo: undefined,
    price: "200",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    oneTimeTermCount: undefined,
    oneTimeTermUnit: undefined,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-04-18"),
    nextBillingDate: assertDateOnly("2099-05-18"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    reminderDays: 3,
    ...overrides,
  };
}

function toSubscriptionDetail(item: SubscriptionCollectionItem): Subscription {
  return {
    ...item,
    website: undefined,
    notes: undefined,
    tags: [],
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
  };
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

function mockResolvedDashboardData() {
  mocks.useSubscriptionAnalytics.mockReturnValue({
    data: [subscription()],
    isPending: false,
  });
  mocks.useSettings.mockReturnValue({
    data: {
      defaultCurrency: "CNY",
      exchangeRateProvider: "exchange-api",
      notificationReminderDays: 5,
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "USD",
      timezone: "Asia/Shanghai",
    },
    isPending: false,
  });
}

describe("Dashboard page loading state", () => {
  beforeEach(() => {
    detailSubscriptions.clear();
    mocks.ratesLoading = false;
    mocks.upcomingRenewalsCalls = [];
    mockResolvedDashboardData();
    mocks.useSubscriptionDetail.mockImplementation((id: string | null) => {
      const item = id
        ? mocks.useSubscriptionAnalytics().data?.find((subscriptionItem: SubscriptionCollectionItem) => subscriptionItem.id === id)
        : undefined;
      if (item && !detailSubscriptions.has(item.id)) {
        detailSubscriptions.set(item.id, toSubscriptionDetail(item));
      }
      return { data: id ? detailSubscriptions.get(id) : undefined, error: null, isPending: false };
    });
  });

  it("keeps dashboard content visible while exchange rates are loading", () => {
    mocks.ratesLoading = true;

    renderDashboard();

    expect(screen.queryByTestId("dashboard-skeleton")).not.toBeInTheDocument();
    expect(screen.getByText("近期订阅")).toBeInTheDocument();
    expect(screen.getByText("Codex Pro")).toBeInTheDocument();
    expect(screen.getByTestId("subscription-card-reminder")).toHaveTextContent("5");
    expect(screen.getByTestId("subscription-card-reference")).toHaveTextContent("USD");
    expect(screen.getByTestId("subscription-card-today")).toHaveTextContent("2026-06-15");
    expect(mocks.upcomingRenewalsCalls[mocks.upcomingRenewalsCalls.length - 1]).toEqual({
      count: 1,
      today: "2026-06-15",
      notificationReminderDays: 5,
    });
    expect(screen.getByTestId("spending-chart")).toHaveTextContent("1:CNY:2026-06-15:7");
    expect(screen.getByText("日均 ¥46.67 · 汇率加载中...")).toBeInTheDocument();
  });

  it("shows a recoverable error instead of zeroed analytics", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error(),
      refetch,
    });

    renderDashboard();

    expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请稍后重试");
    expect(screen.queryByTestId("dashboard-stat-grid")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("uses one primary empty-state action while keeping secondary panels compact", () => {
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: [],
      isPending: false,
    });

    renderDashboard();

    expect(screen.getAllByRole("heading", { name: "从第一个订阅开始" })).toHaveLength(1);
    expect(screen.getByText("添加订阅后，这里会汇总支出、续费和提醒。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加第一个订阅" })).toBeInTheDocument();
    expect(screen.getByTestId("spending-chart")).toHaveTextContent("0:CNY:2026-06-15:7");
    expect(screen.getByTestId("upcoming-renewals")).toHaveTextContent("0");
  });

  it("uses compact mobile-first summary cards without changing the desktop columns", () => {
    renderDashboard();

    const grid = screen.getByTestId("dashboard-stat-grid");
    const monthlySpend = screen.getByTestId("dashboard-stat-monthly-spend");
    const activeSubscriptions = screen.getByTestId("dashboard-stat-active-subscriptions");
    const trials = screen.getByTestId("dashboard-stat-trials");

    expect(grid).toHaveClass("grid", "gap-3", "sm:gap-5", "sm:grid-cols-2", "lg:grid-cols-4");
    expect(grid.className).toContain("grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))]");
    expect(monthlySpend).toHaveClass("p-4", "lg:p-6", "col-span-full", "sm:col-span-1");
    expect(activeSubscriptions).toHaveClass("p-4", "lg:p-6");
    expect(trials).toHaveClass("p-4", "lg:p-6", "col-span-full", "sm:col-span-1");
    expect(monthlySpend).not.toHaveClass("p-6");
    expect(screen.getByText("日均 ¥46.67 · 实时汇率换算 (CNY)")).toBeInTheDocument();
  });

  it("opens subscription details from a recent subscription card", async () => {
    const user = userEvent.setup();

    renderDashboard();

    await user.click(screen.getByRole("button", { name: "查看 Codex Pro 的详情" }));

    expect(screen.getByText("Codex Pro 详情 USD 2026-06-15")).toBeInTheDocument();
  });

  it("wires public visibility toggles from recent subscription cards", async () => {
    const user = userEvent.setup();

    renderDashboard();

    await user.click(screen.getByRole("button", { name: "公开切换 Codex Pro" }));

    expect(mocks.handleTogglePublicHiddenSubscription).toHaveBeenCalledWith("codex-pro");
  });

  it.each([
    ["subscriptions", { subscriptionsPending: true, settingsPending: false }],
    ["settings", { subscriptionsPending: false, settingsPending: true }],
  ])("shows the skeleton while %s data is still pending", (_label, state) => {
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: state.subscriptionsPending ? undefined : [subscription()],
      isPending: state.subscriptionsPending,
    });
    mocks.useSettings.mockReturnValue({
      data: state.settingsPending
        ? undefined
        : {
            defaultCurrency: "CNY",
            exchangeRateProvider: "exchange-api",
            notificationReminderDays: 5,
            subscriptionPriceReferenceEnabled: true,
            subscriptionPriceReferenceCurrency: "USD",
            timezone: "Asia/Shanghai",
          },
      isPending: state.settingsPending,
    });

    renderDashboard();

    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
  });
});
