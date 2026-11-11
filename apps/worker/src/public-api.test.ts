// Worker Public API 测试保护只读 bearer token 底座，避免 Telegram/CLI 等 adapter 以后绕过同一服务边界。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import {
  apiTokenCreatePayloadSchema,
  publicApiDuePayloadSchema,
  publicApiMePayloadSchema,
  publicApiStatusPayloadSchema,
  publicApiSubscriptionPayloadSchema,
  publicApiSubscriptionsListPayloadSchema,
} from "@renewlet/shared/schemas/public-api";
import { describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { countSubscriptionStatuses } from "./subscription-derived-state";
import { dateOnlyInZone } from "./subscription-renewal";
import { sha256 } from "./crypto";
import {
  createApiToken,
  deleteApiToken,
  listApiTokens,
  publicApiDue,
  publicApiMe,
  publicApiStatus,
  publicApiSubscription,
  publicApiSubscriptions,
} from "./public-api";
import type { ApiTokenRow, Env, SubscriptionRow } from "./types";

const USER_ID = "usr_public_api";
const OTHER_USER_ID = "usr_public_api_other";
const TOKEN_BODY = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12";
const PLAIN_TOKEN = `rlt_${TOKEN_BODY}`;

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crypto")>();
  return {
    ...actual,
    randomToken: vi.fn(() => TOKEN_BODY),
  };
});

type PublicApiTestState = {
  users: Array<{ id: string; banned: number }>;
  apiTokens: ApiTokenRow[];
  apiTokenLastUsedUpdates: number;
  subscriptions: SubscriptionRow[];
  settingsJson: string | null;
};

function d1Result<T = unknown>(results: T[], changes = 0): D1Result<T> {
  return { results, success: true, meta: { changes } as D1Meta } as D1Result<T>;
}

function createEnv(overrides: Partial<PublicApiTestState> = {}): Env & { __state: PublicApiTestState } {
  const settings = { ...createDefaultAppSettings(), localePreference: "en-US" as const, timezone: "UTC" };
  const state: PublicApiTestState = {
    users: [
      { id: USER_ID, banned: 0 },
      { id: OTHER_USER_ID, banned: 0 },
    ],
    apiTokens: [],
    apiTokenLastUsedUpdates: 0,
    subscriptions: [],
    settingsJson: JSON.stringify(settings),
    ...overrides,
  };
  return {
    __state: state,
    DB: new PublicApiTestDB(state) as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  } as Env & { __state: PublicApiTestState };
}

class PublicApiTestDB {
  constructor(private readonly state: PublicApiTestState) {}

  prepare(sql: string) {
    return new PublicApiTestStatement(this.state, sql);
  }
}

class PublicApiTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: PublicApiTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM api_tokens") && this.sql.includes("JOIN users")) {
      const tokenHash = String(this.values[0] ?? "");
      const token = this.state.apiTokens.find((item) => item.token_hash === tokenHash);
      const user = token ? this.state.users.find((item) => item.id === token.user_id) : null;
      return token && user ? { ...token, banned: user.banned } as T : null;
    }
    if (this.sql.includes("FROM subscriptions") && this.sql.includes("WHERE user_id = ? AND id = ?")) {
      const [userId, id] = this.values as [string, string];
      return this.state.subscriptions.find((row) => row.user_id === userId && row.id === id) as T | undefined ?? null;
    }
    if (this.sql.includes("FROM subscription_user_stats")) {
      const userId = String(this.values[0]);
      const rows = this.state.subscriptions.filter((row) => row.user_id === userId);
      const statusCounts = countSubscriptionStatuses(rows);
      return {
        user_id: userId,
        total_count: rows.length,
        trial_count: statusCounts.trial,
        active_count: statusCounts.active,
        expired_count: statusCounts.expired,
        paused_count: statusCounts.paused,
        cancelled_count: statusCounts.cancelled,
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      } as T;
    }
    if (this.sql.includes("SELECT settings_json FROM settings")) {
      return this.state.settingsJson === null ? null : { settings_json: this.state.settingsJson } as T;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("FROM api_tokens") && this.sql.includes("WHERE user_id = ?")) {
      const userId = String(this.values[0]);
      const rows = this.state.apiTokens
        .filter((row) => row.user_id === userId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
      return d1Result(rows as T[]);
    }
    if (this.sql.includes("FROM subscriptions") && this.sql.includes("next_billing_date >= ?")) {
      const [userId, today, through] = this.values as [string, string, string, string, string];
      const rows = this.state.subscriptions
        .filter((row) => row.user_id === userId)
        .filter((row) => (
          (row.next_billing_date >= today && row.next_billing_date <= through)
          || (row.trial_end_date !== null && row.trial_end_date >= today && row.trial_end_date <= through)
        ))
        .sort((left, right) => (
          left.next_billing_date.localeCompare(right.next_billing_date)
          || (left.trial_end_date ?? "").localeCompare(right.trial_end_date ?? "")
          || right.created_at.localeCompare(left.created_at)
          || right.id.localeCompare(left.id)
        ));
      return d1Result(rows as T[]);
    }
    if (this.sql.includes("FROM subscriptions") && this.sql.includes("WHERE user_id = ?")) {
      const userId = String(this.values[0]);
      const limit = Number(this.values[this.values.length - 1] ?? 50);
      let rows = this.state.subscriptions
        .filter((row) => row.user_id === userId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
      if (this.sql.includes("created_at <")) {
        const [, createdAt, , id] = this.values as [string, string, string, string, number];
        rows = rows.filter((row) => row.created_at < createdAt || (row.created_at === createdAt && row.id < id));
      }
      return d1Result(rows.slice(0, limit) as T[]);
    }
    return d1Result([]);
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO api_tokens")) {
      const [id, userId, name, tokenHash, tokenPrefix, scopesJson, createdAt, updatedAt] = this.values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      this.state.apiTokens.push({
        id,
        user_id: userId,
        name,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        scopes_json: scopesJson,
        last_used_at: null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return d1Result([], 1);
    }
    if (this.sql.includes("DELETE FROM api_tokens")) {
      const [userId, id] = this.values as [string, string];
      const before = this.state.apiTokens.length;
      this.state.apiTokens = this.state.apiTokens.filter((row) => row.user_id !== userId || row.id !== id);
      return d1Result([], before - this.state.apiTokens.length);
    }
    if (this.sql.includes("SET last_used_at = ?")) {
      const [lastUsedAt, updatedAt, id] = this.values as [string, string, string];
      const token = this.state.apiTokens.find((row) => row.id === id);
      if (!token) return d1Result([], 0);
      this.state.apiTokenLastUsedUpdates += 1;
      token.last_used_at = lastUsedAt;
      token.updated_at = updatedAt;
      return d1Result([], 1);
    }
    return d1Result([]);
  }
}

function authorizedRequest(path: string, init: RequestInit = {}): Request {
  const method = init.method ?? "GET";
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  return new Request(`https://renewlet.test${path}`, {
    ...init,
    method,
    headers: {
      cookie: "renewlet_session=session-token; renewlet_csrf=csrf-token",
      "content-type": "application/json",
      "x-renewlet-locale": "en-US",
      ...(unsafe ? { origin: "https://renewlet.test", "x-renewlet-csrf": "csrf-token" } : {}),
      ...init.headers,
    },
  });
}

function publicRequest(path: string, token: string | null = PLAIN_TOKEN): Request {
  return new Request(`https://renewlet.test${path}`, {
    headers: {
      "accept-language": "en-US",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function addDateOnlyDays(value: string, days: number): string {
  const [yearText, monthText, dayText] = value.split("-");
  return new Date(Date.UTC(
    Number.parseInt(yearText ?? "", 10),
    Number.parseInt(monthText ?? "", 10) - 1,
    Number.parseInt(dayText ?? "", 10) + days,
  )).toISOString().slice(0, 10);
}

function subscriptionRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_public_api",
    user_id: USER_ID,
    name: "Public API Plan",
    logo: null,
    price: "12",
    balance: null,
    balance_currency: null,
    currency: "USD",
    billing_cycle: "monthly",
    custom_days: null,
    custom_cycle_unit: null,
    one_time_term_count: null,
    one_time_term_unit: null,
    category: "developer_tools",
    status: "active",
    pinned: 0,
    public_hidden: 0,
    payment_method: "credit_card",
    start_date: "2026-01-01",
    next_billing_date: "2026-02-01",
    auto_renew: 1,
    auto_calculate_next_billing_date: 1,
    trial_end_date: null,
    website: "https://billing.example.test",
    notes: "private owner note",
    tags_json: JSON.stringify(["api"]),
    reminder_days: 3,
    repeat_reminder_enabled: 0,
    repeat_reminder_interval: "1h",
    repeat_reminder_window: "72h",
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("Cloudflare Public API", () => {
  it("declares the D1 api_tokens table as hash-only read scope storage", () => {
    const migration = readFileSync(resolve("migrations/0020_api_tokens.sql"), "utf8");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS api_tokens");
    expect(migration).toContain("token_hash TEXT NOT NULL UNIQUE");
    expect(migration).toContain("token_prefix TEXT NOT NULL");
    expect(migration).toContain("scopes_json TEXT NOT NULL DEFAULT '[\"read\"]' CHECK");
    expect(migration).not.toContain("revoked_at");
    expect(migration).not.toContain("idx_api_tokens_user_revoked");
    expect(migration).not.toContain("plain_token");
  });

  it("creates, lists, authenticates and deletes read-only API tokens", async () => {
    const today = dateOnlyInZone(new Date(), "UTC");
    const env = createEnv({
      subscriptions: [
        subscriptionRow({
          id: "sub_renewal",
          balance: "0",
          balance_currency: "EUR",
          name: "Renewal Plan",
          status: "active",
          start_date: null,
          next_billing_date: addDateOnlyDays(today, 10),
          auto_calculate_next_billing_date: 0,
          created_at: "2026-06-20T00:00:03.000Z",
        }),
        subscriptionRow({
          id: "sub_trial",
          name: "Trial Plan",
          status: "trial",
          trial_end_date: addDateOnlyDays(today, 5),
          next_billing_date: addDateOnlyDays(today, 40),
          created_at: "2026-06-20T00:00:02.000Z",
        }),
        subscriptionRow({
          id: "sub_expiry",
          name: "Fixed Term Plan",
          billing_cycle: "one-time",
          one_time_term_count: 6,
          one_time_term_unit: "month",
          next_billing_date: addDateOnlyDays(today, 8),
          created_at: "2026-06-20T00:00:01.000Z",
        }),
        subscriptionRow({
          id: "sub_other",
          user_id: OTHER_USER_ID,
          name: "Foreign Plan",
          next_billing_date: addDateOnlyDays(today, 10),
          created_at: "2026-06-20T00:00:04.000Z",
        }),
      ],
    });
    authMocks.requireAuth.mockResolvedValue({ user: { id: USER_ID }, session: { id: "ses" } });

    await expect(createApiToken(authorizedRequest("/api/app/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Telegram", plainToken: "leak" }),
    }), env)).rejects.toMatchObject({ status: 400 });

    const createResponse = await createApiToken(authorizedRequest("/api/app/api-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Telegram Bot" }),
    }), env);
    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get("cache-control")).toBe("no-store");
    const created = apiTokenCreatePayloadSchema.parse(await readSuccessData<unknown>(createResponse));
    expect(created.plainToken).toBe(PLAIN_TOKEN);
    expect(created.token.tokenPrefix).toBe(PLAIN_TOKEN.slice(0, 12));
    expect(env.__state.apiTokens).toHaveLength(1);
    expect(env.__state.apiTokens[0]?.token_hash).toBe(await sha256(PLAIN_TOKEN));
    expect(env.__state.apiTokens[0]?.token_hash).not.toBe(PLAIN_TOKEN);

    const listResponse = await listApiTokens(authorizedRequest("/api/app/api-tokens"), env);
    const listText = await listResponse.text();
    expect(listText).toContain(PLAIN_TOKEN.slice(0, 12));
    expect(listText).not.toContain(PLAIN_TOKEN);
    expect(listText).not.toContain(env.__state.apiTokens[0]?.token_hash);

    await expect(publicApiMe(publicRequest(`/api/public/v1/me?api_token=${PLAIN_TOKEN}`, null), env))
      .rejects.toMatchObject({ status: 401 });
    await expect(publicApiMe(publicRequest("/api/public/v1/me", "session-token"), env))
      .rejects.toMatchObject({ status: 401 });

    const meResponse = await publicApiMe(publicRequest("/api/public/v1/me"), env);
    expect(meResponse.status).toBe(200);
    expect(meResponse.headers.get("cache-control")).toBe("no-store");
    expect(env.__state.apiTokens[0]?.last_used_at).toBeTruthy();
    expect(publicApiMePayloadSchema.parse(await readSuccessData<unknown>(meResponse))).toEqual({ scopes: ["read"] });

    const subscriptionsResponse = await publicApiSubscriptions(publicRequest("/api/public/v1/subscriptions?limit=1"), env);
    const subscriptionsBody = publicApiSubscriptionsListPayloadSchema.parse(await readSuccessData<unknown>(subscriptionsResponse));
    expect(subscriptionsBody.total).toBe(3);
    expect(subscriptionsBody.subscriptions).toHaveLength(1);
    expect(subscriptionsBody.nextCursor).toEqual(expect.any(String));
    expect(subscriptionsBody.subscriptions[0]).not.toHaveProperty("user");
    const nextSubscriptionsResponse = await publicApiSubscriptions(publicRequest(
      `/api/public/v1/subscriptions?limit=1&cursor=${encodeURIComponent(subscriptionsBody.nextCursor ?? "")}`,
    ), env);
    const nextSubscriptionsBody = publicApiSubscriptionsListPayloadSchema.parse(await readSuccessData<unknown>(nextSubscriptionsResponse));
    expect(nextSubscriptionsBody.subscriptions[0]?.id).not.toBe(subscriptionsBody.subscriptions[0]?.id);

    const allSubscriptionsResponse = await publicApiSubscriptions(publicRequest("/api/public/v1/subscriptions?limit=3"), env);
    const allSubscriptionsBody = publicApiSubscriptionsListPayloadSchema.parse(await readSuccessData<unknown>(allSubscriptionsResponse));
    expect(allSubscriptionsBody.subscriptions.find((item) => item.id === "sub_renewal")).toMatchObject({ startDate: null, balance: "0", balanceCurrency: "EUR" });
    expect(allSubscriptionsBody.subscriptions.find((item) => item.id === "sub_expiry")).toMatchObject({
      autoCalculateNextBillingDate: true,
    });
    expect(allSubscriptionsBody.subscriptions.find((item) => item.id === "sub_renewal")).toMatchObject({ extra: {} });

    const detailResponse = await publicApiSubscription(publicRequest("/api/public/v1/subscriptions/sub_renewal"), env, "sub_renewal");
    expect(publicApiSubscriptionPayloadSchema.parse(await readSuccessData<unknown>(detailResponse))).toMatchObject({
      subscription: { id: "sub_renewal", name: "Renewal Plan", startDate: null, balance: "0", balanceCurrency: "EUR" },
    });
    await expect(publicApiSubscription(publicRequest("/api/public/v1/subscriptions/sub_other"), env, "sub_other"))
      .rejects.toMatchObject({ status: 404 });

    const statusResponse = await publicApiStatus(publicRequest("/api/public/v1/status"), env);
    expect(publicApiStatusPayloadSchema.parse(await readSuccessData<unknown>(statusResponse))).toMatchObject({
      total: 3,
      byStatus: { active: 2, trial: 1, expired: 0, paused: 0, cancelled: 0 },
    });

    const dueResponse = await publicApiDue(publicRequest("/api/public/v1/due?days=30"), env);
    const dueBody = publicApiDuePayloadSchema.parse(await readSuccessData<unknown>(dueResponse));
    expect(dueBody.items.map((item) => [item.subscription.id, item.dueType])).toEqual(expect.arrayContaining([
      ["sub_renewal", "renewal"],
      ["sub_trial", "trial"],
      ["sub_expiry", "expiry"],
    ]));
    expect(dueBody.items.find((item) => item.subscription.id === "sub_renewal")?.subscription).toMatchObject({ balance: "0", balanceCurrency: "EUR" });
    expect(dueBody.items.map((item) => item.subscription.id)).not.toContain("sub_other");

    authMocks.requireAuth.mockResolvedValueOnce({ user: { id: OTHER_USER_ID }, session: { id: "ses_other" } });
    await expect(deleteApiToken(authorizedRequest(`/api/app/api-tokens/${created.token.id}`, { method: "DELETE" }), env, created.token.id))
      .rejects.toMatchObject({ status: 404 });
    expect(env.__state.apiTokens).toHaveLength(1);

    authMocks.requireAuth.mockResolvedValue({ user: { id: USER_ID }, session: { id: "ses" } });
    const deleteResponse = await deleteApiToken(authorizedRequest(`/api/app/api-tokens/${created.token.id}`, { method: "DELETE" }), env, created.token.id);
    expect(deleteResponse.status).toBe(200);
    expect(env.__state.apiTokens).toHaveLength(0);
    await expect(publicApiMe(publicRequest("/api/public/v1/me"), env)).rejects.toMatchObject({ status: 401 });
  });

  it("throttles public API last_used_at writes", async () => {
    const tokenHash = await sha256(PLAIN_TOKEN);
    const token: ApiTokenRow = {
      id: "tok_existing",
      user_id: USER_ID,
      name: "Automation",
      token_hash: tokenHash,
      token_prefix: PLAIN_TOKEN.slice(0, 12),
      scopes_json: JSON.stringify(["read"]),
      last_used_at: null,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    };
    const env = createEnv({ apiTokens: [token] });

    const first = await publicApiMe(publicRequest("/api/public/v1/me"), env);
    expect(first.status).toBe(200);
    expect(env.__state.apiTokenLastUsedUpdates).toBe(1);
    const firstLastUsedAt = token.last_used_at;
    expect(firstLastUsedAt).toBeTruthy();

    const fresh = await publicApiMe(publicRequest("/api/public/v1/me"), env);
    expect(fresh.status).toBe(200);
    expect(env.__state.apiTokenLastUsedUpdates).toBe(1);
    expect(token.last_used_at).toBe(firstLastUsedAt);

    const staleLastUsedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    token.last_used_at = staleLastUsedAt;
    const stale = await publicApiMe(publicRequest("/api/public/v1/me"), env);
    expect(stale.status).toBe(200);
    expect(env.__state.apiTokenLastUsedUpdates).toBe(2);
    expect(Date.parse(token.last_used_at ?? "")).toBeGreaterThan(Date.parse(staleLastUsedAt));
  });
});
