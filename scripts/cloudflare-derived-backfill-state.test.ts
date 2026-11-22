import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDerivedSchema,
  executeDerivedBackfillState,
  type DerivedBackfillActions,
  type DerivedSchemaShape,
} from "./cloudflare-derived-backfill-state";

const statsV2Columns = [
  "user_id",
  "total_count",
  "trial_count",
  "active_count",
  "expired_count",
  "paused_count",
  "cancelled_count",
  "created_at",
  "updated_at",
] as const;

function v3Shape(markerPresent: boolean): DerivedSchemaShape {
  return {
    v2MigrationApplied: true,
    v3MigrationApplied: true,
    listIndexColumns: [
      "subscription_id", "user_id", "name", "website", "notes", "search_text_lower", "category", "billing_cycle",
      "currency", "payment_method", "status", "pinned", "public_hidden", "next_billing_date", "trial_end_date",
      "one_time_term_count", "auto_renew", "reminder_days", "repeat_reminder_enabled", "created_at", "updated_at",
    ],
    tagColumns: ["user_id", "subscription_id", "tag_norm", "tag", "created_at", "updated_at"],
    statsColumns: statsV2Columns,
    repeatScheduleColumns: ["user_id", "subscription_id", "next_due_at_utc"],
    repeatScheduleIndexColumns: ["user_id", "next_due_at_utc", "subscription_id"],
    schedulerColumns: [
      "user_id", "auto_renew_count", "repeat_reminder_count", "last_auto_renew_local_date", "created_at", "updated_at",
      "next_auto_renew_check_at_utc", "next_daily_notification_due_at_utc", "next_repeat_notification_due_at_utc",
    ],
    schedulerAutoIndexColumns: ["next_auto_renew_check_at_utc", "user_id"],
    schedulerDailyIndexColumns: ["next_daily_notification_due_at_utc", "user_id"],
    schedulerRepeatIndexColumns: ["next_repeat_notification_due_at_utc", "user_id"],
    backfillColumns: ["name", "completed_at"],
    primaryKeysValid: true,
    foreignKeysValid: true,
    constraintsValid: true,
    markerPresent,
  };
}

test("classifies legacy, v2 repair, v5 pending, v5 complete, and mixed schemas", () => {
  assert.equal(classifyDerivedSchema({
    v2MigrationApplied: false,
    v3MigrationApplied: false,
    listIndexColumns: [],
    tagColumns: [],
    statsColumns: ["user_id", "total_count", "status_counts_json", "created_at", "updated_at", "source_updated_at"],
    repeatScheduleColumns: [],
    repeatScheduleIndexColumns: [],
    schedulerColumns: [],
    schedulerAutoIndexColumns: [],
    schedulerDailyIndexColumns: [],
    schedulerRepeatIndexColumns: [],
    backfillColumns: [],
    primaryKeysValid: false,
    foreignKeysValid: false,
    constraintsValid: false,
    markerPresent: false,
  }), "legacy");
  assert.equal(classifyDerivedSchema({ ...v3Shape(false), v3MigrationApplied: false }), "v2-needs-repair-migration");
  assert.equal(classifyDerivedSchema(v3Shape(false)), "v5-pending-backfill");
  assert.equal(classifyDerivedSchema(v3Shape(true)), "v5-complete");
  assert.equal(classifyDerivedSchema({
    ...v3Shape(false),
    v2MigrationApplied: false,
  }), "invalid-mixed");
  assert.equal(classifyDerivedSchema({
    ...v3Shape(false),
    repeatScheduleIndexColumns: ["user_id", "subscription_id", "next_due_at_utc"],
  }), "invalid-mixed");
  assert.equal(classifyDerivedSchema({
    ...v3Shape(false),
    tagColumns: ["user_id", "subscription_id", "tag"],
  }), "invalid-mixed");
  assert.equal(classifyDerivedSchema({
    ...v3Shape(false),
    foreignKeysValid: false,
  }), "invalid-mixed");
  assert.equal(classifyDerivedSchema({
    ...v3Shape(false),
    constraintsValid: false,
  }), "invalid-mixed");
  assert.equal(classifyDerivedSchema({
    ...v3Shape(true),
    statsColumns: [...statsV2Columns, "unexpected_column"],
  }), "invalid-mixed");
});

test("an old marker never skips the v5 rebuild", () => {
  assert.equal(classifyDerivedSchema(v3Shape(false)), "v5-pending-backfill");
});

test("pending state marks complete only after rebuild and verification", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => { calls.push("verify"); },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };
  await executeDerivedBackfillState("v5-pending-backfill", actions);
  assert.deepEqual(calls, ["rebuild", "verify", "mark"]);
});

test("failed pending runs remain unmarked and can be replayed", async () => {
  const calls: string[] = [];
  let verificationAttempts = 0;
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => {
      calls.push("verify");
      verificationAttempts += 1;
      if (verificationAttempts === 1) throw new Error("injected invariant failure");
    },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };

  await assert.rejects(executeDerivedBackfillState("v5-pending-backfill", actions), /injected invariant failure/);
  assert.deepEqual(calls, ["rebuild", "verify"]);
  await executeDerivedBackfillState("v5-pending-backfill", actions);
  assert.deepEqual(calls, ["rebuild", "verify", "rebuild", "verify", "mark"]);
});

test("a write failure during rebuild never reaches verification or the marker", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => {
      calls.push("rebuild");
      throw new Error("injected batch write failure");
    },
    verify: async (): Promise<void> => { calls.push("verify"); },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };

  await assert.rejects(executeDerivedBackfillState("v5-pending-backfill", actions), /injected batch write failure/);
  assert.deepEqual(calls, ["rebuild"]);
});

test("complete state verifies without rebuilding or rewriting the marker", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => { calls.push("verify"); },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };
  await executeDerivedBackfillState("v5-complete", actions);
  assert.deepEqual(calls, ["verify"]);
});

test("a completed marker never authorizes rebuilding failed invariants", async () => {
  const calls: string[] = [];
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { calls.push("rebuild"); },
    verify: async (): Promise<void> => {
      calls.push("verify");
      throw new Error("injected completed-state invariant failure");
    },
    markComplete: async (): Promise<void> => { calls.push("mark"); },
  };

  await assert.rejects(
    executeDerivedBackfillState("v5-complete", actions),
    /injected completed-state invariant failure/,
  );
  assert.deepEqual(calls, ["verify"]);
});

test("legacy and mixed schemas fail without invoking write actions", async () => {
  let actionCount = 0;
  const actions: DerivedBackfillActions = {
    rebuild: async (): Promise<void> => { actionCount += 1; },
    verify: async (): Promise<void> => { actionCount += 1; },
    markComplete: async (): Promise<void> => { actionCount += 1; },
  };
  await assert.rejects(executeDerivedBackfillState("legacy", actions), /apply migrations 0036 and 0039/);
  await assert.rejects(executeDerivedBackfillState("v2-needs-repair-migration", actions), /apply migration 0039/);
  await assert.rejects(executeDerivedBackfillState("invalid-mixed", actions), /refusing automatic schema repair/);
  assert.equal(actionCount, 0);
});
