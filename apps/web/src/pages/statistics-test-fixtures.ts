import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import { subscriptionCycleFixture, type SubscriptionFixtureOverrides } from "@/test/subscription-fixtures";

type SubscriptionBaseFixture = Omit<SubscriptionCollectionItem, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<SubscriptionCollectionItem>;

export function subscription(overrides: SubscriptionOverrides): SubscriptionCollectionItem {
  const base: SubscriptionBaseFixture = {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "CNY",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2099-01-05"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    reminderDays: 3,
    pinned: false,
    publicHidden: false,
  };

  return {
    ...base,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

export function toSubscriptionDetail(item: SubscriptionCollectionItem): Subscription {
  return {
    ...item,
    website: undefined,
    notes: undefined,
    tags: [],
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
  };
}
