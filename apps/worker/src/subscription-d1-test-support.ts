import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { subscriptionRowValues } from "./db";
import type { Env, SubscriptionRow } from "./types";
export const USER_ID = "usr_derived_transaction";
export const NOW = new Date("2026-08-17T00:00:00.000Z");

export function openDerivedStateDatabase(): { db: DatabaseSync; env: Env } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE settings (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
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
      pinned INTEGER NOT NULL,
      public_hidden INTEGER NOT NULL,
      payment_method TEXT,
      start_date TEXT,
      next_billing_date TEXT NOT NULL,
      auto_renew INTEGER NOT NULL,
      auto_calculate_next_billing_date INTEGER NOT NULL,
      trial_end_date TEXT,
      website TEXT,
      notes TEXT,
      tags_json TEXT NOT NULL,
      reminder_days INTEGER NOT NULL,
      repeat_reminder_enabled INTEGER NOT NULL,
      repeat_reminder_interval TEXT NOT NULL,
      repeat_reminder_window TEXT NOT NULL,
      cost_sharing_json TEXT NOT NULL,
      cost_sharing_collection_reminder_enabled INTEGER NOT NULL,
      cost_sharing_next_collection_reminder_date TEXT,
      extra_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_subscriptions_user_public_hidden_order ON subscriptions(user_id, public_hidden, created_at DESC, id DESC);
    CREATE TABLE subscription_list_index (
      subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      website TEXT,
      notes TEXT,
      search_text_lower TEXT NOT NULL,
      category TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      currency TEXT NOT NULL,
      payment_method TEXT,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      public_hidden INTEGER NOT NULL,
      next_billing_date TEXT NOT NULL,
      trial_end_date TEXT,
      one_time_term_count INTEGER,
      auto_renew INTEGER NOT NULL,
      reminder_days INTEGER NOT NULL,
      repeat_reminder_enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_tags (
      user_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      tag_norm TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id, tag_norm)
    );
    CREATE TABLE subscription_user_stats (
      user_id TEXT PRIMARY KEY,
      total_count INTEGER NOT NULL,
      trial_count INTEGER NOT NULL,
      active_count INTEGER NOT NULL,
      expired_count INTEGER NOT NULL,
      paused_count INTEGER NOT NULL,
      cancelled_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (total_count >= 0 AND trial_count >= 0 AND active_count >= 0 AND expired_count >= 0 AND paused_count >= 0 AND cancelled_count >= 0),
      CHECK (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)
    );
    CREATE TABLE subscription_repeat_schedule (
      user_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      next_due_at_utc TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id)
    );
    CREATE TABLE subscription_scheduler_state (
      user_id TEXT PRIMARY KEY,
      auto_renew_count INTEGER NOT NULL,
      repeat_reminder_count INTEGER NOT NULL,
      last_auto_renew_local_date TEXT NOT NULL,
      next_auto_renew_check_at_utc TEXT,
      next_daily_notification_due_at_utc TEXT,
      next_repeat_notification_due_at_utc TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO users (id) VALUES ('${USER_ID}');
    INSERT INTO subscription_user_stats (
      user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
    ) VALUES ('${USER_ID}', 0, 0, 0, 0, 0, 0, '${NOW.toISOString()}', '${NOW.toISOString()}');
    INSERT INTO subscription_scheduler_state (
      user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
      next_auto_renew_check_at_utc, next_daily_notification_due_at_utc, next_repeat_notification_due_at_utc,
      created_at, updated_at
    ) VALUES ('${USER_ID}', 0, 0, '', NULL, NULL, NULL, '${NOW.toISOString()}', '${NOW.toISOString()}');
  `);
  db.prepare("INSERT INTO settings (user_id, settings_json) VALUES (?, ?)")
    .run(USER_ID, JSON.stringify(createDefaultAppSettings()));
  const database = new TransactionalD1Database(db);
  return {
    db,
    env: {
      DB: database as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    },
  };
}

export function subscriptionRow(id: string, overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id,
    user_id: USER_ID,
    name: `Subscription ${id}`,
    logo: null,
    price: "10",
    currency: "USD",
    billing_cycle: "monthly",
    custom_days: null,
    custom_cycle_unit: null,
    one_time_term_count: null,
    one_time_term_unit: null,
    category: "productivity",
    status: "active",
    pinned: 0,
    public_hidden: 0,
    payment_method: null,
    start_date: "2026-01-15",
    next_billing_date: "2026-09-15",
    auto_renew: 0,
    auto_calculate_next_billing_date: 1,
    trial_end_date: null,
    website: null,
    notes: null,
    tags_json: JSON.stringify(["Team"]),
    reminder_days: 3,
    repeat_reminder_enabled: 0,
    repeat_reminder_interval: "1h",
    repeat_reminder_window: "72h",
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

export function insertSubscriptionStatement(env: Env, row: SubscriptionRow): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO subscriptions (
      id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
      category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
      trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
      cost_sharing_json, cost_sharing_collection_reminder_enabled, cost_sharing_next_collection_reminder_date, extra_json, created_at, updated_at
    ) VALUES (${subscriptionRowValues(row).map(() => "?").join(", ")})
  `).bind(...subscriptionRowValues(row));
}

export function readDerivedSnapshot(db: DatabaseSync): unknown {
  return JSON.parse(JSON.stringify({
    projection: db.prepare(`SELECT subscription_id, user_id, search_text_lower, status, auto_renew, repeat_reminder_enabled
      FROM subscription_list_index ORDER BY subscription_id`).all(),
    tags: db.prepare(`SELECT user_id, subscription_id, tag_norm, tag
      FROM subscription_tags ORDER BY subscription_id, tag_norm`).all(),
    stats: db.prepare(`SELECT user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count
      FROM subscription_user_stats ORDER BY user_id`).all(),
    repeats: db.prepare(`SELECT user_id, subscription_id, next_due_at_utc
      FROM subscription_repeat_schedule ORDER BY user_id, subscription_id`).all(),
    scheduler: db.prepare(`SELECT user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
      next_auto_renew_check_at_utc, next_daily_notification_due_at_utc, next_repeat_notification_due_at_utc
      FROM subscription_scheduler_state ORDER BY user_id`).all(),
  }));
}

export function readCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.["count"] ?? 0);
}

class TransactionalD1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): TransactionalD1PreparedStatement {
    return new TransactionalD1PreparedStatement(this.db, sql);
  }

  async batch(statements: TransactionalD1PreparedStatement[]): Promise<D1Result[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class TransactionalD1PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    // Node SQLite 的变量上限高于线上 D1；测试必须主动施加 D1 的 100 参数限制。
    if (values.length > 100) throw new Error("D1 bound parameter limit exceeded");
    this.values = values as SQLInputValue[];
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      results: this.db.prepare(this.sql).all(...this.values) as T[],
      success: true,
      meta: d1Meta(),
    };
  }

  async first<T>(): Promise<T | null> {
    return this.db.prepare(this.sql).get(...this.values) as T | undefined ?? null;
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  runSync(): D1Result {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: d1Meta(Number(result.changes)) };
  }
}

function d1Meta(changes = 0): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: 0,
    changed_db: changes > 0,
    changes,
  };
}
