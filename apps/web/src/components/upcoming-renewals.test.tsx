import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { RecurringCycleSubscription } from "@/types/subscription";
import { UpcomingRenewals } from "./upcoming-renewals";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "upcoming.noneNextTwoWeeks": "暂无未来续费或到期",
        "upcoming.todayShort": "今",
        "upcoming.daysShort": "{days}天",
        "upcoming.eventOn": "{date} · {event}",
        "upcoming.renewal": "续费",
        "upcoming.projectedRenewal": "预计续费",
        "upcoming.trial": "试用结束",
        "subscription.card.trialEnds": "试用期将于 {date} 结束",
        "subscription.oneTimeMode.term": "固定服务期",
        "subscription.renewal.auto": "自动续订",
        "subscription.renewal.manual": "手动续订",
        "subscription.reminderEnabledHelp": "按此订阅的到期或续费日期发送提醒。",
      };
      let value = messages[key] ?? key;
      for (const [name, replacement] of Object.entries(params ?? {})) {
        value = value.replace(`{${name}}`, String(replacement));
      }
      return value;
    },
    formatCurrency: (amount: number, currency: string) => `${currency} ${amount}`,
  }),
}));

const baseSubscription: RecurringCycleSubscription = {
  id: "netflix",
  name: "Netflix",
  logo: undefined,
  price: "10",
  currency: "USD",
  billingCycle: "annual",
  customDays: undefined,
  customCycleUnit: undefined,
  oneTimeTermCount: undefined,
  oneTimeTermUnit: undefined,
  category: "entertainment",
  status: "active",
  paymentMethod: undefined,
  startDate: assertDateOnly("2025-07-15"),
  nextBillingDate: assertDateOnly("2026-07-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: undefined,
  notes: undefined,
  tags: [],
  reminderDays: 30,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  pinned: false,
  publicHidden: false,
};

function subscription(overrides: Partial<RecurringCycleSubscription> = {}): RecurringCycleSubscription {
  return { ...baseSubscription, ...overrides };
}

describe("UpcomingRenewals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows future subscriptions outside the reminder window", () => {
    render(
      <UpcomingRenewals
        subscriptions={[subscription()]}
        today="2026-06-15"
      />,
    );

    expect(screen.getAllByText("Netflix")).toHaveLength(5);
    expect(screen.getByText("30天")).toBeInTheDocument();
    expect(screen.getAllByText("USD 10")).toHaveLength(5);
    expect(screen.getByText("7月15日 · 续费")).toBeInTheDocument();
    expect(screen.getByText("2027/7/15 · 预计续费")).toBeInTheDocument();
    expect(screen.getByText("2030/7/15 · 预计续费")).toBeInTheDocument();
    expect(screen.getAllByText("手动续订")).toHaveLength(5);
    expect(screen.getAllByRole("img", { name: "按此订阅的到期或续费日期发送提醒。" })).toHaveLength(5);
  });

  it("shares compact columns while only the subscription name can shrink and wrap", () => {
    render(
      <UpcomingRenewals
        subscriptions={[subscription({ name: "AnExtremelyLongSubscriptionNameWithoutNaturalBreaks" })]}
        today="2026-06-15"
      />,
    );

    const name = screen.getAllByText("AnExtremelyLongSubscriptionNameWithoutNaturalBreaks")[0]!;
    const details = name.parentElement;
    const row = details?.parentElement;
    const list = row?.parentElement;
    if (!details || !row || !list) {
      throw new Error("Expected the upcoming renewal content to render inside its shared grid row.");
    }

    const price = screen.getAllByText("USD 10")[0]!;
    expect(list).toHaveClass("grid", "min-w-0", "grid-cols-[max-content_minmax(0,1fr)_max-content]");
    expect(row).toHaveClass("col-span-3", "grid", "min-w-0", "grid-cols-subgrid");
    expect(row.children[1]).toBe(details);
    expect(row.children[2]).toBe(price);
    expect(details).toHaveClass("min-w-0");
    expect(name).toHaveClass("min-w-0", "wrap-break-word");
    expect(price).toHaveClass("whitespace-nowrap", "text-right", "tabular-nums");
  });

  it("keeps reminder-disabled subscriptions visible without the Bell indicator", () => {
    render(
      <UpcomingRenewals
        subscriptions={[subscription({ reminderDays: -2 })]}
        today="2026-06-15"
      />,
    );

    expect(screen.getAllByText("Netflix")).toHaveLength(5);
    expect(screen.queryByRole("img", { name: "按此订阅的到期或续费日期发送提醒。" })).not.toBeInTheDocument();
  });

  it("uses the earlier trial end date and shows automatic renewal state", () => {
    render(
      <UpcomingRenewals
        subscriptions={[subscription({ status: "trial", autoRenew: true, trialEndDate: assertDateOnly("2026-06-20"), nextBillingDate: assertDateOnly("2026-07-15") })]}
        today="2026-06-15"
      />,
    );

    expect(screen.getByText("5天")).toBeInTheDocument();
    expect(screen.getByText("6月20日 · 试用结束")).toBeInTheDocument();
    expect(screen.getAllByText("自动续订")).toHaveLength(5);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("keeps the compact five-item presentation limit after sorting all events", () => {
    const subscriptions = Array.from({ length: 6 }, (_, index) => subscription({
      id: `subscription-${index}`,
      name: `Subscription ${index}`,
      nextBillingDate: assertDateOnly(`2026-06-${String(16 + index).padStart(2, "0")}`),
    }));

    render(<UpcomingRenewals subscriptions={subscriptions} today="2026-06-15" />);

    expect(screen.getByText("Subscription 0")).toBeInTheDocument();
    expect(screen.getByText("Subscription 4")).toBeInTheDocument();
    expect(screen.queryByText("Subscription 5")).not.toBeInTheDocument();
  });

  it("shows an empty state only when no eligible future event exists", () => {
    render(<UpcomingRenewals subscriptions={[]} today="2026-06-15" />);

    expect(screen.getByText("暂无未来续费或到期")).toBeInTheDocument();
  });
});
