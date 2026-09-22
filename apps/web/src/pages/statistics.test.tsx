// Statistics 页面测试保护统计模型到图表 UI 的装配，避免 Recharts 容器和金额口径脱节。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { moneyToNumber } from "@renewlet/shared/money";
import Statistics from "./statistics";

type SubscriptionBaseFixture = Omit<SubscriptionCollectionItem, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<SubscriptionCollectionItem>;

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
  handleEditDialogOpenChange: vi.fn(),
  handleEditSubscription: vi.fn(),
  handleAddSubscription: vi.fn(),
  handleRenewSubscription: vi.fn(),
  handleSaveSubscription: vi.fn(),
  ratesLastUpdated: null as string | null,
  refreshRates: vi.fn(),
  rechartsBarChartProps: [] as Array<Record<string, unknown>>,
  rechartsBarProps: [] as Array<Record<string, unknown>>,
  rechartsCellProps: [] as Array<Record<string, unknown>>,
  rechartsCartesianGridProps: [] as Array<Record<string, unknown>>,
  rechartsLegendProps: [] as Array<Record<string, unknown>>,
  rechartsPieChartProps: [] as Array<Record<string, unknown>>,
  rechartsPieProps: [] as Array<Record<string, unknown>>,
  rechartsResponsiveContainerProps: [] as Array<Record<string, unknown>>,
  rechartsTooltipProps: [] as Array<Record<string, unknown>>,
  rechartsXAxisProps: [] as Array<Record<string, unknown>>,
  rechartsYAxisProps: [] as Array<Record<string, unknown>>,
  useCustomConfigState: vi.fn(),
  useSettings: vi.fn(),
  useSubscriptionCrud: vi.fn(),
  useSubscriptionAnalytics: vi.fn<() => MockSubscriptionAnalyticsResult>(),
  useSubscriptionDetail: vi.fn<(id: string | null) => MockSubscriptionDetailResult>(),
}));
const detailSubscriptions = new Map<string, Subscription>();

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/components/statistics-charts-loader", async () => {
  const module = await vi.importActual<typeof import("@/components/statistics-charts")>("@/components/statistics-charts");
  return { DeferredStatisticsCharts: module.StatisticsCharts };
});

vi.mock("@/components/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: () => null,
}));

vi.mock("@/components/subscription-detail-dialog", () => ({
  SubscriptionDetailDialog: ({
    open,
    subscription,
    priceReferenceCurrency,
    onEditSubscription,
    onRenewSubscription,
  }: {
    open: boolean;
    subscription: Subscription | null;
    priceReferenceCurrency: string | null;
    onEditSubscription?: (subscription: Subscription) => void;
    onRenewSubscription?: (id: string) => void;
  }) => (
    <div data-testid="subscription-detail-dialog">
      {open && subscription ? (
        <>
          <span>{subscription.name} 详情 {priceReferenceCurrency ?? "off"}</span>
          <button type="button" onClick={() => onEditSubscription?.(subscription)}>
            编辑详情 {subscription.name}
          </button>
          <button type="button" onClick={() => onRenewSubscription?.(subscription.id)}>
            续费详情 {subscription.name}
          </button>
        </>
      ) : null}
    </div>
  ),
}));

vi.mock("recharts", () => ({
  Bar: (props: Record<string, unknown>) => {
    mocks.rechartsBarProps.push(props);
    return null;
  },
  BarChart: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    mocks.rechartsBarChartProps.push(props);
    return <div>{children}</div>;
  },
  CartesianGrid: (props: Record<string, unknown>) => {
    mocks.rechartsCartesianGridProps.push(props);
    return null;
  },
  Cell: (props: Record<string, unknown>) => {
    mocks.rechartsCellProps.push(props);
    return null;
  },
  Legend: (props: Record<string, unknown>) => {
    mocks.rechartsLegendProps.push(props);
    return <div data-testid="recharts-legend" />;
  },
  Pie: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    mocks.rechartsPieProps.push(props);
    return <div>{children}</div>;
  },
  PieChart: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    mocks.rechartsPieChartProps.push(props);
    return <div>{children}</div>;
  },
  ResponsiveContainer: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    mocks.rechartsResponsiveContainerProps.push(props);
    return <div>{children}</div>;
  },
  Tooltip: (props: Record<string, unknown>) => {
    mocks.rechartsTooltipProps.push(props);
    if (props["cursor"] !== false) return null;

    const renderContent = props["content"] as
      | ((args: { active: boolean; payload: Array<{ value: number; payload: Record<string, unknown> }> }) => React.ReactNode)
      | undefined;
    const chartData = mocks.rechartsBarChartProps[mocks.rechartsBarChartProps.length - 1]?.["data"] as
      | Array<Record<string, unknown>>
      | undefined;
    const datum = chartData?.[0];
    const dataKey = mocks.rechartsBarChartProps[mocks.rechartsBarChartProps.length - 1]?.["title"] === "月均摊销"
      ? "amortized"
      : "cashflow";
    const rawValue = datum?.[dataKey];
    const value = typeof rawValue === "number" ? rawValue : 0;

    return <div data-testid="statistics-trend-tooltip">{datum ? renderContent?.({ active: true, payload: [{ value, payload: datum }] }) : null}</div>;
  },
  XAxis: (props: Record<string, unknown>) => {
    mocks.rechartsXAxisProps.push(props);
    return null;
  },
  YAxis: (props: Record<string, unknown>) => {
    mocks.rechartsYAxisProps.push(props);
    return null;
  },
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: mocks.useCustomConfigState,
}));

vi.mock("@/hooks/use-report-exchange-rates", () => ({
  useReportExchangeRates: () => ({
    convert: (amount: number | string) => moneyToNumber(amount),
    error: null,
    getCurrencySymbol: () => "¥",
    lastUpdated: mocks.ratesLastUpdated,
    loading: false,
    sourceDate: "2026-08-01",
    reportBasisStatus: { month: "2026-08", locked: true, sourceDate: "2026-08-01", capturedAt: "2026-08-06T00:00:00Z" },
    refresh: mocks.refreshRates,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: mocks.useSettings,
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  prefetchSubscriptionDetail: vi.fn(),
  useSubscriptionAnalytics: mocks.useSubscriptionAnalytics,
  useSubscriptionDetail: mocks.useSubscriptionDetail,
  useSubscriptionFacets: () => ({
    data: { total: 0, categoryCounts: {}, tags: [], visibleCount: 0, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 },
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: mocks.useSubscriptionCrud,
}));

function subscription(overrides: SubscriptionOverrides): SubscriptionCollectionItem {
  const base: SubscriptionBaseFixture = {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "CNY",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2099-01-05"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    reminderDays: 3,
    pinned: false,
    publicHidden: false,
  };

  return {
    ...base,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
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

function renderStatistics() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <Statistics />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function getLastTrendTooltip(): HTMLElement {
  const tooltips = screen.getAllByTestId("statistics-trend-tooltip");
  const tooltip = tooltips[tooltips.length - 1];
  if (!tooltip) {
    throw new Error("Expected at least one trend tooltip to be rendered.");
  }
  return tooltip;
}

describe("Statistics page", () => {
  beforeEach(() => {
    detailSubscriptions.clear();
    Element.prototype.hasPointerCapture ??= vi.fn(() => false);
    Element.prototype.setPointerCapture ??= vi.fn();
    Element.prototype.releasePointerCapture ??= vi.fn();
    mocks.handleAddSubscription.mockReset();
    mocks.handleEditDialogOpenChange.mockReset();
    mocks.handleEditSubscription.mockReset();
    mocks.handleRenewSubscription.mockReset();
    mocks.handleSaveSubscription.mockReset();
    mocks.ratesLastUpdated = null;
    mocks.rechartsBarChartProps.length = 0;
    mocks.rechartsBarProps.length = 0;
    mocks.rechartsCellProps.length = 0;
    mocks.rechartsCartesianGridProps.length = 0;
    mocks.rechartsLegendProps.length = 0;
    mocks.rechartsPieChartProps.length = 0;
    mocks.rechartsPieProps.length = 0;
    mocks.rechartsResponsiveContainerProps.length = 0;
    mocks.rechartsTooltipProps.length = 0;
    mocks.rechartsXAxisProps.length = 0;
    mocks.rechartsYAxisProps.length = 0;
    mocks.useCustomConfigState.mockReturnValue({ config: DEFAULT_CUSTOM_CONFIG });
    mocks.useSettings.mockReturnValue({
      data: {
        defaultCurrency: "CNY",
        monthlyBudget: "500",
        subscriptionPriceReferenceEnabled: true,
        subscriptionPriceReferenceCurrency: "USD",
        timezone: "UTC",
      },
      isPending: false,
    });
    mocks.useSubscriptionCrud.mockReturnValue({
      editingSubscription: null,
      editDialogOpen: false,
      handleAddSubscription: mocks.handleAddSubscription,
      handleEditSubscription: mocks.handleEditSubscription,
      handleRenewSubscription: mocks.handleRenewSubscription,
      handleSaveSubscription: mocks.handleSaveSubscription,
      handleEditDialogOpenChange: mocks.handleEditDialogOpenChange,
    });
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: [
        subscription({ id: "active", status: "active", price: "20" }),
        subscription({ id: "paused", status: "paused", price: "10" }),
        subscription({ id: "cancelled", status: "cancelled", price: "20" }),
      ],
      isPending: false,
    });
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

  it("renders a page-isomorphic skeleton while statistics inputs are pending", () => {
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: undefined,
      isPending: true,
    });

    renderStatistics();

    const skeleton = screen.getByTestId("statistics-skeleton");
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(skeleton.querySelectorAll(".rounded-xl.border.border-border.bg-card")).toHaveLength(16);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a recoverable error instead of empty analytics", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error(),
      refetch,
    });

    renderStatistics();

    expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请稍后重试");
    expect(screen.queryByText("总体统计")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps only dynamic exchange-rate context below the page title", () => {
    mocks.ratesLastUpdated = "2026-08-20T08:00:00.000Z";

    renderStatistics();

    expect(screen.getByRole("heading", { name: "统计分析" })).toBeInTheDocument();
    expect(screen.getByText(/汇率更新于/)).toBeInTheDocument();
    expect(screen.queryByText("查看详细分析和数据洞察")).not.toBeInTheDocument();
  });

  it("uses compact placeholders for empty breakdown charts", () => {
    mocks.useSubscriptionAnalytics.mockReturnValue({ data: [], isPending: false });

    renderStatistics();

    const emptyCharts = screen.getAllByText("暂无数据");
    expect(emptyCharts).not.toHaveLength(0);
    for (const emptyChart of emptyCharts) {
      expect(emptyChart).toHaveStyle({ height: "128px" });
    }
  });

  it("shows the inactive savings explanation on hover", async () => {
    const user = userEvent.setup();

    renderStatistics();

    expect(screen.getByText("停用月节省")).toBeInTheDocument();
    expect(screen.getByText("¥30 CNY")).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "说明：停用月节省" }));

    expect(
      await screen.findAllByText("已暂停、已取消和已过期订阅按月折算后的金额，不包含活跃或试用订阅，也不是预算剩余。"),
    ).not.toHaveLength(0);
  });

  it("keeps the personal cost basis switch in the overview heading row", async () => {
    const user = userEvent.setup();
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: [
        subscription({
          id: "family-plan",
          price: "100",
          status: "active",
          costSharing: {
            enabled: true,
            splitMode: "custom",
            members: [
              { id: "member", name: "Member", currency: "CNY", customAmount: "60" },
            ],
          },
        }),
      ],
      isPending: false,
    });

    renderStatistics();

    const overviewHeading = screen.getByRole("heading", { name: "总体统计" });
    const personalCostBasisSwitch = screen.getByRole("switch", { name: "按我的份额统计" });
    const overviewHeadingRow = overviewHeading.parentElement;

    if (!overviewHeadingRow) {
      throw new Error("Expected overview heading to be rendered inside a heading row.");
    }

    expect(overviewHeadingRow).toContainElement(personalCostBasisSwitch);
    expect(overviewHeadingRow).toHaveClass("sm:flex-row", "sm:justify-between");
    expect(screen.getAllByText("¥100 CNY").length).toBeGreaterThan(0);
    expect(screen.getByText("¥3.33")).toBeInTheDocument();
    expect(overviewHeading.closest("section")).toHaveTextContent(/活跃订阅.*月均支出 \(CNY\).*日均支出 \(CNY\).*年化支出 \(CNY\)/);

    await user.click(personalCostBasisSwitch);

    expect(await screen.findAllByText("¥40 CNY")).not.toHaveLength(0);
    expect(screen.getByText("¥1.33")).toBeInTheDocument();
  });

  it("disables position animation for all chart tooltips", () => {
    renderStatistics();

    expect(mocks.rechartsTooltipProps).toHaveLength(5);
    for (const props of mocks.rechartsTooltipProps) {
      expect(props["isAnimationActive"]).toBe(false);
      expect(props["offset"]).toBe(12);
      expect(props["allowEscapeViewBox"]).toEqual({ x: true, y: true });
      expect(props["wrapperStyle"]).toEqual({ pointerEvents: "none" });
    }
  });

  it("renders crisp donut charts without Recharts-managed legends", () => {
    renderStatistics();

    expect(mocks.rechartsLegendProps).toHaveLength(0);
    expect(mocks.rechartsPieChartProps).toHaveLength(3);
    expect(mocks.rechartsPieChartProps.map((props) => props["title"])).toEqual(["分类视图", "支付方式视图", "费用与预算"]);
    for (const props of mocks.rechartsPieChartProps) {
      expect(props).toEqual(
        expect.objectContaining({
          accessibilityLayer: true,
          margin: { top: 4, right: 4, bottom: 4, left: 4 },
          tabIndex: 0,
        }),
      );
    }
    expect(mocks.rechartsPieProps).toHaveLength(3);
    for (const props of mocks.rechartsPieProps) {
      expect(props).toEqual(
        expect.objectContaining({
          cy: "50%",
          innerRadius: "58%",
          outerRadius: "90%",
          rootTabIndex: -1,
          strokeWidth: 0,
        }),
      );
    }
    const visibleChartLegends = screen
      .getAllByRole("list")
      .filter((list) => list.getAttribute("aria-label") !== "未来 12 个月费用走势明细");
    expect(visibleChartLegends).toHaveLength(3);
  });

  it("gives Recharts positive dimensions before ResizeObserver reports layout", () => {
    renderStatistics();

    for (const frame of screen.getAllByTestId("statistics-chart-frame")) {
      expect(frame).toHaveClass("recharts-frame");
    }
    const donutContainerProps = mocks.rechartsResponsiveContainerProps.filter((props) => props["height"] === 220);
    expect(donutContainerProps).toHaveLength(3);
    for (const props of donutContainerProps) {
      const initialDimension = props["initialDimension"] as { width: number; height: number };

      expect(props).toEqual(
        expect.objectContaining({
          width: "100%",
          height: 220,
          minWidth: 0,
          debounce: 50,
        }),
      );
      expect(props["height"]).not.toBe("100%");
      expect(initialDimension.width).toBeGreaterThan(0);
      expect(initialDimension.height).toBe(220);
    }
  });

  it("renders the trend bar chart with cashflow by default and switches to amortized cost", async () => {
    const user = userEvent.setup();

    renderStatistics();

    expect(screen.getByRole("heading", { name: "费用走势" })).toBeInTheDocument();
    expect(screen.getByText("按未来 12 个月到期或续费日汇总预计扣费。")).toBeInTheDocument();
    const cashflowBarChartProps = mocks.rechartsBarChartProps.find((props) => props["title"] === "未来扣费");
    expect(cashflowBarChartProps).toEqual(
      expect.objectContaining({
        accessibilityLayer: true,
        title: "未来扣费",
        tabIndex: 0,
      }),
    );
    expect(mocks.rechartsBarProps).toContainEqual(
      expect.objectContaining({
        dataKey: "cashflow",
        fill: "hsl(var(--chart-1))",
        radius: [4, 4, 0, 0],
        isAnimationActive: false,
        activeBar: {
          fill: "hsl(var(--chart-1))",
          fillOpacity: 0.88,
          stroke: "hsl(var(--chart-1))",
          strokeOpacity: 0.5,
          strokeWidth: 1,
        },
      }),
    );
    expect(mocks.rechartsTooltipProps.filter((props) => props["cursor"] === false)).toHaveLength(2);
    expect(mocks.rechartsYAxisProps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        domain: [0, "dataMax"],
        width: 72,
      }),
    ]));

    await user.click(screen.getByRole("tab", { name: "月均摊销" }));

    expect(screen.getByText("按当前有效订阅组合估算未来 12 个月的月均成本归属。")).toBeInTheDocument();
    const lastBarChartProps = mocks.rechartsBarChartProps[mocks.rechartsBarChartProps.length - 1];
    const lastBarProps = mocks.rechartsBarProps[mocks.rechartsBarProps.length - 1];
    expect(lastBarChartProps).toEqual(expect.objectContaining({ title: "月均摊销" }));
    expect(lastBarProps).toEqual(expect.objectContaining({ dataKey: "amortized" }));
  });

  it("renders subscription breakdowns in the trend tooltip and screen-reader details", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: [
        subscription({ id: "monthly", name: "Monthly", price: "10", billingCycle: "monthly", nextBillingDate: assertDateOnly("2026-01-15") }),
        subscription({ id: "annual", name: "Annual", price: "120", billingCycle: "annual", nextBillingDate: assertDateOnly("2026-01-20") }),
      ],
      isPending: false,
    });

    try {
      renderStatistics();

      const tooltip = getLastTrendTooltip();
      expect(tooltip).toHaveTextContent("2026年1月");
      expect(tooltip).toHaveTextContent("未来扣费");
      expect(tooltip).toHaveTextContent("¥130 CNY");
      expect(tooltip).toHaveTextContent("Annual");
      expect(tooltip).toHaveTextContent("1月20日");
      expect(tooltip).toHaveTextContent("Monthly");
      expect(tooltip).toHaveTextContent("1月15日");
      const annualDateBadges = within(tooltip).getAllByText("1月20日");
      expect(annualDateBadges).toHaveLength(1);
      expect(within(tooltip).getAllByText("1月15日")).toHaveLength(1);
      const tooltipDateBadge = annualDateBadges[0];
      if (!tooltipDateBadge) {
        throw new Error("Expected trend tooltip to render a compact date badge.");
      }
      const tooltipBadgeCell = tooltipDateBadge.parentElement;
      const tooltipRow = tooltipBadgeCell?.parentElement;
      if (!tooltipBadgeCell || !tooltipRow) {
        throw new Error("Expected trend tooltip date badge to live inside a shared alignment grid.");
      }
      const tooltipList = tooltipRow.parentElement;
      if (!tooltipList) {
        throw new Error("Expected trend tooltip rows to share a grid container.");
      }
      expect(tooltipList).toHaveClass("grid-cols-[max-content_minmax(0,1fr)_auto]", "gap-x-2");
      expect(tooltipRow).toHaveClass("col-span-3", "grid-cols-subgrid");
      expect(tooltipBadgeCell).toHaveClass("min-w-0", "justify-self-start");
      expect(tooltipDateBadge).toHaveClass("inline-flex", "w-[6em]", "max-w-full", "h-5", "truncate", "rounded-full");
      expect(tooltipDateBadge).not.toHaveClass("w-max");
      expect(tooltipDateBadge).not.toHaveClass("w-full");
      expect(screen.getByRole("list", { name: "未来 12 个月费用走势明细" })).toHaveTextContent(
        "构成 Annual ¥120 CNY，1月20日；Monthly ¥10 CNY，1月15日",
      );
      expect(screen.getByRole("heading", { name: "2026年1月 明细" })).toBeInTheDocument();
      expect(screen.getByText("2 个订阅")).toBeInTheDocument();
      const detailsList = screen.getByRole("list", { name: "2026年1月 明细" });
      expect(within(detailsList).getAllByRole("listitem")).toHaveLength(2);
      expect(detailsList).toHaveTextContent("Annual");
      expect(detailsList).toHaveTextContent("Monthly");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the shared subscription detail dialog from a trend detail ledger row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: [
        subscription({ id: "monthly", name: "Monthly", price: "10", billingCycle: "monthly", nextBillingDate: assertDateOnly("2026-01-15") }),
        subscription({ id: "annual", name: "Annual", price: "120", billingCycle: "annual", nextBillingDate: assertDateOnly("2026-01-20") }),
      ],
      isPending: false,
    });

    try {
      renderStatistics();

      const tooltip = getLastTrendTooltip();
      expect(within(tooltip).queryByRole("button", { name: "查看 Annual 的详情" })).not.toBeInTheDocument();

      const detailsList = screen.getByRole("list", { name: "2026年1月 明细" });
      const annualAction = within(detailsList).getByRole("button", { name: "查看 Annual 的详情" });
      expect(annualAction).toHaveClass("grid", "cursor-pointer", "focus-visible:ring-2");

      fireEvent.click(annualAction);

      expect(screen.getByTestId("subscription-detail-dialog")).toHaveTextContent("Annual 详情 USD");

      fireEvent.click(screen.getByRole("button", { name: "编辑详情 Annual" }));
      expect(mocks.handleEditSubscription).toHaveBeenCalledWith("annual");

      fireEvent.click(screen.getByRole("button", { name: "续费详情 Annual" }));
      expect(mocks.handleRenewSubscription).toHaveBeenCalledWith("annual");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows all trend details outside the tooltip and keeps long names constrained", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const longName =
      "ExtremelyLongSubscriptionNameWithoutSpacesThatShouldNotPushTheAmountColumnOutOfTheDetailsPanel";
    mocks.useSubscriptionAnalytics.mockReturnValue({
      data: Array.from({ length: 7 }, (_, index) => subscription({
        id: `sub-${index}`,
        name: index === 6 ? longName : `Service ${index + 1}`,
        price: String(10 + index),
        billingCycle: "monthly",
        nextBillingDate: assertDateOnly("2026-01-10"),
      })),
      isPending: false,
    });

    try {
      renderStatistics();

      const overflowTooltip = getLastTrendTooltip();
      expect(overflowTooltip).toHaveTextContent("还有 2 个订阅");
      expect(within(overflowTooltip).getByText("还有 2 个订阅")).toHaveClass("col-span-3");
      const januaryDetails = screen.getByRole("list", { name: "2026年1月 明细" });
      const januaryLedger = januaryDetails.parentElement;
      if (!januaryLedger) {
        throw new Error("Expected trend details list to be rendered inside a ledger surface.");
      }
      expect(januaryLedger).toHaveClass("overflow-hidden", "rounded-xl", "border", "border-border/70", "bg-background/40");
      const januaryLedgerHeader = januaryLedger.firstElementChild;
      if (!januaryLedgerHeader) {
        throw new Error("Expected trend details ledger to include a compact summary header.");
      }
      expect(januaryLedgerHeader).toHaveClass("grid", "border-b", "border-border/60", "bg-secondary/15");
      expect(within(januaryLedger).getByText("¥91 CNY")).toHaveClass("text-xl", "sm:text-2xl", "tabular-nums");
      expect(januaryDetails).toHaveClass("grid", "max-h-72", "min-w-0", "overflow-y-auto");
      expect(within(januaryDetails).getAllByRole("listitem")).toHaveLength(7);
      expect(januaryDetails).toHaveTextContent("Service 1");
      expect(januaryDetails).toHaveTextContent(longName);

      const truncatedLongName = within(januaryDetails).getByText(longName);
      expect(truncatedLongName).toHaveAttribute("data-slot", "truncated-tooltip-text");
      expect(truncatedLongName).toHaveClass("truncate", "max-w-full");
      const longNameRow = truncatedLongName.closest("[role='listitem']");
      if (!longNameRow) {
        throw new Error("Expected long trend detail name to be rendered inside a list item.");
      }
      expect(longNameRow).toHaveClass("border-b", "border-border/60");
      const longNameAction = within(longNameRow as HTMLElement).getByRole("button", { name: `查看 ${longName} 的详情` });
      expect(longNameAction).toHaveClass(
        "grid",
        "w-full",
        "min-w-0",
        "grid-cols-[max-content_minmax(0,1fr)_auto]",
        "@max-sm/statistics-trend:grid-cols-[minmax(0,1fr)_auto]",
        "hover:bg-secondary/25",
        "focus-visible:ring-2",
        "cursor-pointer",
      );
      const detailDateBadge = within(longNameAction).getByText("1月10日");
      const detailBadgeCell = detailDateBadge.parentElement;
      if (!detailBadgeCell) {
        throw new Error("Expected trend detail date badge to live inside a shared alignment grid.");
      }
      expect(detailBadgeCell).toHaveClass("min-w-0", "justify-self-start", "@max-sm/statistics-trend:col-span-2");
      expect(detailDateBadge).toHaveClass("inline-flex", "w-[6em]", "max-w-full", "h-6", "truncate", "rounded-full");
      expect(detailDateBadge).not.toHaveClass("w-max");
      expect(detailDateBadge).not.toHaveClass("w-full");
      expect(within(longNameAction).getByText("¥16 CNY")).toHaveClass("shrink-0", "whitespace-nowrap", "tabular-nums");
      expect(within(longNameAction).getByText("18%")).toHaveClass("tabular-nums");
      expect(longNameAction).toHaveTextContent("占比 18%");

      vi.useRealTimers();
      const user = userEvent.setup();
      await user.click(screen.getByRole("combobox", { name: "月份" }));
      await user.click(await screen.findByRole("option", { name: "2026年2月" }));

      expect(screen.getByRole("heading", { name: "2026年2月 明细" })).toBeInTheDocument();
      expect(screen.getByRole("list", { name: "2026年2月 明细" })).toHaveTextContent("2月10日");

      await user.click(screen.getByRole("tab", { name: "月均摊销" }));

      expect(screen.getByText("按当前有效订阅组合估算未来 12 个月的月均成本归属。")).toBeInTheDocument();
      const tooltip = getLastTrendTooltip();
      expect(tooltip).toHaveTextContent("月均摊销");
      expect(within(tooltip).getAllByText("月均").length).toBeGreaterThan(0);
      expect(within(tooltip).queryByText("月均归属")).not.toBeInTheDocument();
      expect(tooltip).toHaveTextContent("还有 2 个订阅");
      expect(screen.getByRole("heading", { name: "2026年2月 明细" })).toBeInTheDocument();
      expect(screen.getByRole("list", { name: "2026年2月 明细" })).toHaveTextContent("月均");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the trend chart positive dimensions before ResizeObserver reports layout", () => {
    renderStatistics();

    expect(screen.getByTestId("statistics-trend-chart-frame")).toHaveClass("recharts-frame");
    const trendFrameProps = mocks.rechartsResponsiveContainerProps.find((props) => props["height"] === 280);
    expect(trendFrameProps).toEqual(
      expect.objectContaining({
        width: "100%",
        height: 280,
        minWidth: 0,
        debounce: 50,
      }),
    );
    const initialDimension = trendFrameProps?.["initialDimension"] as { width: number; height: number };
    expect(initialDimension.width).toBeGreaterThan(0);
    expect(initialDimension.height).toBe(280);
  });

  it("uses the same subtle hover feedback as the dashboard spending chart", () => {
    renderStatistics();

    expect(mocks.rechartsCellProps.length).toBeGreaterThan(0);
    for (const props of mocks.rechartsCellProps) {
      expect(props["focusable"]).toBe(false);
      expect(props["className"]).toBe("transition-all duration-300 hover:opacity-80");
    }
  });

  it("makes the inactive annual savings explanation keyboard reachable", async () => {
    const user = userEvent.setup();

    renderStatistics();

    expect(screen.getByText("停用年节省")).toBeInTheDocument();
    expect(screen.getByText("¥360 CNY")).toBeInTheDocument();

    const annualHelp = screen.getByRole("button", { name: "说明：停用年节省" });
    for (let attempt = 0; attempt < 10 && document.activeElement !== annualHelp; attempt += 1) {
      await user.tab();
    }

    expect(annualHelp).toHaveFocus();
    expect(await screen.findAllByText("停用月节省乘以 12，用于估算一年少支出的订阅费用。")).not.toHaveLength(0);
  });
});
