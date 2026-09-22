// Worker 公开展示页测试保护 bearer token、字段 allowlist、隐藏过滤和 R2 私有资产代理边界。
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import {
  createPublicStatusPage,
  deletePublicStatusPage,
  readPublicStatus,
  readPublicStatusAsset,
  readPublicStatusPage,
  updatePublicStatusPage,
} from "./public-status";
import type { AssetRow, Env, ExchangeRateSnapshotRow, PublicStatusPageRow, SubscriptionRow } from "./types";

const USER_ID = "usr_public";
const TOKEN = "pubtokenpubtokenpubtokenpubtokenpubtokenpub";

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
    randomToken: vi.fn(() => TOKEN),
  };
});

type PublicStatusTestState = {
  pages: PublicStatusPageRow[];
  subscriptions: SubscriptionRow[];
  assets: AssetRow[];
  exchangeRateSnapshots: ExchangeRateSnapshotRow[];
  settingsJson: string | null;
  customConfigJson: string | null;
  objects: Map<string, R2ObjectBody>;
};

function d1Result<T = unknown>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} as D1Meta } as D1Result<T>;
}

function createEnv(overrides: Partial<PublicStatusTestState> = {}): Env {
  // public status 资产读取必须走 token -> owner -> 可见订阅引用 -> R2 object；mock 也保持这条链路。
  const settings = { ...createDefaultAppSettings(), localePreference: "en-US" as const, timezone: "UTC" };
  const state: PublicStatusTestState = {
    pages: [],
    subscriptions: [],
    assets: [],
    exchangeRateSnapshots: [],
    settingsJson: JSON.stringify(settings),
    customConfigJson: JSON.stringify({
      categories: [
        {
          id: "developer_tools",
          value: "developer_tools",
          labels: { "zh-CN": "开发工具", "en-US": "Developer Tools" },
          color: "hsl(210 90% 52%)",
        },
      ],
      statuses: [],
      paymentMethods: [],
      currencies: [],
    }),
    objects: new Map(),
    ...overrides,
  };
  return {
    DB: new PublicStatusTestDB(state) as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {
      get: vi.fn(async (key: string) => state.objects.get(key) ?? null),
    } as unknown as R2Bucket,
  } as Env;
}

class PublicStatusTestDB {
  // 只模拟 handler 实际触达的 D1 查询，避免测试因“完整数据库替身”掩盖 owner/visibility 分支。
  constructor(private readonly state: PublicStatusTestState) {}

  prepare(sql: string) {
    return new PublicStatusTestStatement(this.state, sql);
  }
}

class PublicStatusTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: PublicStatusTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM public_status_pages")) {
      if (this.sql.includes("WHERE user_id = ?")) {
        return this.state.pages.find((page) => page.user_id === this.values[0]) as T | undefined ?? null;
      }
      if (this.sql.includes("WHERE token = ?")) {
        return this.state.pages.find((page) => page.token === this.values[0]) as T | undefined ?? null;
      }
    }
    if (this.sql.includes("SELECT settings_json FROM settings")) {
      return this.state.settingsJson === null ? null : { settings_json: this.state.settingsJson } as T;
    }
    if (this.sql.includes("SELECT config_json FROM custom_configs")) {
      return this.state.customConfigJson === null ? null : { config_json: this.state.customConfigJson } as T;
    }
    if (this.sql.includes("FROM assets")) {
      const [userId, assetId] = this.values as [string, string];
      return this.state.assets.find((asset) => asset.user_id === userId && asset.id === assetId) as T | undefined ?? null;
    }
    if (this.sql.includes("FROM exchange_rate_snapshots")) {
      const [userId, month] = this.values as [string, string];
      return this.state.exchangeRateSnapshots.find((snapshot) => snapshot.user_id === userId && snapshot.month === month) as T | undefined ?? null;
    }
    if (this.sql.includes("FROM subscriptions") && this.sql.includes("public_hidden = 0 AND logo = ?")) {
      const [userId, logo] = this.values as [string, string];
      return this.state.subscriptions.find((row) => row.user_id === userId && row.public_hidden === 0 && row.logo === logo) as T | undefined ?? null;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("INNER JOIN subscriptions AS sub")) {
      const [today, userId, limit] = this.values as [string, string, number];
      const inactive = (row: SubscriptionRow) => {
        if (row.status === "expired" || row.status === "paused" || row.status === "cancelled") return 1;
        if (row.billing_cycle === "one-time" && !row.one_time_term_count) return 0;
        return (row.status === "active" || row.status === "trial") && row.next_billing_date < today ? 1 : 0;
      };
      const rows = this.state.subscriptions
        .filter((row) => row.user_id === userId && row.public_hidden === 0)
        .sort((left, right) => (
          right.pinned - left.pinned
          || inactive(left) - inactive(right)
          || right.created_at.localeCompare(left.created_at)
          || right.id.localeCompare(left.id)
        ))
        .slice(0, limit);
      return d1Result(rows as T[]);
    }
    return d1Result([]);
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO public_status_pages")) {
      const [id, userId, token, showPrices, hideExpired, hideLifetime, createdAt, updatedAt] = this.values as [string, string, string, number, number, number, string, string];
      this.state.pages.push({
        id,
        user_id: userId,
        token,
        show_prices: showPrices,
        hide_expired: hideExpired,
        hide_lifetime: hideLifetime,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return d1Result([]);
    }
    if (this.sql.includes("UPDATE public_status_pages SET show_prices")) {
      const [showPrices, hideExpired, hideLifetime, updatedAt, userId] = this.values as [number, number, number, string, string];
      const page = this.state.pages.find((item) => item.user_id === userId);
      if (page) {
        page.show_prices = showPrices;
        page.hide_expired = hideExpired;
        page.hide_lifetime = hideLifetime;
        page.updated_at = updatedAt;
      }
      return d1Result([]);
    }
    if (this.sql.includes("DELETE FROM public_status_pages")) {
      const userId = String(this.values[0]);
      this.state.pages = this.state.pages.filter((page) => page.user_id !== userId);
    }
    return d1Result([]);
  }
}

function authorizedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://renewlet.test${path}`, {
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-renewlet-locale": "en-US",
      ...init.headers,
    },
    ...init,
  });
}

function publicRequest(path: string, locale = "en-US"): Request {
  return new Request(`https://renewlet.test${path}`, {
    headers: { "accept-language": locale },
  });
}

function publicPage(overrides: Partial<PublicStatusPageRow> = {}): PublicStatusPageRow {
  return {
    id: "pub_page",
    user_id: USER_ID,
    token: TOKEN,
    show_prices: 0,
    hide_expired: 0,
    hide_lifetime: 0,
    created_at: "2026-06-07T00:00:00.000Z",
    updated_at: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

function subscriptionRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_public",
    user_id: USER_ID,
    name: "Visible Plan",
    logo: null,
    price: "12",
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
    start_date: "2026-05-01",
    next_billing_date: "2099-06-01",
    auto_renew: 1,
    auto_calculate_next_billing_date: 1,
    trial_end_date: null,
    website: "https://billing.example.test",
    notes: "private note",
    tags_json: JSON.stringify(["private"]),
    reminder_days: 3,
    repeat_reminder_enabled: 0,
    repeat_reminder_interval: "1h",
    repeat_reminder_window: "72h",
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: JSON.stringify({ secret: true }),
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset_visible",
    user_id: USER_ID,
    kind: "logo",
    r2_key: "logos/visible.svg",
    original_name: "visible.svg",
    mime_type: "image/svg+xml",
    size_bytes: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function exchangeRateSnapshotRow(overrides: Partial<ExchangeRateSnapshotRow> = {}): ExchangeRateSnapshotRow {
  return {
    user_id: USER_ID,
    month: new Date().toISOString().slice(0, 7),
    base: "USD",
    rates_json: JSON.stringify({ USD: 1, CNY: 7 }),
    requested_provider: "frankfurter",
    provider: "frankfurter",
    source_date: "2026-08-01",
    captured_at: "2026-08-06T00:00:00.000Z",
    warning_json: null,
    created_at: "2026-08-06T00:00:00.000Z",
    updated_at: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function r2Object(body: string, contentType: string): R2ObjectBody {
  const blob = new Blob([body], { type: contentType });
  return {
    body: blob.stream(),
    httpMetadata: { contentType },
  } as R2ObjectBody;
}

beforeEach(() => {
  // 公开状态同时投影 asOf 与有效状态；固定 Date 才能让两者共享同一账号日界线。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-07T12:00:00.000Z"));
  authMocks.requireAuth.mockReset();
  authMocks.requireAuth.mockResolvedValue({ user: { id: USER_ID }, session: { id: "ses" } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("public status worker handlers", () => {
  it("manages the private public status URL lifecycle without exposing token as a setting", async () => {
    const env = createEnv();

    const disabledResponse = await readPublicStatusPage(authorizedRequest("/api/app/public-status-page"), env);
    expect(await readSuccessData(disabledResponse)).toEqual({ publicStatusPage: { enabled: false, showPrices: false, hideExpired: false, hideLifetime: false } });

    const createResponse = await createPublicStatusPage(authorizedRequest("/api/app/public-status-page", {
      method: "POST",
      body: "{}",
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
    }), env);
    const created = await readSuccessData<{ publicStatusPage: { enabled: boolean; pageUrl: string; showPrices: boolean } }>(createResponse);
    expect(created.publicStatusPage).toMatchObject({
      enabled: true,
      pageUrl: `https://renewlet.test/status/${TOKEN}`,
      showPrices: false, hideExpired: false, hideLifetime: false,
    });
    expect(created.publicStatusPage).not.toHaveProperty("token");

    const updateResponse = await updatePublicStatusPage(authorizedRequest("/api/app/public-status-page", {
      method: "PATCH",
      body: JSON.stringify({ showPrices: true, hideExpired: false, hideLifetime: false }),
    }), env);
    expect(await readSuccessData(updateResponse)).toMatchObject({ publicStatusPage: { enabled: true, showPrices: true } });

    const deleteResponse = await deletePublicStatusPage(authorizedRequest("/api/app/public-status-page", { method: "DELETE" }), env);
    expect(deleteResponse.status).toBe(200);
    await expect(readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`), env, TOKEN)).rejects.toMatchObject({ status: 404 });
  });

  it("returns a minimal public allowlist, filters hidden subscriptions, and only includes prices when enabled", async () => {
    const env = createEnv({
      pages: [publicPage()],
      subscriptions: [
        subscriptionRow({ id: "sub_hidden", name: "Hidden Plan", public_hidden: 1 }),
        subscriptionRow({ id: "sub_visible", name: "Visible Plan", created_at: "2026-05-01T00:00:00.000Z" }),
        subscriptionRow({ id: "sub_overdue", name: "Legacy Overdue", start_date: "1999-01-01", next_billing_date: "2000-01-01", created_at: "2026-06-03T00:00:00.000Z" }),
        subscriptionRow({ id: "sub_later", name: "Later Plan", next_billing_date: "2099-08-01", created_at: "2026-06-02T00:00:00.000Z" }),
        subscriptionRow({ id: "sub_pinned", name: "Pinned Plan", pinned: 1, next_billing_date: "2026-09-01", created_at: "2026-05-15T00:00:00.000Z" }),
      ],
    });

    const response = await readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`), env, TOKEN);
    const data = await readSuccessData<{ subscriptions: Array<Record<string, unknown>>; page: { showPrices: boolean; asOf: string; currency?: string } }>(response);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(data.page.showPrices).toBe(false);
    expect(data.page.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(data.page).not.toHaveProperty("currency");
    expect(data.subscriptions.map((item) => item["name"])).toEqual(["Pinned Plan", "Later Plan", "Visible Plan", "Legacy Overdue"]);
    expect(data.subscriptions.some((item) => item["name"] === "Hidden Plan")).toBe(false);
    expect(data.subscriptions.find((item) => item["name"] === "Legacy Overdue")).toMatchObject({ status: "expired" });
    expect(data.subscriptions[0]).toEqual(expect.objectContaining({
      name: "Pinned Plan",
      category: { value: "developer_tools", label: "Developer Tools", color: "hsl(210 90% 52%)" },
      status: "active",
      startDate: "2026-05-01",
      nextBillingDate: "2026-09-01",
    }));
    expect(data.subscriptions[0]).not.toHaveProperty("id");
    expect(data.subscriptions[0]).not.toHaveProperty("notes");
    expect(data.subscriptions[0]).not.toHaveProperty("website");
    expect(data.subscriptions[0]).not.toHaveProperty("tags");
    expect(data.subscriptions[0]).not.toHaveProperty("paymentMethod");
    expect(data.subscriptions[0]).not.toHaveProperty("price");
    expect(data.subscriptions[0]).not.toHaveProperty("currency");
    expect(data.subscriptions[0]).not.toHaveProperty("billingCycle");

    const chineseResponse = await readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`, "zh-CN"), env, TOKEN);
    const chineseData = await readSuccessData<{ subscriptions: Array<Record<string, unknown>> }>(chineseResponse);
    expect(chineseData.subscriptions[0]).toMatchObject({
      category: { value: "developer_tools", label: "开发工具" },
    });

    const pricedSettings = { ...createDefaultAppSettings(), localePreference: "en-US" as const, timezone: "UTC", publicStatusCurrency: "USD" as const };
    const pricedEnv = createEnv({
      pages: [publicPage({ show_prices: 1 })],
      subscriptions: [subscriptionRow()],
      exchangeRateSnapshots: [exchangeRateSnapshotRow()],
      settingsJson: JSON.stringify(pricedSettings),
    });
    const pricedResponse = await readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`), pricedEnv, TOKEN);
    expect(await readSuccessData(pricedResponse)).toMatchObject({
      page: {
        showPrices: true,
        currency: "USD",
        exchangeRateBasis: {
          status: "locked",
          base: "USD",
          rates: { USD: 1, CNY: 7 },
        },
      },
      subscriptions: [{ price: "12", currency: "USD", billingCycle: "monthly" }],
    });
  });

  it("publishes buyout purchase dates without a future billing event or hidden price fields", async () => {
    const env = createEnv({
      pages: [publicPage()],
      subscriptions: [subscriptionRow({
        id: "sub_buyout",
        name: "Lifetime License",
        billing_cycle: "one-time",
        one_time_term_count: null,
        one_time_term_unit: null,
        start_date: "2026-05-01",
        next_billing_date: "2026-05-01",
        auto_renew: 0,
        auto_calculate_next_billing_date: 0,
      })],
    });

    const response = await readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`), env, TOKEN);
    const data = await readSuccessData<{ subscriptions: Array<Record<string, unknown>> }>(response);
    expect(data.subscriptions[0]).toMatchObject({
      name: "Lifetime License",
      startDate: "2026-05-01",
      nextBillingDate: null,
    });
    expect(data.subscriptions[0]).not.toHaveProperty("price");
    expect(data.subscriptions[0]).not.toHaveProperty("billingCycle");
  });

  it("normalizes historical non-positive terms to the priced buyout projection", async () => {
    const env = createEnv({
      pages: [publicPage({ show_prices: 1 })],
      subscriptions: [subscriptionRow({
        id: "sub_historical_buyout",
        name: "Historical Lifetime License",
        billing_cycle: "one-time",
        one_time_term_count: -1,
        one_time_term_unit: "month",
        start_date: "2026-05-01",
        next_billing_date: "2026-05-01",
        auto_renew: 0,
        auto_calculate_next_billing_date: 0,
      })],
    });

    const response = await readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`), env, TOKEN);
    const data = await readSuccessData<{ subscriptions: Array<Record<string, unknown>> }>(response);
    expect(data.subscriptions[0]).toMatchObject({
      billingCycle: "one-time",
      nextBillingDate: null,
      price: "12",
      currency: "USD",
    });
    expect(data.subscriptions[0]).not.toHaveProperty("oneTimeTermCount");
    expect(data.subscriptions[0]).not.toHaveProperty("oneTimeTermUnit");
  });

  it("returns null start dates for public recurring subscriptions with unknown starts", async () => {
    const env = createEnv({
      pages: [publicPage()],
      subscriptions: [
        subscriptionRow({
          name: "Unknown Start",
          start_date: null,
          next_billing_date: "2099-06-01",
          auto_calculate_next_billing_date: 0,
        }),
      ],
    });

    const response = await readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`), env, TOKEN);
    const data = await readSuccessData<{ subscriptions: Array<{ startDate: string | null; nextBillingDate: string | null }> }>(response);

    expect(data.subscriptions[0]).toMatchObject({
      startDate: null,
      nextBillingDate: "2099-06-01",
    });
  });

  it("limits public subscriptions and reports truncation", async () => {
    const subscriptions = Array.from({ length: 501 }, (_, index) => subscriptionRow({
      id: `sub_${index}`,
      name: `Plan ${String(index).padStart(3, "0")}`,
      next_billing_date: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
    }));
    const env = createEnv({ pages: [publicPage()], subscriptions });

    const response = await readPublicStatus(publicRequest(`/api/public/status/${TOKEN}`), env, TOKEN);
    const data = await readSuccessData<{ subscriptions: unknown[]; page: { truncated: boolean } }>(response);

    expect(data.subscriptions).toHaveLength(500);
    expect(data.page.truncated).toBe(true);
  });

  it("serves only referenced owner assets through the public asset proxy", async () => {
    // R2 里同时放可见、未引用和跨用户对象，确保公开代理不是单纯按 asset id 读取私有文件。
    const visibleAsset = assetRow();
    const unreferencedAsset = assetRow({ id: "asset_unused", r2_key: "logos/unused.svg" });
    const otherUserAsset = assetRow({ id: "asset_other", user_id: "usr_other", r2_key: "logos/other.svg" });
    const objects = new Map<string, R2ObjectBody>([
      [visibleAsset.r2_key, r2Object("<svg/>", "image/svg+xml")],
      [unreferencedAsset.r2_key, r2Object("<svg/>", "image/svg+xml")],
      [otherUserAsset.r2_key, r2Object("<svg/>", "image/svg+xml")],
    ]);
    const env = createEnv({
      pages: [publicPage()],
      subscriptions: [subscriptionRow({ logo: "/api/app/assets/asset_visible" })],
      assets: [visibleAsset, unreferencedAsset, otherUserAsset],
      objects,
    });

    const response = await readPublicStatusAsset(publicRequest(`/api/public/status/${TOKEN}/assets/asset_visible`), env, TOKEN, "asset_visible");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
    await expect(response.text()).resolves.toBe("<svg/>");
    await expect(readPublicStatusAsset(publicRequest(`/api/public/status/${TOKEN}/assets/asset_unused`), env, TOKEN, "asset_unused"))
      .rejects.toMatchObject({ status: 404 });
    await expect(readPublicStatusAsset(publicRequest(`/api/public/status/${TOKEN}/assets/asset_other`), env, TOKEN, "asset_other"))
      .rejects.toMatchObject({ status: 404 });
    await expect(readPublicStatusAsset(publicRequest("/api/public/status/bad/assets/asset_visible"), env, "bad", "asset_visible"))
      .rejects.toMatchObject({ status: 404 });
  });
});
