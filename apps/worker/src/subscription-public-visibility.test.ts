import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkUpdatePublicVisibility } from "./subscription-public-visibility";
import { rebuildSubscriptionDerivedStateForUser } from "./subscription-derived-state";
import { openDerivedStateDatabase, subscriptionRow, insertSubscriptionStatement, USER_ID, NOW } from "./subscription-d1-test-support";
import { subscriptionBulkPublicVisibilityResponseSchema } from "@renewlet/shared/schemas/subscriptions";

vi.mock("./auth", () => ({ requireAuth: vi.fn(async () => ({ user: { id: USER_ID } })) }));
beforeEach(() => vi.restoreAllMocks());

function request(selection: unknown, publicHidden = true, dryRun = false) {
  return new Request("https://renewlet.test/api/app/subscriptions/bulk-public-visibility", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection, publicHidden, dryRun }),
  });
}

async function seed(size: number) {
  const state = openDerivedStateDatabase();
  const ids = Array.from({ length: size }, (_, i) => `sub_visibility_${i}`);
  for (const id of ids) await insertSubscriptionStatement(state.env, subscriptionRow(id)).run();
  await rebuildSubscriptionDerivedStateForUser(state.env, USER_ID, NOW);
  return { ...state, ids };
}

function snapshot(state: ReturnType<typeof openDerivedStateDatabase>) {
  return Object.fromEntries(["subscriptions", "subscription_list_index", "subscription_tags", "subscription_repeat_schedule", "subscription_user_stats", "subscription_scheduler_state"]
    .map((table) => [table, state.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

describe("bulk public visibility with real SQLite transactions", () => {
  it.each([5, 100, 500, 5000])("hides and restores %i rows with bounded reads and a single atomic batch", async (size) => {
    const state = await seed(size);
    try {
      const before = snapshot(state);
      const batch = vi.spyOn(state.env.DB, "batch");
      const prepare = vi.spyOn(state.env.DB, "prepare");
      for (const target of [true, false]) {
        batch.mockClear(); prepare.mockClear();
        const response = await bulkUpdatePublicVisibility(request({ ids: state.ids }, target), state.env);
        expect(response.status).toBe(200);
        expect(subscriptionBulkPublicVisibilityResponseSchema.parse(await response.json()).data).toEqual({ matchedCount: size, changedCount: size, skippedCount: 0, failedIds: [] });
        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch.mock.calls[0]?.[0]).toHaveLength(4);
        expect(prepare.mock.calls.filter(([sql]) => sql.includes("SELECT s.id, s.user_id, s.public_hidden"))).toHaveLength(Math.ceil(size / 400));
        expect(state.db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE public_hidden = ?").get(Number(target))?.["count"]).toBe(size);
        expect(state.db.prepare("SELECT COUNT(*) AS count FROM subscriptions s JOIN subscription_list_index i ON i.subscription_id=s.id WHERE s.public_hidden != i.public_hidden OR s.updated_at != i.updated_at").get()?.["count"]).toBe(0);
      }
      const after = snapshot(state);
      for (const table of ["subscription_tags", "subscription_repeat_schedule", "subscription_user_stats", "subscription_scheduler_state"]) expect(after[table]).toEqual(before[table]);
      batch.mockClear();
      const unchanged = await bulkUpdatePublicVisibility(request({ ids: state.ids }, false), state.env);
      expect(subscriptionBulkPublicVisibilityResponseSchema.parse(await unchanged.json()).data).toMatchObject({ changedCount: 0, skippedCount: size });
      expect(batch).not.toHaveBeenCalled();
    } finally { state.db.close(); }
  });

  it("deduplicates IDs, keeps their order and reports missing/foreign IDs without updating them", async () => {
    const state = await seed(3);
    try {
      state.db.exec("INSERT INTO users (id) VALUES ('foreign')");
      await insertSubscriptionStatement(state.env, subscriptionRow("foreign-sub", { user_id: "foreign" })).run();
      const before = snapshot(state);
      const response = await bulkUpdatePublicVisibility(request({ ids: [state.ids[2], state.ids[0], state.ids[0], "missing", "foreign-sub"] }, true, true), state.env);
      expect(subscriptionBulkPublicVisibilityResponseSchema.parse(await response.json()).data).toEqual({ matchedCount: 2, changedCount: 2, skippedCount: 0, failedIds: ["missing", "foreign-sub"] });
      expect(snapshot(state)).toEqual(before);
      const apply = await bulkUpdatePublicVisibility(request({ ids: [state.ids[0], "foreign-sub"] }), state.env);
      expect(subscriptionBulkPublicVisibilityResponseSchema.parse(await apply.json()).data.failedIds).toEqual(["foreign-sub"]);
      expect(state.db.prepare("SELECT public_hidden FROM subscriptions WHERE id='foreign-sub'").get()?.["public_hidden"]).toBe(0);
    } finally { state.db.close(); }
  });

  it.each([0, 199, 499])("rolls back all facts and indexes when row %i fails", async (failureIndex) => {
    const state = await seed(500);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const before = snapshot(state);
      state.db.exec(`CREATE TRIGGER fail_visibility BEFORE UPDATE ON subscription_list_index WHEN OLD.subscription_id = 'sub_visibility_${failureIndex}' BEGIN SELECT RAISE(ABORT, 'injected index failure'); END`);
      await expect(bulkUpdatePublicVisibility(request({ ids: state.ids }), state.env)).rejects.toMatchObject({ status: 500, code: "SUBSCRIPTION_PUBLIC_VISIBILITY_FAILED" });
      expect(snapshot(state)).toEqual(before);
      expect(log).toHaveBeenCalledWith("subscription_public_visibility_failed", expect.objectContaining({ requestId: expect.any(String) }));
    } finally { state.db.close(); }
  });

  it("detects missing indexes before write and ignored index updates before commit", async () => {
    const state = await seed(5);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.db.exec("CREATE TRIGGER ignore_visibility BEFORE UPDATE ON subscription_list_index BEGIN SELECT RAISE(IGNORE); END");
      const before = snapshot(state);
      await expect(bulkUpdatePublicVisibility(request({ ids: state.ids }), state.env)).rejects.toMatchObject({ status: 500 });
      expect(snapshot(state)).toEqual(before);
      state.db.exec("DROP TRIGGER ignore_visibility; DELETE FROM subscription_list_index WHERE subscription_id='sub_visibility_0'");
      const missing = snapshot(state);
      await expect(bulkUpdatePublicVisibility(request({ ids: state.ids }), state.env)).rejects.toMatchObject({ status: 500 });
      expect(snapshot(state)).toEqual(missing);
    } finally { state.db.close(); }
  });

  it("returns 409 for a changed snapshot and retries using the current facts", async () => {
    const state = await seed(5);
    try {
      const execute = state.env.DB.batch.bind(state.env.DB);
      vi.spyOn(state.env.DB, "batch").mockImplementationOnce((statements) => {
        state.db.exec("UPDATE subscriptions SET status='paused', updated_at='2026-09-15T12:00:00Z' WHERE id='sub_visibility_0'");
        return execute(statements);
      });
      await expect(bulkUpdatePublicVisibility(request({ ids: state.ids }), state.env)).rejects.toMatchObject({ status: 409, code: "SUBSCRIPTION_WRITE_CONFLICT" });
      expect(state.db.prepare("SELECT SUM(public_hidden) AS hidden FROM subscriptions").get()?.["hidden"]).toBe(0);
      expect((await bulkUpdatePublicVisibility(request({ ids: state.ids }), state.env)).status).toBe(200);
    } finally { state.db.close(); }
  });

  it("uses ID lookups for target reads and snapshot guards even when an owner index exists", async () => {
    const state = await seed(100);
    try {
      const prepare = vi.spyOn(state.env.DB, "prepare");
      await bulkUpdatePublicVisibility(request({ ids: state.ids }), state.env);
      const guardSQL = prepare.mock.calls.find(([sql]) => sql.includes("FROM (WITH expected"))?.[0];
      expect(guardSQL).toBeDefined();
      if (!guardSQL) throw new Error("Missing snapshot guard SQL");
      const plan = state.db.prepare(`EXPLAIN QUERY PLAN ${guardSQL}`).all(1, 1, "[]", USER_ID);
      expect(plan.some((row) => String(row["detail"]).includes("SEARCH s USING INDEX sqlite_autoindex_subscriptions_1 (id=?)"))).toBe(true);
      const readSQL = prepare.mock.calls.find(([sql]) => sql.includes("SELECT s.id, s.user_id, s.public_hidden"))?.[0];
      if (!readSQL) throw new Error("Missing target read SQL");
      const readPlan = state.db.prepare(`EXPLAIN QUERY PLAN ${readSQL}`).all("[]", USER_ID);
      expect(readPlan.some((row) => String(row["detail"]).includes("SEARCH s USING INDEX sqlite_autoindex_subscriptions_1 (id=?)"))).toBe(true);
    } finally { state.db.close(); }
  });

  it("evaluates categories at apply time and excludes paused/cancelled and fixed-term buyouts", async () => {
    const state = await seed(6);
    try {
      state.db.exec(`UPDATE subscriptions SET next_billing_date='2000-01-01';
        UPDATE subscriptions SET status='paused' WHERE id='sub_visibility_1';
        UPDATE subscriptions SET status='cancelled' WHERE id='sub_visibility_2';
        UPDATE subscriptions SET billing_cycle='one-time', one_time_term_count=0, next_billing_date='2099-01-01' WHERE id='sub_visibility_3';
        UPDATE subscriptions SET billing_cycle='one-time', one_time_term_count=12, one_time_term_unit='month', next_billing_date='2099-01-01' WHERE id='sub_visibility_4';
        UPDATE subscriptions SET next_billing_date='2099-01-01' WHERE id='sub_visibility_5'`);
      const preview = await bulkUpdatePublicVisibility(request({ categories: ["expired", "lifetime"] }, true, true), state.env);
      expect(subscriptionBulkPublicVisibilityResponseSchema.parse(await preview.json()).data.matchedCount).toBe(2);
      state.db.exec("UPDATE subscriptions SET status='paused' WHERE id='sub_visibility_0'");
      const apply = await bulkUpdatePublicVisibility(request({ categories: ["expired", "lifetime"] }), state.env);
      expect(subscriptionBulkPublicVisibilityResponseSchema.parse(await apply.json()).data.changedCount).toBe(1);
      expect(state.db.prepare("SELECT id FROM subscriptions WHERE public_hidden=1").all()).toEqual([{ id: "sub_visibility_3" }]);
    } finally { state.db.close(); }
  });

  it.each([{ ids: [] }, { ids: [""] }, { ids: ["id"], categories: ["expired"] }, { ids: ["id"], unknown: true }, { ids: Array.from({ length: 5001 }, () => "id") }])("rejects invalid selections before reads: %j", async (selection) => {
    const state = openDerivedStateDatabase();
    try {
      const prepare = vi.spyOn(state.env.DB, "prepare");
      await expect(bulkUpdatePublicVisibility(request(selection), state.env)).rejects.toMatchObject({ status: 400 });
      expect(prepare).not.toHaveBeenCalled();
    } finally { state.db.close(); }
  });
});
