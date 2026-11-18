// 统计模型测试保护金额换算、有效状态和图表分组口径，首页/统计页必须共享这些业务语义。
import { describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS, type Subscription } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { buildDashboardStats } from "./dashboard-stats";
import { buildStatisticsModel } from "./statistics-model";
import { buildUpcomingReminderItems } from "./upcoming-reminders";
import { moneyToNumber } from "@renewlet/shared/money";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

const convert = (amount: number | string, from: string, to: string) => {
  const value = moneyToNumber(amount);
  if (from === to) return value;
  if (from === "USD" && to === "CNY") return value * 7;
  if (from === "CNY" && to === "USD") return value / 7;
  return value;
};

function subscription(overrides: SubscriptionOverrides): Subscription {
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
    nextBillingDate: assertDateOnly("2026-01-05"),
    autoRenew: false,
    autoCalculateNextBillingDate: false,
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

describe("subscription statistics models", () => {
  it("excludes paused/cancelled subscriptions from active spending", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ id: "active", price: "10", status: "active" }),
        subscription({ id: "trial", price: "5", status: "trial" }),
        subscription({ id: "paused", price: "100", status: "paused" }),
        subscription({ id: "cancelled", price: "100", status: "cancelled" }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.totalMonthly).toBe(15);
    expect(model.totalDaily).toBe(0.5);
    expect(model.activeCount).toBe(2);
    expect(model.inactiveCount).toBe(2);
    expect(model.monthlySavings).toBe(200);
    expect(model.annualSavings).toBe(2400);
    expect(model.budgetUsedPercent).toBe(0);
  });

  it("keeps one-time purchases active but excludes them from recurring spend and upcoming renewals", () => {
    const oneTime = subscription({
      id: "lifetime",
      category: "other",
      price: "199",
      status: "active",
      billingCycle: "one-time",
      nextBillingDate: assertDateOnly("2026-01-02"),
      autoCalculateNextBillingDate: false,
    });
    const recurring = subscription({
      id: "monthly",
      category: "productivity",
      price: "10",
      nextBillingDate: assertDateOnly("2026-02-01"),
    });

    const model = buildStatisticsModel({
      subscriptions: [oneTime, recurring],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-10T00:00:00.000Z"),
    });
    const dashboard = buildDashboardStats({
      subscriptions: [oneTime, recurring],
      defaultCurrency: "USD",
      convert,
      today: assertDateOnly("2026-01-01"),
    });

    expect(model.activeCount).toBe(2);
    expect(model.totalMonthly).toBe(10);
    expect(model.totalDaily).toBe(1 / 3);
    expect(model.avgMonthlyPerSub).toBe(10);
    expect(model.categoryData).toEqual([
      expect.objectContaining({ name: "Productivity", value: 10 }),
    ]);
    expect(model.inactiveCount).toBe(0);
    expect(dashboard.activeSubscriptions).toHaveLength(2);
    expect(dashboard.totalMonthly).toBe(10);
    expect(dashboard.totalDaily).toBe(1 / 3);
    expect(dashboard.upcomingCount).toBe(0);
  });

  it("amortizes one-time fixed terms while excluding them from current-month due cashflow", () => {
    const fixedTerm = subscription({
      id: "fixed-term",
      price: "120",
      billingCycle: "one-time",
      startDate: assertDateOnly("2025-07-05"),
      nextBillingDate: assertDateOnly("2026-01-05"),
      autoCalculateNextBillingDate: false,
      reminderDays: 4,
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
    });

    const model = buildStatisticsModel({
      subscriptions: [fixedTerm],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "40",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const dashboard = buildDashboardStats({
      subscriptions: [fixedTerm],
      defaultCurrency: "USD",
      convert,
      today: assertDateOnly("2026-01-01"),
    });

    expect(model.totalMonthly).toBe(20);
    expect(model.totalDaily).toBe(2 / 3);
    expect(model.totalAnnual).toBe(240);
    expect(model.thisMonthDue).toBe(0);
    expect(model.budgetUsedPercent).toBe(50);
    expect(model.categoryData).toEqual([
      expect.objectContaining({ value: 20 }),
    ]);
    expect(dashboard.totalMonthly).toBe(20);
    expect(dashboard.totalDaily).toBe(2 / 3);
    expect(dashboard.upcomingCount).toBe(1);
  });

  it("treats effective expired subscriptions as inactive savings", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ id: "active", price: "10", status: "active", nextBillingDate: assertDateOnly("2026-01-05") }),
        subscription({ id: "legacyExpired", price: "20", status: "active", nextBillingDate: assertDateOnly("2025-12-31") }),
        subscription({ id: "storedExpired", price: "30", status: "expired", nextBillingDate: assertDateOnly("2026-01-05") }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.totalMonthly).toBe(10);
    expect(model.activeCount).toBe(1);
    expect(model.inactiveCount).toBe(2);
    expect(model.monthlySavings).toBe(50);
  });

  it("normalizes inactive savings by billing cycle", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ id: "active", price: "20", status: "active" }),
        subscription({ id: "pausedAnnual", price: "120", status: "paused", billingCycle: "annual" }),
        subscription({ id: "cancelledQuarterly", price: "90", status: "cancelled", billingCycle: "quarterly" }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.totalMonthly).toBe(20);
    expect(model.monthlySavings).toBe(40);
    expect(model.annualSavings).toBe(480);
  });

  it("converts currency before monthly cycle normalization", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ price: "12", currency: "USD", billingCycle: "annual" }),
        subscription({ price: "70", currency: "CNY", billingCycle: "monthly" }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "100",
      defaultCurrency: "CNY",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.totalMonthly).toBe(77);
    expect(model.totalDaily).toBe(77 / 30);
    expect(model.budgetRemaining).toBe(23);
  });

  it("builds 12-month cashflow trend from recurring billing dates", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ id: "monthly", price: "10", billingCycle: "monthly", nextBillingDate: assertDateOnly("2026-01-15") }),
        subscription({ id: "annual", price: "120", billingCycle: "annual", nextBillingDate: assertDateOnly("2026-03-01") }),
        subscription({ id: "custom", price: "30", billingCycle: "custom", customDays: 2, customCycleUnit: "month", nextBillingDate: assertDateOnly("2026-02-10") }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.trendData).toHaveLength(12);
    expect(model.trendData.map((item) => item.monthKey)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
    ]);
    expect(model.trendData.map((item) => item.cashflow)).toEqual([
      10,
      40,
      130,
      40,
      10,
      40,
      10,
      40,
      10,
      40,
      10,
      40,
    ]);
    expect(model.trendData[0]?.cashflowItems).toEqual([
      {
        subscriptionId: "monthly",
        name: "Service",
        amount: 10,
        firstDate: assertDateOnly("2026-01-15"),
        lastDate: assertDateOnly("2026-01-15"),
        occurrenceCount: 1,
      },
    ]);
    expect(model.trendData[1]?.cashflowItems).toEqual([
      expect.objectContaining({ subscriptionId: "custom", amount: 30, firstDate: assertDateOnly("2026-02-10") }),
      expect.objectContaining({ subscriptionId: "monthly", amount: 10, firstDate: assertDateOnly("2026-02-15") }),
    ]);
    expect(model.trendData[2]?.cashflowItems).toEqual([
      expect.objectContaining({ subscriptionId: "annual", amount: 120, firstDate: assertDateOnly("2026-03-01") }),
      expect.objectContaining({ subscriptionId: "monthly", amount: 10, firstDate: assertDateOnly("2026-03-15") }),
    ]);
  });

  it("aggregates repeated cashflow occurrences from the same subscription within a month", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({
          id: "short-cycle",
          name: "Short Cycle",
          price: "3",
          billingCycle: "custom",
          customDays: 10,
          customCycleUnit: "day",
          nextBillingDate: assertDateOnly("2026-01-01"),
        }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.thisMonthDue).toBe(12);
    expect(model.trendData[0]).toEqual(expect.objectContaining({ cashflow: 12 }));
    expect(model.trendData[0]?.cashflowItems).toEqual([
      {
        subscriptionId: "short-cycle",
        name: "Short Cycle",
        amount: 12,
        firstDate: assertDateOnly("2026-01-01"),
        lastDate: assertDateOnly("2026-01-31"),
        occurrenceCount: 4,
      },
    ]);
  });

  it("builds amortized trend for recurring and fixed-term subscriptions without one-time cashflow", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ id: "monthly", price: "10", billingCycle: "monthly", nextBillingDate: assertDateOnly("2026-01-15") }),
        subscription({
          id: "fixedTerm",
          price: "120",
          billingCycle: "one-time",
          startDate: assertDateOnly("2026-02-15"),
          nextBillingDate: assertDateOnly("2026-04-15"),
          oneTimeTermCount: 2,
          oneTimeTermUnit: "month",
        }),
        subscription({
          id: "buyout",
          price: "500",
          billingCycle: "one-time",
          startDate: assertDateOnly("2026-01-01"),
          nextBillingDate: assertDateOnly("2026-01-01"),
        }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.trendData.map((item) => item.cashflow)).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(model.trendData.slice(0, 5).map((item) => [item.monthKey, item.amortized])).toEqual([
      ["2026-01", 10],
      ["2026-02", 70],
      ["2026-03", 70],
      ["2026-04", 70],
      ["2026-05", 10],
    ]);
    expect(model.trendData[0]?.cashflowItems.map((item) => item.subscriptionId)).toEqual(["monthly"]);
    expect(model.trendData[0]?.cashflowItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ subscriptionId: "buyout" })]),
    );
    expect(model.trendData[1]?.amortizedItems).toEqual([
      expect.objectContaining({ subscriptionId: "fixedTerm", amount: 60, occurrenceCount: 1 }),
      expect.objectContaining({ subscriptionId: "monthly", amount: 10, occurrenceCount: 1 }),
    ]);
  });

  it("converts currency before trend aggregation", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ id: "usd", price: "10", currency: "USD", billingCycle: "monthly", nextBillingDate: assertDateOnly("2026-01-05") }),
        subscription({ id: "cny", price: "70", currency: "CNY", billingCycle: "monthly", nextBillingDate: assertDateOnly("2026-01-10") }),
      ],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "CNY",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(model.trendData[0]).toEqual(expect.objectContaining({ cashflow: 140, amortized: 140 }));
  });

  it("switches statistics from total cost to personal cost basis", () => {
    const familyPlan = subscription({
      id: "family-plan",
      price: "100",
      billingCycle: "monthly",
      nextBillingDate: assertDateOnly("2026-01-05"),
      costSharing: {
        enabled: true,
        splitMode: "custom",
        members: [
          { id: "partner", name: "Partner", currency: "USD", customAmount: "60" },
        ],
      },
    });
    const totalModel = buildStatisticsModel({
      subscriptions: [familyPlan],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "100",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
      costBasis: "total",
    });
    const personalModel = buildStatisticsModel({
      subscriptions: [familyPlan],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "100",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-01-01T00:00:00.000Z"),
      costBasis: "personal",
    });

    expect(totalModel.totalMonthly).toBe(100);
    expect(totalModel.totalDaily).toBe(100 / 30);
    expect(totalModel.thisMonthDue).toBe(100);
    expect(totalModel.trendData[0]).toEqual(expect.objectContaining({ cashflow: 100, amortized: 100 }));
    expect(totalModel.trendData[0]?.cashflowItems).toEqual([
      expect.objectContaining({ subscriptionId: "family-plan", amount: 100 }),
    ]);
    expect(personalModel.totalMonthly).toBe(40);
    expect(personalModel.totalDaily).toBe(40 / 30);
    expect(personalModel.thisMonthDue).toBe(40);
    expect(personalModel.budgetUsedPercent).toBe(40);
    expect(personalModel.categoryData).toEqual([
      expect.objectContaining({ value: 40 }),
    ]);
    expect(personalModel.trendData[0]).toEqual(expect.objectContaining({ cashflow: 40, amortized: 40 }));
    expect(personalModel.trendData[0]?.cashflowItems).toEqual([
      expect.objectContaining({ subscriptionId: "family-plan", amount: 40 }),
    ]);
    expect(personalModel.trendData[0]?.amortizedItems).toEqual([
      expect.objectContaining({ subscriptionId: "family-plan", amount: 40 }),
    ]);
  });

  it("uses the configured timezone to choose the trend start month", () => {
    const model = buildStatisticsModel({
      subscriptions: [subscription({ id: "monthly", price: "10", billingCycle: "monthly", nextBillingDate: assertDateOnly("2026-07-01") })],
      config: DEFAULT_CUSTOM_CONFIG,
      monthlyBudget: "0",
      defaultCurrency: "USD",
      convert,
      now: new Date("2026-06-30T16:30:00.000Z"),
      timeZone: "Asia/Shanghai",
    });

    expect(model.trendData[0]?.monthKey).toBe("2026-07");
  });

  it("forecasts only remaining charges and keeps the month-end anchor after overdue periods", () => {
    const model = buildStatisticsModel({
      subscriptions: [
        subscription({ id: "weekly", price: "3", billingCycle: "weekly", nextBillingDate: assertDateOnly("2026-01-01"), reminderDays: -2 }),
        subscription({ id: "month-end", price: "10", startDate: assertDateOnly("2026-01-31"), nextBillingDate: assertDateOnly("2026-02-28"), autoCalculateNextBillingDate: true }),
        subscription({ id: "stopped", price: "100", status: "expired" }),
      ],
      config: DEFAULT_CUSTOM_CONFIG, monthlyBudget: "0", defaultCurrency: "USD", convert,
      today: assertDateOnly("2026-03-15"),
    });
    expect(model.thisMonthDue).toBe(16);
    expect(model.trendData[0]?.cashflowItems).toEqual([
      expect.objectContaining({ subscriptionId: "month-end", firstDate: "2026-03-31", occurrenceCount: 1, amount: 10 }),
      expect.objectContaining({ subscriptionId: "weekly", firstDate: "2026-03-19", lastDate: "2026-03-26", occurrenceCount: 2, amount: 6 }),
    ]);
    expect(model.trendData[1]?.cashflowItems).toContainEqual(expect.objectContaining({ subscriptionId: "month-end", firstDate: "2026-04-30" }));
  });

  it("dashboard upcoming count reuses the reminder window model", () => {
    const stats = buildDashboardStats({
      subscriptions: [
        subscription({ id: "explicit30", nextBillingDate: assertDateOnly("2026-07-15"), reminderDays: 30 }),
        subscription({ id: "inherit30", nextBillingDate: assertDateOnly("2026-07-15"), reminderDays: INHERIT_REMINDER_DAYS }),
        subscription({ id: "disabled", nextBillingDate: assertDateOnly("2026-07-15"), reminderDays: DISABLED_REMINDER_DAYS }),
        subscription({ id: "paused", status: "paused", nextBillingDate: assertDateOnly("2026-07-15"), reminderDays: 30 }),
      ],
      defaultCurrency: "USD",
      convert,
      notificationReminderDays: 30,
      today: assertDateOnly("2026-06-15"),
    });

    expect(stats.upcomingCount).toBe(2);
    expect(stats.activeSubscriptions).toHaveLength(3);
  });

  it("builds upcoming reminder items from effective reminder days", () => {
    const items = buildUpcomingReminderItems({
      subscriptions: [
        subscription({ id: "explicit30", name: "Explicit 30", nextBillingDate: assertDateOnly("2026-07-15"), reminderDays: 30 }),
        subscription({ id: "inherit30", name: "Inherited 30", nextBillingDate: assertDateOnly("2026-07-15"), reminderDays: INHERIT_REMINDER_DAYS }),
        subscription({ id: "disabled", name: "Disabled", nextBillingDate: assertDateOnly("2026-07-15"), reminderDays: DISABLED_REMINDER_DAYS }),
        subscription({ id: "today", name: "Today", nextBillingDate: assertDateOnly("2026-06-15"), reminderDays: 0 }),
        subscription({ id: "tomorrow", name: "Tomorrow", nextBillingDate: assertDateOnly("2026-06-16"), reminderDays: 0 }),
        subscription({ id: "old14Miss", name: "Old 14 Miss", nextBillingDate: assertDateOnly("2026-06-30"), reminderDays: 30 }),
        subscription({
          id: "buyout",
          name: "Buyout",
          billingCycle: "one-time",
          nextBillingDate: assertDateOnly("2026-06-30"),
          autoCalculateNextBillingDate: false,
          reminderDays: 30,
        }),
        subscription({
          id: "fixedTerm",
          name: "Fixed Term",
          billingCycle: "one-time",
          nextBillingDate: assertDateOnly("2026-06-30"),
          autoCalculateNextBillingDate: false,
          oneTimeTermCount: 12,
          oneTimeTermUnit: "month",
          reminderDays: 30,
        }),
      ],
      notificationReminderDays: 30,
      today: assertDateOnly("2026-06-15"),
    });

    expect(items.map((item) => [item.subscription.id, item.daysUntil, item.kind, item.reminderDays])).toEqual([
      ["today", 0, "renewal", 0],
      ["fixedTerm", 15, "expiry", 30],
      ["old14Miss", 15, "renewal", 30],
      ["explicit30", 30, "renewal", 30],
      ["inherit30", 30, "renewal", 30],
    ]);
  });

  it("dashboard excludes effective expired subscriptions from active counts and upcoming renewals", () => {
    const stats = buildDashboardStats({
      subscriptions: [
        subscription({ id: "active", status: "active", nextBillingDate: assertDateOnly("2026-01-05"), reminderDays: 4 }),
        subscription({ id: "legacyExpired", status: "active", nextBillingDate: assertDateOnly("2025-12-31") }),
        subscription({ id: "storedExpired", status: "expired", nextBillingDate: assertDateOnly("2026-01-02") }),
      ],
      defaultCurrency: "USD",
      convert,
      today: assertDateOnly("2026-01-01"),
    });

    expect(stats.upcomingCount).toBe(1);
    expect(stats.activeSubscriptions.map((item) => item.id)).toEqual(["active"]);
    expect(stats.totalMonthly).toBe(10);
  });
});
