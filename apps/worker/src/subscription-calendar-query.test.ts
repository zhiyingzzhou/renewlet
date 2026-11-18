import { afterEach, describe, expect, it, vi } from "vitest";
import { subscriptionsCalendarPayloadSchema, subscriptionsIndexPayloadSchema } from "@renewlet/shared/schemas/subscriptions";
import { readSuccessData } from "./api-test-helpers";
import { readSubscriptionCalendar, readSubscriptionIndex } from "./subscription-collections";
import { insertSubscriptionStatement, openDerivedStateDatabase, subscriptionRow } from "./subscription-d1-test-support";
import { SUBSCRIPTION_LIST_INDEX_UPSERT_SQL, subscriptionListProjectionValues } from "./subscription-derived-state";

vi.mock("./auth", () => ({ requireAuth: vi.fn(async () => ({ user: { id: "usr_derived_transaction" } })) }));

describe("calendar candidate queries against D1", () => {
  const fixtures: ReturnType<typeof openDerivedStateDatabase>[] = [];
  afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.db.close(); });

  it("returns recurring candidates before the range while preserving owner, state and ordinary date filters", async () => {
    const fixture = openDerivedStateDatabase();
    fixtures.push(fixture);
    const { db, env } = fixture;
    db.prepare("INSERT INTO users (id) VALUES (?)").run("foreign");
    const rows = [
      subscriptionRow("overdue", { start_date: "2019-01-31", next_billing_date: "2020-01-31", reminder_days: -2 }),
      subscriptionRow("overdue-trial", { status: "trial", start_date: "2025-01-01", next_billing_date: "2026-01-01" }),
      subscriptionRow("from", { next_billing_date: "2026-06-01" }),
      subscriptionRow("to", { next_billing_date: "2026-06-30" }),
      subscriptionRow("future", { next_billing_date: "2026-07-01" }),
      subscriptionRow("trial", { status: "trial", trial_end_date: "2026-06-15", next_billing_date: "2026-07-01" }),
      subscriptionRow("fixed", { billing_cycle: "one-time", one_time_term_count: 1, one_time_term_unit: "month", next_billing_date: "2026-06-15" }),
      subscriptionRow("past-fixed", { billing_cycle: "one-time", one_time_term_count: 1, one_time_term_unit: "month", next_billing_date: "2026-05-31" }),
      subscriptionRow("buyout", { billing_cycle: "one-time", next_billing_date: "2026-06-15" }),
      ...(["paused", "cancelled", "expired"] as const).map(status => subscriptionRow(status, { status, next_billing_date: "2026-06-15" })),
      subscriptionRow("foreign", { user_id: "foreign", next_billing_date: "2026-06-15" }),
    ];
    for (const row of rows) {
      await env.DB.batch([
        insertSubscriptionStatement(env, row),
        env.DB.prepare(SUBSCRIPTION_LIST_INDEX_UPSERT_SQL).bind(...subscriptionListProjectionValues(row, [])),
      ]);
    }
    const response = await readSubscriptionCalendar(new Request("https://renewlet.test/api/app/subscriptions/calendar?from=2026-06-01&to=2026-06-30"), env);
    const calendar = subscriptionsCalendarPayloadSchema.parse(await readSuccessData<unknown>(response));
    expect(calendar.subscriptions.map(item => item.id).sort()).toEqual(["fixed", "from", "overdue", "overdue-trial", "to", "trial"]);
    expect(calendar.subscriptions.find(item => item.id === "overdue")?.nextBillingDate).toBe("2020-01-31");

    const indexResponse = await readSubscriptionIndex(new Request("https://renewlet.test/api/app/subscriptions/index?nextBillingFrom=2026-06-01&nextBillingTo=2026-06-30"), env);
    const index = subscriptionsIndexPayloadSchema.parse(await readSuccessData<unknown>(indexResponse));
    expect(index.subscriptions.map(item => item.id).sort()).toEqual(["cancelled", "expired", "fixed", "from", "paused", "to", "trial"]);
  });
});
