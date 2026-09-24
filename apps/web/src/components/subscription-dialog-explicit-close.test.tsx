// 订阅表单显式关闭测试独立放置，避免通用弹窗状态机测试超过文件行数门禁。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
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

function getTopDialogOverlay() {
  const overlays = document.querySelectorAll<HTMLElement>("[data-dialog-overlay]");
  const overlay = overlays.item(overlays.length - 1);
  if (!overlay) throw new Error("Dialog overlay was not rendered");
  return overlay;
}

function makeSubscription(overrides: SubscriptionFixtureOverrides<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Critical SaaS",
    logo: undefined,
    price: "50",
    currency: "CNY",
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

describe("SubscriptionDialog explicit close", () => {
  it("keeps create form dialogs open until an internal close control is used", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={onOpenChange}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(getTopDialogOverlay());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog", { name: "添加新订阅" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the cost sharing manager open on Escape and overlay clicks", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="edit"
          open
          onOpenChange={onOpenChange}
          onSubmit={vi.fn()}
          subscription={makeSubscription({
            costSharing: {
              enabled: true,
              splitMode: "custom",
              members: [
                { id: "partner", name: "伴侣", currency: "CNY", customAmount: "10" },
                { id: "friend", name: "朋友", currency: "CNY", customAmount: "10" },
              ],
            },
          })}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "管理成员" }));
    expect(screen.getByRole("dialog", { name: "管理共享成员" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);

    await user.click(getTopDialogOverlay());
    expect(screen.getByRole("dialog", { name: "管理共享成员" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "管理共享成员" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog", { name: "管理共享成员" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "编辑订阅" })).toBeInTheDocument();
  });
});
