import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscription, renewSubscription, updateSubscription } from "./subscriptions";
import { getSubscription } from "./db";
import { openDerivedStateDatabase, USER_ID } from "./subscription-d1-test-support";
import { readSuccessData } from "./api-test-helpers";

vi.mock("./auth", () => ({ requireAuth: vi.fn(async () => ({ user: { id: "usr_derived_transaction" } })) }));
const request = (body: unknown) => new Request("https://renewlet.test/api/app/subscriptions", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const draft = {
  name: "Manual renewal", price: "12", currency: "USD", billingCycle: "monthly", category: "productivity",
  status: "trial", startDate: "2026-01-31", nextBillingDate: "2026-02-28", autoRenew: false,
  autoCalculateNextBillingDate: true, balance: "0", balanceCurrency: "JPY",
  reminderDays: -1, repeatReminderEnabled: false, repeatReminderInterval: "1h", repeatReminderWindow: "72h",
};
describe("renewal with real transactional D1 facts and projections", () => {
  const fixtures: ReturnType<typeof openDerivedStateDatabase>[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-02-01T08:00:00Z")); });
  afterEach(() => { for (const f of fixtures.splice(0)) f.db.close(); vi.useRealTimers(); });
  async function setup() {
    const f = openDerivedStateDatabase(); fixtures.push(f);
    const { subscription } = await readSuccessData<{ subscription: { id: string; updatedAt: string; nextBillingDate: string } }>(await createSubscription(request(draft), f.env));
    const payload = { expectedUpdatedAt: subscription.updatedAt, expectedNextBillingDate: subscription.nextBillingDate,
      mode: "continue", price: "0", currency: "EUR", startDate: null, nextBillingDate: "2026-03-31", autoCalculateNextBillingDate: false };
    return { ...f, id: subscription.id, payload };
  }
  it("commits exactly once for concurrent confirmations, preserves trial and balance, and permits a newly confirmed period", async () => {
    const { env, id, payload } = await setup();
    const results = await Promise.allSettled([renewSubscription(request(payload), env, id), renewSubscription(request(payload), env, id)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409, code: "SUBSCRIPTION_RENEW_CONFLICT" } });
    const row = await getSubscription(env, USER_ID, id);
    expect(row).toMatchObject({ next_billing_date: "2026-03-31", status: "trial", price: "0", balance: "0", balance_currency: "JPY" });
    await expect(renewSubscription(request(payload), env, id)).rejects.toMatchObject({ status: 409 });
    await renewSubscription(request({ ...payload, expectedUpdatedAt: row!.updated_at, expectedNextBillingDate: row!.next_billing_date, nextBillingDate: "2026-04-30" }), env, id);
    expect(await getSubscription(env, USER_ID, id)).toMatchObject({ next_billing_date: "2026-04-30" });
  });
  it("rejects stale price-only edits even in the same millisecond and refuses changed previews", async () => {
    const { env, id, payload } = await setup();
    await expect(renewSubscription(request({ ...payload, nextBillingDate: "2026-04-30" }), env, id)).rejects.toMatchObject({ status: 409 });
    await updateSubscription(request({ price: "25" }), env, id);
    await expect(renewSubscription(request(payload), env, id)).rejects.toMatchObject({ status: 409 });
    expect(await getSubscription(env, USER_ID, id)).toMatchObject({ price: "25", next_billing_date: "2026-02-28" });
  });
  it("invalidates renewal confirmation when public visibility changes at the same clock instant", async () => {
    const { env, id, payload } = await setup();
    await updateSubscription(request({ publicHidden: true }), env, id);
    await expect(renewSubscription(request(payload), env, id)).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back both facts and projections on storage failure without misreporting a conflict", async () => {
    const { db, env, id, payload } = await setup();
    const before = await getSubscription(env, USER_ID, id);
    db.exec("CREATE TRIGGER fail_renewal BEFORE UPDATE ON subscription_list_index BEGIN SELECT RAISE(ABORT, 'injected renewal failure'); END;");
    await expect(renewSubscription(request(payload), env, id)).rejects.toThrow("injected renewal failure");
    expect(await getSubscription(env, USER_ID, id)).toEqual(before);
    expect(db.prepare("SELECT next_billing_date FROM subscription_list_index WHERE subscription_id = ?").get(id)).toMatchObject({ next_billing_date: "2026-02-28" });
  });
  it("keeps deleted and foreign records behind the same 404 boundary", async () => {
    const { env, id, payload, db } = await setup();
    await expect(renewSubscription(request(payload), env, "other")).rejects.toMatchObject({ status: 404 });
    db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
    await expect(renewSubscription(request(payload), env, id)).rejects.toMatchObject({ status: 404 });
  });
});
