import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api-client";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import type { Subscription } from "@/types/subscription";
import {
  RenewSubscriptionDialogContent,
  type RenewSubscriptionDialogProps,
} from "./renew-subscription-dialog";

function RenewSubscriptionDialog(props: RenewSubscriptionDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel="关闭"
        dismissMode="explicit"
        layout="content"
        className="h5-dialog-auto-frame gap-0 border-border bg-card p-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (!props.restoreFocusRef?.current) return;
          event.preventDefault();
          props.restoreFocusRef.current.focus();
        }}
      >
        <RenewSubscriptionDialogContent {...props} />
      </DialogContent>
    </Dialog>
  );
}

const mocks = vi.hoisted(() => ({
  config: {
    currencies: [
      { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
      { id: "EUR", value: "EUR", labels: { "zh-CN": "€ 欧元 (EUR)", "en-US": "€ Euro (EUR)" }, enabled: true },
    ],
  },
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({ config: mocks.config }),
  useLunarCalendar: () => ({ enabled: false, supported: true }),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string, values?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        "common.cancel": "取消",
        "common.close": "关闭",
        "subscription.empty.currency": "未找到货币",
        "subscription.field.currency": "货币",
        "subscription.field.nextBillingDate": "到期日期",
        "subscription.field.price": "价格",
        "subscription.field.startDate": "开始日期",
        "subscription.placeholder.currency": "选择货币",
        "subscription.placeholder.date": "选择日期",
        "subscription.renew": "续订",
        "subscription.renew.description": "选择续订方式，并确认本次续订后的价格、货币和扣费日期。",
        "subscription.renew.continueNextBillingDate": "续订后下次扣费日",
        "subscription.renew.currentNextBillingDate": "当前下次扣费日",
        "subscription.renew.mode": "续订方式",
        "subscription.renew.modeContinue": "延续原周期",
        "subscription.renew.modeContinueHelp": "适合订阅一直在用，只确认下一期继续。系统会按原周期自动推进下次扣费日。",
        "subscription.renew.modeContinueShort": "按原周期锚点推进日期。",
        "subscription.renew.modeRestart": "重新开始订阅",
        "subscription.renew.modeRestartHelp": "适合中间断订后重新订阅。可以设置新的开始日期和下次扣费日。",
        "subscription.renew.modeRestartShort": "把新日期写成开始日。",
        "subscription.renew.restartSubmit": "重新开始订阅",
        "subscription.renew.submit": "确认续订",
        "subscription.renew.title": `续订「${String(values?.["name"] ?? "")}」`,
        "subscription.renew.validation.startDateRequired": "请选择新的开始日期",
        "subscription.renew.memberDates.title": "确认成员上车日期",
        "subscription.renew.memberDates.label": `${String(values?.["name"] ?? "")}的上车日期`,
        "subscription.renew.memberDates.original": `原日期：${String(values?.["date"] ?? "")}`,
        "subscription.search.currency": "搜索货币、代码或符号...",
        "subscription.validation.amountInvalid": "金额必须是 0 到 1,000,000,000 之间的有效数字",
        "subscription.validation.dateOrderInvalid": "到期日期不能早于开始日期",
      };
      return messages[key] ?? key;
    },
    formatCurrency: (value: string, currency: string) => `${value} ${currency}`,
    formatDateOnly: (value: string) => value,
    formatDateTime: (value: Date | string) => {
      const date = value instanceof Date ? value : new Date(value);
      return date.toISOString().slice(0, 10);
    },
  }),
}));

beforeEach(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("shows only affected member dates with original values and submits the confirmed proposal", async () => {
  const user = setupUser();
  const { onSubmit } = renderDialog({ subscription: makeSubscription({ costSharing: { enabled: true, splitMode: "equal", members: [
    { id: "old", name: "Alice", joinedDate: assertDateOnly("2026-01-31") },
    { id: "inside", name: "Bob", joinedDate: assertDateOnly("2026-08-20") },
    { id: "blank", name: "Dan" },
  ] } }) });
  expect(screen.queryByText("确认成员上车日期")).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: /重新开始订阅/ }));
  const memberField = screen.getByRole("button", { name: /Alice的上车日期/ });
  expect(memberField).toHaveTextContent("2026-08-12");
  expect(memberField).toHaveAccessibleDescription("原日期：2026-01-31");
  expect(screen.queryByRole("button", { name: /Bob的上车日期/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Dan的上车日期/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新开始订阅" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ costSharingMemberJoinedDates: [{ id: "old", joinedDate: "2026-08-12" }] }));
});

it("localizes nested domain codes instead of showing the raw server message", async () => {
  const user = setupUser();
  renderDialog({ onSubmit: vi.fn().mockRejectedValue(new ApiError("COST_SHARING_MEMBER_JOINED_DATE_OUT_OF_RANGE.", 400, undefined, "INVALID_PAYLOAD")) });
  await user.click(screen.getByRole("button", { name: "确认续订" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("成员上车日期必须在订阅日期范围内");
  expect(screen.queryByText(/COST_SHARING_MEMBER_JOINED_DATE_OUT_OF_RANGE/)).not.toBeInTheDocument();
});

function setupUser() {
  return userEvent.setup();
}

function makeSubscription(overrides: SubscriptionFixtureOverrides<Subscription> = {}): Subscription {
  return {
    id: "sub-renew",
    updatedAt: "2026-01-31T00:00:00.000Z",
    name: "Renewable SaaS",
    logo: undefined,
    price: "12",
    currency: "USD",
    category: "productivity",
    status: "expired",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-31"),
    nextBillingDate: assertDateOnly("2026-02-28"),
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
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

function renderDialog(props: Partial<ComponentProps<typeof RenewSubscriptionDialog>> = {}) {
  const onSubmit = vi.fn<NonNullable<ComponentProps<typeof RenewSubscriptionDialog>["onSubmit"]>>();
  const onOpenChange = vi.fn();
  const view = render(
    <TooltipProvider delayDuration={0}>
      <RenewSubscriptionDialog
        subscription={makeSubscription()}
        loadingPreview={null}
        open
        today={assertDateOnly("2026-08-12")}
        submitting={false}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onSubmit, onOpenChange, rerenderWith: (next: Partial<RenewSubscriptionDialogProps>) => view.rerender(
    <TooltipProvider delayDuration={0}><RenewSubscriptionDialog subscription={makeSubscription()} loadingPreview={null} open today={assertDateOnly("2026-08-12")} submitting={false} onOpenChange={onOpenChange} onSubmit={onSubmit} {...props} {...next} /></TooltipProvider>,
  ) };
}

function FocusRestoreHarness() {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <TooltipProvider delayDuration={0}>
      <button type="button" ref={triggerRef}>续订入口</button>
      <RenewSubscriptionDialog
        subscription={makeSubscription()}
        loadingPreview={null}
        open={open}
        today={assertDateOnly("2026-08-12")}
        submitting={false}
        restoreFocusRef={triggerRef}
        onOpenChange={setOpen}
        onSubmit={vi.fn()}
      />
    </TooltipProvider>
  );
}

describe("RenewSubscriptionDialog", () => {
  it("uses the resolved renewal scaffold while detail data is pending", () => {
    const preview = makeSubscription({ status: "expired" });
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={null}
          loadingPreview={preview}
          open
          today={assertDateOnly("2026-08-12")}
          submitting={false}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          loading
        />
      </TooltipProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "续订「Renewable SaaS」" });
    const form = dialog.querySelector("form");
    expect(screen.getByTestId("renew-subscription-data-loading")).toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={preview}
          loadingPreview={preview}
          open
          today={assertDateOnly("2026-08-12")}
          submitting={false}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog", { name: "续订「Renewable SaaS」" })).toBe(dialog);
    expect(dialog.querySelector("form")).toBe(form);
    expect(screen.queryByTestId("renew-subscription-data-loading")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /延续原周期/ })).toBeChecked();
  });

  it("defaults expired subscriptions to continue and opens restart only on explicit choice", async () => {
    renderDialog();
    expect(screen.queryByRole("button", { name: /开始日期/ })).not.toBeInTheDocument();

    const dialog = screen.getByRole("dialog", { name: "续订「Renewable SaaS」" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass("h5-dialog-auto-frame", "h-fit", "gap-0");
    expect(dialog).not.toHaveClass("h5-dialog-frame");
    const form = dialog.querySelector("form");
    expect(form).toHaveClass("h5-subscription-dialog-form", "overflow-hidden");
    expect(screen.getByRole("radio", { name: /延续原周期/ })).toBeChecked();
    await setupUser().click(screen.getByRole("radio", { name: /重新开始订阅/ }));
    expect(screen.getByRole("button", { name: /开始日期 2026-08-12/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /到期日期 2026-09-12/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新开始订阅" })).toBeEnabled();
    const pricingRow = screen.getByLabelText("价格").closest('[data-slot="form-field-row"]');
    const scheduleRow = screen.getByRole("button", { name: /开始日期 2026-08-12/ }).closest('[data-slot="form-field-row"]');
    expect(pricingRow).toHaveAttribute("data-align-at", "sm");
    expect(pricingRow).toHaveAttribute("data-tracks", "2");
    expect(scheduleRow).toHaveAttribute("data-align-at", "sm");
    expect(scheduleRow).toHaveAttribute("data-tracks", "2");
  });

  it("opens active subscriptions in continue mode and submits an explicit payload", async () => {
    const user = setupUser();
    const { onSubmit } = renderDialog({ subscription: makeSubscription({ status: "active" }) });

    expect(screen.getByRole("dialog", { name: "续订「Renewable SaaS」" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /延续原周期/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: /开始日期/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /到期日期/ })).not.toBeInTheDocument();
    expect(screen.getByText("当前下次扣费日")).toBeInTheDocument();
    expect(screen.getByText("续订后下次扣费日")).toBeInTheDocument();
    expect(screen.getByText("2026-02-28")).toBeInTheDocument();
    expect(screen.getByText("2026-08-31")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("价格"));
    await user.type(screen.getByLabelText("价格"), "15.50");
    await user.click(screen.getByRole("combobox", { name: "货币" }));
    await user.click(within(screen.getByRole("listbox")).getByText("€ 欧元 (EUR)"));
    await user.click(screen.getByRole("button", { name: "确认续订" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      expectedNextBillingDate: "2026-02-28",
      expectedUpdatedAt: "2026-01-31T00:00:00.000Z",
      mode: "continue",
      price: "15.5",
      currency: "EUR",
      startDate: null,
      nextBillingDate: "2026-08-31",
      autoCalculateNextBillingDate: false,
    }));
  });

  it("switches to restart mode, recalculates default dates, and marks manual next date edits", async () => {
    const user = setupUser();
    const { onSubmit } = renderDialog({ subscription: makeSubscription({ status: "active" }) });

    await user.click(screen.getByRole("radio", { name: /重新开始订阅/ }));

    expect(screen.getByRole("button", { name: /开始日期 2026-08-12/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /到期日期 2026-09-12/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /到期日期 2026-09-12/ }));
    await user.click(within(screen.getByRole("gridcell", { name: "15" })).getByRole("button"));
    await user.click(screen.getByRole("button", { name: "重新开始订阅" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      mode: "restart",
      startDate: "2026-08-12",
      nextBillingDate: "2026-09-15",
      autoCalculateNextBillingDate: false,
    })));
  });

  it("focuses the first invalid field and disables duplicate submit while submitting", async () => {
    const user = setupUser();
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={makeSubscription()}
          loadingPreview={null}
          open
          today={assertDateOnly("2026-08-12")}
          submitting
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: "确认续订" })).toBeDisabled();

    rerender(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={makeSubscription()}
          loadingPreview={null}
          open
          today={assertDateOnly("2026-08-12")}
          submitting={false}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );
    await user.clear(screen.getByLabelText("价格"));
    await user.click(screen.getByRole("button", { name: "确认续订" }));

    const invalidPrice = screen.getByLabelText("价格");
    await waitFor(() => expect(invalidPrice).toHaveFocus());
    expect(screen.getByText("金额必须是 0 到 1,000,000,000 之间的有效数字")).toBeInTheDocument();
  });

  it("restores focus to the renew entry after closing", async () => {
    const user = setupUser();
    render(<FocusRestoreHarness />);

    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "续订入口" })).toHaveFocus());
  });
});


describe("renewal draft and recovery", () => {
  it("keeps amount and restart drafts through background refresh, midnight, and mode changes", async () => {
    const user = setupUser();
    const { rerenderWith, onSubmit } = renderDialog();
    await user.clear(screen.getByLabelText("价格"));
    await user.type(screen.getByLabelText("价格"), "23");
    await user.click(screen.getByRole("radio", { name: /重新开始订阅/ }));
    await user.click(screen.getByRole("button", { name: /到期日期 2026-09-12/ }));
    await user.click(within(screen.getByRole("gridcell", { name: "15" })).getByRole("button"));
    await user.click(screen.getByRole("radio", { name: /延续原周期/ }));
    rerenderWith({ subscription: makeSubscription({ price: "99", updatedAt: "2026-08-13T00:00:00Z" }), today: assertDateOnly("2026-08-13") });
    expect(screen.getByLabelText("价格")).toHaveValue("23");
    await user.click(screen.getByRole("radio", { name: /重新开始订阅/ }));
    expect(screen.getByRole("button", { name: /到期日期 2026-09-15/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "重新开始订阅" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ price: "23", expectedUpdatedAt: "2026-01-31T00:00:00.000Z", nextBillingDate: "2026-09-15" }));
  });

  it.each([
    new ApiError("Conflict", 409, undefined, "SUBSCRIPTION_RENEW_CONFLICT"),
    new ApiError("Timeout", 0, undefined, "timeout"),
    new ApiError("Invalid response", 200, undefined, "invalid_response"),
  ])("preserves inputs and requires a read before another confirmation after $code", async (error) => {
    const user = setupUser();
    const submit = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const refresh = vi.fn().mockResolvedValue(makeSubscription({ nextBillingDate: assertDateOnly("2026-08-31"), updatedAt: "2026-08-12T00:00:00.000Z" }));
    renderDialog({ onSubmit: submit, onRefresh: refresh });
    await user.clear(screen.getByLabelText("价格"));
    await user.type(screen.getByLabelText("价格"), "0");
    await user.click(screen.getByRole("button", { name: "确认续订" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认续订" })).toBeDisabled());
    expect(screen.getByLabelText("价格")).toHaveValue("0");
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    expect(submit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "subscription.renew.refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认续订" })).toBeEnabled());
    expect(screen.getByLabelText("价格")).toHaveValue("0");
    expect(submit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "确认续订" }));
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ price: "0", expectedUpdatedAt: "2026-08-12T00:00:00.000Z", nextBillingDate: "2026-09-30" }));
  });

  it("locks synchronous double submission and all fields until the write settles", async () => {
    let resolve!: () => void;
    const submit = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    renderDialog({ onSubmit: submit });
    const form = screen.getByLabelText("价格").closest("form")!;
    act(() => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("价格")).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => { resolve(); });
    expect(screen.getByLabelText("价格")).toBeEnabled();
  });

  it("reads missing metadata once and blocks unversioned writes", async () => {
    const refresh = vi.fn().mockResolvedValue(makeSubscription({ updatedAt: undefined }));
    const { onSubmit } = renderDialog({ subscription: makeSubscription({ updatedAt: undefined }), onRefresh: refresh });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认续订" })).toBeDisabled());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
