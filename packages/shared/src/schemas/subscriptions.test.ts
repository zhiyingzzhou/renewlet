import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_INDEX_LIMIT,
  SUBSCRIPTION_PAYMENT_METHOD_NONE,
  apiSubscriptionCollectionItemSchema,
  apiSubscriptionSchema,
  subscriptionCreateBodySchema,
  subscriptionUpdateBodySchema,
  subscriptionRenewBodySchema,
  subscriptionsAnalyticsPayloadSchema,
  subscriptionsCalendarPayloadSchema,
  subscriptionsCalendarQuerySchema,
  subscriptionsExportPayloadSchema,
  subscriptionsIndexPayloadSchema,
  subscriptionsIndexQuerySchema,
  subscriptionsListQuerySchema,
} from "./subscriptions";

const recurringBody = {
  name: "QQ Music",
  logo: null,
  price: "15",
  currency: "CNY",
  billingCycle: "monthly",
  customDays: null,
  customCycleUnit: null,
  category: "entertainment",
  status: "active",
  pinned: false,
  publicHidden: false,
  paymentMethod: null,
  startDate: null,
  nextBillingDate: "2026-07-01",
  autoRenew: false,
  autoCalculateNextBillingDate: false,
  trialEndDate: null,
  website: null,
  notes: null,
  tags: [],
  reminderDays: -1,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
};

const recurringResponse = {
  id: "sub_qq_music",
  name: recurringBody.name,
  price: recurringBody.price,
  currency: recurringBody.currency,
  billingCycle: recurringBody.billingCycle,
  category: recurringBody.category,
  status: recurringBody.status,
  pinned: recurringBody.pinned,
  publicHidden: recurringBody.publicHidden,
  startDate: recurringBody.startDate,
  nextBillingDate: recurringBody.nextBillingDate,
  autoRenew: recurringBody.autoRenew,
  autoCalculateNextBillingDate: recurringBody.autoCalculateNextBillingDate,
  tags: recurringBody.tags,
  reminderDays: recurringBody.reminderDays,
  repeatReminderEnabled: recurringBody.repeatReminderEnabled,
  repeatReminderInterval: recurringBody.repeatReminderInterval,
  repeatReminderWindow: recurringBody.repeatReminderWindow,
  extra: {},
};

const recurringCollectionItem = {
  id: recurringResponse.id,
  name: recurringResponse.name,
  price: recurringResponse.price,
  currency: recurringResponse.currency,
  billingCycle: recurringResponse.billingCycle,
  category: recurringResponse.category,
  status: recurringResponse.status,
  pinned: recurringResponse.pinned,
  publicHidden: recurringResponse.publicHidden,
  startDate: recurringResponse.startDate,
  nextBillingDate: recurringResponse.nextBillingDate,
  autoRenew: recurringResponse.autoRenew,
  autoCalculateNextBillingDate: recurringResponse.autoCalculateNextBillingDate,
  reminderDays: recurringResponse.reminderDays,
};

describe("subscription start date contract", () => {
  it("accepts recurring subscriptions without a known start date", () => {
    expect(subscriptionCreateBodySchema.parse(recurringBody).startDate).toBeNull();
    expect(apiSubscriptionSchema.parse(recurringResponse).startDate).toBeNull();
  });

  it("rejects non date-only response renewal and trial dates", () => {
    expect(apiSubscriptionSchema.safeParse({
      ...recurringResponse,
      nextBillingDate: "2026-07-01T00:00:00Z",
    }).success).toBe(false);

    expect(apiSubscriptionSchema.safeParse({
      ...recurringResponse,
      trialEndDate: "2026/07/01",
    }).success).toBe(false);
  });

  it("requires start date when automatic billing date calculation is enabled", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      autoCalculateNextBillingDate: true,
    }).success).toBe(false);
  });

  it("keeps one-time subscriptions tied to a real purchase or service start date", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      autoCalculateNextBillingDate: false,
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      startDate: "2026-06-01",
      autoCalculateNextBillingDate: false,
    }).success).toBe(true);
  });
});

describe("cost sharing collection reminder contract", () => {
  const costSharing = {
    enabled: true,
    splitMode: "equal",
    members: [{ id: "partner", name: "Partner", currency: "USD" }],
  } as const;

  it("keeps old cost sharing payloads compatible", () => {
    const parsed = subscriptionCreateBodySchema.parse({
      ...recurringBody,
      costSharing,
    });

    expect(parsed.costSharing).toEqual(costSharing);
  });

  it("accepts collection reminders with inherited or custom days", () => {
    expect(subscriptionCreateBodySchema.parse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).costSharing?.collectionReminder).toEqual({ enabled: true, reminderDays: -1 });

    expect(subscriptionCreateBodySchema.parse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: 0 },
      },
    }).costSharing?.collectionReminder).toEqual({ enabled: true, reminderDays: 0 });
  });

  it("rejects the removed collection interval field", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, intervalMonths: 3, reminderDays: -1 },
      },
    }).success).toBe(false);
  });

  it("rejects disabled reminder sentinel for collection reminders", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: -2 },
      },
    }).success).toBe(false);
  });

  it("rejects invalid member joined dates", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026/01/01" }],
      },
    }).success).toBe(false);
  });

  it("requires member joined dates when collection reminders are enabled without a subscription start date", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: null,
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.parse({
      ...recurringBody,
      startDate: null,
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-01-01" }],
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).costSharing?.members[0]?.joinedDate).toBe("2026-01-01");
  });

  it("rejects enabled collection reminders when cost sharing is disabled", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        enabled: false,
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).success).toBe(false);
  });

  it("rejects collection reminders for one-time buyouts while accepting fixed-term one-time records", () => {
    const collectionCostSharing = {
      ...costSharing,
      collectionReminder: { enabled: true, reminderDays: -1 },
    };

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      startDate: "2026-01-01",
      nextBillingDate: "2026-01-01",
      autoCalculateNextBillingDate: false,
      costSharing: collectionCostSharing,
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      startDate: "2026-01-01",
      nextBillingDate: "2026-04-01",
      autoCalculateNextBillingDate: false,
      oneTimeTermCount: 3,
      oneTimeTermUnit: "month",
      costSharing: collectionCostSharing,
    }).success).toBe(true);
  });

  it("rejects member joined dates outside the subscription date range", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-10",
      nextBillingDate: "2026-02-10",
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-01-09" }],
      },
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-10",
      nextBillingDate: "2026-02-10",
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-02-11" }],
      },
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-10",
      nextBillingDate: "2026-02-10",
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-01-10" }],
      },
    }).success).toBe(true);
  });
});

describe("subscription renew request contract", () => {
  const renewBody = {
      expectedNextBillingDate: "2026-07-01",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    mode: "continue",
    price: "12.500000",
    currency: "USD",
    startDate: null,
    nextBillingDate: "2026-08-01",
    autoCalculateNextBillingDate: false,
  } as const;

  it("requires valid, exact renewal preconditions", () => {
    for (const patch of [
      { expectedNextBillingDate: undefined }, { expectedUpdatedAt: undefined },
      { expectedNextBillingDate: "2026-02-30" }, { expectedUpdatedAt: "yesterday" },
      { expectedUpdatedAt: 123 },
    ]) expect(subscriptionRenewBodySchema.safeParse({ ...renewBody, ...patch }).success).toBe(false);
    expect(subscriptionRenewBodySchema.parse({ ...renewBody, expectedUpdatedAt: "2026-01-01T00:00:00.123456Z" }).expectedUpdatedAt).toBe("2026-01-01T00:00:00.123456Z");
  });

  it("accepts continue renewal payloads and canonicalizes money", () => {
    const parsed = subscriptionRenewBodySchema.parse(renewBody);

    expect(parsed).toMatchObject({
      mode: "continue",
      price: "12.5",
      currency: "USD",
      startDate: null,
      nextBillingDate: "2026-08-01",
      autoCalculateNextBillingDate: false,
    });
  });

  it("accepts restart renewal only with a real start date", () => {
    expect(subscriptionRenewBodySchema.parse({
      ...renewBody,
      mode: "restart",
      startDate: "2026-08-12",
      nextBillingDate: "2026-09-12",
      autoCalculateNextBillingDate: true,
    })).toMatchObject({
      mode: "restart",
      startDate: "2026-08-12",
      nextBillingDate: "2026-09-12",
      autoCalculateNextBillingDate: true,
    });

    expect(subscriptionRenewBodySchema.safeParse({
      ...renewBody,
      mode: "restart",
      startDate: null,
    }).success).toBe(false);

    expect(subscriptionRenewBodySchema.safeParse({
      ...renewBody,
      mode: "restart",
      startDate: undefined,
    }).success).toBe(false);
  });

  it("rejects invalid renew money, currency, dates, and unknown fields", () => {
    expect(subscriptionRenewBodySchema.safeParse({ ...renewBody, price: "1e3" }).success).toBe(false);
    expect(subscriptionRenewBodySchema.safeParse({ ...renewBody, currency: "usd" }).success).toBe(false);
    expect(subscriptionRenewBodySchema.safeParse({ ...renewBody, nextBillingDate: "2026-08-01T00:00:00Z" }).success).toBe(false);
    expect(subscriptionRenewBodySchema.safeParse({
      ...renewBody,
      startDate: "2026-09-01",
      nextBillingDate: "2026-08-31",
    }).success).toBe(false);
    expect(subscriptionRenewBodySchema.safeParse({
      ...renewBody,
      note: "unexpected",
    }).success).toBe(false);
  });
});

describe("subscriptions list query contract", () => {
  it.each(["auto", "manual", "one-time-buyout", "one-time-fixed-term"] as const)(
    "accepts paymentType=%s",
    (paymentType) => {
      expect(subscriptionsListQuerySchema.parse({ paymentType }).paymentType).toBe(paymentType);
    },
  );

  it("accepts repeated custom filter values and strict boolean query strings", () => {
    const query = subscriptionsListQuerySchema.parse({
      limit: "25",
      q: " cloud ",
      category: ["productivity", "developer_tools"],
      tag: ["AI"],
      billingCycle: ["monthly", "annual"],
      paymentMethod: [SUBSCRIPTION_PAYMENT_METHOD_NONE, "paypal"],
      currency: ["USD", "CNY"],
      status: "active",
      paymentType: "auto",
      nextBillingFrom: "2026-07-01",
      nextBillingTo: "2026-12-31",
      pinned: "false",
      publicHidden: "1",
      reminderMode: "custom",
      repeatReminder: "true",
    });

    expect(query).toMatchObject({
      limit: 25,
      q: "cloud",
      pinned: false,
      publicHidden: true,
      repeatReminder: true,
    });
  });

  it("rejects invalid custom filter query values", () => {
    expect(subscriptionsListQuerySchema.safeParse({ pinned: "nope" }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({ currency: ["usd"] }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({ billingCycle: ["forever"] }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({ paymentType: "one-time" }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({ renewal: "one-time" }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({
      nextBillingFrom: "2026-12-31",
      nextBillingTo: "2026-01-01",
    }).success).toBe(false);
  });
});

describe("subscription collection read contract", () => {
  it("keeps collection items strict and separate from complete subscriptions", () => {
    expect(apiSubscriptionCollectionItemSchema.parse(recurringCollectionItem)).toEqual(recurringCollectionItem);
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      website: "https://music.example.com",
    }).success).toBe(false);
    expect(subscriptionsExportPayloadSchema.safeParse({ subscriptions: [recurringCollectionItem] }).success).toBe(false);
    expect(subscriptionsExportPayloadSchema.safeParse({ subscriptions: [recurringResponse] }).success).toBe(true);
  });

  it("requires cycle-specific collection fields without accepting padded shapes", () => {
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      billingCycle: "custom",
      customDays: 30,
      customCycleUnit: "day",
    }).success).toBe(true);
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      billingCycle: "custom",
      customDays: 30,
    }).success).toBe(false);
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      customDays: 30,
      customCycleUnit: "day",
    }).success).toBe(false);
  });

  it("models recurring, custom, one-time buyout, and one-time fixed-term branches explicitly", () => {
    expect(apiSubscriptionCollectionItemSchema.safeParse(recurringCollectionItem).success).toBe(true);
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      billingCycle: "custom",
      customDays: 30,
      customCycleUnit: "day",
    }).success).toBe(true);
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      billingCycle: "one-time",
      startDate: "2026-01-01",
      nextBillingDate: "2026-01-01",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
    }).success).toBe(true);
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      billingCycle: "one-time",
      startDate: "2026-01-01",
      nextBillingDate: "2026-04-01",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
      oneTimeTermCount: 3,
      oneTimeTermUnit: "month",
    }).success).toBe(true);
    expect(apiSubscriptionCollectionItemSchema.safeParse({
      ...recurringCollectionItem,
      billingCycle: "one-time",
      startDate: "2026-01-01",
      nextBillingDate: "2026-04-01",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
      oneTimeTermCount: 3,
    }).success).toBe(false);
  });

  it("keeps normal API logos separate from ZIP-internal asset paths", () => {
    expect(apiSubscriptionSchema.safeParse({
      ...recurringResponse,
      logo: "https://cdn.example.com/logo.svg",
    }).success).toBe(true);
    expect(apiSubscriptionSchema.safeParse({
      ...recurringResponse,
      logo: "assets/logo.svg",
    }).success).toBe(false);
  });

  it("accepts exactly 5000 collection items and rejects 5001", () => {
    const subscriptions = Array.from({ length: SUBSCRIPTION_INDEX_LIMIT }, (_, index) => ({
      ...recurringCollectionItem,
      id: `sub_${index}`,
    }));
    const overLimit = [...subscriptions, { ...recurringCollectionItem, id: "sub_over_limit" }];

    expect(subscriptionsIndexPayloadSchema.safeParse({
      subscriptions,
      total: SUBSCRIPTION_INDEX_LIMIT,
    }).success).toBe(true);
    expect(subscriptionsIndexPayloadSchema.safeParse({
      subscriptions: overLimit,
      total: SUBSCRIPTION_INDEX_LIMIT + 1,
    }).success).toBe(false);
    expect(subscriptionsAnalyticsPayloadSchema.safeParse({ subscriptions: overLimit }).success).toBe(false);
    expect(subscriptionsCalendarPayloadSchema.safeParse({ subscriptions: overLimit }).success).toBe(false);
  });

  it("keeps index filters pagination-free and validates calendar ranges", () => {
    expect(subscriptionsIndexQuerySchema.safeParse({ q: "music", category: ["entertainment"] }).success).toBe(true);
    expect(subscriptionsIndexQuerySchema.safeParse({ limit: 50 }).success).toBe(false);
    expect(subscriptionsIndexQuerySchema.safeParse({ cursor: "cursor" }).success).toBe(false);
    expect(subscriptionsCalendarQuerySchema.safeParse({ from: "2026-07-01", to: "2026-07-31" }).success).toBe(true);
    expect(subscriptionsCalendarQuerySchema.safeParse({ from: "2026-08-01", to: "2026-07-31" }).success).toBe(false);
  });
});

describe("subscription custom cycle write contract", () => {
  it("requires an explicit positive count and unit", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "custom",
      customDays: 45,
      customCycleUnit: null,
    }).success).toBe(false);
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "custom",
      customDays: 45,
      customCycleUnit: "day",
    }).success).toBe(true);
  });
});


describe("optional account balance contract", () => {
  it.each([{}, { balance: null, balanceCurrency: null }, { balance: "0", balanceCurrency: "USD" },
    { balance: "0.000001", balanceCurrency: "EUR" }, { balance: "1000000000", balanceCurrency: "CNY" }])(
    "accepts paired write %j", (fields) => {
      expect(subscriptionCreateBodySchema.safeParse({ ...recurringBody, ...fields }).success).toBe(true);
      expect(subscriptionUpdateBodySchema.safeParse({ pinned: true, ...fields }).success).toBe(true);
    },
  );
  it.each([
    { balance: "0" }, { balanceCurrency: "USD" }, { balance: null }, { balanceCurrency: null },
    { balance: "0", balanceCurrency: null }, { balance: null, balanceCurrency: "USD" },
    ...[0, "", "-1", "1000000000.000001", "0.0000001", "1e3", {}, false].map((balance) => ({ balance, balanceCurrency: "USD" })),
    { balance: "1", balanceCurrency: "usd" },
  ])("rejects invalid write %j", (fields) => {
    expect(subscriptionCreateBodySchema.safeParse({ ...recurringBody, ...fields }).success).toBe(false);
    expect(subscriptionUpdateBodySchema.safeParse({ pinned: true, ...fields }).success).toBe(false);
  });
  it("requires paired optional values in collection and detail responses", () => {
    for (const [schema, response] of [[apiSubscriptionCollectionItemSchema, recurringCollectionItem], [apiSubscriptionSchema, recurringResponse]] as const) {
      expect(schema.safeParse(response).success).toBe(true);
      expect(schema.parse({ ...response, balance: "0", balanceCurrency: "USD" })).toMatchObject({ balance: "0", balanceCurrency: "USD" });
      expect(schema.safeParse({ ...response, balance: "0" }).success).toBe(false);
      expect(schema.safeParse({ ...response, balance: null, balanceCurrency: null }).success).toBe(false);
    }
  });
});
