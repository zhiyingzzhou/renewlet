import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
  type SubscriptionAdvancedFilterState,
} from "@/modules/subscriptions/domain/subscription-filters";
import { SubscriptionAdvancedFilter } from "./subscription-advanced-filter";

const billingCycleOptions = [
  { value: "monthly" as const, label: "Monthly" },
  { value: "annual" as const, label: "Annual" },
];
const paymentMethodOptions = [
  { value: "__none", label: "No payment method" },
  { value: "card", label: "Credit card" },
  { value: "paypal", label: "PayPal" },
  { value: "bank", label: "Bank transfer" },
  { value: "apple", label: "Apple Pay" },
  { value: "crypto", label: "Crypto" },
];
const currencyOptions = [
  { value: "CNY", label: "¥ 人民币 (CNY)", keywords: ["人民币", "yuan"] },
  { value: "EUR", label: "€ 欧元 (EUR)", keywords: ["欧元", "Euro"] },
  ...Array.from({ length: 20 }, (_, index) => ({
    value: `X${index}`,
    label: `Currency ${index}`,
  })),
  { value: "USD", label: "$ 美元 (USD)", keywords: ["美元", "$", "US Dollar"] },
];

const LAZY_PANEL_CONTENT_TIMEOUT = 5_000;

function installPointerMocks({ mobileOverlay = false }: { mobileOverlay?: boolean } = {}) {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
  Element.prototype.scrollIntoView ??= vi.fn();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: mobileOverlay && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderFilter(
  mode: "desktopSidePanel" | "mobileWorkspace",
  filters: SubscriptionAdvancedFilterState = DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
  onChange = vi.fn(),
  filterCurrencyOptions = currencyOptions,
) {
  render(
    <SubscriptionAdvancedFilter
      filters={filters}
      onChange={onChange}
      billingCycleOptions={billingCycleOptions}
      paymentMethodOptions={paymentMethodOptions}
      currencyOptions={filterCurrencyOptions}
      mode={mode}
    />,
  );
  return onChange;
}

const calendarYearButtonName = /^2026(?:年)?$/;

function visibleCalendarYearOptionName() {
  const yearRangeStart = Math.floor(new Date().getFullYear() / 12) * 12;
  const year = yearRangeStart === 2026 ? yearRangeStart + 1 : yearRangeStart;
  return new RegExp(`^${year}(?:年)?$`);
}

function optionRow(checkbox: HTMLElement): HTMLElement {
  const row = checkbox.closest("[data-advanced-option-row]");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

async function openFilter(user: ReturnType<typeof userEvent.setup>, mode: "desktop" | "mobile") {
  await user.click(within(screen.getByTestId(`${mode}-advanced-filter`)).getByRole("button"));
  // 弹层外壳先取得焦点；Node 24 冷启动会跨过 Testing Library 默认 1 秒窗口，必须等待真实模块内容而不是依赖任意延时。
  await screen.findByTestId(
    mode === "desktop" ? "advanced-payment-method-entry" : "advanced-section-billingCycle-entry",
    undefined,
    { timeout: LAZY_PANEL_CONTENT_TIMEOUT },
  );
}

describe("SubscriptionAdvancedFilter", () => {
  it("opens a dedicated desktop dialog for payment method selection and applies through the side panel", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel");

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    const paymentEntry = within(panel).getByTestId("advanced-payment-method-entry");

    expect(screen.queryByTestId("desktop-advanced-filter-popover")).not.toBeInTheDocument();
    expect(within(panel).queryByTestId("advanced-payment-method-picker")).not.toBeInTheDocument();
    expect(paymentEntry).toHaveTextContent(/Any|不限/);
    expect(within(paymentEntry).queryByTestId("advanced-payment-method-entry-preview")).not.toBeInTheDocument();

    await user.click(paymentEntry);
    const dialog = screen.getByTestId("advanced-payment-method-dialog");
    const paymentList = within(dialog).getByTestId("advanced-payment-method-picker");
    const paymentOptions = within(paymentList).getByTestId("advanced-payment-method-picker-all-options");

    expect(within(paymentList).getByPlaceholderText(/Filter payment methods|筛选支付方式/)).toBeInTheDocument();
    expect(within(paymentOptions).queryByRole("button", { name: "PayPal" })).not.toBeInTheDocument();
    expect(within(paymentList).queryByTestId("advanced-payment-method-picker-selected-options")).not.toBeInTheDocument();
    const paypalRow = within(paymentOptions).getByRole("checkbox", { name: "PayPal" });
    expect(paypalRow).toHaveAttribute("aria-checked", "false");
    expect(optionRow(paypalRow)).toHaveClass("border-border", "bg-secondary/30");
    await user.click(paypalRow);

    expect(paypalRow).toHaveAttribute("aria-checked", "true");
    expect(optionRow(paypalRow)).toHaveClass("border-primary/60", "bg-primary/5");
    expect(optionRow(paypalRow)).not.toHaveClass("bg-primary/10");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    const updatedPaymentEntry = within(panel).getByTestId("advanced-payment-method-entry");
    expect(updatedPaymentEntry).toHaveTextContent("PayPal");
    expect(within(updatedPaymentEntry).getByTestId("advanced-payment-method-entry-preview")).toHaveTextContent("PayPal");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole("button", { name: /Apply|确定/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedPaymentMethods: ["paypal"],
    });
  });

  it("shows selected value previews on the desktop side-panel entries", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    renderFilter("desktopSidePanel", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedPaymentMethods: ["card", "paypal", "bank", "apple"],
      selectedCurrencies: ["CNY", "EUR", "USD", "X19"],
    });

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    const paymentEntry = within(panel).getByTestId("advanced-payment-method-entry");
    const paymentPreview = within(paymentEntry).getByTestId("advanced-payment-method-entry-preview");
    const currencyEntry = within(panel).getByTestId("advanced-currency-entry");
    const currencyPreview = within(currencyEntry).getByTestId("advanced-currency-entry-preview");

    expect(paymentEntry).toHaveTextContent(/4 selected|4 项/);
    expect(paymentPreview).toHaveTextContent("Credit card");
    expect(paymentPreview).toHaveTextContent("PayPal");
    expect(paymentPreview).toHaveTextContent("Bank transfer");
    expect(paymentPreview).toHaveTextContent("+1");
    expect(currencyEntry).toHaveTextContent(/4 selected|4 项/);
    expect(currencyPreview).toHaveTextContent("¥ 人民币 (CNY)");
    expect(currencyPreview).toHaveTextContent("€ 欧元 (EUR)");
    expect(currencyPreview).toHaveTextContent("$ 美元 (USD)");
    expect(currencyPreview).toHaveTextContent("+1");
  });

  it("shows the full desktop next billing summary without fixed truncation", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    renderFilter("desktopSidePanel", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "2026-06-04",
      nextBillingTo: "2026-06-30",
    });

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    const nextBillingSummary = within(panel).getByTestId("advanced-section-nextBilling-summary");

    expect(nextBillingSummary).toHaveTextContent("2026/6/4");
    expect(nextBillingSummary).toHaveTextContent("2026/6/30");
    expect(nextBillingSummary).not.toHaveClass("truncate");
    expect(nextBillingSummary.className).not.toContain("max-w-40");
  });

  it("opens a dedicated desktop dialog for currency browsing and search", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel");

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    const currencyEntry = within(panel).getByTestId("advanced-currency-entry");

    expect(within(panel).queryByTestId("advanced-currency-picker")).not.toBeInTheDocument();
    await user.click(currencyEntry);

    const dialog = screen.getByTestId("advanced-currency-dialog");
    const currencyList = within(dialog).getByTestId("advanced-currency-picker");
    const currencyOptionsList = within(currencyList).getByTestId("advanced-currency-picker-all-options");

    expect(within(currencyList).getByPlaceholderText(/Filter currencies|筛选货币/)).toBeInTheDocument();
    expect(within(currencyOptionsList).getByRole("checkbox", { name: "¥ 人民币 (CNY)" })).toBeInTheDocument();
    expect(within(currencyOptionsList).getByRole("checkbox", { name: "€ 欧元 (EUR)" })).toBeInTheDocument();
    expect(within(currencyOptionsList).getByRole("checkbox", { name: "Currency 19" })).toBeInTheDocument();
    expect(within(currencyList).queryByRole("button", { name: /Show more currencies|显示更多货币/ })).not.toBeInTheDocument();
    expect(within(currencyList).queryByTestId("advanced-currency-picker-selected-options")).not.toBeInTheDocument();

    await user.type(within(currencyList).getByPlaceholderText(/Filter currencies|筛选货币/), "usd");
    const searchResults = within(currencyList).getByTestId("advanced-currency-picker-search-results");
    const usdRow = within(searchResults).getByRole("checkbox", { name: "$ 美元 (USD)" });
    await user.click(usdRow);

    expect(usdRow).toHaveAttribute("aria-checked", "true");
    expect(optionRow(usdRow)).toHaveClass("border-primary/60", "bg-primary/5");
    expect(optionRow(usdRow)).not.toHaveClass("bg-primary/10");
    expect(within(currencyList).queryByTestId("advanced-currency-picker-selected-options")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    expect(within(panel).getByTestId("advanced-currency-entry")).toHaveTextContent("$ 美元 (USD)");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole("button", { name: /Apply|确定/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedCurrencies: ["USD"],
    });
  });

  it("keeps desktop currency browsing and search in the supplied manager order", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    renderFilter("desktopSidePanel", DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS, vi.fn(), [
      { value: "PHP", label: "₱ 菲律宾比索 (PHP)" },
      { value: "CNY", label: "¥ 人民币 (CNY) with USD reference", keywords: ["reference usd"] },
      { value: "USD", label: "$ 美元 (USD)", keywords: ["美元", "US Dollar"] },
      { value: "EUR", label: "€ 欧元 (EUR)", keywords: ["Euro"] },
    ]);

    await openFilter(user, "desktop");
    await user.click(within(screen.getByTestId("desktop-advanced-filter-panel")).getByTestId("advanced-currency-entry"));

    const currencyList = within(screen.getByTestId("advanced-currency-dialog")).getByTestId("advanced-currency-picker");
    const allOptions = within(currencyList).getByTestId("advanced-currency-picker-all-options");
    expect(Array.from(allOptions.querySelectorAll("[data-advanced-option-row]")).map((row) => row.textContent)).toEqual([
      "₱ 菲律宾比索 (PHP)",
      "¥ 人民币 (CNY) with USD reference",
      "$ 美元 (USD)",
      "€ 欧元 (EUR)",
    ]);

    await user.type(within(currencyList).getByPlaceholderText(/Filter currencies|筛选货币/), "usd");

    const searchResults = within(currencyList).getByTestId("advanced-currency-picker-search-results");
    expect(Array.from(searchResults.querySelectorAll("[data-advanced-option-row]")).map((row) => row.textContent)).toEqual([
      "¥ 人民币 (CNY) with USD reference",
      "$ 美元 (USD)",
    ]);
  });

  it("filters desktop currency search by single-character high-signal prefixes", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    renderFilter("desktopSidePanel", DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS, vi.fn(), [
      { value: "GBP", label: "£ 英镑 (GBP)", keywords: ["pound sterling", "global", "currency"] },
      { value: "AUD", label: "AU$ 澳大利亚元 (AUD)", keywords: ["Australian dollar"] },
      { value: "USD", label: "$ 美元 (USD)", keywords: ["美元", "US Dollar"] },
      { value: "TRY", label: "₺ 土耳其里拉 (TRY)", keywords: ["Turkish lira"] },
      { value: "UGX", label: "UGX 乌干达先令", keywords: ["Ugandan Shilling"] },
      { value: "PHP", label: "₱ 菲律宾比索 (PHP)", keywords: ["Philippine peso", "currency"] },
    ]);

    await openFilter(user, "desktop");
    await user.click(within(screen.getByTestId("desktop-advanced-filter-panel")).getByTestId("advanced-currency-entry"));

    const currencyList = within(screen.getByTestId("advanced-currency-dialog")).getByTestId("advanced-currency-picker");
    await user.type(within(currencyList).getByPlaceholderText(/Filter currencies|筛选货币/), "u");

    const searchResults = within(currencyList).getByTestId("advanced-currency-picker-search-results");
    await within(searchResults).findByRole("checkbox", { name: "$ 美元 (USD)" });
    expect(Array.from(searchResults.querySelectorAll("[data-advanced-option-row]")).map((row) => row.textContent)).toEqual([
      "$ 美元 (USD)",
      "UGX 乌干达先令",
    ]);
  });

  it("toggles selected list rows before applying", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedPaymentMethods: ["paypal"],
    });

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    await user.click(within(panel).getByTestId("advanced-payment-method-entry"));
    const dialog = screen.getByTestId("advanced-payment-method-dialog");
    const paymentList = within(dialog).getByTestId("advanced-payment-method-picker");
    const paymentOptions = within(paymentList).getByTestId("advanced-payment-method-picker-all-options");

    expect(within(paymentList).queryByTestId("advanced-payment-method-picker-selected-options")).not.toBeInTheDocument();
    const paypalRow = within(paymentOptions).getByRole("checkbox", { name: "PayPal" });
    expect(paypalRow).toHaveAttribute("aria-checked", "true");
    await user.click(paypalRow);
    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    await user.click(within(panel).getByRole("button", { name: /Apply|确定/ }));

    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS);
  });

  it("discards desktop selection dialog edits when cancelled", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel");

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    await user.click(within(panel).getByTestId("advanced-payment-method-entry"));
    const dialog = screen.getByTestId("advanced-payment-method-dialog");
    const paymentOptions = within(dialog).getByTestId("advanced-payment-method-picker-all-options");

    await user.click(within(paymentOptions).getByRole("checkbox", { name: "PayPal" }));
    await user.click(within(dialog).getByRole("button", { name: /Cancel|取消/ }));

    expect(screen.queryByTestId("advanced-payment-method-dialog")).not.toBeInTheDocument();
    expect(within(panel).getByTestId("advanced-payment-method-entry")).toHaveTextContent(/Any|不限/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("discards desktop side panel edits when closed without applying", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel");
    const trigger = within(screen.getByTestId("desktop-advanced-filter")).getByRole("button");

    await user.click(trigger);
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    await user.click(within(panel).getByTestId("advanced-payment-method-entry"));
    const dialog = screen.getByTestId("advanced-payment-method-dialog");
    const paymentOptions = within(dialog).getByTestId("advanced-payment-method-picker-all-options");

    await user.click(within(paymentOptions).getByRole("checkbox", { name: "PayPal" }));
    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    await user.click(within(panel).getByRole("button", { name: /Close|关闭/ }));

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("desktop-advanced-filter-panel")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it.each(["Escape", "overlay"] as const)("discards desktop drafts when closed through %s", async (closeMethod) => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel");
    const trigger = within(screen.getByTestId("desktop-advanced-filter")).getByRole("button");

    await user.click(trigger);
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    await user.click(within(panel).getByTestId("advanced-payment-method-entry"));
    const dialog = screen.getByTestId("advanced-payment-method-dialog");
    const paymentOptions = within(dialog).getByTestId("advanced-payment-method-picker-all-options");
    await user.click(within(paymentOptions).getByRole("checkbox", { name: "PayPal" }));
    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));

    if (closeMethod === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      const overlay = document.querySelector<HTMLElement>("[data-side-drawer-overlay]");
      if (!overlay) throw new Error("Side drawer overlay was not rendered");
      await user.click(overlay);
    }

    await waitFor(() => expect(screen.queryByTestId("desktop-advanced-filter-panel")).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(within(screen.getByTestId("desktop-advanced-filter-panel")).getByTestId("advanced-payment-method-entry"))
      .toHaveTextContent(/Any|不限/);
  });

  it("uses calendar buttons for next billing date filters and applies them through the side panel", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "2026-08-01",
      nextBillingTo: "2026-08-31",
    });

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");

    expect(panel.querySelector('input[type="date"]')).toBeNull();
    const startPicker = within(panel).getByTestId("advanced-next-billing-from-picker");
    expect(within(startPicker).getByRole("button", { name: /2026\/8\/1/ })).toBeInTheDocument();

    await user.click(within(startPicker).getByRole("button", { name: /2026\/8\/1/ }));
    const calendar = await screen.findByRole("grid");
    expect(panel).toContainElement(calendar);

    const yearTrigger = within(panel).getByRole("button", { name: calendarYearButtonName });
    await user.click(yearTrigger);
    const yearOption = await screen.findByRole("button", { name: visibleCalendarYearOptionName() });
    expect(panel).toContainElement(yearOption);
    await user.click(yearTrigger);

    await user.click(within(calendar).getByRole("button", { name: /2026年8月2日|August 2, 2026/ }));

    expect(within(startPicker).getByRole("button", { name: /2026\/8\/2/ })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole("button", { name: /Apply|确定/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "2026-08-02",
      nextBillingTo: "2026-08-31",
    });
  });

  it("prevents inverted next billing date ranges and clears one date at a time", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("desktopSidePanel", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "2026-08-10",
      nextBillingTo: "2026-08-20",
    });

    await openFilter(user, "desktop");
    const panel = screen.getByTestId("desktop-advanced-filter-panel");
    const endPicker = within(panel).getByTestId("advanced-next-billing-to-picker");

    await user.click(within(endPicker).getByRole("button", { name: /2026\/8\/20/ }));
    const endCalendar = await screen.findByRole("grid");
    expect(within(endCalendar).getByRole("button", { name: /2026年8月9日|August 9, 2026/ })).toBeDisabled();
    await user.keyboard("{Escape}");

    const startPicker = within(panel).getByTestId("advanced-next-billing-from-picker");
    await user.click(within(startPicker).getByRole("button", { name: /2026\/8\/10/ }));
    const startCalendar = await screen.findByRole("grid");
    expect(within(startCalendar).getByRole("button", { name: /2026年8月21日|August 21, 2026/ })).toBeDisabled();
    await user.keyboard("{Escape}");

    await user.click(within(startPicker).getByRole("button", { name: /Clear start date|清空开始日期/ }));
    expect(within(startPicker).getByRole("button", { name: /Select date|选择日期/ })).toBeInTheDocument();
    expect(within(endPicker).getByRole("button", { name: /2026\/8\/20/ })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole("button", { name: /Apply|确定/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "",
      nextBillingTo: "2026-08-20",
    });
  });

  it("opens an independent mobile billing cycle dialog and applies through the workspace", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("mobileWorkspace");

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");

    expect(workspace).toHaveClass("h5-dialog-panel");
    expect(workspace).not.toHaveClass("h5-drawer-panel");
    expect(within(workspace).queryByRole("button", { name: "Monthly" })).not.toBeInTheDocument();
    expect(within(workspace).queryByRole("button", { name: /Back to filter groups|返回筛选分组/ })).not.toBeInTheDocument();

    await user.click(within(workspace).getByRole("button", { name: /Billing cycle|扣费周期/ }));
    const dialog = screen.getByTestId("advanced-billing-cycle-dialog");

    expect(dialog).toHaveClass("h5-dialog-panel", "rounded-none");
    expect(workspace).not.toContainElement(dialog);
    expect(within(workspace).queryByRole("button", { name: "Monthly" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Monthly" }));
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("advanced-billing-cycle-dialog")).not.toBeInTheDocument();
    });
    const billingEntry = within(workspace).getByTestId("advanced-section-billingCycle-entry");
    expect(billingEntry).toHaveTextContent("Monthly");
    expect(within(billingEntry).getByTestId("advanced-section-billingCycle-preview")).toHaveTextContent("Monthly");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(workspace).getByRole("button", { name: /Apply|确定/ }));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedBillingCycles: ["monthly"],
    });
  });

  it("uses the calendar date picker inside an independent mobile next billing dialog", async () => {
    installPointerMocks({ mobileOverlay: true });
    const user = userEvent.setup();
    const onChange = renderFilter("mobileWorkspace", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "2026-08-01",
    });

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    await user.click(within(workspace).getByRole("button", { name: /Renewal \/ expiry date|续费\/到期日期/ }));
    const dialog = screen.getByTestId("advanced-next-billing-dialog");

    expect(dialog).toHaveClass("h5-dialog-panel", "rounded-none");
    expect(workspace).not.toContainElement(dialog);
    expect(workspace.querySelector('input[type="date"]')).toBeNull();
    expect(dialog.querySelector('input[type="date"]')).toBeNull();
    expect(within(workspace).queryByRole("button", { name: /Back to filter groups|返回筛选分组/ })).not.toBeInTheDocument();
    const startPicker = within(dialog).getByTestId("advanced-next-billing-from-picker");
    await user.click(within(startPicker).getByRole("button", { name: /2026\/8\/1/ }));

    const sheet = await screen.findByRole("dialog", { name: /Select|请选择/ });
    expect(sheet).toHaveClass("h5-mobile-sheet-content");
    expect(dialog).toContainElement(sheet);
    const calendar = await screen.findByRole("grid");
    await user.click(within(calendar).getByRole("button", { name: /2026年8月2日|August 2, 2026/ }));
    expect(onChange).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Select|请选择/ })).not.toBeInTheDocument();
    });
    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("advanced-next-billing-dialog")).not.toBeInTheDocument();
    });
    const nextBillingEntry = within(workspace).getByTestId("advanced-section-nextBilling-entry");
    expect(nextBillingEntry).toHaveTextContent("2026/8/2");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(workspace).getByRole("button", { name: /Apply|确定/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "2026-08-02",
    });
  });

  it("shows selected currency previews on the mobile section homepage", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    renderFilter("mobileWorkspace", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedCurrencies: ["CNY", "EUR", "USD", "X19"],
    });

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    const currencyEntry = within(workspace).getByTestId("advanced-section-currency-entry");
    const currencyPreview = within(currencyEntry).getByTestId("advanced-section-currency-preview");

    expect(currencyEntry).toHaveTextContent(/4 selected|4 项/);
    expect(currencyPreview).toHaveTextContent("¥ 人民币 (CNY)");
    expect(currencyPreview).toHaveTextContent("€ 欧元 (EUR)");
    expect(currencyPreview).toHaveTextContent("$ 美元 (USD)");
    expect(currencyPreview).toHaveTextContent("+1");
    expect(within(workspace).queryByTestId("advanced-currency-picker-selected-options")).not.toBeInTheDocument();
  });

  it("shows the next billing date range preview on the mobile section homepage", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    renderFilter("mobileWorkspace", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      nextBillingFrom: "2026-06-04",
      nextBillingTo: "2026-06-30",
    });

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    const nextBillingEntry = within(workspace).getByTestId("advanced-section-nextBilling-entry");
    const nextBillingPreview = within(nextBillingEntry).getByTestId("advanced-section-nextBilling-preview");

    expect(within(nextBillingEntry).getByTestId("advanced-section-nextBilling-summary")).toHaveTextContent("2026/6/4");
    expect(nextBillingPreview).toHaveTextContent("2026/6/4");
    expect(nextBillingPreview).toHaveTextContent("2026/6/30");
  });

  it("opens an independent mobile flags dialog and clears only that group", async () => {
    installPointerMocks({ mobileOverlay: true });
    const user = userEvent.setup();
    const onChange = renderFilter("mobileWorkspace", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedCurrencies: ["USD"],
      pinnedFilter: "yes",
      publicHiddenFilter: "yes",
      reminderModeFilter: "custom",
      repeatReminderFilter: "yes",
    });

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    const flagsEntry = within(workspace).getByTestId("advanced-section-flags-entry");
    expect(flagsEntry).toHaveTextContent(/4 selected|4 项/);
    expect(within(flagsEntry).getByTestId("advanced-section-flags-preview")).toHaveTextContent(/仅置顶|Pinned only/);

    await user.click(within(workspace).getByRole("button", { name: /More state|更多状态/ }));
    const dialog = screen.getByTestId("advanced-flags-dialog");
    const pinnedSelect = within(dialog).getByRole("combobox", { name: /Pinned|置顶/ });

    expect(dialog).toHaveClass("h5-dialog-panel", "rounded-none");
    expect(workspace).not.toContainElement(dialog);
    expect(within(workspace).queryByRole("button", { name: /Back to filter groups|返回筛选分组/ })).not.toBeInTheDocument();
    await user.click(pinnedSelect);
    await user.click(screen.getByRole("option", { name: /仅未置顶|Unpinned only/ }));
    expect(pinnedSelect).toHaveTextContent(/仅未置顶|Unpinned only/);
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /Clear group|清空本组/ }));
    expect(pinnedSelect).toHaveTextContent(/Any|不限/);
    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("advanced-flags-dialog")).not.toBeInTheDocument();
    });

    const updatedFlagsEntry = within(workspace).getByTestId("advanced-section-flags-entry");
    const currencyEntry = within(workspace).getByTestId("advanced-section-currency-entry");
    expect(updatedFlagsEntry).toHaveTextContent(/Any|不限/);
    expect(within(updatedFlagsEntry).queryByTestId("advanced-section-flags-preview")).not.toBeInTheDocument();
    expect(currencyEntry).toHaveTextContent("$ 美元 (USD)");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(workspace).getByRole("button", { name: /Apply|确定/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedCurrencies: ["USD"],
    });
  });

  it("opens an independent mobile currency dialog and keeps edits as workspace draft", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("mobileWorkspace");

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    await user.click(within(workspace).getByRole("button", { name: /Currency|货币/ }));

    const dialog = screen.getByTestId("advanced-currency-dialog");
    const currencyList = within(dialog).getByTestId("advanced-currency-picker");
    const currencySearchInput = within(currencyList).getByPlaceholderText(/Filter currencies|筛选货币/);
    const currencySearchRegion = within(currencyList).getByTestId("advanced-currency-picker-search");
    const currencyOptionsScroll = within(currencyList).getByTestId("advanced-currency-picker-options-scroll");

    expect(dialog).toHaveClass("h5-dialog-panel", "rounded-none");
    expect(workspace).not.toContainElement(dialog);
    expect(within(workspace).queryByTestId("advanced-currency-picker")).not.toBeInTheDocument();
    expect(currencyList).toHaveClass("flex", "h-full", "min-h-0", "flex-col");
    expect(currencySearchRegion).toContainElement(currencySearchInput);
    expect(currencyOptionsScroll).not.toContainElement(currencySearchInput);
    expect(currencyOptionsScroll).toHaveClass("overflow-y-auto");
    expect(within(currencyOptionsScroll).getByTestId("advanced-currency-picker-all-options")).toHaveTextContent("¥ 人民币 (CNY)");
    expect(within(currencyList).queryByTestId("advanced-currency-picker-selected-options")).not.toBeInTheDocument();

    await user.type(currencySearchInput, "usd");
    const usdRow = within(currencyOptionsScroll).getByRole("checkbox", { name: "$ 美元 (USD)" });
    await user.click(usdRow);
    expect(usdRow).toHaveAttribute("aria-checked", "true");

    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("advanced-currency-dialog")).not.toBeInTheDocument();
    });
    const updatedCurrencyEntry = within(workspace).getByTestId("advanced-section-currency-entry");
    expect(updatedCurrencyEntry).toHaveTextContent("$ 美元 (USD)");
    expect(within(updatedCurrencyEntry).getByTestId("advanced-section-currency-preview")).toHaveTextContent("$ 美元 (USD)");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(workspace).getByRole("button", { name: /Apply|确定/ }));

    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedCurrencies: ["USD"],
    });
  });

  it("discards mobile payment method dialog edits when cancelled", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("mobileWorkspace");

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    await user.click(within(workspace).getByRole("button", { name: /Payment method|支付方式/ }));
    const dialog = screen.getByTestId("advanced-payment-method-dialog");
    const paymentList = within(dialog).getByTestId("advanced-payment-method-picker");
    const paymentSearchInput = within(paymentList).getByPlaceholderText(/Filter payment methods|筛选支付方式/);
    const paymentSearchRegion = within(paymentList).getByTestId("advanced-payment-method-picker-search");
    const paymentOptionsScroll = within(paymentList).getByTestId("advanced-payment-method-picker-options-scroll");
    expect(paymentSearchRegion).toContainElement(paymentSearchInput);
    expect(paymentOptionsScroll).not.toContainElement(paymentSearchInput);
    expect(paymentOptionsScroll).toHaveClass("overflow-y-auto");
    await user.click(within(paymentList).getByRole("checkbox", { name: "PayPal" }));
    await user.click(within(dialog).getByRole("button", { name: /Cancel|取消/ }));

    await waitFor(() => {
      expect(screen.queryByTestId("advanced-payment-method-dialog")).not.toBeInTheDocument();
    });
    const paymentEntry = within(workspace).getByTestId("advanced-section-paymentMethod-entry");
    expect(paymentEntry).toHaveTextContent(/Any|不限/);
    expect(within(paymentEntry).queryByTestId("advanced-section-paymentMethod-preview")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not commit mobile workspace selections when closed without apply", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("mobileWorkspace");

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    await user.click(within(workspace).getByRole("button", { name: /Billing cycle|扣费周期/ }));
    const dialog = screen.getByTestId("advanced-billing-cycle-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Monthly" }));
    await user.click(within(dialog).getByRole("button", { name: /Done|完成/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("advanced-billing-cycle-dialog")).not.toBeInTheDocument();
    });
    await user.click(within(workspace).getByRole("button", { name: /Close|关闭/ }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears mobile workspace draft filters before applying", async () => {
    installPointerMocks();
    const user = userEvent.setup();
    const onChange = renderFilter("mobileWorkspace", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      selectedCurrencies: ["USD"],
    });

    await openFilter(user, "mobile");
    const workspace = screen.getByTestId("mobile-advanced-filter-workspace");
    await user.click(within(workspace).getByRole("button", { name: /Clear conditions|清空条件/ }));
    await user.click(within(workspace).getByRole("button", { name: /Apply|确定/ }));

    expect(onChange).toHaveBeenCalledWith(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS);
  });
});
