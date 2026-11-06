// Worker Telegram Bot 测试保护 command adapter、webhook secret、chat owner 边界和 Public API service 复用。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { updateSettings } from "./settings";
import { countSubscriptionStatuses } from "./subscription-derived-state";
import {
  deleteTelegramBotCommands,
  installTelegramBotCommands,
  readTelegramBotCommands,
  telegramWebhook,
} from "./telegram-bot";
import type { ApiAppSettings, Env, SubscriptionRow, TelegramBotBindingRow } from "./types";

const USER_ID = "usr_telegram";
const BOT_TOKEN = "123456:telegram-secret-token";
const CHAT_ID = "12345";
const SECRET_TOKEN = "telegram-webhook-secret";

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
    randomToken: vi.fn(() => SECRET_TOKEN),
  };
});

interface TelegramBotTestState {
  settingsJson: string;
  bindings: TelegramBotBindingRow[];
  subscriptions: SubscriptionRow[];
  queries: string[];
}

function d1Result<T = unknown>(results: T[] = [], changes = 0): D1Result<T> {
  return { results, success: true, meta: { changes } as D1Meta } as D1Result<T>;
}

function settings(overrides: Partial<ApiAppSettings> = {}): ApiAppSettings {
  return {
    ...createDefaultAppSettings(),
    localePreference: "zh-CN",
    timezone: "UTC",
    telegramBotToken: BOT_TOKEN,
    telegramChatId: CHAT_ID,
    ...overrides,
  };
}

function createEnv(overrides: Partial<TelegramBotTestState> = {}): Env & { __state: TelegramBotTestState } {
  const state: TelegramBotTestState = {
    settingsJson: JSON.stringify(settings()),
    bindings: [],
    subscriptions: [subscriptionRow({ id: "sub_active", name: "Active Plan" }), subscriptionRow({ id: "sub_trial", name: "Trial Plan", status: "trial" })],
    queries: [],
    ...overrides,
  };
  return {
    __state: state,
    DB: new TelegramBotTestDB(state) as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  } as Env & { __state: TelegramBotTestState };
}

class TelegramBotTestDB {
  constructor(private readonly state: TelegramBotTestState) {}

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }

  prepare(sql: string) {
    this.state.queries.push(sql);
    return new TelegramBotTestStatement(this.state, sql);
  }
}

class TelegramBotTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: TelegramBotTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT settings_json FROM settings")) {
      return { settings_json: this.state.settingsJson } as T;
    }
    if (this.sql.includes("FROM telegram_bot_bindings") && this.sql.includes("WHERE user_id = ?")) {
      const userId = String(this.values[0]);
      return this.state.bindings.find((row) => row.user_id === userId) as T | undefined ?? null;
    }
    if (this.sql.includes("FROM telegram_bot_bindings") && this.sql.includes("WHERE id = ?")) {
      const id = String(this.values[0]);
      return this.state.bindings.find((row) => row.id === id) as T | undefined ?? null;
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
        created_at: "2026-06-05T00:00:00.000Z",
        updated_at: "2026-06-05T00:00:00.000Z",
      } as T;
    }
    if (this.sql.includes("FROM subscription_scheduler_state")) {
      return null;
    }
    if (this.sql.includes("SUM(CASE WHEN auto_renew")) {
      const userId = String(this.values[0]);
      const rows = this.state.subscriptions.filter((row) => row.user_id === userId);
      return {
        auto_renew_count: rows.filter((row) => row.auto_renew === 1).length,
        repeat_reminder_count: rows.filter((row) => row.repeat_reminder_enabled === 1 && row.status !== "cancelled").length,
      } as T;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("FROM subscriptions") && this.sql.includes("next_billing_date >= ?")) {
      const userId = String(this.values[0]);
      return d1Result(this.state.subscriptions.filter((row) => row.user_id === userId) as T[]);
    }
    if (this.sql.includes("FROM subscriptions") && this.sql.includes("WHERE user_id = ?")) {
      const userId = String(this.values[0]);
      const limit = Number(this.values[this.values.length - 1] ?? 50);
      return d1Result(this.state.subscriptions.filter((row) => row.user_id === userId).slice(0, limit) as T[]);
    }
    return d1Result([]);
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO telegram_bot_bindings")) {
      const [id, userId, chatId, botTokenHash, webhookSecretHash, status, lastUpdateId, createdAt, updatedAt] = this.values as [
        string,
        string,
        string,
        string,
        string,
        TelegramBotBindingRow["status"],
        number,
        string,
        string,
      ];
      const existingIndex = this.state.bindings.findIndex((row) => row.user_id === userId);
      const row: TelegramBotBindingRow = {
        id,
        user_id: userId,
        chat_id: chatId,
        bot_token_hash: botTokenHash,
        webhook_secret_hash: webhookSecretHash,
        status,
        last_update_id: lastUpdateId,
        last_used_at: null,
        created_at: existingIndex >= 0 ? this.state.bindings[existingIndex]!.created_at : createdAt,
        updated_at: updatedAt,
      };
      if (existingIndex >= 0) this.state.bindings[existingIndex] = row;
      else this.state.bindings.push(row);
      return d1Result([], 1);
    }
    if (this.sql.includes("UPDATE telegram_bot_bindings SET status = 'installed'")) {
      const [updatedAt, userId, id] = this.values as [string, string, string];
      const binding = this.state.bindings.find((row) => row.user_id === userId && row.id === id);
      if (!binding) return d1Result([], 0);
      binding.status = "installed";
      binding.updated_at = updatedAt;
      return d1Result([], 1);
    }
    if (this.sql.includes("UPDATE telegram_bot_bindings") && this.sql.includes("last_update_id")) {
      const [updateId, used, lastUsedAt, updatedAt, id] = this.values as [number, number, string, string, string];
      const binding = this.state.bindings.find((row) => row.id === id);
      if (!binding) return d1Result([], 0);
      binding.last_update_id = updateId;
      if (used) binding.last_used_at = lastUsedAt;
      binding.updated_at = updatedAt;
      return d1Result([], 1);
    }
    if (this.sql.includes("DELETE FROM telegram_bot_bindings")) {
      const [userId, id] = this.values as [string, string];
      const before = this.state.bindings.length;
      this.state.bindings = this.state.bindings.filter((row) => row.user_id !== userId || row.id !== id);
      return d1Result([], before - this.state.bindings.length);
    }
    if (this.sql.includes("INSERT INTO settings")) {
      const [, settingsJson] = this.values as [string, string, string, string];
      this.state.settingsJson = settingsJson;
      return d1Result([], 1);
    }
    if (
      this.sql.includes("subscription_scheduler_state")
      || this.sql.includes("subscription_list_index")
      || this.sql.includes("subscription_tags")
      || this.sql.includes("subscription_user_stats")
    ) {
      return d1Result([], 1);
    }
    return d1Result([], 0);
  }
}

describe("Cloudflare Telegram Bot commands", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset().mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "ses" },
    });
    vi.restoreAllMocks();
  });

  it("declares the D1 binding table without plaintext secret columns", () => {
    const migration = readFileSync(resolve("migrations/0021_telegram_bot_bindings.sql"), "utf8");
    const rebuildMigration = readFileSync(resolve("migrations/0022_rebuild_telegram_bot_bindings.sql"), "utf8");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS telegram_bot_bindings");
    expect(migration).toContain("bot_token_hash");
    expect(migration).toContain("webhook_secret_hash");
    expect(migration).not.toContain("webhook_secret TEXT");
    expect(migration).toContain("UNIQUE REFERENCES users");
    expect(rebuildMigration).toContain("CREATE TABLE telegram_bot_bindings_next");
    expect(rebuildMigration).toContain("SELECT\n  id,\n  user_id,\n  chat_id");
    expect(rebuildMigration).toContain("ALTER TABLE telegram_bot_bindings_next RENAME TO telegram_bot_bindings");
  });

  it("installs, handles webhook commands, and hard deletes the binding", async () => {
    const env = createEnv();
    const telegramCalls = captureTelegramFetch();

    const status = await readTelegramBotCommands(authorizedRequest("/api/app/telegram-bot/commands"), env);
    await expect(readSuccessData(status)).resolves.toMatchObject({ status: "not_installed", installed: false, configComplete: true });

    await expect(installTelegramBotCommands(authorizedRequest("/api/app/telegram-bot/commands", { method: "POST", url: "http://renewlet.test" }), env))
      .rejects.toMatchObject({ status: 400, code: "TELEGRAM_BOT_HTTPS_REQUIRED" });

    await expect(installTelegramBotCommands(authorizedRequest("/api/app/telegram-bot/commands", { method: "POST", body: "{}" }), env))
      .rejects.toMatchObject({ status: 400, code: "NON_EMPTY_BODY" });

    const install = await installTelegramBotCommands(authorizedRequest("/api/app/telegram-bot/commands", { method: "POST" }), env);

    const installBody = await readSuccessData<Record<string, unknown>>(install);
    expect(installBody).toMatchObject({ status: "installed", installed: true });
    expect(installBody).not.toHaveProperty("commandsVersion");
    expect(env.__state.bindings).toHaveLength(1);
    expect(env.__state.bindings[0]!.bot_token_hash).not.toBe(BOT_TOKEN);
    expect(env.__state.bindings[0]!.webhook_secret_hash).not.toBe(SECRET_TOKEN);
    expect(telegramCalls.map((call) => call.method)).toEqual(["setWebhook", "setMyCommands"]);
    expect(telegramCalls[0]!.body).toMatchObject({
      url: expect.stringMatching(/^https:\/\/renewlet\.test\/api\/telegram\/webhook\/tgb_/),
      allowed_updates: ["message"],
      drop_pending_updates: true,
      max_connections: 1,
      secret_token: SECRET_TOKEN,
    });
    expect(telegramCalls[1]!.body).toMatchObject({ scope: { type: "chat", chat_id: CHAT_ID } });
    const commands = telegramCalls[1]!.body["commands"] as Array<{ command: string; description: string }>;
    expect(commands.map((item) => item.command)).toEqual(["start", "help", "status", "next", "today", "week", "month", "subscriptions", "settings"]);
    expect(commands).not.toContainEqual(expect.objectContaining({ command: "due" }));
    expect(commands).toContainEqual({ command: "status", description: "查看订阅状态摘要" });
    expect(telegramCalls[1]!.body).not.toHaveProperty("language_code");

    env.__state.settingsJson = JSON.stringify(settings({ telegramBotToken: "123456:another-token" }));
    const mismatched = await readTelegramBotCommands(authorizedRequest("/api/app/telegram-bot/commands"), env);
    await expect(readSuccessData(mismatched)).resolves.toMatchObject({
      status: "not_installed",
      installed: false,
    });
    env.__state.settingsJson = JSON.stringify(settings());

    await expect(updateSettings(authorizedRequest("/api/app/settings", { method: "PUT", body: JSON.stringify({ telegramChatId: "99999" }) }), env))
      .rejects.toMatchObject({ status: 400, code: "TELEGRAM_BOT_COMMANDS_INSTALLED" });

    const binding = env.__state.bindings[0]!;
    const badSecret = await telegramWebhook(webhookRequest(binding.id, "wrong-secret", { update_id: 1, message: { chat: { id: Number(CHAT_ID) }, text: "/status" } }), env, binding.id);
    expect(badSecret.status).toBe(401);

    const statusWebhook = await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 1, message: { chat: { id: Number(CHAT_ID) }, text: "/status" } }), env, binding.id);
    expect(statusWebhook.status).toBe(200);
    expect(telegramCalls.map((call) => call.method)).toEqual(["setWebhook", "setMyCommands", "sendMessage"]);
    expect(telegramCalls[2]!.body).toMatchObject({
      chat_id: CHAT_ID,
      link_preview_options: { is_disabled: true },
    });
    expect(telegramCalls[2]!.body).not.toHaveProperty("parse_mode");
    expect(String(telegramCalls[2]!.body["text"])).toContain("总数：2");
    expect(binding.last_update_id).toBe(1);
    expect(binding.last_used_at).not.toBeNull();

    await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 1, message: { chat: { id: Number(CHAT_ID) }, text: "/status" } }), env, binding.id);
    expect(telegramCalls).toHaveLength(3);
    const foreignQueryStart = env.__state.queries.length;
    await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 2, message: { chat: { id: 99999 }, text: "/subscriptions" } }), env, binding.id);
    expect(telegramCalls).toHaveLength(3);
    expect(binding.last_update_id).toBe(1);
    expect(sqlSince(env, foreignQueryStart)).not.toContain("SELECT settings_json FROM settings");
    expect(sqlSince(env, foreignQueryStart)).not.toContain("UPDATE telegram_bot_bindings");
    const nonCommandQueryStart = env.__state.queries.length;
    await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 2, message: { chat: { id: Number(CHAT_ID) }, text: "hello" } }), env, binding.id);
    expect(telegramCalls).toHaveLength(3);
    expect(binding.last_update_id).toBe(1);
    expect(sqlSince(env, nonCommandQueryStart)).not.toContain("SELECT settings_json FROM settings");
    expect(sqlSince(env, nonCommandQueryStart)).not.toContain("UPDATE telegram_bot_bindings");
    await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 3, message: { chat: { id: Number(CHAT_ID) }, text: "/subscriptions" } }), env, binding.id);
    expect(telegramCalls).toHaveLength(4);
    expect(String(telegramCalls[3]!.body["text"])).toContain("Active Plan");
    expect(binding.last_update_id).toBe(3);
    const dueQueryStart = env.__state.queries.length;
    await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 4, message: { chat: { id: Number(CHAT_ID) }, text: "/due 30abc" } }), env, binding.id);
    expect(telegramCalls).toHaveLength(5);
    expect(String(telegramCalls[4]!.body["text"])).toContain("未来 30 天续费");
    expect(countSql(sqlSince(env, dueQueryStart), "SELECT settings_json FROM settings")).toBe(1);
    await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 5, message: { chat: { id: Number(CHAT_ID) }, text: "/due 367" } }), env, binding.id);
    expect(telegramCalls).toHaveLength(6);
    expect(String(telegramCalls[5]!.body["text"])).toContain("未来 366 天续费");

    const deleted = await deleteTelegramBotCommands(authorizedRequest("/api/app/telegram-bot/commands", { method: "DELETE" }), env);
    expect(deleted.status).toBe(200);
    expect(telegramCalls.slice(-2).map((call) => call.method)).toEqual(["deleteWebhook", "deleteMyCommands"]);
    expect(env.__state.bindings).toHaveLength(0);
  });

  it("sends HTML replies only after escaping subscription content", async () => {
    const env = createEnv({
      settingsJson: JSON.stringify(settings({ telegramMessageFormat: "html" })),
      subscriptions: [subscriptionRow({ id: "sub_html", name: `A&B <Pro> "Plan"` })],
    });
    const telegramCalls = captureTelegramFetch();
    await installTelegramBotCommands(authorizedRequest("/api/app/telegram-bot/commands", { method: "POST" }), env);
    const binding = env.__state.bindings[0]!;

    const response = await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 1, message: { chat: { id: Number(CHAT_ID) }, text: "/subscriptions" } }), env, binding.id);

    expect(response.status).toBe(200);
    expect(telegramCalls).toHaveLength(3);
    expect(telegramCalls[2]!.body).toMatchObject({ parse_mode: "HTML" });
    expect(String(telegramCalls[2]!.body["text"])).toContain("A&amp;B &lt;Pro&gt; &quot;Plan&quot;");
    expect(String(telegramCalls[2]!.body["text"])).not.toContain("<Pro>");
    await telegramWebhook(webhookRequest(binding.id, SECRET_TOKEN, { update_id: 2, message: { chat: { id: Number(CHAT_ID) }, text: "/status" } }), env, binding.id);
    expect(telegramCalls).toHaveLength(4);
    expect(String(telegramCalls[3]!.body["text"])).toContain("总数：<b>1</b>");
  });
});

type AuthorizedRequestInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string>; url?: string };

function authorizedRequest(path: string, init: AuthorizedRequestInit = {}): Request {
  const method = init.method ?? "GET";
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  const requestInit: RequestInit = {
    method,
    headers: {
      cookie: "renewlet_session=session-token; renewlet_csrf=csrf-token",
      "content-type": "application/json",
      "x-renewlet-locale": "en-US",
      ...(unsafe ? { origin: "https://renewlet.test", "x-renewlet-csrf": "csrf-token" } : {}),
      ...init.headers,
    },
  };
  if (init.body !== undefined) requestInit.body = init.body;
  return new Request(init.url ?? `https://renewlet.test${path}`, requestInit);
}

function sqlSince(env: Env & { __state: TelegramBotTestState }, start: number): string {
  return env.__state.queries.slice(start).join("\n");
}

function countSql(sql: string, fragment: string): number {
  return sql.split(fragment).length - 1;
}

function webhookRequest(bindingId: string, secret: string, body: unknown): Request {
  return new Request(`https://renewlet.test/api/telegram/webhook/${bindingId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(body),
  });
}

function captureTelegramFetch(): Array<{ method: string; body: Record<string, unknown> }> {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: url.slice(url.lastIndexOf("/") + 1),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
  return calls;
}

function subscriptionRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_telegram",
    user_id: USER_ID,
    name: "Telegram Plan",
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
    payment_method: null,
    start_date: "2026-01-01",
    next_billing_date: "2026-07-01",
    auto_renew: 1,
    auto_calculate_next_billing_date: 1,
    trial_end_date: null,
    website: null,
    notes: null,
    tags_json: "[]",
    reminder_days: 3,
    repeat_reminder_enabled: 0,
    repeat_reminder_interval: "24h",
    repeat_reminder_window: "24h",
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}
