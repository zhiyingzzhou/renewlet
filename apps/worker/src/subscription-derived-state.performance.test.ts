import {
  buildSubscriptionPerformanceScenario,
  subscriptionPerformanceFixture,
  type SubscriptionPerformanceRecord,
} from "@renewlet/shared/contract-fixtures";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { BILLING_CYCLES } from "@renewlet/shared/runtime";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { subscriptionDerivedMutationPlan, type SubscriptionDerivedMutation } from "./subscription-derived-state";
import {
  boundedSubscriptionCollectionQueryPlan,
  listBoundedSubscriptionsForQuery,
  listSubscriptionsForQuery,
  subscriptionCollectionPageQueryPlan,
} from "./subscription-list-filters";
import type { Env, SubscriptionRow } from "./types";

class PerformanceD1Database {
  readonly prepared: PerformanceD1PreparedStatement[] = [];

  prepare(sql: string): D1PreparedStatement {
    const statement = new PerformanceD1PreparedStatement(sql);
    this.prepared.push(statement);
    return statement as unknown as D1PreparedStatement;
  }
}

class PerformanceD1PreparedStatement {
  params: unknown[] = [];

  constructor(readonly sql: string) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }
}

describe.each(subscriptionPerformanceFixture.scenarios)("Worker derived mutation budget: $size", (scenario) => {
  it("keeps create/update/delete/renew independent of the user's collection size", () => {
    const { initial, final } = buildSubscriptionPerformanceScenario(scenario.size);
    const database = new PerformanceD1Database();
    const env = {
      DB: database as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } satisfies Env;
    const mutations = performanceMutations(initial, final, scenario.size);
    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();

    for (const mutation of mutations) {
      database.prepared.length = 0;
      const plan = subscriptionDerivedMutationPlan(env, mutation, createDefaultAppSettings(), new Date("2026-08-17T00:00:00Z"));
      const statements = [...plan.beforeFact, ...plan.afterFact];
      const uniqueTagCount = mutation.after
        ? new Set(JSON.parse(mutation.after.tags_json).map((tag: string) => tag.trim().toLocaleLowerCase()).filter(Boolean)).size
        : 0;

      expect(statements.length).toBeLessThanOrEqual(scenario.operationBudget.derivedWriteBase + uniqueTagCount);
      expect(database.prepared.some(({ sql }) => /DELETE FROM subscription_(?:list_index|tags|repeat_schedule)\s+WHERE user_id = \?\s*$/m.test(sql))).toBe(false);
      const factReads = database.prepared.filter(({ sql }) => /FROM subscriptions\b/.test(sql));
      expect(factReads).toHaveLength(mutation.kind === "create" ? 0 : 1);
      expect(factReads.every(({ sql }) => /WHERE user_id = \? AND id = \?/.test(sql))).toBe(true);
      expect(database.prepared.some(({ sql }) => /status_counts_json|source_updated_at/.test(sql))).toBe(false);
    }

    // operation 数是 CI 硬门；共享 runner 的毫秒值和 RSS 只输出趋势。
    console.info(`[perf] worker n=${scenario.size} elapsed_ms=${(performance.now() - startedAt).toFixed(2)} rss_delta=${process.memoryUsage().rss - rssBefore}`);
  });
});

describe.each(subscriptionPerformanceFixture.scenarios)("Worker collection read budget: $size", (scenario) => {
  it("uses one private-page query, two bounded-index queries, and indexed fact lookups", async () => {
    const db = openSubscriptionReadDatabase();
    try {
      const { final } = buildSubscriptionPerformanceScenario(scenario.size);
      seedSubscriptionReadRows(db, final);
      const database = new SubscriptionReadD1Database(db);
      const env = {
        DB: database as unknown as D1Database,
        ASSETS: {} as Fetcher,
        ASSETS_BUCKET: {} as R2Bucket,
      } satisfies Env;

      for (let sample = 0; sample < 10; sample += 1) {
        database.readQueries = 0;
        database.reads.length = 0;
        const privatePage = await listSubscriptionsForQuery(env, "subscription-perf-owner", { limit: 50 }, "2026-08-17", null);
        expect(privatePage.total).toBe(scenario.expected.total);
        expect(privatePage.rows).toHaveLength(Math.min(51, scenario.expected.total));
        expect(database.readQueries).toBe(1);
        console.info(`[perf] worker_sqlite ${JSON.stringify({ size: scenario.size, sample, operation: "private-page", reads: database.reads })}`);

        database.readQueries = 0;
        database.reads.length = 0;
        const boundedPage = await listBoundedSubscriptionsForQuery(env, "subscription-perf-owner", {}, "2026-08-17", scenario.size);
        expect(boundedPage).toMatchObject({ total: scenario.expected.total, exceeded: false });
        expect(boundedPage.rows).toHaveLength(scenario.expected.total);
        expect(database.readQueries).toBe(scenario.operationBudget.listReadQueries);
        console.info(`[perf] worker_sqlite ${JSON.stringify({ size: scenario.size, sample, operation: "bounded-index", reads: database.reads })}`);
      }

      const queryPlanFilters = [
        {},
        { paymentType: "auto" as const },
        { paymentType: "manual" as const },
        { paymentType: "one-time-buyout" as const },
        { paymentType: "one-time-fixed-term" as const },
      ];
      for (const filters of queryPlanFilters) {
        const plan = subscriptionCollectionPageQueryPlan(
          "subscription-perf-owner",
          filters,
          "2026-08-17",
          scenario.size + 1,
        );
        const details = db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`)
          .all(...(plan.params as SQLInputValue[])) as Array<{ detail: string }>;
        const label = filters.paymentType ?? "default";
        console.info(`[perf] worker_sqlite_plan ${JSON.stringify({ size: scenario.size, paymentType: label, details })}`);
        expect(details.some(({ detail }) => /SEARCH idx\b/u.test(detail)), label).toBe(true);
        expect(details.some(({ detail }) => /SEARCH sub\b/u.test(detail)), label).toBe(true);
        expect(details.some(({ detail }) => /SCAN (?:idx|subscription_list_index)\b/u.test(detail)), label).toBe(false);
        expect(details.some(({ detail }) => /SCAN (?:sub|subscriptions)\b/u.test(detail)), label).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

describe("Worker collection SQL limits", () => {
  it("rejects 5001 rows after one projection read", async () => {
    const db = openSubscriptionReadDatabase();
    try {
      const { final } = buildSubscriptionPerformanceScenario(5_000);
      const first = final[0];
      if (!first) throw new Error("Missing 5000-row performance fixture");
      seedSubscriptionReadRows(db, [...final, { ...first, id: "sub_performance_overflow", index: 5_001 }]);
      const database = new SubscriptionReadD1Database(db);
      const env = {
        DB: database as unknown as D1Database,
        ASSETS: {} as Fetcher,
        ASSETS_BUCKET: {} as R2Bucket,
      } satisfies Env;

      const page = await listBoundedSubscriptionsForQuery(
        env,
        "subscription-perf-owner",
        {},
        "2026-08-17",
        5_000,
      );

      expect(page).toEqual({ rows: [], total: 5_001, exceeded: true });
      expect(database.readQueries).toBe(1);
    } finally {
      db.close();
    }
  });

  it("executes the maximum multi-select shape with fewer than 100 bindings", () => {
    const db = openSubscriptionReadDatabase();
    try {
      const filters = {
        category: Array.from({ length: 50 }, (_, index) => `category-${index}`),
        tag: Array.from({ length: 100 }, (_, index) => `tag-${index}`),
        billingCycle: [...BILLING_CYCLES],
        currency: Array.from({ length: 50 }, (_, index) => `C${String(index).padStart(2, "0")}`),
        paymentMethod: Array.from({ length: 200 }, (_, index) => `payment-${index}`),
        status: "active" as const,
        paymentType: "auto" as const,
        nextBillingFrom: "2026-01-01" as const,
        nextBillingTo: "2026-12-31" as const,
        pinned: true,
        publicHidden: false,
        reminderMode: "disabled" as const,
        repeatReminder: true,
        q: "search",
      };
      const page = subscriptionCollectionPageQueryPlan("subscription-perf-owner", filters, "2026-08-17", 51);
      const bounded = boundedSubscriptionCollectionQueryPlan("subscription-perf-owner", filters, "2026-08-17", 5_001);

      for (const plan of [page, bounded.preflight, bounded.facts]) {
        expect(plan.params.length).toBeLessThan(100);
        expect(() => db.prepare(plan.sql).all(...(plan.params as SQLInputValue[]))).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  it("matches Unicode-normalized tags while preserving exact display casing", () => {
    const db = openSubscriptionReadDatabase();
    try {
      const { final } = buildSubscriptionPerformanceScenario(10);
      const record = final[0];
      if (!record) throw new Error("Missing tag query fixture");
      seedSubscriptionReadRows(db, [record]);
      db.prepare(`INSERT INTO subscription_tags (user_id, subscription_id, tag_norm, tag)
        VALUES (?, ?, ?, ?)`).run("subscription-perf-owner", record.id, "äi", "ÄI");

      const exact = subscriptionCollectionPageQueryPlan(
        "subscription-perf-owner",
        { tag: ["ÄI"] },
        "2026-08-17",
        51,
      );
      const wrongCase = subscriptionCollectionPageQueryPlan(
        "subscription-perf-owner",
        { tag: ["äi"] },
        "2026-08-17",
        51,
      );

      expect(db.prepare(exact.sql).all(...(exact.params as SQLInputValue[])))
        .toEqual([expect.objectContaining({ id: record.id, collection_total: 1 })]);
      expect(db.prepare(wrongCase.sql).all(...(wrongCase.params as SQLInputValue[])))
        .toEqual([expect.objectContaining({ id: null, collection_total: 0 })]);
    } finally {
      db.close();
    }
  });
});

function performanceMutations(
  initial: SubscriptionPerformanceRecord[],
  final: SubscriptionPerformanceRecord[],
  size: number,
): SubscriptionDerivedMutation[] {
  const initialByIndex = new Map(initial.map((record) => [record.index, toSubscriptionRow(record)]));
  const finalByIndex = new Map(final.map((record) => [record.index, toSubscriptionRow(record)]));
  return [
    { kind: "update", before: requiredRow(initialByIndex, 1), after: requiredRow(finalByIndex, 1) },
    { kind: "update", before: requiredRow(initialByIndex, 2), after: requiredRow(finalByIndex, 2) },
    { kind: "delete", before: requiredRow(initialByIndex, 3), after: null },
    { kind: "create", before: null, after: requiredRow(finalByIndex, size) },
  ];
}

function requiredRow(rows: Map<number, SubscriptionRow>, index: number): SubscriptionRow {
  const row = rows.get(index);
  if (!row) throw new Error(`Missing performance row ${index}`);
  return row;
}

function toSubscriptionRow(
  record: SubscriptionPerformanceRecord,
): SubscriptionRow & { cost_sharing_json: string } {
  return {
    id: record.id,
    user_id: "subscription-perf-owner",
    name: record.name,
    logo: null,
    price: record.price,
    currency: record.currency,
    billing_cycle: record.billingCycle,
    custom_days: record.customDays,
    custom_cycle_unit: record.customCycleUnit,
    one_time_term_count: null,
    one_time_term_unit: null,
    category: record.category,
    status: record.status,
    pinned: Number(record.pinned),
    public_hidden: Number(record.publicHidden),
    payment_method: record.paymentMethod,
    start_date: record.startDate,
    next_billing_date: record.nextBillingDate,
    auto_renew: Number(record.autoRenew),
    auto_calculate_next_billing_date: Number(record.autoCalculateNextBillingDate),
    trial_end_date: record.trialEndDate,
    website: record.website,
    notes: record.notes,
    tags_json: JSON.stringify(record.tags),
    reminder_days: record.reminderDays,
    repeat_reminder_enabled: Number(record.repeatReminderEnabled),
    repeat_reminder_interval: record.repeatReminderInterval,
    repeat_reminder_window: record.repeatReminderWindow,
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function openSubscriptionReadDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
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
      reminder_days INTEGER NOT NULL,
      cost_sharing_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE subscription_list_index (
      subscription_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      search_text_lower TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT '',
      one_time_term_count INTEGER,
      next_billing_date TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      public_hidden INTEGER NOT NULL DEFAULT 0,
      trial_end_date TEXT,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      reminder_days INTEGER NOT NULL DEFAULT -1,
      repeat_reminder_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE subscription_tags (
      user_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      tag_norm TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id, tag_norm)
    );
    CREATE INDEX idx_subscription_list_index_user_pinned_order
      ON subscription_list_index (user_id, pinned DESC, created_at DESC, subscription_id DESC);
  `);
  return db;
}

function seedSubscriptionReadRows(db: DatabaseSync, records: SubscriptionPerformanceRecord[]): void {
  const insertFact = db.prepare(`INSERT INTO subscriptions (
    id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit,
    one_time_term_count, one_time_term_unit, category, status, pinned, public_hidden, payment_method,
    start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date, trial_end_date,
    reminder_days, cost_sharing_json, created_at
  ) VALUES (${Array.from({ length: 24 }, () => "?").join(", ")})`);
  const insertIndex = db.prepare(`INSERT INTO subscription_list_index (
    subscription_id, user_id, status, billing_cycle, one_time_term_count, next_billing_date, pinned, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    for (const record of records) {
      const row = toSubscriptionRow(record);
      insertFact.run(
        row.id, row.user_id, row.name, row.logo, row.price, row.currency, row.billing_cycle,
        row.custom_days, row.custom_cycle_unit, row.one_time_term_count, row.one_time_term_unit,
        row.category, row.status, row.pinned, row.public_hidden, row.payment_method, row.start_date,
        row.next_billing_date, row.auto_renew, row.auto_calculate_next_billing_date, row.trial_end_date,
        row.reminder_days, row.cost_sharing_json, row.created_at,
      );
      insertIndex.run(
        row.id, row.user_id, row.status, row.billing_cycle, row.one_time_term_count,
        row.next_billing_date, row.pinned, row.created_at,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

class SubscriptionReadD1Database {
  readQueries = 0;
  // node:sqlite 只能给本地执行/返回量，不能把返回行数伪造成真实 D1 rows_read 或 SQL duration 元数据。
  readonly reads: { elapsedMs: number; returnedRows: number; resultBytes: number }[] = [];

  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    return new SubscriptionReadD1PreparedStatement(this, this.db, sql) as unknown as D1PreparedStatement;
  }
}

class SubscriptionReadD1PreparedStatement {
  private params: SQLInputValue[] = [];

  constructor(
    private readonly owner: SubscriptionReadD1Database,
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    this.owner.readQueries += 1;
    const startedAt = performance.now();
    const result = (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
    this.owner.reads.push({ elapsedMs: performance.now() - startedAt, returnedRows: result === null ? 0 : 1, resultBytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  }

  async all<T>(): Promise<D1Result<T>> {
    this.owner.readQueries += 1;
    const startedAt = performance.now();
    const results = this.db.prepare(this.sql).all(...this.params) as T[];
    this.owner.reads.push({ elapsedMs: performance.now() - startedAt, returnedRows: results.length, resultBytes: Buffer.byteLength(JSON.stringify(results)) });
    return { results, success: true, meta: {} } as D1Result<T>;
  }
}
