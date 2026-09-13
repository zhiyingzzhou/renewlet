// Worker 私有资产测试保护 D1 owner 索引、订阅引用阻止和 R2/D1 删除顺序。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { deleteAsset, readAsset, uploadAsset } from "./assets";
import worker from "./index";
import type { AssetRow, Env, SubscriptionRow } from "./types";

const USER_ID = "usr_asset_owner";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./smtp", () => ({
  notificationSmtpConfig: () => {
    throw new Error("SMTP should not be used by asset route tests");
  },
  sendSmtpEmail: async () => undefined,
}));

interface AssetTestState {
  assets: AssetRow[];
  subscriptions: Pick<SubscriptionRow, "user_id" | "logo">[];
  customConfigs: Array<{ user_id: string; config_json: string }>;
  deletedMetadata: Array<{ userId: string; id: string }>;
}

function d1Result<T = unknown>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} as D1Meta } as D1Result<T>;
}

function createEnv(overrides: Partial<AssetTestState> = {}) {
  const state: AssetTestState = {
    assets: [],
    subscriptions: [],
    customConfigs: [],
    deletedMetadata: [],
    ...overrides,
  };
  const r2Delete = vi.fn(async () => undefined);
  const r2Get = vi.fn(async () => ({ body: new Response("private asset").body }));
  const env = {
    DB: new AssetTestDB(state) as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {
      delete: r2Delete,
      get: r2Get,
    } as unknown as R2Bucket,
  } satisfies Env;
  return { env, r2Delete, r2Get, state };
}

class AssetTestDB {
  // 只模拟删除 handler 触达的 SQL，确保 owner 过滤和引用计数分支在断言里保持可见。
  constructor(private readonly state: AssetTestState) {}

  prepare(sql: string) {
    return new AssetTestStatement(this.state, sql);
  }
}

class AssetTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: AssetTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM assets")) {
      const [userId, id] = this.values as [string, string];
      return this.state.assets.find((asset) => asset.user_id === userId && asset.id === id) as T | undefined ?? null;
    }
    if (this.sql.includes("FROM subscriptions")) {
      const [userId, logo] = this.values as [string, string];
      const count = this.state.subscriptions.filter((row) => row.user_id === userId && row.logo === logo).length;
      return { count } as T;
    }
    if (this.sql.includes("FROM custom_configs")) {
      const [userId] = this.values as [string];
      return this.state.customConfigs.find((row) => row.user_id === userId) as T | undefined ?? null;
    }
    return null;
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("DELETE FROM assets")) {
      const [userId, id] = this.values as [string, string];
      this.state.deletedMetadata.push({ userId, id });
      this.state.assets = this.state.assets.filter((asset) => asset.user_id !== userId || asset.id !== id);
      return d1Result([]);
    }
    throw new Error(`unexpected run query: ${this.sql}`);
  }
}

function requestFixture(method = "DELETE"): Request {
  return new Request("https://renewlet.test/api/app/assets/asset_logo", {
    method,
    headers: {
      authorization: "Bearer test",
      origin: "https://renewlet.test",
      "x-renewlet-locale": "en-US",
    },
  });
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset_logo",
    user_id: USER_ID,
    kind: "logo",
    r2_key: "usr_asset_owner/logo/asset_logo/logo.png",
    original_name: "logo.png",
    mime_type: "image/png",
    size_bytes: 1024,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function customConfigRow(userId: string, icon: string) {
  return {
    user_id: userId,
    config_json: JSON.stringify({
      categories: [],
      statuses: [],
      paymentMethods: [{
        id: "card",
        value: "card",
        labels: { "zh-CN": "银行卡", "en-US": "Card" },
        icon,
      }],
      currencies: [],
    }),
  };
}

describe("Cloudflare uploaded assets", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    authMocks.requireAuth.mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "ses" },
    });
  });

  it("reads private metadata and the object once, in authenticated owner order", async () => {
    const fixture = createEnv({ assets: [assetRow()] });
    const metadata = vi.spyOn(fixture.env.DB, "prepare");
    const response = await readAsset(requestFixture("GET"), fixture.env, "asset_logo");

    expect(await response.text()).toBe("private asset");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata.mock.calls[0]?.[0]).toContain("WHERE user_id = ? AND id = ?");
    expect(fixture.r2Get).toHaveBeenCalledExactlyOnceWith(assetRow().r2_key);
    // 少一次权限读取不是优化：必须先认证，再查 owner，最后访问 R2。
    expect(authMocks.requireAuth.mock.invocationCallOrder[0]).toBeLessThan(metadata.mock.invocationCallOrder[0] ?? 0);
    expect(metadata.mock.invocationCallOrder[0]).toBeLessThan(fixture.r2Get.mock.invocationCallOrder[0] ?? 0);
  });

  it("does not read objects owned by another account", async () => {
    const fixture = createEnv({ assets: [assetRow({ user_id: "another-owner" })] });
    await expect(readAsset(requestFixture("GET"), fixture.env, "asset_logo")).rejects.toMatchObject({ status: 404 });
    expect(fixture.r2Get).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated reads before metadata or object access", async () => {
    const fixture = createEnv({ assets: [assetRow()] });
    const metadata = vi.spyOn(fixture.env.DB, "prepare");
    const denied = new Error("unauthenticated");
    authMocks.requireAuth.mockRejectedValueOnce(denied);
    await expect(readAsset(requestFixture("GET"), fixture.env, "asset_logo")).rejects.toBe(denied);
    expect(metadata).not.toHaveBeenCalled();
    expect(fixture.r2Get).not.toHaveBeenCalled();
  });

  it("deletes the R2 object and owner-scoped D1 metadata", async () => {
    const fixture = createEnv({ assets: [assetRow()] });

    const response = await deleteAsset(requestFixture(), fixture.env, "asset_logo");
    const data = await readSuccessData<Record<string, never>>(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({});
    expect(fixture.r2Delete).toHaveBeenCalledWith("usr_asset_owner/logo/asset_logo/logo.png");
    expect(fixture.state.deletedMetadata).toEqual([{ userId: USER_ID, id: "asset_logo" }]);
    expect(fixture.state.assets).toEqual([]);
  });

  it("returns 404 for missing or foreign assets without touching R2", async () => {
    const fixture = createEnv({ assets: [assetRow({ user_id: "usr_other" })] });

    await expect(deleteAsset(requestFixture(), fixture.env, "asset_logo"))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    expect(fixture.r2Delete).not.toHaveBeenCalled();
    expect(fixture.state.deletedMetadata).toEqual([]);
  });

  it("blocks deletion while current-user subscriptions still reference the asset", async () => {
    const fixture = createEnv({
      assets: [assetRow()],
      subscriptions: [
        { user_id: USER_ID, logo: "/api/app/assets/asset_logo" },
        { user_id: USER_ID, logo: "/api/app/assets/asset_logo" },
        { user_id: "usr_other", logo: "/api/app/assets/asset_logo" },
      ],
    });

    await expect(deleteAsset(requestFixture(), fixture.env, "asset_logo"))
      .rejects.toMatchObject({
        status: 409,
        code: "ASSET_IN_USE",
        details: { usageCount: 2, subscriptionLogoCount: 2, paymentMethodIconCount: 0 },
      });

    expect(fixture.r2Delete).not.toHaveBeenCalled();
    expect(fixture.state.assets).toHaveLength(1);
    expect(fixture.state.deletedMetadata).toEqual([]);
  });

  it("blocks deletion while payment methods still reference the uploaded icon", async () => {
    const fixture = createEnv({
      assets: [assetRow({ kind: "icon", r2_key: "usr_asset_owner/icon/asset_logo/icon.svg" })],
      customConfigs: [
        customConfigRow(USER_ID, "/api/app/assets/asset_logo"),
        customConfigRow("usr_other", "/api/app/assets/asset_logo"),
      ],
    });

    await expect(deleteAsset(requestFixture(), fixture.env, "asset_logo"))
      .rejects.toMatchObject({
        status: 409,
        code: "ASSET_IN_USE",
        details: { usageCount: 1, subscriptionLogoCount: 0, paymentMethodIconCount: 1 },
      });

    expect(fixture.r2Delete).not.toHaveBeenCalled();
    expect(fixture.state.assets).toHaveLength(1);
    expect(fixture.state.deletedMetadata).toEqual([]);
  });

  it("reports mixed subscription and payment method references without counting other users", async () => {
    const fixture = createEnv({
      assets: [assetRow()],
      subscriptions: [
        { user_id: USER_ID, logo: "/api/app/assets/asset_logo" },
        { user_id: "usr_other", logo: "/api/app/assets/asset_logo" },
      ],
      customConfigs: [
        customConfigRow(USER_ID, "/api/app/assets/asset_logo"),
        customConfigRow("usr_other", "/api/app/assets/asset_logo"),
      ],
    });

    await expect(deleteAsset(requestFixture(), fixture.env, "asset_logo"))
      .rejects.toMatchObject({
        status: 409,
        code: "ASSET_IN_USE",
        details: { usageCount: 2, subscriptionLogoCount: 1, paymentMethodIconCount: 1 },
      });

    expect(fixture.r2Delete).not.toHaveBeenCalled();
    expect(fixture.state.deletedMetadata).toEqual([]);
  });

  it("rejects oversized uploads before parsing multipart form data", async () => {
    const fixture = createEnv();
    const request = new Request("https://renewlet.test/api/app/assets", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-length": String(2 * 1024 * 1024 + 64 * 1024 + 1),
        "x-renewlet-locale": "en-US",
      },
    });
    const formDataSpy = vi.spyOn(request, "formData").mockRejectedValue(new Error("formData should not be called"));

    await expect(uploadAsset(request, fixture.env)).rejects.toMatchObject({ status: 400 });

    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("routes DELETE /api/app/assets/{id} to the asset deletion handler", async () => {
    const fixture = createEnv({ assets: [assetRow()] });
    const fetchHandler = worker.fetch;
    if (!fetchHandler) throw new Error("Expected Worker fetch handler");

    const response = await fetchHandler(
      requestFixture() as unknown as Parameters<typeof fetchHandler>[0],
      fixture.env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await readSuccessData<Record<string, never>>(response)).toEqual({});
    expect(fixture.r2Delete).toHaveBeenCalledWith("usr_asset_owner/logo/asset_logo/logo.png");
  });
});
