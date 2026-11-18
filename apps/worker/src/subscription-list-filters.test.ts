import { describe, expect, it } from "vitest";
import {
  boundedSubscriptionCollectionQueryPlan,
  isSubscriptionCollectionInactive,
  parsePrivateSubscriptionCursor,
  privateSubscriptionCursor,
  publicStatusSubscriptionQueryPlan,
  subscriptionCollectionPageQueryPlan,
} from "./subscription-list-filters";

const USER_ID = "usr_subscription_owner";

describe("subscription collection query plan", () => {
  it("keeps all filters owner-scoped and reads only collection fact columns", () => {
    const plan = subscriptionCollectionPageQueryPlan(USER_ID, {
      q: "Cursor",
      category: ["developer_tools"],
      tag: ["ÄI"],
      billingCycle: ["monthly"],
      paymentMethod: ["paypal"],
      currency: ["USD"],
      status: "active",
      paymentType: "auto",
      nextBillingFrom: "2999-08-01",
      nextBillingTo: "2999-08-31",
      pinned: true,
      publicHidden: false,
      reminderMode: "custom",
      repeatReminder: true,
    }, "2999-07-30", 11);

    expect(plan.sql).toContain("idx.user_id = ?");
    expect(plan.sql).toContain("idx.category IN (SELECT CAST(value AS TEXT) FROM json_each(?))");
    expect(plan.sql).toContain("idx.billing_cycle IN (SELECT CAST(value AS TEXT) FROM json_each(?))");
    expect(plan.sql).toContain("idx.currency IN (SELECT CAST(value AS TEXT) FROM json_each(?))");
    expect(plan.sql).toContain("idx.payment_method IN (SELECT CAST(value AS TEXT) FROM json_each(?))");
    expect(plan.sql).toContain("INNER JOIN json_each(?) AS selected");
    expect(plan.sql).toContain("json_extract(selected.value, '$.key')");
    expect(plan.sql).not.toContain("lower(CAST(selected.value AS TEXT))");
    expect(plan.sql).toContain("idx.next_billing_date >= ? AND idx.next_billing_date <= ?");
    expect(plan.sql).toContain("idx.status = 'trial' AND idx.trial_end_date >= ? AND idx.trial_end_date <= ?");
    expect(plan.sql).toContain("idx.pinned = ?");
    expect(plan.sql).toContain("idx.reminder_days >= 0");
    expect(plan.sql).toContain("instr(idx.search_text_lower, ?) > 0");
    expect(plan.sql).toContain("LEFT JOIN subscriptions AS sub");
    expect(plan.sql).toContain("SELECT idx.subscription_id, idx.user_id, idx.pinned, idx.created_at");
    expect(plan.sql).not.toContain("SELECT idx.*");
    expect(plan.sql).toContain("sub.auto_calculate_next_billing_date");
    expect(plan.sql).not.toContain("sub.notes");
    expect(plan.sql).not.toContain("sub.tags_json");
    expect(plan.sql).not.toContain("sub.extra_json");
    expect(plan.params).toEqual([
      "2999-07-30",
      USER_ID,
      JSON.stringify(["developer_tools"]),
      JSON.stringify(["monthly"]),
      JSON.stringify(["USD"]),
      JSON.stringify(["paypal"]),
      JSON.stringify([{ key: "äi", value: "ÄI" }]),
      "2999-08-01",
      "2999-08-31",
      "2999-08-01",
      "2999-08-31",
      1,
      0,
      1,
      "cursor",
      "2999-07-30",
      "active",
      11,
    ]);
    expect(plan.sql).toContain("ORDER BY idx.pinned DESC, idx.inactive ASC, idx.created_at DESC, idx.subscription_id DESC");
  });

  it("builds mutually exclusive payment type predicates and excludes buyouts from date ranges", () => {
    const plans = {
      auto: subscriptionCollectionPageQueryPlan(USER_ID, { paymentType: "auto" }, "2026-08-18", 51),
      manual: subscriptionCollectionPageQueryPlan(USER_ID, { paymentType: "manual" }, "2026-08-18", 51),
      buyout: subscriptionCollectionPageQueryPlan(USER_ID, { paymentType: "one-time-buyout" }, "2026-08-18", 51),
      fixed: subscriptionCollectionPageQueryPlan(USER_ID, { paymentType: "one-time-fixed-term" }, "2026-08-18", 51),
      dateRange: subscriptionCollectionPageQueryPlan(USER_ID, {
        nextBillingFrom: "2026-08-01",
        nextBillingTo: "2026-08-31",
      }, "2026-08-18", 51),
    };

    expect(plans.auto.sql).toContain("idx.billing_cycle != 'one-time' AND idx.auto_renew = 1");
    expect(plans.manual.sql).toContain("idx.billing_cycle != 'one-time' AND idx.auto_renew = 0");
    expect(plans.buyout.sql).toContain("idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0");
    expect(plans.fixed.sql).toContain("idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) > 0");
    expect(plans.dateRange.sql).toContain("NOT (idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0)");
  });

  it("keeps cursor parameters out of the exact total CTE", () => {
    const plan = subscriptionCollectionPageQueryPlan(USER_ID, {}, "2026-08-18", 51, {
      v: 1,
      asOf: "2026-08-18",
      pinned: 1,
      inactive: 0,
      createdAt: "2026-08-18T10:00:00.000Z",
      id: "sub_cursor",
    });

    expect(plan.sql).toContain("SELECT COUNT(*) AS collection_total FROM filtered");
    expect(plan.params).toEqual([
      "2026-08-18",
      USER_ID,
      1,
      1,
      0,
      1,
      0,
      "2026-08-18T10:00:00.000Z",
      1,
      0,
      "2026-08-18T10:00:00.000Z",
      "sub_cursor",
      51,
    ]);
  });

  it("bounds index preflight at 5001 before reading facts", () => {
    const plan = boundedSubscriptionCollectionQueryPlan(USER_ID, { status: "active" }, "2026-08-18", 5_001);

    expect(plan.sql).toContain("totals AS MATERIALIZED");
    expect(plan.sql).toContain("idx.user_id = CASE WHEN totals.collection_total < ? THEN ? END");
    expect(plan.sql).toContain("LEFT JOIN subscriptions AS sub ON sub.user_id = idx.user_id AND sub.id = idx.subscription_id");
    expect(plan.params).toEqual([USER_ID, "2026-08-18", "active", 5_001, 5_001, USER_ID, "2026-08-18", "active", "2026-08-18"]);
  });

  it("ranks the complete public collection before limiting fact reads", () => {
    const plan = publicStatusSubscriptionQueryPlan(USER_ID, "2026-08-18", 501);

    expect(plan.sql.indexOf("LIMIT ?")).toBeLessThan(plan.sql.indexOf("INNER JOIN subscriptions AS sub"));
    expect(plan.params).toEqual(["2026-08-18", USER_ID, 501]);
  });

  it("keeps the maximum multi-select request below the D1 binding limit", () => {
    const plan = subscriptionCollectionPageQueryPlan(USER_ID, {
      category: Array.from({ length: 50 }, (_, index) => `category-${index}`),
      tag: Array.from({ length: 100 }, (_, index) => `tag-${index}`),
      billingCycle: ["weekly", "monthly", "quarterly", "semi-annual", "annual", "custom", "one-time"],
      currency: Array.from({ length: 50 }, (_, index) => `C${String(index).padStart(2, "0")}`),
      paymentMethod: Array.from({ length: 200 }, (_, index) => `payment-${index}`),
      status: "active",
      paymentType: "auto",
      nextBillingFrom: "2026-01-01",
      nextBillingTo: "2026-12-31",
      pinned: true,
      publicHidden: false,
      reminderMode: "disabled",
      repeatReminder: true,
      q: "search",
    }, "2026-08-18", 51);

    expect(plan.params.length).toBeLessThan(100);
    expect(plan.sql.match(/json_each\(\?\)/gu)).toHaveLength(5);
  });

  it("uses a versioned base64url cursor and rejects the public cursor shape", () => {
    const cursor = privateSubscriptionCursor({
      id: "sub_cursor",
      pinned: 1,
      status: "expired",
      billing_cycle: "monthly",
      one_time_term_count: null,
      next_billing_date: "2999-01-01",
      created_at: "2026-08-18T10:00:00.000Z",
    }, "2026-08-18");

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(parsePrivateSubscriptionCursor(cursor)).toEqual({
      v: 1,
      asOf: "2026-08-18",
      pinned: 1,
      inactive: 1,
      createdAt: "2026-08-18T10:00:00.000Z",
      id: "sub_cursor",
    });
    expect(parsePrivateSubscriptionCursor(btoa(JSON.stringify({
      createdAt: "2026-08-18T10:00:00.000Z",
      id: "sub_cursor",
    })))).toBeNull();
    expect(parsePrivateSubscriptionCursor(privateSubscriptionCursor({
      id: "sub_cursor",
      pinned: 0,
      status: "active",
      billing_cycle: "monthly",
      one_time_term_count: null,
      next_billing_date: "2026-08-18",
      created_at: "2026-08-18T10:00:00.000Z",
    }, "2026-08-17"))).toMatchObject({ asOf: "2026-08-17", inactive: 0 });
  });

  it("keeps permanent buyout cursor ranking identical to SQL for null and legacy non-positive terms", () => {
    const buyout = {
      status: "active" as const,
      billing_cycle: "one-time" as const,
      next_billing_date: "2026-01-01",
    };
    expect(isSubscriptionCollectionInactive({ ...buyout, one_time_term_count: null }, "2026-08-18")).toBe(0);
    expect(isSubscriptionCollectionInactive({ ...buyout, one_time_term_count: -1 }, "2026-08-18")).toBe(0);
  });
});
