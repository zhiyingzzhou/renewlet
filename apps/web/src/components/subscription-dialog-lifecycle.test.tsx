// 订阅弹窗生命周期测试守住 create/edit 草稿 session，避免关闭重开再次继承未提交输入。
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import type { Subscription, SubscriptionFormSubmission } from "@/types/subscription";
import { preloadSubscriptionDialog, SubscriptionDialog } from "./subscription-dialog";

const mocks = vi.hoisted(() => ({
  config: {
    categories: [{ id: "productivity", value: "productivity", labels: { "zh-CN": "效率工具", "en-US": "Productivity" } }],
    statuses: [{ id: "active", value: "active", labels: { "zh-CN": "活跃", "en-US": "Active" } }],
    paymentMethods: [{ id: "alipay", value: "alipay", labels: { "zh-CN": "支付宝", "en-US": "Alipay" } }],
    currencies: [
      { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
      { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
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

vi.mock("@/components/logo-picker", () => ({
  LogoPicker: () => null,
}));

beforeAll(async () => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
  await preloadSubscriptionDialog();
});

function makeSubscription(overrides: SubscriptionFixtureOverrides<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Original SaaS",
    logo: undefined,
    price: "29",
    currency: "USD",
    category: "productivity",
    status: "active",
    publicHidden: false,
    paymentMethod: "alipay",
    startDate: assertDateOnly("2026-05-14"),
    nextBillingDate: assertDateOnly("2026-06-14"),
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

function CreateDialogHarness({
  onSubmit = vi.fn<(submission: SubscriptionFormSubmission) => void>(),
}: {
  onSubmit?: (submission: SubscriptionFormSubmission) => void;
} = {}) {
  const [open, setOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={0}>
      <button type="button" onClick={() => setOpen(true)}>打开新增弹窗</button>
      <SubscriptionDialog
          loadingPreview={null}
        mode="create"
        open={open}
        onOpenChange={setOpen}
        onSubmit={onSubmit}
      />
    </TooltipProvider>
  );
}

function CreateCloneDialogHarness({
  onSubmit = vi.fn<(submission: SubscriptionFormSubmission) => void>(),
}: {
  onSubmit?: (submission: SubscriptionFormSubmission) => void;
} = {}) {
  const [dialogKind, setDialogKind] = useState<"create" | "clone" | null>(null);
  const cloneSource = makeSubscription({
    name: "Cloned SaaS",
    price: "42",
    currency: "CNY",
    publicHidden: true,
    notes: "Keep note",
    tags: ["Infra"],
  });

  return (
    <TooltipProvider delayDuration={0}>
      <button type="button" onClick={() => setDialogKind("create")}>打开普通新增弹窗</button>
      <button type="button" onClick={() => setDialogKind("clone")}>打开复制弹窗</button>
      <SubscriptionDialog
          loadingPreview={null}
        mode="create"
        open={dialogKind !== null}
        onOpenChange={(open) => {
          if (!open) setDialogKind(null);
        }}
        onSubmit={onSubmit}
        initialSubscription={dialogKind === "clone" ? cloneSource : null}
      />
    </TooltipProvider>
  );
}

function EditDialogHarness() {
  const [open, setOpen] = useState(false);
  const subscription = makeSubscription();

  return (
    <TooltipProvider delayDuration={0}>
      <button type="button" onClick={() => setOpen(true)}>打开编辑弹窗</button>
      <SubscriptionDialog
          loadingPreview={null}
        mode="edit"
        open={open}
        onOpenChange={setOpen}
        onSubmit={vi.fn()}
        subscription={subscription}
      />
    </TooltipProvider>
  );
}

describe("SubscriptionDialog lifecycle", () => {
  it("hands data loading to the resolved form scaffold without replacing the dialog shell", () => {
    const preview = makeSubscription();
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={preview}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={null}
          loading
        />
      </TooltipProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "编辑订阅" });
    const form = dialog.querySelector("form");
    expect(screen.getByTestId("subscription-form-data-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("dialog-module-pending")).not.toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={preview}
          mode="edit"
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          subscription={preview}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog", { name: "编辑订阅" })).toBe(dialog);
    expect(dialog.querySelector("form")).toBe(form);
    expect(screen.queryByTestId("subscription-form-data-loading")).not.toBeInTheDocument();
    expect(screen.getByLabelText("服务名称")).toHaveValue("Original SaaS");
  });

  it("clears an unsubmitted create draft after cancelling and reopening", async () => {
    const user = userEvent.setup();

    render(<CreateDialogHarness />);

    await user.click(screen.getByRole("button", { name: "打开新增弹窗" }));
    await user.type(screen.getByLabelText("服务名称"), "Lingering SaaS");
    await user.type(screen.getByLabelText("价格"), "12");
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "添加新订阅" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开新增弹窗" }));

    expect(screen.getByLabelText("服务名称")).toHaveValue("");
    expect(screen.getByLabelText("价格")).toHaveValue("");
  });

  it("clears an unsubmitted create draft after using the close button", async () => {
    const user = userEvent.setup();

    render(<CreateDialogHarness />);

    await user.click(screen.getByRole("button", { name: "打开新增弹窗" }));
    await user.type(screen.getByLabelText("服务名称"), "Close Button SaaS");
    await user.click(screen.getByRole("button", { name: "关闭" }));

    await user.click(screen.getByRole("button", { name: "打开新增弹窗" }));

    expect(screen.getByLabelText("服务名称")).toHaveValue("");
  });

  it("resets the create currency to the current default after reopening", async () => {
    const user = userEvent.setup();

    render(<CreateDialogHarness />);

    await user.click(screen.getByRole("button", { name: "打开新增弹窗" }));
    expect(screen.getByRole("combobox", { name: "选择货币" })).toHaveTextContent("$ 美元 (USD)");

    await user.click(screen.getByRole("combobox", { name: "选择货币" }));
    await user.click(await screen.findByText("¥ 人民币 (CNY)"));
    expect(screen.getByRole("combobox", { name: "选择货币" })).toHaveTextContent("¥ 人民币 (CNY)");

    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "打开新增弹窗" }));

    expect(screen.getByRole("combobox", { name: "选择货币" })).toHaveTextContent("$ 美元 (USD)");
  });

  it("keeps user input after create validation fails", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(submission: SubscriptionFormSubmission) => void>();

    render(<CreateDialogHarness onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "打开新增弹窗" }));
    await user.type(screen.getByLabelText("服务名称"), "Needs Fixing");
    await user.type(screen.getByLabelText("价格"), "1000000001");
    await user.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(screen.getByLabelText("服务名称")).toHaveValue("Needs Fixing");
    expect(screen.getByLabelText("价格")).toHaveValue("1,000,000,001");
    expect(screen.getByText("金额必须是 0 到 1,000,000,000 之间的有效数字")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("prefills clone create sessions and keeps regular create sessions blank", async () => {
    const user = userEvent.setup();

    render(<CreateCloneDialogHarness />);

    await user.click(screen.getByRole("button", { name: "打开复制弹窗" }));

    expect(screen.getByRole("dialog", { name: "复制订阅" })).toBeInTheDocument();
    expect(screen.getByLabelText("服务名称")).toHaveValue("Cloned SaaS");
    expect(screen.getByLabelText("价格")).toHaveValue("42");
    expect(screen.getByRole("combobox", { name: "选择货币" })).toHaveTextContent("¥ 人民币 (CNY)");
    expect(screen.getByRole("switch", { name: "从公开页隐藏" })).toBeChecked();
    expect(screen.getByLabelText("备注")).toHaveValue("Keep note");

    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "打开普通新增弹窗" }));

    expect(screen.getByRole("dialog", { name: "添加新订阅" })).toBeInTheDocument();
    expect(screen.getByLabelText("服务名称")).toHaveValue("");
    expect(screen.getByLabelText("价格")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "选择货币" })).toHaveTextContent("$ 美元 (USD)");
    expect(screen.getByRole("switch", { name: "从公开页隐藏" })).not.toBeChecked();
  });

  it("reopens edit mode from the subscription snapshot instead of unsaved edits", async () => {
    const user = userEvent.setup();

    render(<EditDialogHarness />);

    await user.click(screen.getByRole("button", { name: "打开编辑弹窗" }));
    expect(await screen.findByDisplayValue("Original SaaS")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("服务名称"));
    await user.type(screen.getByLabelText("服务名称"), "Unsaved SaaS");
    await user.click(screen.getByRole("button", { name: "取消" }));

    await user.click(screen.getByRole("button", { name: "打开编辑弹窗" }));

    expect(await screen.findByDisplayValue("Original SaaS")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Unsaved SaaS")).not.toBeInTheDocument();
  });
});
