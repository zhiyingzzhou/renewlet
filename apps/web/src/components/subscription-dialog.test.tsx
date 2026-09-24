// 订阅弹窗测试覆盖新增/编辑状态机、默认货币同步和 date-only 自动推算边界。
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import type {
  CostSharingMember,
  Subscription,
  SubscriptionFormSubmission,
} from "@/types/subscription";
import { preloadSubscriptionDialog, SubscriptionDialog } from "./subscription-dialog";

const mocks = vi.hoisted(() => ({
  config: {
    categories: [{ id: "productivity", value: "productivity", labels: { "zh-CN": "效率工具", "en-US": "Productivity" } }],
    statuses: [{ id: "active", value: "active", labels: { "zh-CN": "活跃", "en-US": "Active" } }],
    paymentMethods: [{ id: "alipay", value: "alipay", labels: { "zh-CN": "支付宝", "en-US": "Alipay" } }],
    currencies: [
      { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
      { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
      { id: "EUR", value: "EUR", labels: { "zh-CN": "€ 欧元 (EUR)", "en-US": "€ Euro (EUR)" }, enabled: true },
    ],
  },
}));
const FIXED_DIALOG_NOW = new Date("2026-06-01T12:00:00.000Z");

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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXED_DIALOG_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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

describe("SubscriptionDialog", () => {
  it("shows field errors on empty create submit instead of relying on native validation", async () => {
    const user = setupUser();
    const onSubmit = vi.fn<(submission: SubscriptionFormSubmission) => void>();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    expect(document.querySelector("form")).toHaveAttribute("novalidate");

    await user.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(screen.getByText("请输入服务名称")).toBeInTheDocument();
    expect(screen.getByText("金额必须是 0 到 1,000,000,000 之间的有效数字")).toBeInTheDocument();
    const startDateButton = document.getElementById("startDate");
    const nextBillingDateButton = document.getElementById("nextBillingDate");
    if (!(startDateButton instanceof HTMLButtonElement) || !(nextBillingDateButton instanceof HTMLButtonElement)) {
      throw new Error("Date buttons were not rendered");
    }
    const dateError = screen.getByText("请选择到期日期");
    const startDateField = startDateButton.closest('[data-slot="form-field"]');
    const nextBillingDateField = nextBillingDateButton.closest('[data-slot="form-field"]');
    expect(dateError).toBeInTheDocument();
    expect(startDateButton).toHaveAttribute("aria-invalid", "false");
    expect(nextBillingDateButton).toHaveAttribute("aria-invalid", "true");
    expect(nextBillingDateButton).toHaveAttribute("aria-describedby", "nextBillingDate-error");
    expect(nextBillingDateButton.closest('[data-slot="form-field-row"]')).toContainElement(dateError);
    expect(nextBillingDateField).not.toContainElement(dateError);
    expect(startDateField).not.toContainElement(dateError);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the action footer in normal flow without oversized scroll padding", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    const form = document.querySelector("form");
    const dialog = screen.getByRole("dialog", { name: "添加新订阅" });
    const header = document.querySelector("[data-subscription-dialog-header]");
    const scrollRegion = form?.firstElementChild;
    const footer = screen.getByRole("button", { name: "添加订阅" }).closest("div");

    expect(dialog).toHaveClass("h5-dialog-frame", "h5-subscription-dialog-panel");
    expect(dialog).not.toHaveClass("h-fit");
    expect(header).toHaveClass("shrink-0");
    expect(form).toHaveClass("h5-subscription-dialog-form");
    expect(scrollRegion).toHaveClass("h5-mobile-sheet-scroll", "h5-subscription-dialog-scroll", "py-4");
    expect(scrollRegion?.className).not.toContain("--subscription-dialog-footer-space");
    expect(scrollRegion?.className).not.toContain("md:max-h-[calc(90vh-12rem)]");
    expect(scrollRegion).not.toHaveClass("pb-[calc(10rem+env(safe-area-inset-bottom))]");
    expect(footer).toHaveClass("shrink-0");
    expect(footer).not.toHaveClass("absolute");
  });

  it("keeps cost sharing member rows in a bounded manager view", async () => {
    const user = setupUser();
    const onOpenChange = vi.fn();
    let submittedMembers: CostSharingMember[] = [], submittedCostSharing: Subscription["costSharing"];
    const onSubmit = vi.fn<(submission: SubscriptionFormSubmission) => void>((submission) => {
      submittedCostSharing = submission.costSharing;
      submittedMembers = submission.costSharing?.members ?? [];
    });

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={onOpenChange}
          onSubmit={onSubmit}
          subscription={makeSubscription({
            price: "50",
            currency: "CNY",
            startDate: assertDateOnly("2026-01-01"),
            nextBillingDate: assertDateOnly("2026-04-01"),
            costSharing: {
              enabled: true,
              splitMode: "custom",
              collectionReminder: { enabled: true, reminderDays: -1 },
              members: [
                { id: "partner", name: "伴侣", currency: "CNY", customAmount: "10", joinedDate: assertDateOnly("2026-01-01") },
                { id: "friend", name: "朋友", currency: "CNY", customAmount: "10", joinedDate: assertDateOnly("2026-03-01") },
              ],
            },
          })}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog", { name: "编辑订阅" })).toBeInTheDocument();
    const form = document.querySelector("form");
    if (!form) throw new Error("Subscription dialog form was not rendered");
    const nameInput = screen.getByLabelText("服务名称");
    expect(screen.queryByLabelText("成员名称")).not.toBeInTheDocument();
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/成员合计\s*¥20 CNY\s*你的份额\s*¥30 CNY\s*可回收金额\s*¥20 CNY/);
    const formScrollRegion = document.querySelector<HTMLElement>("[data-subscription-dialog-scroll]");
    if (!formScrollRegion) throw new Error("Subscription dialog scroll region was not rendered");
    formScrollRegion.scrollTop = 320;

    await user.click(screen.getByRole("button", { name: "管理成员" }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const subscriptionHeader = document.querySelector("[data-subscription-dialog-header]");
    expect(subscriptionHeader).toHaveTextContent("编辑订阅");
    expect(subscriptionHeader?.closest('[role="dialog"]')).toHaveAttribute("data-state", "open");
    const memberDialog = screen.getByRole("dialog", { name: "管理共享成员" });
    expect(within(memberDialog).queryByRole("button", { name: "返回表单" })).not.toBeInTheDocument();
    expect(within(memberDialog).getAllByRole("button", { name: "完成" })).toHaveLength(1);
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
    expect(form).toContainElement(nameInput);
    expect(formScrollRegion.scrollTop).toBe(320);
    expect(within(memberDialog).getByTestId("cost-sharing-members-scroll")).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    const manager = within(memberDialog).getByTestId("cost-sharing-members-view");
    expect(within(manager).getAllByLabelText("成员名称")).toHaveLength(2);
    const memberNameInputs = within(manager).getAllByLabelText("成员名称");
    expect(manager.querySelector('input[type="date"]')).toBeNull();
    const joinedDateButtons = within(manager).getAllByRole("button", { name: /上车日期/ });
    expect(within(manager).queryByRole("button", { name: "设为我" })).not.toBeInTheDocument();
    expect(within(manager).queryByRole("button", { name: "设为付款人" })).not.toBeInTheDocument();
    expect(joinedDateButtons[0]).toHaveTextContent("2026年1月1日");
    expect(memberNameInputs[0]!).toHaveFocus();
    await user.click(memberNameInputs[1]!);
    expect(memberNameInputs[1]).toHaveFocus();
    await user.clear(memberNameInputs[1]!);
    await user.type(memberNameInputs[1]!, "队友");
    expect(memberNameInputs[1]).toHaveValue("队友");
    await user.click(joinedDateButtons[1]!);
    await user.click(await screen.findByRole("button", { name: /2026年3月15日/ }));
    expect(within(manager).getAllByRole("button", { name: /上车日期/ })[1]).toHaveTextContent("2026年3月15日");
    const amountInputs = within(manager).getAllByLabelText("应收金额");
    await user.clear(amountInputs[1]!);
    await user.type(amountInputs[1]!, "15");
    await user.click(within(memberDialog).getByRole("button", { name: "完成" }));

    expect(screen.getByRole("dialog", { name: "编辑订阅" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "管理共享成员" })).not.toBeInTheDocument();
    expect(formScrollRegion.scrollTop).toBe(320);
    expect(form).not.toHaveAttribute("inert");
    expect(form).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("button", { name: "管理成员" })).toHaveFocus();
    expect(screen.queryByLabelText("成员名称")).not.toBeInTheDocument();
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/成员合计\s*¥25 CNY\s*你的份额\s*¥25 CNY\s*可回收金额\s*¥25 CNY/);

    await user.click(screen.getByRole("button", { name: "管理成员" }));
    const reopenedMemberDialog = screen.getByRole("dialog", { name: "管理共享成员" });
    await user.click(within(reopenedMemberDialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "管理共享成员" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "编辑订阅" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "管理成员" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(submittedCostSharing?.collectionReminder).toEqual({ enabled: true, reminderDays: -1 });
    expect(submittedMembers).toEqual([
      expect.objectContaining({ id: "partner", customAmount: "10", joinedDate: assertDateOnly("2026-01-01") }),
      expect.objectContaining({ id: "friend", name: "队友", customAmount: "15", joinedDate: assertDateOnly("2026-03-15") }),
    ]);
  });

  it("closes the member manager when the parent subscription dialog closes", async () => {
    const user = setupUser();
    const dialogProps = {
      mode: "edit" as const,
      loadingPreview: null,
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      subscription: makeSubscription({
        costSharing: {
          enabled: true,
          splitMode: "equal",
          members: [
            { id: "partner", name: "伴侣", currency: "CNY" },
            { id: "friend", name: "朋友", currency: "CNY" },
          ],
        },
      }),
    };
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog {...dialogProps} open />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "管理成员" }));
    expect(screen.getByRole("dialog", { name: "管理共享成员" })).toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog {...dialogProps} open={false} />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("dialog", { name: "管理共享成员" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "编辑订阅" })).not.toBeInTheDocument();
  });

  it("keeps a manually selected create currency instead of syncing back to the default", async () => {
    const user = setupUser();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "添加新订阅" });
    expect(dialog).toHaveAccessibleDescription(/填写订阅名称/);
    expect(screen.getByLabelText("服务名称")).toBeInTheDocument();
    const priceInput = screen.getByLabelText("价格");
    expect(priceInput).toHaveAttribute("type", "text");
    expect(priceInput).toHaveAttribute("inputmode", "decimal");
    expect(screen.queryByRole("spinbutton", { name: "价格" })).not.toBeInTheDocument();

    const currencySelect = screen.getByRole("combobox", { name: "选择货币" });
    expect(currencySelect).toHaveTextContent("$ 美元 (USD)");

    await user.click(currencySelect);
    await user.click(await screen.findByText("¥ 人民币 (CNY)"));

    expect(screen.getByRole("combobox", { name: "选择货币" })).toHaveTextContent("¥ 人民币 (CNY)");
  });

  it("defaults new subscriptions to manual renewal and submits explicit auto-renew opt-in", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    const autoRenewSwitch = screen.getByRole("switch", { name: "自动续订" });
    expect(autoRenewSwitch).not.toBeChecked();

    await user.click(autoRenewSwitch);
    await user.type(screen.getByLabelText("服务名称"), "Opt-in SaaS");
    await user.type(screen.getByLabelText("价格"), "10");
    await user.click(screen.getByRole("button", { name: /到期日期.*选择日期/ }));
    await user.click(await screen.findByRole("button", { name: /2026年6月8日/ }));
    await user.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Opt-in SaaS",
      autoRenew: true,
    }));
  });

  it("keeps auto renewal off when switching from one-time back to a recurring cycle", async () => {
    const user = setupUser();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    const billingCycleSelect = screen.getByRole("combobox", { name: "扣费周期" });
    expect(screen.getByRole("switch", { name: "自动续订" })).not.toBeChecked();

    await user.click(billingCycleSelect);
    await user.click(await screen.findByRole("option", { name: "一次性购买" }));
    expect(screen.queryByRole("switch", { name: "自动续订" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "扣费周期" }));
    await user.click(await screen.findByRole("option", { name: "每年" }));

    expect(screen.getByRole("switch", { name: "自动续订" })).not.toBeChecked();
  });

  it("submits custom billing cycles with selectable units", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({ autoCalculateNextBillingDate: true })}
        />
      </TooltipProvider>,
    );

    const billingCycleSelect = screen.getByRole("combobox", { name: "扣费周期" });
    await user.click(billingCycleSelect);
    await user.click(await screen.findByRole("option", { name: "自定义" }));

    const inlineControl = screen.getByTestId("custom-cycle-inline-control");
    expect(inlineControl).toHaveClass("min-w-0", "grid-cols-[auto_minmax(0,1fr)_5rem]");
    await user.type(screen.getByLabelText("自定义周期"), "3");
    await user.click(screen.getByRole("combobox", { name: "自定义周期单位" }));
    await user.click(await screen.findByRole("option", { name: "年" }));

    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
      nextBillingDate: "2029-05-14",
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("id");
  });

  it("keeps explicit reminder days when editing historical subscriptions", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={makeSubscription({ reminderDays: 30 })}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("combobox", { name: "到期提醒" })).toHaveTextContent("提前 30 天");
  });

  it("shows inherited reminder selections when editing inherited subscriptions", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={makeSubscription({ reminderDays: -1 })}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("combobox", { name: "到期提醒" })).toHaveTextContent("默认值从设置中获取（提前 5 天）");
  });

  it("shows disabled reminders and hides repeat reminder controls when editing quiet subscriptions", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={makeSubscription({ reminderDays: -2, repeatReminderEnabled: true })}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("switch", { name: "到期提醒" })).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: "到期提醒" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("重复提醒")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "间隔" })).not.toBeInTheDocument();
  });

  it("opens the date picker on the month of the selected field value", async () => {
    const user = setupUser();
    const subscription: Subscription = {
      id: "sub-1",
      name: "OpenAI",
      logo: undefined,
      price: "20",
      currency: "USD",
      billingCycle: "monthly",
      customDays: undefined,
      customCycleUnit: undefined,
      category: "productivity",
      status: "active",
      publicHidden: false,
      pinned: false,
      paymentMethod: "alipay",
      startDate: assertDateOnly("2026-04-16"),
      nextBillingDate: assertDateOnly("2026-05-16"),
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
    };

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={subscription}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /2026年4月16日/ }));

    expect(await screen.findByRole("button", { name: "2026年" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "四月" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2026年4月16日.*selected/ })).toBeInTheDocument();
  });

  it("shows an inline error for historical subscriptions whose renewal date is before the start date", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({
            startDate: assertDateOnly("2026-05-14"),
            nextBillingDate: assertDateOnly("2026-05-13"),
            autoCalculateNextBillingDate: false,
          })}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(screen.getByText("到期日期不能早于开始日期")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables manual renewal dates before the selected start date", async () => {
    const user = setupUser();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={makeSubscription({
            startDate: assertDateOnly("2026-05-14"),
            nextBillingDate: assertDateOnly("2026-05-20"),
            autoCalculateNextBillingDate: false,
          })}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /2026年5月20日/ }));

    expect(await screen.findByRole("button", { name: "五月" })).toBeInTheDocument();
    const calendar = screen.getByRole("grid");
    expect(within(calendar).getByRole("button", { name: /2026年5月13日/ })).toBeDisabled();
    expect(within(calendar).getByRole("button", { name: /2026年5月14日/ })).not.toBeDisabled();
  });

  it("shows website and notes fields for an edited subscription", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={makeSubscription({
            website: "https://billing.example.com",
            notes: "团队年度订阅",
          })}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("网站")).toHaveValue("https://billing.example.com");
    expect(screen.getByLabelText("备注")).toHaveValue("团队年度订阅");
  });

  it("reuses existing tags and creates new tags when editing", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({ tags: ["Infra"] })}
          availableTags={["Security", "Docs", "Infra"]}
        />
      </TooltipProvider>,
    );

    const tagInput = screen.getByLabelText("标签");
    expect(screen.getByText("Infra")).toBeInTheDocument();

    await user.click(tagInput);
    await user.click(await screen.findByText("Security"));
    const refreshedTagInput = screen.getByLabelText("标签");
    await user.type(refreshedTagInput, "AI");
    expect(refreshedTagInput).toHaveValue("AI");
    await user.keyboard("{Enter}");
    await user.type(refreshedTagInput, "Infra");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      tags: ["Infra", "Security", "AI"],
    }));
  });

  it("commits pending tag text when submitting without Enter", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({ tags: ["Infra"] })}
          availableTags={["Infra"]}
        />
      </TooltipProvider>,
    );

    await user.type(screen.getByLabelText("标签"), "AI");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      tags: ["Infra", "AI"],
    }));
  });

  it("removes an edited tag chip before submitting", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({ tags: ["Infra", "Security"] })}
          availableTags={["Infra", "Security"]}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "移除标签 Infra" }));
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      tags: ["Security"],
    }));
  });

  it("submits editable website and notes without leaking read-model identity", async () => {
    const user = setupUser();
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          subscription={makeSubscription({
            id: "sub-edit-website-notes",
            website: "https://old.example.com",
            notes: "旧备注",
          })}
        />
      </TooltipProvider>,
    );

    await user.clear(screen.getByLabelText("网站"));
    await user.type(screen.getByLabelText("网站"), "https://new.example.com");
    await user.clear(screen.getByLabelText("备注"));
    await user.type(screen.getByLabelText("备注"), "新备注");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      website: "https://new.example.com",
      notes: "新备注",
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("id");
  });

});
