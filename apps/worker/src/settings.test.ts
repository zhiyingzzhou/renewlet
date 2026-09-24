// Worker settings 测试保护账号偏好与请求语言分权；缺失 settings 行只能写入 auto。
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { ensureSettings, normalizeSettingsJson } from "./db";
import { readSettings, updateSettings } from "./settings";
import type { Env } from "./types";

const USER_ID = "usr_settings";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

interface SettingsTestState {
  rows: Map<string, string>;
  inserts: string[];
}

function d1Result<T = unknown>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} as D1Meta } as D1Result<T>;
}

function createEnv(initialSettings?: ApiAppSettings): { env: Env; state: SettingsTestState } {
  const state: SettingsTestState = {
    rows: new Map(initialSettings ? [[USER_ID, JSON.stringify(initialSettings)]] : []),
    inserts: [],
  };
  return {
    env: {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    },
    state,
  };
}

function settingsWithLocalePreference(localePreference: ApiAppSettings["localePreference"]): ApiAppSettings {
  return { ...createDefaultAppSettings(), localePreference };
}

class SettingsTestDB {
  constructor(private readonly state: SettingsTestState) {}

  prepare(sql: string) {
    return new SettingsTestStatement(this.state, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const statement of statements) {
      results.push(await (statement as unknown as SettingsTestStatement).run());
    }
    return results;
  }
}

class SettingsTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: SettingsTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT settings_json FROM settings")) {
      const [userId] = this.values as [string];
      const settingsJson = this.state.rows.get(userId);
      return settingsJson ? { settings_json: settingsJson } as T : null;
    }
    if (this.sql.includes("FROM subscription_scheduler_state")) {
      return null;
    }
    if (this.sql.includes("SUM(CASE WHEN auto_renew")) {
      return { auto_renew_count: 0, repeat_reminder_count: 0 } as T;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("FROM subscriptions")) {
      return d1Result<T>([]);
    }
    throw new Error(`unexpected settings query: ${this.sql}`);
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO settings")) {
      const [userId, settingsJson] = this.values as [string, string, string, string];
      if (this.sql.includes("DO NOTHING")) {
        if (!this.state.rows.has(userId)) {
          this.state.rows.set(userId, settingsJson);
          this.state.inserts.push(userId);
        }
      } else {
        this.state.rows.set(userId, settingsJson);
      }
      return d1Result([]);
    }
    if (this.sql.includes("INSERT INTO subscription_scheduler_state")) {
      return d1Result([]);
    }
    throw new Error(`unexpected settings query: ${this.sql}`);
  }
}

function settingsRequest(method: string, locale: string, body?: unknown): Request {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  const init: RequestInit = {
    method,
    headers: {
      cookie: "renewlet_session=session-token; renewlet_csrf=csrf-token",
      "content-type": "application/json",
      "x-renewlet-locale": locale,
      ...(unsafe ? { origin: "https://renewlet.example", "x-renewlet-csrf": "csrf-token" } : {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request("https://renewlet.example/api/app/settings", init);
}

describe("Cloudflare settings initialization", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset().mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "ses" },
    });
  });

  it("creates missing settings with auto preference", async () => {
    const { env, state } = createEnv();

    const settings = await ensureSettings(env, USER_ID);

    expect(settings.localePreference).toBe("auto");
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ localePreference: "auto" });
  });

  it("does not overwrite an existing explicit locale preference", async () => {
    const existing = settingsWithLocalePreference("en-US");
    const { env, state } = createEnv(existing);

    const settings = await ensureSettings(env, USER_ID);

    expect(settings.localePreference).toBe("en-US");
    expect(state.inserts).toEqual([]);
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ localePreference: "en-US" });
  });

  it("defaults Telegram message format to plain and recovers invalid stored values", async () => {
    expect(createDefaultAppSettings().telegramMessageFormat).toBe("plain");
    const existing = {
      ...settingsWithLocalePreference("en-US"),
      monthlyBudget: "2333",
      telegramMessageFormat: "markdown",
    };
    const state: SettingsTestState = {
      rows: new Map([[USER_ID, JSON.stringify(existing)]]),
      inserts: [],
    };
    const env = {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } as Env;

    const settings = await ensureSettings(env, USER_ID);

    expect(settings.telegramMessageFormat).toBe("plain");
    expect(settings.monthlyBudget).toBe("2333");
  });

  it("adds subscription price reference defaults when reading old settings JSON", () => {
    const settings = normalizeSettingsJson(JSON.stringify({
      localePreference: "auto",
      defaultCurrency: "USD",
      monthlyBudget: "2333",
    }));

    expect(settings.defaultCurrency).toBe("USD");
    expect(settings.monthlyBudget).toBe("2333");
    expect(settings.subscriptionPriceReferenceEnabled).toBe(false);
    expect(settings.subscriptionPriceReferenceCurrency).toBe("default");
  });

  it("adds the lunar display default when reading old settings JSON", () => {
    const settings = normalizeSettingsJson(JSON.stringify({ localePreference: "auto", defaultCurrency: "USD" }));

    expect(settings.showLunarCalendar).toBe(false);
    expect(normalizeSettingsJson(JSON.stringify({ localePreference: "auto", showLunarCalendar: true })).showLunarCalendar).toBe(true);
  });

  it("rejects migrated settings rows without a valid locale preference", async () => {
    expect(() => normalizeSettingsJson(JSON.stringify({ monthlyBudget: "2333" }))).toThrow();
    expect(() => normalizeSettingsJson("{")).toThrow();

    const state: SettingsTestState = {
      rows: new Map([[USER_ID, JSON.stringify({ monthlyBudget: "2333" })]]),
      inserts: [],
    };
    const env = {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } as Env;

    await expect(ensureSettings(env, USER_ID)).rejects.toThrow();
  });

  it("recovers invalid stored subscription price reference currency without dropping other settings", async () => {
    const existing = {
      ...settingsWithLocalePreference("en-US"),
      monthlyBudget: "2333",
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "usd",
    };
    const state: SettingsTestState = {
      rows: new Map([[USER_ID, JSON.stringify(existing)]]),
      inserts: [],
    };
    const env = {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } as Env;

    const settings = await ensureSettings(env, USER_ID);

    expect(settings.subscriptionPriceReferenceEnabled).toBe(true);
    expect(settings.subscriptionPriceReferenceCurrency).toBe("default");
    expect(settings.monthlyBudget).toBe("2333");
  });

  it("recovers invalid stored DingTalk template fields without dropping other settings", async () => {
    const existing = {
      ...settingsWithLocalePreference("en-US"),
      monthlyBudget: "2333",
      dingtalkTitleTemplate: "x".repeat(501),
      dingtalkContentTemplate: 42,
    };
    const state: SettingsTestState = {
      rows: new Map([[USER_ID, JSON.stringify(existing)]]),
      inserts: [],
    };
    const env = {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } as Env;

    const settings = await ensureSettings(env, USER_ID);

    expect(settings.dingtalkTitleTemplate).toBe("");
    expect(settings.dingtalkContentTemplate).toBe("");
    expect(settings.monthlyBudget).toBe("2333");
  });

  it("readSettings ignores request locale when ensuring a settings row", async () => {
    const { env, state } = createEnv();

    const response = await readSettings(settingsRequest("GET", "zh-CN"), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({
      settings: { localePreference: "auto" },
      secretStatus: { telegramBotToken: { configured: false }, "aiRecognition.apiKey": { configured: false } },
    });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ localePreference: "auto" });
  });

  it("never returns stored secrets and only updates them through discriminated mutations", async () => {
    const defaults = settingsWithLocalePreference("en-US");
    const existing = {
      ...defaults,
      telegramBotToken: "stored-telegram-secret",
      aiRecognition: { ...defaults.aiRecognition, apiKey: "stored-ai-secret" },
    };
    const { env, state } = createEnv(existing);

    const read = await readSettings(settingsRequest("GET", "en-US"), env);
    const readText = await read.text();
    expect(readText).not.toContain("stored-telegram-secret");
    expect(readText).not.toContain("stored-ai-secret");
    expect(JSON.parse(readText).data.secretStatus).toMatchObject({
      telegramBotToken: { configured: true },
      "aiRecognition.apiKey": { configured: true },
    });

    const update = await updateSettings(settingsRequest("PUT", "en-US", {
      secretUpdates: {
        telegramBotToken: { action: "clear" },
        "aiRecognition.apiKey": { action: "set", value: "new-ai-secret" },
      },
    }), env);
    const updateText = await update.text();
    expect(updateText).not.toContain("new-ai-secret");
    expect(JSON.parse(updateText).data.secretStatus).toMatchObject({
      telegramBotToken: { configured: false },
      "aiRecognition.apiKey": { configured: true },
    });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({
      telegramBotToken: "",
      aiRecognition: { apiKey: "new-ai-secret" },
    });
  });

  it("rejects direct secret fields and malformed secret mutations", async () => {
    const { env } = createEnv(settingsWithLocalePreference("en-US"));

    await expect(updateSettings(settingsRequest("PUT", "en-US", { telegramBotToken: "raw-secret" }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      secretUpdates: { telegramBotToken: { action: "set" } },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });

  it("updateSettings keeps auto when creating the first row", async () => {
    const { env, state } = createEnv();

    const response = await updateSettings(settingsRequest("PUT", "zh-CN", { monthlyBudget: "2333" }), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({ settings: { localePreference: "auto", monthlyBudget: "2333" } });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ localePreference: "auto", monthlyBudget: "2333" });
  });

  it("reads and writes the account lunar display preference", async () => {
    const { env, state } = createEnv();

    const response = await updateSettings(settingsRequest("PUT", "en-US", { showLunarCalendar: true }), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({ settings: { showLunarCalendar: true } });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ showLunarCalendar: true });
    await expect(readSuccessData(await readSettings(settingsRequest("GET", "en-US"), env))).resolves.toMatchObject({
      settings: { showLunarCalendar: true },
    });
  });

  it("persists an explicit locale preference only from the settings payload", async () => {
    const { env, state } = createEnv();

    const response = await updateSettings(settingsRequest("PUT", "en-US", { localePreference: "zh-CN" }), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({ settings: { localePreference: "zh-CN" } });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ localePreference: "zh-CN" });
  });

  it("does not create settings for invalid or legacy locale fields", async () => {
    const { env, state } = createEnv();

    await expect(updateSettings(settingsRequest("PUT", "zh-CN", { localePreference: "fr-FR" }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "zh-CN", { locale: "zh-CN" }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });

    expect(state.rows.has(USER_ID)).toBe(false);
  });

  it("rejects invalid subscription price reference currency on write", async () => {
    const { env } = createEnv(settingsWithLocalePreference("en-US"));

    await expect(updateSettings(settingsRequest("PUT", "zh-CN", {
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "usd",
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });

  it("accepts only supported Telegram message formats on write", async () => {
    const { env, state } = createEnv(settingsWithLocalePreference("en-US"));

    const response = await updateSettings(settingsRequest("PUT", "en-US", { telegramMessageFormat: "html" }), env);
    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({ settings: { telegramMessageFormat: "html" } });

    await expect(updateSettings(settingsRequest("PUT", "en-US", { telegramMessageFormat: "markdown" }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ telegramMessageFormat: "html" });
  });

  it("merges online icon source settings without dropping defaults", async () => {
    const { env, state } = createEnv(settingsWithLocalePreference("en-US"));

    const response = await updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { enabled: false },
      },
    }), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({
      settings: {
        onlineIconSources: {
          appStore: { enabled: false, storefronts: ["us"] },
        },
      },
    });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({
      onlineIconSources: {
        appStore: { enabled: false, storefronts: ["us"] },
      },
    });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: ["cn"] },
      },
    }), env)).resolves.toMatchObject({ status: 200 });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({
      onlineIconSources: {
        appStore: { enabled: false, storefronts: ["cn"] },
      },
    });

    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        googlePlay: { enabled: true },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: [] },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: ["us", "us"] },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: ["jp"] },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });

  it("rejects overly long DingTalk templates on write", async () => {
    const { env } = createEnv(settingsWithLocalePreference("en-US"));

    await expect(updateSettings(settingsRequest("PUT", "en-US", { dingtalkTitleTemplate: "x".repeat(501) }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", { dingtalkContentTemplate: "x".repeat(20_001) }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });
});
