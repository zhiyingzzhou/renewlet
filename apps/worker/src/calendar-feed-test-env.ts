import type { LocalePreference } from "@renewlet/shared/i18n-config";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { sha256 } from "./crypto";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "./http";
import type { CalendarFeedRow, Env, SessionAuthRow, SubscriptionRow, UserRow } from "./types";

const SESSION_TOKEN = "session-token";
const CSRF_TOKEN = "csrf-token";
export const CALENDAR_FEED_TEST_USER_ID = "usr_calendar";

export type CalendarFeedTestEnv = Env & {
  __state: CalendarFeedTestState;
};

export interface CalendarFeedTestState {
  calendarFeedMutationError: Error | null;
  calendarFeedSchemaError: Error | null;
  calendarFeedScopedSchema: boolean;
  calendarFeedsTableExists: boolean;
  feeds: CalendarFeedRow[];
  legacyFeeds: CalendarFeedRow[];
  listQueryCount: number;
  sessionHash: string;
  csrfHash: string;
  customConfigJson: string | null;
  settingsJson: string;
  subscriptions: SubscriptionRow[];
  user: UserRow;
}

export interface CalendarFeedTestOptions {
  calendarFeedMutationError?: Error | null;
  calendarFeedSchemaError?: Error | null;
  calendarFeedScopedSchema?: boolean;
  calendarFeedsTableExists?: boolean;
  customConfigJson?: string | null;
  feeds?: CalendarFeedRow[];
  localePreference?: LocalePreference;
  subscriptions?: SubscriptionRow[];
}

export async function createCalendarFeedTestEnv(options: CalendarFeedTestOptions = {}): Promise<CalendarFeedTestEnv> {
  const settings = {
    ...createDefaultAppSettings(),
    localePreference: options.localePreference ?? "en-US" as const,
    timezone: "UTC",
    notificationReminderDays: 5,
  };
  // 这份状态同时模拟正常表、旧 hash-only 表和缺表，用来锁住 Worker 的自修复与 migration-required 分支。
  const state: CalendarFeedTestState = {
    sessionHash: await sha256(SESSION_TOKEN),
    csrfHash: await sha256(CSRF_TOKEN),
    user: {
      id: CALENDAR_FEED_TEST_USER_ID,
      email: "calendar@example.com",
      name: "Calendar User",
      role: "user",
      banned: 0,
      ban_reason: "",
      password_hash: "hash",
      reset_token_hash: null,
      reset_token_expires_at: null,
      created_at: "2026-05-29T00:00:00.000Z",
      updated_at: "2026-05-29T00:00:00.000Z",
    },
    calendarFeedMutationError: options.calendarFeedMutationError ?? null,
    calendarFeedSchemaError: options.calendarFeedSchemaError ?? null,
    calendarFeedScopedSchema: options.calendarFeedScopedSchema ?? true,
    calendarFeedsTableExists: options.calendarFeedsTableExists ?? true,
    feeds: options.feeds ?? [],
    legacyFeeds: [],
    listQueryCount: 0,
    customConfigJson: Object.hasOwn(options, "customConfigJson")
      ? options.customConfigJson ?? null
      : JSON.stringify(createCalendarFeedTestCustomConfig()),
    settingsJson: JSON.stringify(settings),
    subscriptions: options.subscriptions ?? [
      subscriptionRow("sub_active", "Active Plan", "active", "monthly", "2099-06-02"),
      subscriptionRow("sub_paused", "Paused Plan", "paused", "monthly", "2099-06-03"),
      subscriptionRow("sub_cancelled", "Cancelled Plan", "cancelled", "monthly", "2099-06-03"),
      subscriptionRow("sub_expired", "Expired Plan", "expired", "monthly", "2099-06-03"),
      subscriptionRow("sub_once", "One Time Plan", "active", "one-time", "2099-06-04"),
      subscriptionRow("sub_fixed_term", "Fixed Term Plan", "active", "one-time", "2099-06-05", {
        one_time_term_count: 6,
        one_time_term_unit: "month",
      }),
      subscriptionRow("sub_quiet", "Quiet Plan", "active", "monthly", "2099-06-06", {
        reminder_days: -2,
      }),
    ],
  };
  return {
    DB: new CalendarFeedTestDB(state) as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
    __state: state,
  };
}

export function authorizedCalendarFeedRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}; ${CSRF_COOKIE_NAME}=${CSRF_TOKEN}`);
  if (!["GET", "HEAD", "OPTIONS"].includes((init.method ?? "GET").toUpperCase())) {
    headers.set(CSRF_HEADER_NAME, CSRF_TOKEN);
    if (!headers.has("origin")) headers.set("origin", new URL(url).origin);
  }
  return new Request(url, { ...init, headers });
}

export function subscriptionRow(
  id: string,
  name: string,
  status: string,
  billingCycle: string,
  nextBillingDate: string,
  overrides: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  return {
    id,
    user_id: CALENDAR_FEED_TEST_USER_ID,
    name,
    logo: null,
    price: "12.5",
    balance: null,
    balance_currency: null,
    currency: "USD",
    billing_cycle: billingCycle,
    custom_days: null,
    custom_cycle_unit: null,
    one_time_term_count: null,
    one_time_term_unit: null,
    category: "developer_tools",
    status,
    pinned: 0,
    public_hidden: 0,
    payment_method: "credit_card",
    start_date: "2099-01-01",
    next_billing_date: nextBillingDate,
    auto_renew: billingCycle === "one-time" ? 0 : 1,
    auto_calculate_next_billing_date: 1,
    trial_end_date: null,
    website: "https://example.com",
    notes: "Team plan",
    tags_json: "[]",
    reminder_days: -1,
    repeat_reminder_enabled: 0,
    repeat_reminder_interval: "24h",
    repeat_reminder_window: "24h",
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    created_at: `2026-05-29T00:00:0${id.endsWith("active") ? 1 : 2}.000Z`,
    updated_at: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

export function createCalendarFeedTestCustomConfig() {
  return {
    categories: [{
      id: "developer_tools",
      value: "developer_tools",
      labels: { "zh-CN": "开发工具", "en-US": "Developer Tools" },
      color: "hsl(265 68% 58%)",
    }],
    statuses: [],
    paymentMethods: [{
      id: "credit_card",
      value: "credit_card",
      labels: { "zh-CN": "信用卡", "en-US": "Credit Card" },
    }],
    currencies: [],
  };
}

export function calendarFeedRow(overrides: Partial<CalendarFeedRow> = {}): CalendarFeedRow {
  return {
    id: "cal_existing",
    user_id: CALENDAR_FEED_TEST_USER_ID,
    scope: "all",
    subscription_id: null,
    token: "feed-token",
    created_at: "2026-05-29T00:00:00.000Z",
    updated_at: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

class CalendarFeedTestDB {
  // 公开 ICS 只靠 token 读取，登录态管理 route 才查 session；fake D1 保持两个入口的权限边界。
  constructor(private readonly state: CalendarFeedTestState) {}

  prepare(sql: string) {
    return new CalendarFeedTestStatement(this.state, sql);
  }
}

class CalendarFeedTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: CalendarFeedTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM sessions JOIN users")) {
      if (this.values[0] !== this.state.sessionHash) return null;
      const row = {
        session_id: "ses_calendar",
        session_token_hash: this.state.sessionHash,
        session_csrf_token_hash: this.state.csrfHash,
        session_user_id: CALENDAR_FEED_TEST_USER_ID,
        session_expires_at: "2099-01-01T00:00:00.000Z",
        session_created_at: "2026-05-29T00:00:00.000Z",
        session_last_seen_at: "2026-05-29T00:00:00.000Z",
        ...this.state.user,
      } satisfies SessionAuthRow;
      return row as T;
    }
    if (this.sql.includes("UPDATE calendar_feeds") && this.sql.includes("RETURNING")) {
      this.assertCalendarFeedTableReadable();
      if (this.state.calendarFeedMutationError) throw this.state.calendarFeedMutationError;
      const [token, updatedAt, id, userId] = this.values as [string, string, string, string];
      const row = this.state.feeds.find((feed) => feed.id === id && feed.user_id === userId);
      if (!row) return null;
      row.token = token;
      row.updated_at = updatedAt;
      return { ...row } as T;
    }
    if (this.sql.includes("DELETE FROM calendar_feeds") && this.sql.includes("RETURNING")) {
      this.assertCalendarFeedTableReadable();
      const row = this.sql.includes("scope = 'all'")
        ? this.state.feeds.find((feed) => feed.user_id === this.values[0] && feed.scope === "all")
        : this.state.feeds.find((feed) => feed.user_id === this.values[0]
          && feed.scope === "subscription" && feed.subscription_id === this.values[1]);
      if (!row) return null;
      this.state.feeds = this.state.feeds.filter((feed) => feed.id !== row.id);
      return { id: row.id } as T;
    }
    if (this.sql.includes("FROM calendar_feeds")) {
      this.assertCalendarFeedTableReadable();
      if (this.sql.includes("WHERE token =")) {
        return this.state.feeds.find((feed) => feed.token === this.values[0]) as T | undefined ?? null;
      }
      if (this.sql.includes("scope = 'all'")) {
        return this.state.feeds.find((feed) => feed.user_id === this.values[0] && feed.scope === "all") as T | undefined ?? null;
      }
      if (this.sql.includes("scope = 'subscription'")) {
        return this.state.feeds.find((feed) => feed.user_id === this.values[0]
          && feed.scope === "subscription" && feed.subscription_id === this.values[1]) as T | undefined ?? null;
      }
    }
    if (this.sql.includes("SELECT settings_json FROM settings")) return { settings_json: this.state.settingsJson } as T;
    if (this.sql.includes("SELECT config_json FROM custom_configs")) {
      return this.state.customConfigJson === null ? null : { config_json: this.state.customConfigJson } as T;
    }
    if (this.sql.includes("FROM subscriptions WHERE user_id = ? AND id = ?")) {
      return this.state.subscriptions.find((row) => row.user_id === this.values[0] && row.id === this.values[1]) as T | undefined ?? null;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("PRAGMA table_info(calendar_feeds)")) {
      if (!this.state.calendarFeedsTableExists) return d1Result([]);
      const names = this.state.calendarFeedScopedSchema
        ? ["id", "user_id", "scope", "subscription_id", "token", "created_at", "updated_at"]
        : ["user_id", "token_hash", "created_at", "updated_at"];
      return d1Result(names.map((name) => ({ name })) as T[]);
    }
    if (this.sql.includes("WITH owned AS")) {
      this.assertCalendarFeedTableReadable();
      this.state.listQueryCount += 1;
      const [userId, limit, offset] = this.values as [string, number, number];
      const owned = this.state.feeds
        .filter((feed) => feed.user_id === userId && feed.scope === "subscription")
        .map((feed) => ({
          feed,
          subscription: this.state.subscriptions.find((subscription) => subscription.id === feed.subscription_id
            && subscription.user_id === feed.user_id),
        }))
        .filter(({ subscription }) => subscription !== undefined)
        .sort((left, right) => right.feed.updated_at.localeCompare(left.feed.updated_at)
          || right.feed.id.localeCompare(left.feed.id));
      const page = owned.slice(offset, offset + limit).map(({ feed, subscription }) => ({
        ...feed,
        subscription_name: subscription?.name ?? null,
        subscription_status: subscription?.status ?? null,
        subscription_next_billing_date: subscription?.next_billing_date ?? null,
        total: owned.length,
      }));
      return d1Result((page.length > 0 ? page : [{
        id: "",
        user_id: "",
        subscription_id: null,
        token: "",
        created_at: "",
        updated_at: "",
        subscription_name: null,
        subscription_status: null,
        subscription_next_billing_date: null,
        total: owned.length,
      }]) as T[]);
    }
    if (this.sql.includes("FROM subscriptions")) return d1Result(this.state.subscriptions as T[]);
    return d1Result([]);
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("CREATE TABLE IF NOT EXISTS calendar_feeds")) {
      this.assertCalendarFeedSchemaWritable();
      this.state.calendarFeedsTableExists = true;
      this.state.calendarFeedScopedSchema = true;
      return d1Result([]);
    }
    if (this.sql.includes("ALTER TABLE calendar_feeds RENAME TO calendar_feeds_legacy")) {
      this.assertCalendarFeedSchemaWritable();
      this.assertCalendarFeedTableExists();
      this.state.legacyFeeds = [...this.state.feeds];
      this.state.feeds = [];
      this.state.calendarFeedsTableExists = false;
      return d1Result([]);
    }
    if (this.sql.includes("DROP TABLE calendar_feeds_legacy")) {
      this.state.legacyFeeds = [];
      return d1Result([]);
    }
    if (this.sql.includes("CREATE") && this.sql.includes("INDEX IF NOT EXISTS idx_calendar_feeds_")) {
      this.assertCalendarFeedSchemaWritable();
      this.assertCalendarFeedTableReadable();
      return d1Result([]);
    }
    if (this.sql.includes("INSERT INTO calendar_feeds")) {
      this.assertCalendarFeedTableReadable();
      const [id, userId, scope, subscriptionId, token, createdAt, updatedAt] = this.values as [
        string, string, CalendarFeedRow["scope"], string | null, string, string, string,
      ];
      this.state.feeds.push({
        id, user_id: userId, scope, subscription_id: subscriptionId, token, created_at: createdAt, updated_at: updatedAt,
      });
    }
    return d1Result([]);
  }

  private assertCalendarFeedSchemaWritable() {
    if (this.state.calendarFeedSchemaError) throw this.state.calendarFeedSchemaError;
  }

  private assertCalendarFeedTableExists() {
    if (!this.state.calendarFeedsTableExists) throw new Error("D1_ERROR: no such table: calendar_feeds: SQLITE_ERROR");
  }

  private assertCalendarFeedTableReadable() {
    this.assertCalendarFeedTableExists();
    if (!this.state.calendarFeedScopedSchema) throw new Error("D1_ERROR: no such column: scope: SQLITE_ERROR");
  }
}

function d1Result<T = unknown>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} } as D1Result<T>;
}
