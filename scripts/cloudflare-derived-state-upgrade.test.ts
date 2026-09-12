import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { runBackfill } from "./backfill-cloudflare-subscription-derived-state";
import type {
  D1Client,
  D1QueryResult,
  D1RowParser,
  D1Statement,
  D1Value,
} from "./cloudflare-d1-client";

const timestamp = "2026-08-24T00:00:00.000Z";
const backfillNow = (): Date => new Date("2026-08-24T12:00:00.000Z");

function plainRows(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

class SqliteDerivedClient implements D1Client {
  constructor(readonly db: DatabaseSync) {}

  async query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]> {
    return this.db.prepare(sql).all(...[...params] as SQLInputValue[]).map(parseRow);
  }

  async batch(statements: readonly D1Statement[]): Promise<D1QueryResult[]> {
    if (statements.length === 0) return [];
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement): D1QueryResult => {
        this.db.prepare(statement.sql).run(...[...(statement.params ?? [])] as SQLInputValue[]);
        return { success: true, results: [] };
      });
      this.db.exec("COMMIT");
      return results;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class FailFirstWriteClient implements D1Client {
  private failed = false;

  constructor(private readonly delegate: D1Client) {}

  query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]> {
    return this.delegate.query(sql, params, parseRow);
  }

  async batch(statements: readonly D1Statement[]): Promise<D1QueryResult[]> {
    if (!this.failed && statements.length > 0) {
      this.failed = true;
      throw new Error("injected derived-state interruption");
    }
    return this.delegate.batch(statements);
  }
}

// canonical v3 schema 搭配故意污染的派生行，用于证明回填只相信 subscriptions facts；各 mixed-schema 用例再从这里定向破坏签名。
function openDerivedDatabase({ v2Marker = true }: { v2Marker?: boolean } = {}): SqliteDerivedClient {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE d1_migrations (name TEXT PRIMARY KEY);
    INSERT INTO d1_migrations (name) VALUES
      ('0036_subscription_derived_state_v2.sql'),
      ('0039_rebuild_subscription_collection_projections.sql');
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL
    );
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      logo TEXT,
      price TEXT NOT NULL,
      currency TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      custom_days INTEGER,
      custom_cycle_unit TEXT,
      one_time_term_count INTEGER,
      one_time_term_unit TEXT,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      public_hidden INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      start_date TEXT,
      next_billing_date TEXT NOT NULL,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      auto_calculate_next_billing_date INTEGER NOT NULL,
      trial_end_date TEXT,
      website TEXT,
      notes TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      reminder_days INTEGER NOT NULL,
      repeat_reminder_enabled INTEGER NOT NULL,
      repeat_reminder_interval TEXT NOT NULL,
      repeat_reminder_window TEXT NOT NULL,
      cost_sharing_json TEXT NOT NULL DEFAULT '{}',
      cost_sharing_collection_reminder_enabled INTEGER NOT NULL DEFAULT 0,
      cost_sharing_next_collection_reminder_date TEXT,
      extra_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_list_index (
      subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      website TEXT,
      notes TEXT,
      search_text_lower TEXT NOT NULL,
      category TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      currency TEXT NOT NULL,
      payment_method TEXT,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      public_hidden INTEGER NOT NULL DEFAULT 0,
      next_billing_date TEXT NOT NULL,
      trial_end_date TEXT,
      one_time_term_count INTEGER,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      reminder_days INTEGER NOT NULL DEFAULT 0,
      repeat_reminder_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_subscription_list_index_user_order
      ON subscription_list_index (user_id, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_category_order
      ON subscription_list_index (user_id, category, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_billing_cycle_order
      ON subscription_list_index (user_id, billing_cycle, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_currency_order
      ON subscription_list_index (user_id, currency, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_payment_method_order
      ON subscription_list_index (user_id, payment_method, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_pinned_order
      ON subscription_list_index (user_id, pinned, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_public_hidden_order
      ON subscription_list_index (user_id, public_hidden, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_reminder_order
      ON subscription_list_index (user_id, reminder_days, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_list_index_user_repeat_order
      ON subscription_list_index (user_id, repeat_reminder_enabled, created_at DESC, subscription_id DESC);
    CREATE TABLE subscription_tags (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      tag_norm TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id, tag_norm)
    );
    CREATE INDEX idx_subscription_tags_user_tag_order
      ON subscription_tags (user_id, tag_norm, created_at DESC, subscription_id DESC);
    CREATE INDEX idx_subscription_tags_user_updated
      ON subscription_tags (user_id, updated_at DESC, tag_norm);
    CREATE TABLE subscription_user_stats (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      total_count INTEGER NOT NULL DEFAULT 0,
      trial_count INTEGER NOT NULL DEFAULT 0,
      active_count INTEGER NOT NULL DEFAULT 0,
      expired_count INTEGER NOT NULL DEFAULT 0,
      paused_count INTEGER NOT NULL DEFAULT 0,
      cancelled_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (total_count >= 0 AND trial_count >= 0 AND active_count >= 0 AND expired_count >= 0 AND paused_count >= 0 AND cancelled_count >= 0),
      CHECK (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)
    );
    CREATE TABLE subscription_repeat_schedule (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      next_due_at_utc TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id)
    );
    CREATE INDEX idx_subscription_repeat_schedule_due
      ON subscription_repeat_schedule (user_id, next_due_at_utc, subscription_id);
    CREATE TABLE subscription_scheduler_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      auto_renew_count INTEGER NOT NULL DEFAULT 0,
      repeat_reminder_count INTEGER NOT NULL DEFAULT 0,
      last_auto_renew_local_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_auto_renew_check_at_utc TEXT,
      next_daily_notification_due_at_utc TEXT,
      next_repeat_notification_due_at_utc TEXT
    );
    CREATE INDEX idx_subscription_scheduler_auto_due
      ON subscription_scheduler_state (next_auto_renew_check_at_utc, user_id);
    CREATE INDEX idx_subscription_scheduler_daily_due
      ON subscription_scheduler_state (next_daily_notification_due_at_utc, user_id);
    CREATE INDEX idx_subscription_scheduler_repeat_due
      ON subscription_scheduler_state (next_repeat_notification_due_at_utc, user_id);
    CREATE TABLE subscription_derived_backfills (
      name TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );
    INSERT INTO users (id) VALUES ('usr_one'), ('usr_two');
    INSERT INTO settings (user_id, settings_json) VALUES ('usr_one', '{"localePreference":"auto"}');
    INSERT INTO subscriptions (
      id, user_id, name, price, currency, billing_cycle, category, status, pinned, public_hidden,
      start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date, website, notes, tags_json,
      reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
      cost_sharing_json, cost_sharing_collection_reminder_enabled, extra_json, created_at, updated_at
    ) VALUES
      (
        'sub_one', 'usr_one', 'Service One', '10.00', 'USD', 'monthly', 'software', 'active', 1, 0,
        '2026-01-24', '2026-08-27', 1, 1, 'https://one.example', 'Notes',
        '[" Work ","work","工具"," 工具 ","İ","i̇",""]', 3, 1, '1h', '72h',
        '{}', 0, '{}', '${timestamp}', '${timestamp}'
      ),
      (
        'sub_two', 'usr_two', 'Service Two', '20.00', 'EUR', 'yearly', 'media', 'trial', 0, 1,
        '2026-01-24', '2027-01-24', 0, 1, NULL, NULL, '[]', 7, 0, '24h', '24h',
        '{}', 0, '{}', '${timestamp}', '${timestamp}'
      );
    INSERT INTO subscription_list_index (
      subscription_id, user_id, name, search_text_lower, category, billing_cycle, currency, status,
      pinned, public_hidden, next_billing_date, auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
    ) VALUES (
      'sub_one', 'usr_two', 'stale', 'stale', 'stale', 'monthly', 'USD', 'active',
      0, 0, '2026-08-27', 0, 0, 0, '${timestamp}', '${timestamp}'
    );
    INSERT INTO subscription_tags (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
    VALUES ('usr_two', 'sub_one', 'stale', 'stale', '${timestamp}', '${timestamp}');
    INSERT INTO subscription_user_stats (
      user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
    ) VALUES ('usr_one', 0, 0, 0, 0, 0, 0, '${timestamp}', '${timestamp}');
    INSERT INTO subscription_scheduler_state (
      user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
      next_auto_renew_check_at_utc, next_daily_notification_due_at_utc,
      next_repeat_notification_due_at_utc, created_at, updated_at
    ) VALUES ('usr_one', 0, 0, '', NULL, NULL, NULL, '${timestamp}', '${timestamp}');
  `);
  if (v2Marker) {
    db.prepare("INSERT INTO subscription_derived_backfills (name, completed_at) VALUES (?, ?)")
      .run("subscription-derived-state-v2", timestamp);
  }
  return new SqliteDerivedClient(db);
}

function markerCount(db: DatabaseSync, name: string): number {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM subscription_derived_backfills WHERE name = ?")
    .get(name)?.["count"] ?? 0);
}

test("v3 rebuild restores collection, stats, schedule, and scheduler state from subscription facts", async () => {
  const client = openDerivedDatabase();
  try {
    await runBackfill(client, backfillNow);

    assert.equal(markerCount(client.db, "subscription-derived-state-v2"), 1);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 1);
    assert.deepEqual(plainRows(client.db.prepare(`SELECT subscription_id, user_id, name, search_text_lower
      FROM subscription_list_index ORDER BY subscription_id`).all()), [
      {
        subscription_id: "sub_one",
        user_id: "usr_one",
        name: "Service One",
        search_text_lower: "service one\nhttps://one.example\nnotes\ni̇\nwork\n工具",
      },
      {
        subscription_id: "sub_two",
        user_id: "usr_two",
        name: "Service Two",
        search_text_lower: "service two\n\n",
      },
    ]);
    assert.deepEqual(plainRows(client.db.prepare(`SELECT tag_norm, tag FROM subscription_tags
      WHERE user_id = 'usr_one' AND subscription_id = 'sub_one' ORDER BY tag_norm`).all()), [
      { tag_norm: "i̇", tag: "i̇" },
      { tag_norm: "work", tag: "work" },
      { tag_norm: "工具", tag: "工具" },
    ]);
    assert.deepEqual(plainRows(client.db.prepare(`SELECT user_id, total_count, trial_count, active_count
      FROM subscription_user_stats ORDER BY user_id`).all()), [
      { user_id: "usr_one", total_count: 1, trial_count: 0, active_count: 1 },
      { user_id: "usr_two", total_count: 1, trial_count: 1, active_count: 0 },
    ]);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_repeat_schedule").get()?.["count"], 1);
    assert.deepEqual(plainRows(client.db.prepare(`SELECT user_id, auto_renew_count, repeat_reminder_count
      FROM subscription_scheduler_state ORDER BY user_id`).all()), [
      { user_id: "usr_one", auto_renew_count: 1, repeat_reminder_count: 1 },
      { user_id: "usr_two", auto_renew_count: 0, repeat_reminder_count: 0 },
    ]);
    assert.deepEqual(client.db.prepare("PRAGMA foreign_key_check").all(), []);

    await runBackfill(client, backfillNow);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 1);
  } finally {
    client.db.close();
  }
});

test("a fresh migrated database records v3 only after empty-state invariants pass", async () => {
  const client = openDerivedDatabase({ v2Marker: false });
  try {
    client.db.exec("DELETE FROM users");

    await runBackfill(client, backfillNow);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 1);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_list_index").get()?.["count"], 0);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_user_stats").get()?.["count"], 0);
    assert.deepEqual(client.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    client.db.close();
  }
});

test("an interrupted v3 run remains unmarked and safely replays", async () => {
  const client = openDerivedDatabase();
  try {
    await assert.rejects(runBackfill(new FailFirstWriteClient(client), backfillNow), /injected derived-state interruption/);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 0);

    await runBackfill(client, backfillNow);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 1);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_list_index").get()?.["count"], 2);
  } finally {
    client.db.close();
  }
});

test("a completed v3 marker verifies corruption and never silently rebuilds it", async () => {
  const client = openDerivedDatabase();
  try {
    await runBackfill(client, backfillNow);
    client.db.prepare("UPDATE subscription_list_index SET name = 'corrupt' WHERE subscription_id = 'sub_one'").run();

    await assert.rejects(runBackfill(client, backfillNow), /subscription_list_index value invariant failed/);
    assert.equal(client.db.prepare("SELECT name FROM subscription_list_index WHERE subscription_id = 'sub_one'").get()?.["name"], "corrupt");
  } finally {
    client.db.close();
  }
});

test("a completed v3 marker rejects a missing repeat schedule even when its aggregate was also cleared", async () => {
  const client = openDerivedDatabase();
  try {
    await runBackfill(client, backfillNow);
    client.db.exec(`
      DELETE FROM subscription_repeat_schedule WHERE subscription_id = 'sub_one';
      UPDATE subscription_scheduler_state
      SET next_repeat_notification_due_at_utc = NULL
      WHERE user_id = 'usr_one';
    `);

    await assert.rejects(runBackfill(client, backfillNow), /missing-row invariant failed/);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_repeat_schedule")
      .get()?.["count"], 0);
  } finally {
    client.db.close();
  }
});

test("a completed v3 marker rejects parseable scheduler instants that are not legal configured occurrences", async () => {
  const client = openDerivedDatabase();
  try {
    await runBackfill(client, backfillNow);
    client.db.prepare(`UPDATE subscription_scheduler_state
      SET next_daily_notification_due_at_utc = '2026-08-25T01:00:00Z'
      WHERE user_id = 'usr_one'`).run();

    await assert.rejects(runBackfill(client, backfillNow), /stored occurrence invariant failed/);
  } finally {
    client.db.close();
  }
});

test("a completed v3 marker accepts an empty user without a daily scheduler occurrence", async () => {
  const client = openDerivedDatabase();
  try {
    await runBackfill(client, backfillNow);
    client.db.exec(`
      DELETE FROM subscriptions WHERE id = 'sub_two';
      UPDATE subscription_user_stats
      SET total_count = 0, trial_count = 0, active_count = 0, expired_count = 0, paused_count = 0, cancelled_count = 0
      WHERE user_id = 'usr_two';
      UPDATE subscription_scheduler_state
      SET auto_renew_count = 0,
          repeat_reminder_count = 0,
          next_auto_renew_check_at_utc = NULL,
          next_daily_notification_due_at_utc = NULL,
          next_repeat_notification_due_at_utc = NULL
      WHERE user_id = 'usr_two';
    `);

    await runBackfill(client, backfillNow);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 1);
  } finally {
    client.db.close();
  }
});

test("a completed v3 marker accepts overdue scheduler occurrences that still match the stored settings", async () => {
  const client = openDerivedDatabase();
  try {
    await runBackfill(client, backfillNow);
    await runBackfill(client, (): Date => new Date("2026-08-27T12:00:00.000Z"));
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 1);
  } finally {
    client.db.close();
  }
});

test("a completed v3 marker accepts an immediate overdue auto-renew check after settings refresh", async () => {
  const client = openDerivedDatabase();
  try {
    await runBackfill(client, backfillNow);
    client.db.prepare(`UPDATE subscription_scheduler_state
      SET last_auto_renew_local_date = '2026-08-23',
          next_auto_renew_check_at_utc = '2026-08-24T11:00:00Z'
      WHERE user_id = 'usr_one'`).run();

    await runBackfill(client, backfillNow);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 1);
  } finally {
    client.db.close();
  }
});

test("a mixed scheduler schema is rejected before any projection repair writes", async () => {
  const client = openDerivedDatabase();
  try {
    client.db.exec("DROP INDEX idx_subscription_scheduler_repeat_due");
    const staleName = client.db.prepare("SELECT name FROM subscription_list_index WHERE subscription_id = 'sub_one'")
      .get()?.["name"];

    await assert.rejects(runBackfill(client, backfillNow), /invalid or mixed/);
    assert.equal(client.db.prepare("SELECT name FROM subscription_list_index WHERE subscription_id = 'sub_one'")
      .get()?.["name"], staleName);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 0);
  } finally {
    client.db.close();
  }
});

test("a mixed stats schema without the released CHECK constraints is rejected", async () => {
  const client = openDerivedDatabase();
  try {
    client.db.exec(`
      DROP TABLE subscription_user_stats;
      CREATE TABLE subscription_user_stats (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        total_count INTEGER NOT NULL DEFAULT 0,
        trial_count INTEGER NOT NULL DEFAULT 0,
        active_count INTEGER NOT NULL DEFAULT 0,
        expired_count INTEGER NOT NULL DEFAULT 0,
        paused_count INTEGER NOT NULL DEFAULT 0,
        cancelled_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    await assert.rejects(runBackfill(client, backfillNow), /invalid or mixed/);
    assert.equal(markerCount(client.db, "subscription-derived-state-v3"), 0);
  } finally {
    client.db.close();
  }
});
