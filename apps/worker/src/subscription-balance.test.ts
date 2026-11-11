import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubscription, updateSubscription, renewSubscription } from "./subscriptions";
import { getSubscription, toApiSubscription, toApiSubscriptionCollectionItem, toPublicApiSubscription } from "./db";
import { openDerivedStateDatabase, USER_ID } from "./subscription-d1-test-support";
import { readSuccessData } from "./api-test-helpers";

vi.mock("./auth", () => ({ requireAuth: vi.fn(async () => ({ user: { id: "usr_derived_transaction" } })) }));

const body = {
  name: "Prepaid", price: "15.99", currency: "USD", billingCycle: "monthly", category: "productivity",
  status: "active", startDate: null, nextBillingDate: "2027-01-01", autoCalculateNextBillingDate: false,
  reminderDays: -1, repeatReminderEnabled: false, repeatReminderInterval: "1h", repeatReminderWindow: "72h",
};
const request = (fields: unknown, method = "POST") => new Request("https://renewlet.test/api/app/subscriptions", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(fields),
});

describe("account balance in real subscription transactions", () => {
  const databases: ReturnType<typeof openDerivedStateDatabase>[] = [];
  afterEach(() => { for (const fixture of databases.splice(0)) fixture.db.close(); });
  function setup() { const fixture = openDerivedStateDatabase(); databases.push(fixture); return fixture; }

  it("creates zero, preserves independent currency on PATCH and renewal, then clears both fields", async () => {
    const { env } = setup();
    const response = await createSubscription(request({ ...body, balance: "0", balanceCurrency: "EUR" }), env);
    const { subscription } = await readSuccessData<{ subscription: { id: string; balance: string; balanceCurrency: string } }>(response);
    expect(subscription).toMatchObject({ balance: "0", balanceCurrency: "EUR" });
    await updateSubscription(request({ pinned: true, currency: "CNY" }, "PATCH"), env, subscription.id);
    const beforeRenew = await getSubscription(env, USER_ID, subscription.id);
    await renewSubscription(request({ expectedNextBillingDate: beforeRenew!.next_billing_date, expectedUpdatedAt: beforeRenew!.updated_at, mode: "continue", price: "25", currency: "GBP", startDate: null,
      nextBillingDate: "2027-02-01", autoCalculateNextBillingDate: false }), env, subscription.id);
    const row = await getSubscription(env, USER_ID, subscription.id);
    expect(row).toMatchObject({ balance: "0", balance_currency: "EUR", currency: "GBP" });
    if (!row) throw new Error("Missing saved subscription");
    for (const map of [toApiSubscription, toApiSubscriptionCollectionItem, toPublicApiSubscription]) {
      expect(map(row)).toMatchObject({ balance: "0", balanceCurrency: "EUR" });
    }
    const cleared = await updateSubscription(request({ balance: null, balanceCurrency: null }, "PATCH"), env, subscription.id);
    const data = await readSuccessData<{ subscription: Record<string, unknown> }>(cleared);
    expect(data.subscription).not.toHaveProperty("balance");
    expect(data.subscription).not.toHaveProperty("balanceCurrency");
    expect(await getSubscription(env, USER_ID, subscription.id)).toMatchObject({ balance: null, balance_currency: null });
    expect(await getSubscription(env, "other-owner", subscription.id)).toBeNull();
  });

  it("rejects incomplete pairs before merging and rolls back balance when a derived write fails", async () => {
    const { db, env } = setup();
    const created = await readSuccessData<{ subscription: { id: string } }>(await createSubscription(request({ ...body, balance: "12.123456", balanceCurrency: "USD" }), env));
    const id = created.subscription.id;
    await expect(updateSubscription(request({ balance: "50" }, "PATCH"), env, id)).rejects.toMatchObject({ status: 400 });
    await expect(updateSubscription(request({ balance: 0, balanceCurrency: "USD" }, "PATCH"), env, id)).rejects.toMatchObject({ status: 400 });
    db.exec("CREATE TRIGGER fail_balance_update BEFORE UPDATE ON subscription_list_index BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    await expect(updateSubscription(request({ balance: "90", balanceCurrency: "EUR" }, "PATCH"), env, id)).rejects.toThrow("injected failure");
    expect(await getSubscription(env, USER_ID, id)).toMatchObject({ balance: "12.123456", balance_currency: "USD" });
  });
});
