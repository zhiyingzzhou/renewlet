// 订阅弹窗货币顺序测试独立成文件，避免主状态机测试膨胀并专注设置页货币管理契约。
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { CostSharing } from "@renewlet/shared/cost-sharing";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import type { Subscription } from "@/types/subscription";
import { preloadSubscriptionDialog, SubscriptionDialog } from "./subscription-dialog";

const mocks = vi.hoisted(() => ({
  config: {
    categories: [{ id: "productivity", value: "productivity", labels: { "zh-CN": "效率工具", "en-US": "Productivity" } }],
    statuses: [{ id: "active", value: "active", labels: { "zh-CN": "活跃", "en-US": "Active" } }],
    paymentMethods: [{ id: "alipay", value: "alipay", labels: { "zh-CN": "支付宝", "en-US": "Alipay" } }],
    currencies: [
      { id: "PHP", value: "PHP", labels: { "zh-CN": "₱ 菲律宾比索 (PHP)", "en-US": "₱ Philippine Peso (PHP)" }, enabled: true },
      { id: "AED", value: "AED", labels: { "zh-CN": "AED 阿联酋迪拉姆", "en-US": "AED United Arab Emirates Dirham" }, enabled: true },
      { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
      { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
      { id: "EUR", value: "EUR", labels: { "zh-CN": "€ 欧元 (EUR)", "en-US": "€ Euro (EUR)" }, enabled: true },
    ],
  },
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({ config: mocks.config }),
  useLunarCalendar: () => ({ enabled: false, supported: true }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { defaultCurrency: "USD", notificationReminderDays: 5 },
  }),
}));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: () => ({
    convert: (amount: number) => amount,
  }),
}));

vi.mock("@/components/logo-picker", () => ({
  LogoPicker: () => null,
}));

beforeAll(async () => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
  await preloadSubscriptionDialog();
});

function getCurrencyOptionTexts(): string[] {
  const listbox = screen.getByRole("listbox");
  return Array.from(listbox.querySelectorAll<HTMLElement>("[cmdk-item]"))
    .map((item) => item.textContent ?? "");
}

function expectCurrencyOptionsFollowManagerOrder() {
  const optionTexts = getCurrencyOptionTexts();
  expect(optionTexts).toHaveLength(5);
  expect(optionTexts[0]).toContain("PHP");
  expect(optionTexts[1]).toContain("AED");
  expect(optionTexts[2]).toContain("USD");
  expect(optionTexts[3]).toContain("CNY");
  expect(optionTexts[4]).toContain("EUR");
}

function makeSubscription(overrides: SubscriptionFixtureOverrides<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Critical SaaS",
    logo: undefined,
    price: "99",
    currency: "USD",
    category: "productivity",
    status: "active",
    publicHidden: false,
    paymentMethod: "alipay",
    startDate: assertDateOnly("2026-05-14"),
    nextBillingDate: assertDateOnly("2026-06-13"),
    autoRenew: false,
    autoCalculateNextBillingDate: false,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    reminderDays: 3,
    tags: [],
    repeatReminderEnabled: true,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    pinned: false,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

describe("SubscriptionDialog currency order", () => {
  it("uses the currency manager order for the create currency selector", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          mode="create"
          loadingPreview={null}
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: /选择货币|Select currency/ }));

    expectCurrencyOptionsFollowManagerOrder();
  });

  it("uses the currency manager order for the edit currency selector", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={makeSubscription({ currency: "CNY" })}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: /选择货币|Select currency/ }));

    expectCurrencyOptionsFollowManagerOrder();
  });

  it("uses the same currency manager order for cost sharing member currency selectors", async () => {
    const user = userEvent.setup();
    const costSharing = {
      enabled: true,
      splitMode: "equal",
      members: [{ id: "partner", name: "Partner", currency: "CNY" }],
    } satisfies CostSharing;

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={makeSubscription({ currency: "USD", costSharing })}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "管理成员" }));
    const memberDialog = screen.getByRole("dialog", { name: "管理共享成员" });
    await user.click(within(memberDialog).getByRole("combobox", { name: "成员金额货币" }));

    expectCurrencyOptionsFollowManagerOrder();
  });
});
