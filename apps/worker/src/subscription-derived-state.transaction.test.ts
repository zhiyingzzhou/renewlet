import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { describe, expect, it } from "vitest";
import {
  countSubscriptionStatuses,
  rebuildSubscriptionDerivedStateForUser,
  subscriptionDerivedBulkMutationPlan,
  subscriptionDerivedMutationPlan,
  type SubscriptionDerivedMutation,
} from "./subscription-derived-state";
import type { Env, SubscriptionRow } from "./types";

import { openDerivedStateDatabase, subscriptionRow, insertSubscriptionStatement, readDerivedSnapshot, readCount, USER_ID, NOW } from "./subscription-d1-test-support";

function mutationBatch(
  env: Env,
  fact: D1PreparedStatement,
  mutation: SubscriptionDerivedMutation,
  settings = createDefaultAppSettings(),
): D1PreparedStatement[] {
  const derived = subscriptionDerivedMutationPlan(env, mutation, settings, NOW);
  return [...derived.beforeFact, fact, ...derived.afterFact];
}

describe("Worker subscription derived-state transactions", () => {
  it("counts every fixed status and ignores unknown dirty values", () => {
    expect(countSubscriptionStatuses([
      { status: "trial" },
      { status: "active" },
      { status: "expired" },
      { status: "paused" },
      { status: "cancelled" },
      { status: "unknown-dirty-value" },
    ])).toEqual({ trial: 1, active: 1, expired: 1, paused: 1, cancelled: 1 });
    expect(countSubscriptionStatuses([])).toEqual({ trial: 0, active: 0, expired: 0, paused: 0, cancelled: 0 });
  });

  it("rolls back the fact row when a derived statement fails", async () => {
    const { db, env } = openDerivedStateDatabase();
    try {
      db.exec(`
        CREATE TRIGGER fail_subscription_stats_update
        BEFORE UPDATE ON subscription_user_stats
        BEGIN
          SELECT RAISE(ABORT, 'injected derived failure');
        END;
      `);
      const row = subscriptionRow("sub_rollback", { tags_json: JSON.stringify(["critical"]) });

      await expect(env.DB.batch(mutationBatch(
        env,
        insertSubscriptionStatement(env, row),
        { before: null, after: row, kind: "create" },
      ))).rejects.toThrow("injected derived failure");

      for (const table of [
        "subscriptions",
        "subscription_list_index",
        "subscription_tags",
        "subscription_repeat_schedule",
      ]) {
        expect(readCount(db, table)).toBe(0);
      }
      expect(readCount(db, "subscription_user_stats")).toBe(1);
      expect(readCount(db, "subscription_scheduler_state")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects a stale delete before applying a second stats or scheduler delta", async () => {
    const { db, env } = openDerivedStateDatabase();
    try {
      const settings = createDefaultAppSettings();
      const row = subscriptionRow("sub_delete_race", { auto_renew: 1, repeat_reminder_enabled: 1 });
      await env.DB.batch(mutationBatch(
        env,
        insertSubscriptionStatement(env, row),
        { before: null, after: row, kind: "create" },
        settings,
      ));
      await env.DB.batch(mutationBatch(
        env,
        env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ? AND id = ?").bind(USER_ID, row.id),
        { before: row, after: null, kind: "delete" },
        settings,
      ));
      const settled = readDerivedSnapshot(db);

      await expect(env.DB.batch(mutationBatch(
        env,
        env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ? AND id = ?").bind(USER_ID, row.id),
        { before: row, after: null, kind: "delete" },
        settings,
      ))).rejects.toThrow();

      expect(readDerivedSnapshot(db)).toEqual(settled);
    } finally {
      db.close();
    }
  });

  it("rejects a stale concurrent update before consuming the same before delta twice", async () => {
    const { db, env } = openDerivedStateDatabase();
    try {
      const settings = createDefaultAppSettings();
      const row = subscriptionRow("sub_update_race", { status: "active", auto_renew: 1 });
      await env.DB.batch(mutationBatch(
        env,
        insertSubscriptionStatement(env, row),
        { before: null, after: row, kind: "create" },
        settings,
      ));
      const first = { ...row, status: "paused", updated_at: "2026-08-17T00:01:00.000Z" } satisfies SubscriptionRow;
      const stale = { ...row, status: "cancelled", updated_at: "2026-08-17T00:02:00.000Z" } satisfies SubscriptionRow;

      await env.DB.batch(mutationBatch(
        env,
        env.DB.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?")
          .bind(first.status, first.updated_at, USER_ID, row.id),
        { before: row, after: first, kind: "update" },
        settings,
      ));
      const settled = readDerivedSnapshot(db);

      await expect(env.DB.batch(mutationBatch(
        env,
        env.DB.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?")
          .bind(stale.status, stale.updated_at, USER_ID, row.id),
        { before: row, after: stale, kind: "update" },
        settings,
      ))).rejects.toThrow();
      expect(readDerivedSnapshot(db)).toEqual(settled);
    } finally {
      db.close();
    }
  });

  it("applies 200 create mutations with a fixed statement count and matches the oracle", async () => {
    const { db, env } = openDerivedStateDatabase();
    try {
      const settings = createDefaultAppSettings();
      const mutations = Array.from({ length: 200 }, (_, index): SubscriptionDerivedMutation => {
        const row = subscriptionRow(`sub_bulk_${index}`, {
          status: index % 2 === 0 ? "active" : "trial",
          auto_renew: index % 3 === 0 ? 1 : 0,
          repeat_reminder_enabled: index % 5 === 0 ? 1 : 0,
          tags_json: JSON.stringify([`tag-${index % 7}`]),
        });
        return { before: null, after: row, kind: "create" };
      });
      const plan = subscriptionDerivedBulkMutationPlan(env, mutations, settings, NOW);
      const statements = [...plan.beforeFact, plan.fact, ...plan.afterFact];

      expect(statements).toHaveLength(9);
      await env.DB.batch(statements);
      expect(readCount(db, "subscriptions")).toBe(200);

      const incremental = readDerivedSnapshot(db);
      await rebuildSubscriptionDerivedStateForUser(env, USER_ID, NOW);
      expect(readDerivedSnapshot(db)).toEqual(incremental);
    } finally {
      db.close();
    }
  });

  it("matches the full rebuild oracle after create, update, delete and renew-like mutations", async () => {
    const { db, env } = openDerivedStateDatabase();
    try {
      const settings = createDefaultAppSettings();
      const first = subscriptionRow("sub_first", { status: "active", auto_renew: 1, repeat_reminder_enabled: 1 });
      const second = subscriptionRow("sub_second", { status: "trial", tags_json: JSON.stringify(["Team", "team"]), trial_end_date: "2026-09-15" });
      const third = subscriptionRow("sub_third", { status: "paused", auto_renew: 0 });
      for (const row of [first, second, third]) {
        await env.DB.batch(mutationBatch(
          env,
          insertSubscriptionStatement(env, row),
          { before: null, after: row, kind: "create" },
          settings,
        ));
      }

      const updatedSecond = {
        ...second,
        status: "cancelled",
        tags_json: JSON.stringify(["Priority", "TEAM"]),
        repeat_reminder_enabled: 1,
        updated_at: "2026-08-17T00:01:00.000Z",
      } satisfies SubscriptionRow;
      await env.DB.batch(mutationBatch(
        env,
        env.DB.prepare(`UPDATE subscriptions
          SET status = ?, tags_json = ?, repeat_reminder_enabled = ?, updated_at = ?
          WHERE user_id = ? AND id = ?`).bind(
          updatedSecond.status,
          updatedSecond.tags_json,
          updatedSecond.repeat_reminder_enabled,
          updatedSecond.updated_at,
          USER_ID,
          updatedSecond.id,
        ),
        {
          before: second,
          after: updatedSecond,
          kind: "update",
        },
        settings,
      ));

      const renewedFirst = {
        ...first,
        next_billing_date: "2026-10-15",
        updated_at: "2026-08-17T00:02:00.000Z",
      } satisfies SubscriptionRow;
      await env.DB.batch(mutationBatch(
        env,
        env.DB.prepare(`UPDATE subscriptions SET next_billing_date = ?, updated_at = ?
          WHERE user_id = ? AND id = ?`).bind(
          renewedFirst.next_billing_date,
          renewedFirst.updated_at,
          USER_ID,
          renewedFirst.id,
        ),
        {
          before: first,
          after: renewedFirst,
          kind: "update",
        },
        settings,
      ));

      await env.DB.batch(mutationBatch(
        env,
        env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ? AND id = ?").bind(USER_ID, third.id),
        { before: third, after: null, kind: "delete" },
        settings,
      ));

      const created = subscriptionRow("sub_created", { status: "expired", auto_renew: 0 });
      await env.DB.batch(mutationBatch(
        env,
        insertSubscriptionStatement(env, created),
        { before: null, after: created, kind: "create" },
        settings,
      ));

      const incremental = readDerivedSnapshot(db);
      await rebuildSubscriptionDerivedStateForUser(env, USER_ID, NOW);
      expect(readDerivedSnapshot(db)).toEqual(incremental);
    } finally {
      db.close();
    }
  });
});
