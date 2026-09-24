import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { CustomConfig } from "@/types/config";
import { DEFAULT_SETTINGS, type Subscription } from "@/types/subscription";
import { appSettingsSecretStatus } from "@renewlet/shared/schemas/settings";
import type { SubscriptionListFilters } from "@/services/subscription-service";
import type { SettingsReadModel } from "@/services/settings-service";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import {
  subscriptionFacetsQueryFixture,
  subscriptionIndexQueryFixture,
} from "./subscriptions.test-fixtures";
import Subscriptions from "./subscriptions";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;
interface MockInfiniteSubscriptionsResult {
  subscriptions?: Subscription[];
  total?: number;
  isPending: boolean;
}
type MockSettingsEnvelopeResult = { data?: SettingsReadModel };
type MockSubscriptionIndexResult = ReturnType<typeof subscriptionIndexQueryFixture>;
type MockSubscriptionFacetsResult = ReturnType<typeof subscriptionFacetsQueryFixture>;

const mocks = vi.hoisted(() => ({
  useInfiniteSubscriptions: vi.fn<() => MockInfiniteSubscriptionsResult>(),
  useSubscriptionIndex: vi.fn<(filters?: SubscriptionListFilters) => MockSubscriptionIndexResult>(),
  useSubscriptionFacets: vi.fn<() => MockSubscriptionFacetsResult>(),
  useSettingsEnvelope: vi.fn<() => MockSettingsEnvelopeResult>(),
  handleAddSubscription: vi.fn(),
  handleDeleteSubscription: vi.fn(),
  handleEditSubscription: vi.fn(),
  handleTogglePinnedSubscription: vi.fn(),
  handleTogglePublicHiddenSubscription: vi.fn(),
  handleSaveSubscription: vi.fn(),
  handleEditDialogOpenChange: vi.fn(),
  exportToJSON: vi.fn(),
  exportToJSONWithSecrets: vi.fn(),
  exportToCSV: vi.fn(),
  customConfig: {
    // 长分类墙复现默认内置分类数量，专门覆盖桌面 Popover 超过首屏时的滚动布局。
    categories: ([
      ["productivity", "生产力", "Productivity", "hsl(200 80% 50%)"],
      ["entertainment", "娱乐", "Entertainment", "hsl(280 70% 55%)"],
      ["lifestyle", "生活", "Lifestyle", "hsl(35 90% 55%)"],
      ["finance", "财务", "Finance", "hsl(160 84% 45%)"],
      ["streaming", "影音流媒体", "Streaming", "hsl(355 78% 58%)"],
      ["music", "音乐", "Music", "hsl(320 70% 55%)"],
      ["gaming", "游戏", "Gaming", "hsl(250 80% 60%)"],
      ["utilities", "公用事业", "Utilities", "hsl(210 18% 48%)"],
      ["cloud_storage", "云存储", "Cloud storage", "hsl(205 85% 54%)"],
      ["education", "教育", "Education", "hsl(45 90% 52%)"],
      ["health_fitness", "健康健身", "Health & fitness", "hsl(145 70% 45%)"],
      ["food_dining", "餐饮", "Food & dining", "hsl(18 85% 56%)"],
      ["shopping", "购物", "Shopping", "hsl(330 72% 56%)"],
      ["travel", "旅行出行", "Travel", "hsl(190 76% 45%)"],
      ["business", "商务", "Business", "hsl(225 58% 52%)"],
      ["communication", "通讯与邮件", "Communication", "hsl(175 68% 42%)"],
      ["developer_tools", "开发工具", "Developer tools", "hsl(265 68% 58%)"],
      ["design", "设计创意", "Design", "hsl(12 78% 60%)"],
      ["ai_tools", "AI 工具", "AI tools", "hsl(275 76% 62%)"],
      ["security_vpn", "安全与 VPN", "Security & VPN", "hsl(350 75% 55%)"],
      ["hosting_domains", "域名与托管", "Hosting & domains", "hsl(32 86% 50%)"],
      ["news_media", "新闻媒体", "News media", "hsl(215 72% 55%)"],
      ["other", "其他", "Other", "hsl(220 12% 55%)"],
    ] as const).map(([value, zhCN, enUS, color]) => ({
      id: value,
      value,
      labels: { "zh-CN": zhCN, "en-US": enUS },
      color,
    })),
    statuses: [],
    paymentMethods: [],
    currencies: [] as CustomConfig["currencies"],
  },
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

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({ config: mocks.customConfig }),
  useLunarCalendar: () => ({ enabled: false, supported: true }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: () => ({
    editingSubscription: undefined,
    editDialogOpen: false,
    handleAddSubscription: mocks.handleAddSubscription,
    handleDeleteSubscription: mocks.handleDeleteSubscription,
    handleEditSubscription: mocks.handleEditSubscription,
    handleTogglePinnedSubscription: mocks.handleTogglePinnedSubscription,
    handleTogglePublicHiddenSubscription: mocks.handleTogglePublicHiddenSubscription,
    handleSaveSubscription: mocks.handleSaveSubscription,
    handleEditDialogOpenChange: mocks.handleEditDialogOpenChange,
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-export", () => ({
  useSubscriptionExport: () => ({
    exportToJSON: mocks.exportToJSON,
    exportToJSONWithSecrets: mocks.exportToJSONWithSecrets,
    exportToCSV: mocks.exportToCSV,
  }),
}));

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/components/subscription-card", () => ({
  SubscriptionCard: ({ subscription }: { subscription: Subscription }) => (
    <article data-testid="subscription-card">{subscription.name}</article>
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

function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  const base: SubscriptionBaseFixture = {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "USD",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    pinned: false,
    publicHidden: false,
  };

  return {
    ...base,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

function renderSubscriptionsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <div id="root" style={{ height: 800, overflowY: "auto" }}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TooltipProvider delayDuration={0}>
            <Subscriptions />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </div>,
  );
}

function visibleSubscriptionNames() {
  return screen.getAllByTestId("subscription-card").map((card) => card.textContent ?? "");
}

function expectAdvancedOptionRowsContainCodes(container: HTMLElement, codes: string[]) {
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-advanced-option-row]"));
  expect(rows).toHaveLength(codes.length);
  codes.forEach((code, index) => {
    const row = rows[index];
    expect(row).toBeDefined();
    expect(row!).toHaveTextContent(code);
  });
}

// 这里锁的是“外框限高 + 中间唯一滚动区”的结构契约，不是装饰性 Tailwind 快照。
function expectDesktopFilterPopoverFrame(contentTestId: string, scrollTestId: string) {
  const popover = screen.getByTestId(contentTestId);
  const scroll = screen.getByTestId(scrollTestId);

  expect(popover).toHaveClass(
    "flex",
    "max-h-[min(calc(var(--app-viewport-height)-1rem),var(--radix-popover-content-available-height,32rem))]",
    "flex-col",
    "overflow-hidden",
  );
  expect(scroll).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  expect(scroll).not.toHaveClass("max-h-72");

  return { popover, scroll };
}

function mockMobileTagFilterMatch(isMobile: boolean, width = isMobile ? 390 : 1280) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        query === "(max-width: 767px)"
          ? isMobile
          : query === "(min-width: 640px)"
            ? width >= 640
            : query === "(min-width: 1024px)"
              ? width >= 1024
              : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("Subscriptions page category filters", () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= vi.fn(() => false);
    Element.prototype.setPointerCapture ??= vi.fn();
    Element.prototype.releasePointerCapture ??= vi.fn();
    Element.prototype.scrollIntoView ??= vi.fn();
  });

  beforeEach(() => {
    mocks.customConfig.currencies = [];
    mocks.useSubscriptionIndex.mockImplementation((filters) =>
      subscriptionIndexQueryFixture(mocks.useInfiniteSubscriptions().subscriptions ?? [], filters));
    mocks.useSubscriptionFacets.mockImplementation(() =>
      subscriptionFacetsQueryFixture(mocks.useInfiniteSubscriptions().subscriptions ?? []));
    const settings = {
      ...DEFAULT_SETTINGS,
      timezone: "Asia/Shanghai",
      defaultCurrency: "CNY",
      notificationReminderDays: 5,
    };
    mocks.useSettingsEnvelope.mockReturnValue({
      data: {
        settings,
        secretStatus: appSettingsSecretStatus(settings),
      },
    });
    mocks.useInfiniteSubscriptions.mockReturnValue({
      subscriptions: [
        subscription({
          id: "docs",
          name: "Docs Notes",
          category: "productivity",
          tags: ["Docs", "Planning", "Research", "Writing", "Archive"],
        }),
        subscription({
          id: "budget",
          name: "Budget Vault",
          category: "finance",
          tags: ["Budget", "Finance Ops", "Tax", "Receipt", "Invoice"],
        }),
        subscription({
          id: "sheet",
          name: "Finance Sheet",
          category: "finance",
          tags: ["Sheets", "Reports", "Forecast", "Audit"],
        }),
        subscription({
          id: "music",
          name: "Music Box",
          category: "music",
          tags: ["Music", "Family", "Shared", "Offline"],
        }),
      ],
      isPending: false,
    });
  });

  it("filters desktop subscriptions from a searchable multi-category popover", async () => {
    const user = userEvent.setup();
    mockMobileTagFilterMatch(false);
    renderSubscriptionsPage();

    const desktopCategoryFilter = screen.getByTestId("desktop-category-filter");
    expect(within(desktopCategoryFilter).getByRole("button", { name: "分类" })).toBeInTheDocument();

    await user.click(within(desktopCategoryFilter).getByRole("button", { name: "分类" }));
    const { scroll: categoryScroll } = expectDesktopFilterPopoverFrame(
      "desktop-category-filter-popover",
      "desktop-category-filter-scroll",
    );
    expect(within(categoryScroll).getByText("开发工具")).toBeInTheDocument();
    const searchInput = await screen.findByPlaceholderText("搜索分类...");
    await user.type(searchInput, "财");
    expect(screen.queryByText("生产力")).not.toBeInTheDocument();
    await user.click(screen.getByText("财务"));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Budget Vault", "Finance Sheet"]);
    });
    expect(screen.getByTestId("desktop-category-filter-footer")).toHaveClass("shrink-0", "border-t");
    expect(within(desktopCategoryFilter).getByRole("button", { name: "财务" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索分类...")).toBeInTheDocument();

    await user.clear(searchInput);
    await user.click(await screen.findByText("生产力"));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Docs Notes", "Budget Vault", "Finance Sheet"]);
    });
    expect(within(desktopCategoryFilter).getByRole("button", { name: "分类(2)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清空分类" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Docs Notes", "Budget Vault", "Finance Sheet", "Music Box"]);
    });
    expect(within(desktopCategoryFilter).getByRole("button", { name: "分类" })).toBeInTheDocument();
  });

  it("uses page, index, and facets totals for their distinct count meanings", async () => {
    const user = userEvent.setup();
    const page = mocks.useInfiniteSubscriptions();
    mocks.useInfiniteSubscriptions.mockReturnValue({ ...page, total: 120 });
    mocks.useSubscriptionFacets.mockReturnValue({
      ...subscriptionFacetsQueryFixture(page.subscriptions ?? []),
      data: { ...subscriptionFacetsQueryFixture(page.subscriptions ?? []).data, total: 120 },
    });
    mockMobileTagFilterMatch(false);
    renderSubscriptionsPage();

    expect(screen.getByText("共 120 个订阅")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "Docs");
    expect(await screen.findByText("共 1 个订阅 （从 120 个中筛选）")).toBeInTheDocument();
  });

  it("applies mobile category drawer selections after confirmation", async () => {
    const user = userEvent.setup();
    mockMobileTagFilterMatch(true);
    renderSubscriptionsPage();

    const mobileCategoryFilter = screen.getByTestId("mobile-category-filter");
    expect(within(mobileCategoryFilter).getByRole("button", { name: "分类" })).toBeInTheDocument();

    await user.click(within(mobileCategoryFilter).getByRole("button", { name: "分类" }));
    const drawer = await screen.findByRole("dialog", { name: "筛选分类" });
    const searchInput = screen.getByPlaceholderText("搜索分类...");
    await user.type(searchInput, "财");
    await user.click(screen.getByText("财务"));

    expect(drawer).toBeInTheDocument();
    expect(visibleSubscriptionNames()).toEqual(["Docs Notes", "Budget Vault", "Finance Sheet", "Music Box"]);

    await user.clear(searchInput);
    await user.click(await screen.findByText("生产力"));

    expect(drawer).toBeInTheDocument();
    expect(visibleSubscriptionNames()).toEqual(["Docs Notes", "Budget Vault", "Finance Sheet", "Music Box"]);
    await user.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => {
      expect(drawer).not.toBeInTheDocument();
      expect(visibleSubscriptionNames()).toEqual(["Docs Notes", "Budget Vault", "Finance Sheet"]);
    });
    expect(within(mobileCategoryFilter).getByRole("button", { name: "分类(2)" })).toBeInTheDocument();
  });

  it("clears category and tag filters together", async () => {
    const user = userEvent.setup();
    mockMobileTagFilterMatch(false);
    renderSubscriptionsPage();

    const desktopCategoryFilter = screen.getByTestId("desktop-category-filter");
    await user.click(within(desktopCategoryFilter).getByRole("button", { name: "分类" }));
    await user.click(await screen.findByText("财务"));

    const desktopTagFilter = screen.getByTestId("desktop-tag-filter");
    await user.click(within(desktopTagFilter).getByRole("button", { name: "标签" }));
    const { scroll: tagScroll } = expectDesktopFilterPopoverFrame(
      "desktop-tag-filter-popover",
      "desktop-tag-filter-scroll",
    );
    expect(within(tagScroll).getByRole("button", { name: "Finance Ops" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Budget" }));
    expect(screen.getByTestId("desktop-tag-filter-footer")).toHaveClass("shrink-0", "border-t");

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Budget Vault"]);
    });

    await user.click(screen.getByRole("button", { name: "清除筛选" }));

    await waitFor(() => {
      expect(visibleSubscriptionNames()).toEqual(["Docs Notes", "Budget Vault", "Finance Sheet", "Music Box"]);
    });
    expect(within(desktopCategoryFilter).getByRole("button", { name: "分类" })).toBeInTheDocument();
    expect(within(desktopTagFilter).getByRole("button", { name: "标签" })).toBeInTheDocument();
    expect(screen.queryByTestId("desktop-selected-tags")).not.toBeInTheDocument();
  });

  it("keeps desktop advanced currency options in persisted manager order", async () => {
    const user = userEvent.setup();
    mocks.customConfig.currencies = [
      { id: "AUD", value: "AUD", labels: { "zh-CN": "AUD", "en-US": "AUD" }, enabled: true },
      { id: "CAD", value: "CAD", labels: { "zh-CN": "CAD", "en-US": "CAD" }, enabled: true },
      { id: "USD", value: "USD", labels: { "zh-CN": "USD", "en-US": "USD" }, enabled: true },
      { id: "EUR", value: "EUR", labels: { "zh-CN": "EUR", "en-US": "EUR" }, enabled: true },
    ];
    mockMobileTagFilterMatch(false);
    renderSubscriptionsPage();

    await user.click(within(screen.getByTestId("desktop-advanced-filter")).getByRole("button"));
    await user.click(await within(screen.getByTestId("desktop-advanced-filter-panel")).findByTestId("advanced-currency-entry"));

    const currencyList = within(screen.getByTestId("advanced-currency-dialog")).getByTestId("advanced-currency-picker");
    expectAdvancedOptionRowsContainCodes(
      within(currencyList).getByTestId("advanced-currency-picker-all-options"),
      ["AUD", "CAD", "USD", "EUR"],
    );

    await user.type(within(currencyList).getByPlaceholderText(/Filter currencies|筛选货币/), "$");

    expectAdvancedOptionRowsContainCodes(
      within(currencyList).getByTestId("advanced-currency-picker-search-results"),
      ["AUD", "CAD", "USD"],
    );
  });
});
