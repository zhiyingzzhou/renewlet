import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscription, renewSubscription, updateSubscription } from "./subscriptions";
import { getSubscription } from "./db";
import { openDerivedStateDatabase, USER_ID } from "./subscription-d1-test-support";
import { readSuccessData } from "./api-test-helpers";

vi.mock("./auth", () => ({ requireAuth: vi.fn(async () => ({ user: { id: "usr_derived_transaction" } })) }));
const request = (body: unknown) => new Request("https://renewlet.test/api/app/subscriptions", {
  method: "POST", headers: { "content-type": "application/json", "x-renewlet-locale": "zh-CN" }, body: JSON.stringify(body),
});
const sharing = { enabled: true, splitMode: "custom", collectionReminder: { enabled: true, reminderDays: 3 }, members: [
  { id: "old", name: "旧成员", joinedDate: "2026-01-31", currency: "JPY", customAmount: "0", note: "keep" },
  { id: "inside", name: "区间内", joinedDate: "2026-11-10", customAmount: "2" },
  { id: "after", name: "区间外", joinedDate: "2027-01-01", customAmount: "3" },
  { id: "inherited", name: "继承", customAmount: "4" },
] };
describe("restart renewal confirms cost sharing dates atomically", () => {
  const fixtures: ReturnType<typeof openDerivedStateDatabase>[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T08:00:00Z")); });
  afterEach(() => { fixtures.splice(0).forEach(f => f.db.close()); vi.useRealTimers(); });
  async function setup() {
    const f = openDerivedStateDatabase(); fixtures.push(f);
    const { subscription } = await readSuccessData<{ subscription: { id: string; updatedAt: string } }>(await createSubscription(request({
      name: "Shared Netflix", price: "12", currency: "USD", billingCycle: "monthly", category: "entertainment",
      status: "active", startDate: "2026-01-01", nextBillingDate: "2027-01-01", autoRenew: false,
      autoCalculateNextBillingDate: false, balance: "0", balanceCurrency: "JPY", costSharing: sharing,
      reminderDays: -1, repeatReminderEnabled: false, repeatReminderInterval: "1h", repeatReminderWindow: "72h",
    }), f.env));
    const payload = { expectedUpdatedAt: subscription.updatedAt, expectedNextBillingDate: "2027-01-01", mode: "restart",
      price: "10", currency: "EUR", startDate: "2026-11-07", nextBillingDate: "2026-12-07", autoCalculateNextBillingDate: true,
      costSharingMemberJoinedDates: [{ id: "old", joinedDate: "2026-11-07" }, { id: "after", joinedDate: "2026-12-07" }] };
    return { ...f, id: subscription.id, payload };
  }
  it("persists only confirmed member dates, recalculates reminders and protects against replay", async () => {
    const { env, id, payload } = await setup();
    const response = await renewSubscription(request(payload), env, id);
    const { subscription } = await readSuccessData<{ subscription: { costSharing: typeof sharing } }>(response);
    const expectedSharing = { ...sharing, members: sharing.members.map(m => ({ ...m, ...(payload.costSharingMemberJoinedDates.find(u => u.id === m.id) ?? {}) })) };
    expect(subscription.costSharing).toEqual(expectedSharing);
    const saved = await getSubscription(env, USER_ID, id);
    expect(saved).toMatchObject({ price: "10", currency: "EUR", balance: "0", balance_currency: "JPY", start_date: "2026-11-07",
      next_billing_date: "2026-12-07", cost_sharing_next_collection_reminder_date: "2026-12-04", cost_sharing_collection_reminder_enabled: 1 });
    expect(JSON.parse(saved!.cost_sharing_json!)).toEqual(expectedSharing);
    await expect(renewSubscription(request(payload), env, id)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects unconfirmed, missing, unknown and out-of-range dates without changing any facts", async () => {
    const { env, id, payload } = await setup();
    const before = await getSubscription(env, USER_ID, id);
    for (const dates of [undefined, [], payload.costSharingMemberJoinedDates.slice(0, 1), [{ id: "foreign-member", joinedDate: "2026-11-07" }],
      [{ id: "old", joinedDate: "2026-11-06" }, payload.costSharingMemberJoinedDates[1]]]) {
      await expect(renewSubscription(request({ ...payload, costSharingMemberJoinedDates: dates }), env, id)).rejects.toMatchObject({
        status: 400, code: "SUBSCRIPTION_RENEW_COST_SHARING_INVALID", message: expect.stringContaining("请核对成员上车日期"),
      });
      expect(await getSubscription(env, USER_ID, id)).toEqual(before);
    }
  });
  it("rolls back member dates, renewal facts and projections together", async () => {
    const { env, db, id, payload } = await setup();
    const before = await getSubscription(env, USER_ID, id);
    const projection = db.prepare("SELECT * FROM subscription_list_index WHERE subscription_id = ?").get(id);
    db.exec("CREATE TRIGGER fail_shared_restart BEFORE UPDATE ON subscription_list_index BEGIN SELECT RAISE(ABORT, 'injected shared restart failure'); END;");
    await expect(renewSubscription(request(payload), env, id)).rejects.toThrow("injected shared restart failure");
    expect(await getSubscription(env, USER_ID, id)).toEqual(before);
    expect(db.prepare("SELECT * FROM subscription_list_index WHERE subscription_id = ?").get(id)).toEqual(projection);
  });
  it("rejects a stale member list before applying date updates", async () => {
    const { env, id, payload } = await setup();
    await updateSubscription(request({ costSharing: { ...sharing, members: sharing.members.filter(m => m.id !== "old") } }), env, id);
    const before = await getSubscription(env, USER_ID, id);
    await expect(renewSubscription(request(payload), env, id)).rejects.toMatchObject({ status: 409 });
    expect(await getSubscription(env, USER_ID, id)).toEqual(before);
  });
});
