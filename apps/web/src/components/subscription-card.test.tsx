// 订阅卡片测试保护有效状态、公开隐藏、菜单操作和日历入口，避免列表展示与 domain 状态计算分叉。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  baseSubscription,
  expectMetaFlowItemsInOrder,
  mediaUtilitiesCss,
  openMoreActionsMenu,
  renderSubscriptionCard,
  setSubscriptionCardTestMocks,
} from "./subscription-card.test-utils";

const mocks = vi.hoisted(() => {
  const longCategoryLabel = "生产力平台和开发者基础设施";
  const shortCategoryLabel = "生产力";
  const creditCardLabel = "信用卡";
  const longPaymentMethodLabel = "Google Pay 企业共享付款方式";

  return {
    longCategoryLabel,
    shortCategoryLabel,
    creditCardLabel,
    longPaymentMethodLabel,
    categories: [
      {
        id: "developer-tools",
        value: "developer-tools",
        labels: { "zh-CN": longCategoryLabel, "en-US": longCategoryLabel },
        color: "hsl(200 80% 50%)",
      },
      {
        id: "productivity",
        value: "productivity",
        labels: { "zh-CN": shortCategoryLabel, "en-US": shortCategoryLabel },
        color: "hsl(200 80% 50%)",
      },
    ],
    paymentMethods: [
      {
        id: "credit-card",
        value: "credit_card",
        labels: { "zh-CN": creditCardLabel, "en-US": creditCardLabel },
        icon: "/icons/payment-methods/credit_card.svg",
      },
      {
        id: "google-pay",
        value: "google_pay",
        labels: { "zh-CN": longPaymentMethodLabel, "en-US": longPaymentMethodLabel },
        icon: "/icons/payment-methods/google_pay.svg",
      },
    ],
  };
});

setSubscriptionCardTestMocks(mocks);

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: mocks.categories,
      statuses: [],
      paymentMethods: mocks.paymentMethods,
      currencies: [],
    },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { notificationReminderDays: 5 },
  }),
}));

describe("SubscriptionCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the card body free of global settings and config hooks", () => {
    const source = readFileSync(join(process.cwd(), "src/components/subscription-card.tsx"), "utf8");

    expect(source).not.toContain("useSettings");
    expect(source).not.toContain("useCustomConfig");
  });

  it("keeps the mobile card header from forcing price or meta rows into a single-column layout", () => {
    const source = readFileSync(join(process.cwd(), "src/components/subscription-card.tsx"), "utf8");

    renderSubscriptionCard({ name: "Figma Professional", paymentMethod: "credit_card" });

    const card = screen.getByTestId("subscription-card");
    const metaFlow = screen.getByTestId("subscription-card-meta-flow");
    const dateGroup = screen.getByTestId("subscription-card-meta-date-group");
    const startDateMeta = screen.getByTestId("subscription-card-meta-start-date");
    const billingDateMeta = screen.getByTestId("subscription-card-meta-billing-date");
    const dailyAverageMeta = screen.getByTestId("subscription-card-meta-daily-average");
    const paymentMethodMeta = screen.getByTestId("subscription-card-meta-payment-method");
    const badgeFlow = screen.getByTestId("subscription-card-badge-flow");

    expect(source).not.toContain("@container/subscription-card");
    expect(source).not.toContain("@max-xs/subscription-card");
    expect(card.getAttribute("class")).not.toContain("@container/subscription-card");
    expect(metaFlow).toHaveClass("flex", "flex-wrap");
    expect(metaFlow.getAttribute("class")).not.toContain("@max-xs/subscription-card");
    expect(dateGroup).toHaveClass("inline-flex", "min-w-0", "max-w-full", "flex-[0_1_auto]", "flex-wrap");
    expect(dateGroup).toContainElement(startDateMeta);
    expect(dateGroup).toContainElement(billingDateMeta);
    expect(metaFlow).toContainElement(paymentMethodMeta);
    expect(metaFlow).toContainElement(dailyAverageMeta);
    expect(dateGroup).not.toContainElement(paymentMethodMeta);
    expect(dateGroup).not.toContainElement(dailyAverageMeta);
    expect(dailyAverageMeta).toHaveClass("tabular-nums");
    expect(paymentMethodMeta).toHaveClass("min-w-0", "max-w-full");
    expect(paymentMethodMeta).not.toHaveClass("shrink-0");
    expect(badgeFlow).toHaveClass("col-span-full", "flex", "flex-wrap", "gap-x-1.5", "gap-y-2", "sm:gap-2");
  });

  it("renders subscription logos through the unified theme-aware logo surface", () => {
    renderSubscriptionCard({ logo: "https://example.com/apple-tv.svg", name: "Apple TV" });

    const logo = screen.getByAltText("Apple TV");
    const logoTile = logo.closest(".subscription-logo-tile");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logo).not.toHaveClass("media-thumbnail-image", "invert", "brightness-125", "mix-blend-screen");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
    expect(logoTile).not.toHaveClass("bg-linear-to-br");
    expect(logoTile?.getAttribute("style")).not.toContain("accent");
  });

  it("keeps real subscription logo styling as one plate without an inner pseudo-element", () => {
    expect(mediaUtilitiesCss).not.toContain(".subscription-logo-tile::before");
    expect(mediaUtilitiesCss).not.toContain(".dark .subscription-logo-tile::before");
    expect(mediaUtilitiesCss).not.toMatch(/\.subscription-logo-tile\s*{[^}]*media-thumbnail-canvas/s);
    expect(mediaUtilitiesCss).not.toMatch(/\.subscription-logo-tile\s*{[^}]*(::before|::after)/s);
    expect(mediaUtilitiesCss).toMatch(/\.subscription-logo-tile\s*{[^}]*background:\s*hsl\(/s);
    expect(mediaUtilitiesCss).toMatch(/\.dark \.subscription-logo-tile\s*{[^}]*background:\s*hsl\(210 18% 90% \/ 0\.88\)/s);
    expect(mediaUtilitiesCss).toMatch(/\.dark \.subscription-logo-image\s*{[^}]*drop-shadow/s);
    expect(mediaUtilitiesCss).toMatch(/\.subscription-logo-image\s*{[^}]*drop-shadow/s);
    expect(mediaUtilitiesCss).not.toMatch(/\.subscription-logo-image\s*{[^}]*(mix-blend|invert|brightness|contrast|saturate)/s);
  });

  it("uses the same unified logo surface for white transparent logos", () => {
    renderSubscriptionCard({ logo: "https://example.com/white-logo.svg", name: "ngrok" });

    const logo = screen.getByAltText("ngrok");
    const logoTile = logo.closest(".subscription-logo-tile");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
    expect(logoTile?.getAttribute("style")).not.toContain("accent");
  });

  it("keeps the initials fallback inside the unified logo surface", () => {
    renderSubscriptionCard({ name: "dmit", logo: undefined });

    const initials = screen.getByText("DM");
    const logoTile = initials.closest(".subscription-logo-tile");

    expect(initials).toHaveClass("subscription-logo-fallback");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("bg-linear-to-br");
  });

  it("shows pin actions from the card menu", () => {
    const onTogglePinned = vi.fn();
    renderSubscriptionCard({ pinned: false }, { onTogglePinned });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));

    expect(onTogglePinned).toHaveBeenCalledWith("sub-1");
  });

  it("shows unpin actions for pinned subscriptions", () => {
    renderSubscriptionCard({ pinned: true }, { onTogglePinned: vi.fn() });

    openMoreActionsMenu();

    expect(screen.getByRole("menuitem", { name: "取消置顶" })).toBeInTheDocument();
  });

  it("toggles public visibility from the card menu", () => {
    const onTogglePublicHidden = vi.fn();
    renderSubscriptionCard({ publicHidden: false }, { onTogglePublicHidden });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "从公开页隐藏" }));

    expect(onTogglePublicHidden).toHaveBeenCalledWith("sub-1");
  });

  it("shows a public reveal action for hidden subscriptions", () => {
    renderSubscriptionCard({ publicHidden: true }, { onTogglePublicHidden: vi.fn() });

    openMoreActionsMenu();

    expect(screen.getByRole("menuitem", { name: "在公开页展示" })).toBeInTheDocument();
  });

  it("shows a title pin without adding card-level pinned accents", () => {
    renderSubscriptionCard({ pinned: true, category: "productivity" }, { onTogglePinned: vi.fn() });

    const pinnedIcon = screen.getByTestId("subscription-pinned-title-icon");
    const subscriptionName = screen.getByText(baseSubscription.name);
    const card = screen.getByTestId("subscription-card");
    const cardContent = card.firstElementChild;

    expect(screen.queryByTestId("subscription-pinned-accent")).not.toBeInTheDocument();
    expect(pinnedIcon).toHaveClass("h-3.5", "w-3.5", "shrink-0", "text-primary");
    expect(pinnedIcon).toHaveAttribute("aria-hidden", "true");
    expect(pinnedIcon.compareDocumentPosition(subscriptionName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("置顶")).toHaveClass("sr-only");
    expect(cardContent).toHaveClass("relative", "z-10", "flex", "items-start", "gap-4");
    expect(cardContent).not.toHaveClass("pt-7");
  });

  it("does not show pinned accents or reserve space for regular subscriptions", () => {
    renderSubscriptionCard({ pinned: false }, { onTogglePinned: vi.fn() });

    const card = screen.getByTestId("subscription-card");
    const cardContent = card.firstElementChild;

    expect(screen.queryByTestId("subscription-pinned-accent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subscription-pinned-title-icon")).not.toBeInTheDocument();
    expect(screen.queryByText("置顶")).not.toBeInTheDocument();
    expect(cardContent).not.toHaveClass("pt-7");
  });

  it("keeps category and status badges separate from the pinned state", () => {
    renderSubscriptionCard({ pinned: true, category: "productivity" }, { onTogglePinned: vi.fn() });

    const categoryBadge = screen.getByText(mocks.shortCategoryLabel).closest("div");
    const badgeGroup = categoryBadge?.parentElement;
    const statusBadge = screen.getByText("活跃").closest("div");
    if (!categoryBadge || !badgeGroup || !statusBadge) {
      throw new Error("Expected category and status badges to render.");
    }

    expect(badgeGroup).toHaveTextContent(mocks.shortCategoryLabel);
    expect(badgeGroup).toHaveTextContent("活跃");
    expect(badgeGroup).not.toHaveTextContent("置顶");
    expect(categoryBadge.compareDocumentPosition(statusBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides pin actions when the card is rendered without a pin handler", () => {
    renderSubscriptionCard();

    openMoreActionsMenu();

    expect(screen.queryByRole("menuitem", { name: "置顶" })).not.toBeInTheDocument();
  });

  it("falls back to initials when the subscription logo fails to load", () => {
    renderSubscriptionCard({ logo: "https://example.com/broken.svg", name: "OpenAI" });

    fireEvent.error(screen.getByAltText("OpenAI"));

    const initials = screen.getByText("OP");
    expect(initials).toHaveClass("subscription-logo-fallback");
    expect(initials.closest(".subscription-logo-tile")).not.toBeNull();
  });

  it("lets the badge group use the full header width before wrapping", () => {
    renderSubscriptionCard();

    const categoryText = screen.getByText(mocks.longCategoryLabel);
    const categoryBadge = categoryText.closest("div");
    const badgeGroup = categoryBadge?.parentElement;
    const statusBadge = screen.getByText("活跃").closest("div");
    const subscriptionName = screen.getByText(baseSubscription.name);

    expect(badgeGroup).toHaveClass("col-span-full", "flex", "flex-wrap", "items-center", "gap-x-1.5", "gap-y-2", "sm:gap-2");
    expect(badgeGroup).not.toHaveClass("overflow-hidden");
    expect(subscriptionName).toHaveAttribute("data-slot", "truncated-tooltip-text");
    expect(subscriptionName).not.toHaveAttribute("title");
    expect(categoryBadge).not.toHaveAttribute("title");
    expect(categoryBadge).toHaveClass(
      "max-w-full",
      "shrink-0",
      "overflow-hidden",
      "whitespace-nowrap",
      "px-2",
      "sm:px-2.5",
    );
    expect(categoryBadge).not.toHaveClass("min-w-14", "max-w-30");
    expect(categoryText).toHaveClass("block", "max-w-full", "truncate");
    expect(statusBadge).toHaveClass("shrink-0", "whitespace-nowrap");
  });

  it("shows short category labels inside the badge", () => {
    renderSubscriptionCard({ category: "productivity" });

    const categoryText = screen.getByText(mocks.shortCategoryLabel);
    const categoryBadge = categoryText.closest("div");

    expect(categoryBadge).toHaveTextContent(mocks.shortCategoryLabel);
    expect(categoryBadge).not.toHaveAttribute("title");
    expect(categoryBadge).not.toHaveClass("min-w-14", "max-w-30");
    expect(categoryText).toHaveAttribute("data-slot", "truncated-tooltip-text");
    expect(categoryText).toHaveClass("block", "max-w-full", "truncate");
  });

  it("always exposes the overflow menu trigger", () => {
    renderSubscriptionCard();

    const menuButton = screen.getByRole("button", { name: "更多操作" });

    expect(menuButton).toHaveClass("h-8", "w-8", "shrink-0");
    expect(menuButton).not.toHaveClass("opacity-0");
    expect(menuButton.getAttribute("class")).not.toContain("group-hover:opacity-100");
  });

  it("shows the configured reference amount under the billing cycle for foreign-currency subscriptions", () => {
    renderSubscriptionCard({ price: "10", currency: "USD" }, {}, { priceReferenceCurrency: "CNY" });

    const priceBlock = screen.getByText("$10 USD").parentElement;
    if (!priceBlock) throw new Error("Missing subscription price block");

    expect(within(priceBlock).getByText("每月")).toBeInTheDocument();
    expect(within(priceBlock).getByText("≈ ¥70 CNY")).toHaveClass(
      "text-xs",
      "tabular-nums",
      "text-muted-foreground",
    );
  });

  it("hides the reference amount for same-currency subscriptions, disabled settings, and while rates are not ready", () => {
    renderSubscriptionCard({ price: "10", currency: "CNY" }, {}, { priceReferenceCurrency: "CNY" });
    expect(screen.queryByText(/^≈/)).not.toBeInTheDocument();

    renderSubscriptionCard({ price: "10", currency: "USD" });
    expect(screen.queryByText("≈ ¥70 CNY")).not.toBeInTheDocument();

    renderSubscriptionCard({ price: "10", currency: "USD" }, {}, { currencyRatesReady: false, priceReferenceCurrency: "CNY" });
    expect(screen.queryByText("≈ ¥70 CNY")).not.toBeInTheDocument();
  });

  it("opens subscription details from the card primary action", () => {
    const onViewDetails = vi.fn();
    renderSubscriptionCard({ name: "Fastmail" }, { onViewDetails });

    fireEvent.click(screen.getByRole("button", { name: "查看 Fastmail 的详情" }));

    expect(onViewDetails).toHaveBeenCalledWith("sub-1");
  });

  it("opens subscription details from keyboard activation", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onViewDetails = vi.fn();
    renderSubscriptionCard({ name: "Fastmail" }, { onViewDetails });

    screen.getByRole("button", { name: "查看 Fastmail 的详情" }).focus();
    await user.keyboard("{Enter}");

    expect(onViewDetails).toHaveBeenCalledWith("sub-1");
  });

  it("selects from the whole card in public visibility management mode", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderSubscriptionCard({ name: "Fastmail" }, { onSelect }, { selectionMode: true });

    const card = screen.getByTestId("subscription-card");
    await user.click(card);
    expect(onSelect).toHaveBeenCalledWith("sub-1", true);
    expect(card).toHaveAttribute("aria-checked", "false");
  });

  it("supports keyboard selection without turning the card into a nested button", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderSubscriptionCard({}, { onSelect, onTogglePinned: vi.fn() }, { selectionMode: true });

    const card = screen.getByTestId("subscription-card");
    card.focus();
    await user.keyboard(" ");

    expect(onSelect).toHaveBeenCalledWith("sub-1", true);
    expect(card.querySelector("button")).toBeInTheDocument();
  });

  it("keeps card menu actions separate from selection", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    renderSubscriptionCard({}, { onSelect, onEdit }, { selectionMode: true });

    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));

    expect(onEdit).toHaveBeenCalledWith("sub-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens details from the menu while management mode reserves the card body for selection", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onViewDetails = vi.fn();
    renderSubscriptionCard({ name: "Fastmail" }, { onSelect, onViewDetails }, { selectionMode: true });

    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "查看 Fastmail 的详情" }));

    expect(onViewDetails).toHaveBeenCalledWith("sub-1");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId("subscription-card-primary-action")).not.toBeInTheDocument();
  });

  it("orders overflow menu actions with matching icons and separates the destructive action", () => {
    renderSubscriptionCard({}, { onTogglePinned: vi.fn() });

    openMoreActionsMenu();

    expect(screen.getByRole("menu")).toHaveClass("pointer-events-auto", "w-max", "min-w-40");
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual(["编辑", "复制", "添加到日历", "置顶", "删除"]);
    const [editItem, cloneItem, calendarItem, pinItem, deleteItem] = menuItems as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    for (const item of [editItem, cloneItem, calendarItem, pinItem]) {
      expect(item).toHaveClass("gap-2.5", "px-2.5", "py-2", "text-sm", "whitespace-nowrap");
    }
    expect(deleteItem).toHaveClass(
      "gap-2.5",
      "px-2.5",
      "py-2",
      "text-sm",
      "whitespace-nowrap",
      "text-destructive",
      "focus:bg-destructive/10",
      "focus:text-destructive",
    );
    expect(editItem).not.toHaveClass("text-destructive");
    expect(cloneItem).not.toHaveClass("text-destructive");
    expect(calendarItem).not.toHaveClass("text-destructive");
    expect(pinItem).not.toHaveClass("text-destructive");

    const separator = screen.getByRole("separator");
    expect(calendarItem.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(separator.compareDocumentPosition(deleteItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps overflow actions separate from the card detail action", () => {
    const onViewDetails = vi.fn();
    const onEdit = vi.fn();
    renderSubscriptionCard({}, { onViewDetails, onEdit, onTogglePinned: vi.fn() });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));

    expect(onEdit).toHaveBeenCalledWith("sub-1");
    expect(onViewDetails).not.toHaveBeenCalled();
  });

  it("forwards the add-to-calendar intent from the overflow menu", () => {
    const onAddToCalendar = vi.fn();
    renderSubscriptionCard({
      name: "Fastmail",
      website: "https://fastmail.example",
      notes: "Team renewal",
    }, { onAddToCalendar });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加到日历" }));

    expect(onAddToCalendar).toHaveBeenCalledWith("sub-1");
  });

  it("hides the add-to-calendar entry for one-time buyouts", () => {
    renderSubscriptionCard({ billingCycle: "one-time" });

    openMoreActionsMenu();

    expect(screen.queryByRole("menuitem", { name: "添加到日历" })).not.toBeInTheDocument();
  });

  it("keeps the add-to-calendar entry available for one-time fixed terms", () => {
    const onAddToCalendar = vi.fn();
    renderSubscriptionCard({
      billingCycle: "one-time",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
    }, { onAddToCalendar });

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加到日历" }));

    expect(onAddToCalendar).toHaveBeenCalledWith("sub-1");
  });

  it("renders concrete custom billing cycle labels", () => {
    renderSubscriptionCard({ billingCycle: "custom", customDays: 3, customCycleUnit: "year" });

    expect(screen.getByText("每 3 年")).toBeInTheDocument();
    expect(screen.queryByText("自定义")).not.toBeInTheDocument();
  });

  it("renders future recurring subscriptions with remaining days and the target date", () => {
    renderSubscriptionCard({ nextBillingDate: assertDateOnly("2026-06-15") });

    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/6/15", "日均 $5.3", "28 天后续费");
  });

  it("hides the start-date meta item when a recurring subscription has an unknown start date", () => {
    renderSubscriptionCard({
      startDate: null,
      autoCalculateNextBillingDate: false,
      nextBillingDate: assertDateOnly("2026-06-15"),
    });

    const metaFlow = expectMetaFlowItemsInOrder("到期: 2026/6/15", "日均 $5.3", "28 天后续费");

    expect(within(metaFlow).queryByText(/开始:/)).not.toBeInTheDocument();
  });

  it("keeps start date, billing date, payment method, and relative days in the intended order", () => {
    renderSubscriptionCard({
      paymentMethod: "credit_card",
      nextBillingDate: assertDateOnly("2026-06-15"),
    });

    expectMetaFlowItemsInOrder(
      "开始: 2026/5/15",
      "到期: 2026/6/15",
      "日均 $5.3",
      mocks.creditCardLabel,
      "28 天后续费",
    );
  });

  it("keeps long payment methods after the billing date without hiding either value", () => {
    renderSubscriptionCard({
      paymentMethod: "google_pay",
      nextBillingDate: assertDateOnly("2026-06-02"),
    });

    const metaFlow = expectMetaFlowItemsInOrder("到期: 2026/6/2", "日均 $5.3", mocks.longPaymentMethodLabel, "15 天后续费");
    const paymentMethodMeta = screen.getByTestId("subscription-card-meta-payment-method");
    const paymentMethodText = within(paymentMethodMeta).getByText(mocks.longPaymentMethodLabel);

    expect(metaFlow).toContainElement(paymentMethodMeta);
    expect(paymentMethodMeta).toHaveClass("min-w-0", "max-w-full");
    expect(paymentMethodMeta).not.toHaveClass("shrink-0");
    expect(paymentMethodText).toHaveClass("block", "max-w-24", "truncate", "sm:max-w-32");
  });

  it("keeps relative billing after the billing date when there is no payment method", () => {
    renderSubscriptionCard({ paymentMethod: undefined, nextBillingDate: assertDateOnly("2026-06-02") });

    const metaFlow = expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/6/2", "日均 $5.3", "15 天后续费");

    expect(within(metaFlow).queryByText(mocks.creditCardLabel)).not.toBeInTheDocument();
  });

  it("renders future one-time fixed terms with remaining days and the expiry date", () => {
    renderSubscriptionCard({
      billingCycle: "one-time",
      price: "180",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
      nextBillingDate: assertDateOnly("2026-08-01"),
    });

    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/8/1", "日均 $1", "75 天后到期");
  });

  it("keeps long daily amounts constrained inside the shared metadata flow", () => {
    renderSubscriptionCard({ price: "1000000000" });

    const dailyAverageMeta = screen.getByTestId("subscription-card-meta-daily-average");
    expect(dailyAverageMeta).toHaveClass("min-w-0", "max-w-full", "tabular-nums");
    expect(within(dailyAverageMeta).getByText("日均 $33,333,333.33")).toBeInTheDocument();
  });

  it("renders buyout purchase dates without relative renewal days", () => {
    renderSubscriptionCard({ billingCycle: "one-time" });

    const metaFlow = expectMetaFlowItemsInOrder("购买日期: 2026/5/15", "持有日均 $39.75");

    expect(within(metaFlow).queryByText("28 天后续费")).not.toBeInTheDocument();
    expect(within(metaFlow).queryByText("到期: 2026/6/15")).not.toBeInTheDocument();
    expect(screen.getAllByText("长期有效").length).toBeGreaterThan(0);
  });

  it("keeps incurred buyout cost visible for paused and cancelled records but hides future purchases", () => {
    const paused = renderSubscriptionCard({ billingCycle: "one-time", status: "paused" });
    expect(screen.getByText("持有日均 $39.75")).toBeInTheDocument();
    paused.unmount();

    const cancelled = renderSubscriptionCard({ billingCycle: "one-time", status: "cancelled" });
    expect(screen.getByText("持有日均 $39.75")).toBeInTheDocument();
    cancelled.unmount();

    renderSubscriptionCard({ billingCycle: "one-time", startDate: assertDateOnly("2026-05-19"), nextBillingDate: assertDateOnly("2026-05-19") });
    expect(screen.queryByText(/持有日均/)).not.toBeInTheDocument();
  });

  it("renders overdue active subscriptions with the expired status treatment", () => {
    renderSubscriptionCard({ status: "active", nextBillingDate: assertDateOnly("2026-05-15") });

    const statusBadge = screen.getByText("已过期").closest("div");
    const expiredDateText = screen.getByText("已过期 3 天");
    const card = statusBadge?.closest(".group");

    expect(statusBadge).toHaveClass("bg-muted", "text-muted-foreground", "border-muted");
    expect(expiredDateText.closest("div")).toHaveClass("text-muted-foreground");
    expect(card).toHaveClass("border-muted", "bg-muted/20");
    expect(card).not.toHaveClass("border-destructive/40");
    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/5/15", "已过期 3 天");
  });

  it("does not render relative renewal days for overdue paused subscriptions", () => {
    renderSubscriptionCard({ status: "paused", nextBillingDate: assertDateOnly("2026-05-12") });
    const metaFlow = screen.getByTestId("subscription-card-meta-flow");

    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/5/12");
    expect(within(metaFlow).queryByText("-6 天后续费")).not.toBeInTheDocument();
    expect(within(metaFlow).queryByText("已过期 6 天")).not.toBeInTheDocument();
  });

  it("keeps future inactive subscriptions neutral instead of applying renewal warning", () => {
    renderSubscriptionCard({ status: "paused", nextBillingDate: assertDateOnly("2026-05-20") });

    const card = screen.getByTestId("subscription-card");
    expect(card).toHaveClass("border-muted", "bg-muted/20");
    expect(card).not.toHaveClass("border-warning/40");
    expect(screen.queryByText("2 天后续费")).not.toBeInTheDocument();
  });

  it("does not render relative renewal days for overdue cancelled subscriptions", () => {
    renderSubscriptionCard({ status: "cancelled", nextBillingDate: assertDateOnly("2026-05-12") });
    const metaFlow = screen.getByTestId("subscription-card-meta-flow");

    expect(screen.getByText("已取消")).toBeInTheDocument();
    expectMetaFlowItemsInOrder("开始: 2026/5/15", "到期: 2026/5/12");
    expect(within(metaFlow).queryByText("-6 天后续费")).not.toBeInTheDocument();
    expect(within(metaFlow).queryByText("已过期 6 天")).not.toBeInTheDocument();
  });

  it("renders inherited reminder days with the current global setting", () => {
    renderSubscriptionCard({ reminderDays: -1 }, {}, { viewMode: "list" });

    expect(screen.getByText("默认提醒：提前 5 天")).toBeInTheDocument();
    expect(screen.getByText("日均 $5.3")).toBeInTheDocument();
  });

  it("renders disabled reminder days", () => {
    renderSubscriptionCard({ reminderDays: -2 }, {}, { viewMode: "list" });

    expect(screen.getByText("不提醒")).toBeInTheDocument();
  });
});
