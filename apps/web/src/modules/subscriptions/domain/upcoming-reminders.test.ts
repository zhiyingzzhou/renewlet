import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { subscriptionCycleFixture, type SubscriptionFixtureOverrides } from "@/test/subscription-fixtures";
import { buildUpcomingSubscriptionEvents, resolveUpcomingSubscriptionEvent } from "./upcoming-reminders";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

const baseSubscription: SubscriptionBaseFixture = {
  id: "base",
  name: "Base",
  logo: undefined,
  price: "10",
  currency: "USD",
  category: "productivity",
  status: "active",
  paymentMethod: undefined,
  startDate: assertDateOnly("2026-01-01"),
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
  costSharing: undefined,
  pinned: false,
  publicHidden: false,
};

function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  return {
    ...baseSubscription,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

describe("upcoming subscription events", () => {
  it("takes the global five across interleaved streams and stable equal-date ties", () => {
    const events = buildUpcomingSubscriptionEvents({ today: "2026-06-01", subscriptions: [
      subscription({ id: "later", name: "Later", nextBillingDate: assertDateOnly("2026-07-15") }),
      subscription({ id: "b", name: "Same", billingCycle: "custom", customDays: 1, customCycleUnit: "day", nextBillingDate: assertDateOnly("2026-06-01"), autoCalculateNextBillingDate: false }),
      subscription({ id: "a", name: "Same", billingCycle: "custom", customDays: 1, customCycleUnit: "day", nextBillingDate: assertDateOnly("2026-06-01"), autoCalculateNextBillingDate: false }),
    ] });
    expect(events.map(({ subscriptionId, dueDate }) => [subscriptionId, dueDate])).toEqual([
      ["a", "2026-06-01"], ["b", "2026-06-01"], ["a", "2026-06-02"], ["b", "2026-06-02"], ["a", "2026-06-03"],
    ]);
  });

  it("keeps reminder-disabled and reminder-window-outside events visible", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-15", to: "2026-12-31",
      subscriptions: [
        subscription({ id: "disabled", name: "Disabled", reminderDays: -2, nextBillingDate: assertDateOnly("2026-12-01") }),
        subscription({ id: "auto", name: "Auto", autoRenew: true, nextBillingDate: assertDateOnly("2026-06-20") }),
      ],
    });

    expect(events.find((event) => event.subscriptionId === "auto")).toMatchObject({ reminderEnabled: true });
    expect(events.find((event) => event.subscriptionId === "disabled")).toMatchObject({ reminderEnabled: false, dueDate: "2026-12-01" });
  });

  it("uses the earlier trial end date and keeps equal dates as a trial event", () => {
    const earlier = resolveUpcomingSubscriptionEvent(
      subscription({
        status: "trial",
        trialEndDate: assertDateOnly("2026-06-20"),
        nextBillingDate: assertDateOnly("2026-07-15"),
      }),
      "2026-06-15",
    );
    const equal = resolveUpcomingSubscriptionEvent(
      subscription({
        status: "trial",
        trialEndDate: assertDateOnly("2026-07-15"),
      }),
      "2026-06-15",
    );

    expect(earlier).toMatchObject({ kind: "trial", dueDate: "2026-06-20", daysUntil: 5 });
    expect(equal).toMatchObject({ kind: "trial", dueDate: "2026-07-15" });
  });

  it("preserves fixed-term expiry events and excludes buyouts and inactive subscriptions", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-15",
      subscriptions: [
        subscription({ id: "fixed", name: "Fixed", billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month" }),
        subscription({ id: "buyout", name: "Buyout", billingCycle: "one-time", nextBillingDate: assertDateOnly("2099-01-01") }),
        subscription({ id: "paused", name: "Paused", status: "paused" }),
        subscription({ id: "cancelled", name: "Cancelled", status: "cancelled" }),
        subscription({ id: "expired", name: "Expired", status: "expired" }),
      ],
    });

    expect(events.map((event) => [event.subscriptionId, event.kind, event.amount])).toEqual([["fixed", "expiry", null]]);
  });

  it("sorts equal dates by name and then stable id", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-15",
      to: "2026-06-30",
      subscriptions: [
        subscription({ id: "b", name: "Same", nextBillingDate: assertDateOnly("2026-06-20") }),
        subscription({ id: "a", name: "Same", nextBillingDate: assertDateOnly("2026-06-20") }),
        subscription({ id: "c", name: "Earlier", nextBillingDate: assertDateOnly("2026-06-20") }),
      ],
    });

    expect(events.map((event) => event.subscriptionId)).toEqual(["c", "a", "b"]);
  });

  it("returns the globally nearest five occurrences, including repeated subscriptions", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-15",
      subscriptions: [
        subscription({ id: "weekly", billingCycle: "weekly", autoCalculateNextBillingDate: false, nextBillingDate: assertDateOnly("2026-06-15") }),
        subscription({ id: "monthly", nextBillingDate: assertDateOnly("2026-07-01") }),
      ],
    });
    expect(events.map((event) => [event.subscriptionId, event.dueDate, event.projected])).toEqual([
      ["weekly", "2026-06-15", false], ["weekly", "2026-06-22", true], ["weekly", "2026-06-29", true],
      ["monthly", "2026-07-01", false], ["weekly", "2026-07-06", true],
    ]);
    expect(new Set(events.map((event) => event.id)).size).toBe(5);
  });

  it("forecasts overdue active and trial records without changing list date filtering", () => {
    const overdue = subscription({ nextBillingDate: assertDateOnly("2026-01-01"), reminderDays: -2 });
    const events = buildUpcomingSubscriptionEvents({ subscriptions: [overdue], today: "2026-06-15", from: "2026-08-01", to: "2026-09-30" });
    expect(events.map((event) => [event.dueDate, event.projected])).toEqual([["2026-08-01", true], ["2026-09-01", true]]);
    expect(resolveUpcomingSubscriptionEvent(overdue, "2026-06-15")).toBeNull();
    expect(overdue.nextBillingDate).toBe("2026-01-01");
    expect(buildUpcomingSubscriptionEvents({ subscriptions: [{ ...overdue, status: "trial" }], today: "2026-06-15", to: "2026-07-31" })).toHaveLength(1);
    expect(buildUpcomingSubscriptionEvents({ subscriptions: [overdue], today: "2026-06-15", to: "2026-06-14" })).toEqual([]);
  });

  it("separates free trial-end events and counts coincident charges once, including zero prices", () => {
    const events = buildUpcomingSubscriptionEvents({
      today: "2026-06-01", to: "2026-06-30",
      subscriptions: [
        subscription({ id: "separate", status: "trial", trialEndDate: assertDateOnly("2026-06-10"), nextBillingDate: assertDateOnly("2026-06-20") }),
        subscription({ id: "same", status: "trial", price: "0", trialEndDate: assertDateOnly("2026-06-20"), nextBillingDate: assertDateOnly("2026-06-20") }),
      ],
    });
    expect(events.map((event) => [event.subscriptionId, event.kind, event.amount])).toEqual([
      ["separate", "trial", null], ["same", "trial", "0"], ["separate", "renewal", "10"],
    ]);
  });
});
