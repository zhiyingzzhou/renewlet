import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { apiSubscriptionSchema, type ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { collectNotificationItemsForLocalDate, notificationHistory, runScheduledNotifications } from "./notifications";
import { readSuccessData } from "./api-test-helpers";
import { createCronJobResult } from "./notification-jobs";
import { sendServerChan, serverChanEndpoint } from "./notification-serverchan";
import { notificationChannelErrorDetails } from "./notification-errors";
import type { Env, NotificationJobRow, SubscriptionRow } from "./types";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./smtp", () => ({
  notificationSmtpConfig: () => {
    throw new Error("SMTP should not be used by notification collection tests");
  },
  sendSmtpEmail: async () => undefined,
}));

type FakeD1Query = {
  sql: string;
  params: unknown[];
  method: "all" | "first" | "run";
};

type FakeSchedulerState = {
  autoRenewCount?: number;
  repeatReminderCount?: number;
  lastAutoRenewLocalDate?: string;
};

// 这个 D1 mock 保留 prepare/bind/all/first/run 形状，让用例能验证 SQL 阶段和参数边界，而不是只测纯函数。
function fakeEnv(handler: (query: FakeD1Query) => unknown | Promise<unknown>, options: { schedulerState?: FakeSchedulerState } = {}): Env {
  return {
    DB: {
      async batch(statements: D1PreparedStatement[]) {
        const results: D1Result[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => await handleFakeD1({ sql, params, method: "all" }, handler, options.schedulerState),
              first: async () => await handleFakeD1({ sql, params, method: "first" }, handler, options.schedulerState),
              run: async () => await handleFakeD1({ sql, params, method: "run" }, handler, options.schedulerState),
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
}

async function handleFakeD1(
  query: FakeD1Query,
  handler: (query: FakeD1Query) => unknown | Promise<unknown>,
  state: FakeSchedulerState | undefined,
): Promise<unknown> {
  if (query.method === "first" && query.sql.includes("FROM subscription_scheduler_state")) {
    return {
      user_id: String(query.params[0] ?? "usr_due"),
      auto_renew_count: state?.autoRenewCount ?? 1,
      repeat_reminder_count: state?.repeatReminderCount ?? 1,
      last_auto_renew_local_date: state?.lastAutoRenewLocalDate ?? "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
  }
  if (query.method === "first" && query.sql.includes("SUM(CASE WHEN auto_renew")) {
    return {
      auto_renew_count: state?.autoRenewCount ?? 0,
      repeat_reminder_count: state?.repeatReminderCount ?? 0,
    };
  }
  if (query.method === "run" && query.sql.includes("subscription_scheduler_state")) {
    return d1Run(1);
  }
  if (query.method === "run" && (
    query.sql.includes("notification_job_messages")
    || query.sql.includes("subscription_list_index")
    || query.sql.includes("subscription_tags")
    || query.sql.includes("subscription_repeat_schedule")
    || query.sql.includes("subscription_user_stats")
  )) {
    return d1Run(1);
  }
  if (query.method === "all" && query.params.length === 1 && query.sql.includes("FROM subscriptions") && query.sql.includes("WHERE user_id = ?") && query.sql.includes("ORDER BY created_at DESC, id DESC")) {
    return d1All([]);
  }
  return await handler(query);
}

function d1All<T>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} as D1Meta } as D1Result<T>;
}

function d1Run(changes = 0): D1Result {
  return { results: [], success: true, meta: { changes } } as unknown as D1Result;
}

function settings(overrides: Partial<ApiAppSettings> = {}): ApiAppSettings {
  return {
    ...createDefaultAppSettings(),
    timezone: "UTC",
    notificationTimeLocal: "08:00" as ApiAppSettings["notificationTimeLocal"],
    ...overrides,
  };
}

function subscription(overrides: Partial<ApiSubscription> = {}): ApiSubscription {
  return apiSubscriptionSchema.parse({
    id: "sub_quiet",
    name: "Quiet SaaS",
    price: "10",
    currency: "USD",
    billingCycle: "monthly",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    startDate: "2026-01-01",
    nextBillingDate: "2026-01-10",
    autoRenew: true,
    autoCalculateNextBillingDate: true,
    tags: [],
    reminderDays: 0,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    ...overrides,
  });
}

function subscriptionRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_due",
    user_id: "usr_due",
    name: "Apple",
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
    start_date: "2026-01-01",
    next_billing_date: "2026-01-10",
    auto_renew: 1,
    auto_calculate_next_billing_date: 1,
    trial_end_date: null,
    website: null,
    notes: null,
    tags_json: "[]",
    reminder_days: 1,
    repeat_reminder_enabled: 0,
    repeat_reminder_interval: "1h",
    repeat_reminder_window: "72h",
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function notificationJobRow(overrides: Partial<NotificationJobRow> = {}): NotificationJobRow {
  return {
    id: "job_due",
    user_id: "usr_due",
    scheduled_local_date: "2026-01-09",
    scheduled_local_time: "08:00",
    time_zone: "UTC",
    scheduled_instant_utc: "2026-01-09T08:00:00Z",
    status: "pending",
    attempts: 0,
    last_error: null,
    result_json: "{}",
    created_at: "2026-01-09T08:00:00.000Z",
    updated_at: "2026-01-09T08:00:00.000Z",
    ...overrides,
  };
}

function cronResultWithDecisionSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "cron",
    reason: "no_due_items",
    force: false,
    windowMinutes: 2,
    triggeredAtUtc: "2026-01-09T08:00:00Z",
    schedule: {
      scheduledLocalDate: "2026-01-09",
      scheduledLocalTime: "08:00",
      timeZone: "UTC",
      scheduledInstantUtc: "2026-01-09T08:00:00Z",
      due: true,
      reason: "not_in_time_window(delta=0m)",
    },
    settings: {
      timezone: "UTC",
      locale: "zh-CN",
      notificationTimeLocal: "08:00",
      enabledChannels: [],
      showExpired: true,
    },
    message: {
      title: "Renewlet 订阅提醒",
      content: "今天没有需要提醒的订阅。",
      timestamp: "2026-01-09 08:00:00 UTC",
      hasPayload: false,
      items: [],
    },
    channels: {
      attempted: [],
      succeeded: [],
      failed: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cloudflare notifications", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    authMocks.requireAuth.mockResolvedValue({
      user: { id: "usr_due", role: "admin" },
      session: { id: "ses" },
    });
  });

  it("skips subscriptions with disabled reminders", () => {
    const items = collectNotificationItemsForLocalDate(
      "2026-01-10",
      { ...createDefaultAppSettings(), timezone: "UTC", showExpired: false },
      [subscription({ reminderDays: -2 })],
    );

    expect(items).toEqual([]);
  });

  it("persists cron result schedules without internal decision fields", () => {
    const schedule = {
      scheduledLocalDate: "2026-01-09",
      scheduledLocalTime: "08:00",
      timeZone: "UTC",
      scheduledInstantUtc: "2026-01-09T08:00:00Z",
      due: true,
      reason: "not_in_time_window(delta=0m)",
    };
    const result = createCronJobResult({
      reason: "no_due_items",
      force: false,
      windowMinutes: 2,
      triggeredAtUtc: "2026-01-09T08:00:00Z",
      schedule,
      settings: settings({ localePreference: "zh-CN" }),
      locale: "zh-CN",
      message: {
        title: "Renewlet 订阅提醒",
        content: "今天没有需要提醒的订阅。",
        timestamp: "2026-01-09 08:00:00 UTC",
        hasPayload: false,
        items: [],
      },
      channels: { attempted: [], succeeded: [], failed: [] },
    }) as { schedule: Record<string, unknown> };

    expect(result.schedule).toEqual({
      scheduledLocalDate: "2026-01-09",
      scheduledLocalTime: "08:00",
      timeZone: "UTC",
      scheduledInstantUtc: "2026-01-09T08:00:00Z",
    });
    expect(result.schedule).not.toHaveProperty("due");
    expect(result.schedule).not.toHaveProperty("reason");
  });

  it("drops legacy notification history results with internal decision fields", async () => {
    const legacyJob = notificationJobRow({
      status: "skipped",
      attempts: 1,
      last_error: null,
      result_json: JSON.stringify(cronResultWithDecisionSchedule()),
    });
    const queries: FakeD1Query[] = [];
    const env = fakeEnv((query) => {
      queries.push(query);
      const { sql, method } = query;
      if (method === "all" && sql.includes("FROM notification_jobs")) return d1All([{ ...legacyJob, chunk_index: null, content: null }]);
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    const response = await notificationHistory(new Request("https://renewlet.test/api/app/notifications/history?status=all&limit=20&offset=0", {
      headers: { authorization: "Bearer test" },
    }), env);
    const body = await readSuccessData<{ jobs: Array<{ result: Record<string, unknown> }> }>(response);

    expect(response.status).toBe(200);
    expect(body.jobs[0]?.result).toEqual({});
    expect(queries.filter(({ sql }) => /\bFROM\s+subscriptions\b/i.test(sql))).toHaveLength(0);
  });

  it("logs and rejects top-level scheduled failures without leaking secrets", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = fakeEnv(({ sql }) => {
      if (sql.includes("FROM subscription_scheduler_state AS scheduler")) {
        throw new Error("database is locked SCTsecret Bearer abc.def");
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).rejects.toThrow("database is locked [redacted] Bearer [redacted]");

    expect(errorSpy).toHaveBeenCalledWith("scheduled_notifications_failed", expect.objectContaining({
      event: "scheduled_notifications_failed",
      phase: "list_due_users",
      error: { name: "Error", message: "database is locked [redacted] Bearer [redacted]" },
    }));
  });

  it("continues scheduled cron after one user fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:00:00.000Z"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seenSettingsUsers: string[] = [];
    // Cron 顶层按用户隔离失败；坏用户只写脱敏日志，不能阻断后续用户的通知窗口。
    const env = fakeEnv(({ sql, params, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) {
        return d1All([{ user_id: "usr_bad" }, { user_id: "usr_ok" }]);
      }
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        const userId = String(params[0]);
        seenSettingsUsers.push(userId);
        if (userId === "usr_bad") throw new Error("settings broken SCTsecret");
        return { settings_json: JSON.stringify(settings({ notificationTimeLocal: "09:59" as ApiAppSettings["notificationTimeLocal"] })) };
      }
      if (method === "all" && sql.includes("auto_renew = 1")) {
        return d1All([]);
      }
      if (method === "all" && sql.includes("FROM subscriptions")) {
        return d1All([]);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(seenSettingsUsers).toEqual(expect.arrayContaining(["usr_bad", "usr_ok"]));
    expect(errorSpy).toHaveBeenCalledWith("scheduled_notifications_failed", expect.objectContaining({
      event: "scheduled_notifications_failed",
      phase: "run_user",
      userId: "usr_bad",
      error: { name: "Error", message: "settings broken [redacted]" },
    }));
  });

  it("keeps ServerChan business failures summarized inside the cron job history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:00:00.000Z"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 40001,
      message: "SCTsecret disabled",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    let finalizeParams: unknown[] | null = null;
    // 渠道业务失败属于单个 notification_jobs 结果，不能升级成顶层 scheduled failure 或泄露 sendkey。
    const env = fakeEnv(({ sql, params, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) {
        return d1All([{ user_id: "usr_due" }]);
      }
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({ enabledChannels: ["serverchan"], serverchanSendKey: "SCTsecret" })) };
      }
      if (method === "all" && sql.includes("FROM subscriptions")) {
        return d1All([subscriptionRow()]);
      }
      if (method === "first" && sql.includes("FROM notification_jobs")) {
        return null;
      }
      if (method === "run" && sql.includes("INSERT OR IGNORE INTO notification_jobs")) {
        return d1Run(1);
      }
      if (method === "run" && sql.includes("UPDATE notification_jobs SET status")) {
        finalizeParams = params;
        return d1Run(1);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      title: "Renewlet subscription reminder",
    });
    expect(finalizeParams?.[0]).toBe("failed");
    expect(finalizeParams?.[1]).toBe(1);
    expect(String(finalizeParams?.[2])).toContain("[redacted] disabled");
    expect(String(finalizeParams?.[2])).not.toContain("SCTsecret");
    const result = JSON.parse(String(finalizeParams?.[3])) as {
      schedule: Record<string, unknown>;
      settings: { locale: string };
      channels: { failed: Array<{ channel: string; error: string }> };
    };
    expect(result.schedule).toEqual({
      scheduledLocalDate: "2026-01-09",
      scheduledLocalTime: "08:00",
      timeZone: "UTC",
      scheduledInstantUtc: "2026-01-09T08:00:00Z",
    });
    expect(result.schedule).not.toHaveProperty("due");
    expect(result.schedule).not.toHaveProperty("reason");
    expect(result.settings.locale).toBe("en-US");
    expect(result.channels.failed[0]?.channel).toBe("serverchan");
    expect(result.channels.failed[0]?.error).toContain("[redacted] disabled");
    expect(result.channels.failed[0]?.error).not.toContain("SCTsecret");
    expect(JSON.stringify(result)).not.toContain("providerResponse");
  });

  it("renews automatic subscriptions before building scheduled notification content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:00:00.000Z"));
    const events: string[] = [];
    let renewalSelectSql = "";
    let renewalUpdateParams: unknown[] | null = null;
    let finalizeParams: unknown[] | null = null;
    const env = fakeEnv(({ sql, params, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) {
        return d1All([{ user_id: "usr_due" }]);
      }
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({ enabledChannels: [], showExpired: true })) };
      }
      if (method === "run" && sql.includes("INSERT OR IGNORE INTO notification_jobs")) {
        return d1Run(1);
      }
      if (method === "all" && sql.includes("auto_renew = 1")) {
        renewalSelectSql = sql;
        events.push("renewal-maintenance");
        return d1All([subscriptionRow({
          start_date: "2026-01-08",
          next_billing_date: "2026-01-08",
          auto_renew: 1,
        })]);
      }
      if (method === "run" && sql.includes("UPDATE subscriptions SET next_billing_date")) {
        renewalUpdateParams = params;
        return d1Run(1);
      }
      if (method === "all" && sql.includes("FROM subscriptions") && sql.includes("AND cost_sharing_collection_reminder_enabled = 1")) {
        events.push("notification-content");
        return d1All([subscriptionRow({
          start_date: "2026-01-08",
          next_billing_date: "2026-02-08",
          auto_renew: 1,
        })]);
      }
      if (method === "all" && sql.includes("FROM subscriptions")) {
        return d1All([]);
      }
      if (method === "first" && sql.includes("FROM notification_jobs")) {
        return null;
      }
      if (method === "run" && sql.includes("INSERT OR IGNORE INTO notification_jobs")) {
        return d1Run(1);
      }
      if (method === "run" && sql.includes("UPDATE notification_jobs SET status")) {
        finalizeParams = params;
        return d1Run(1);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(events).toEqual(["renewal-maintenance", "notification-content"]);
    expect(renewalSelectSql).toContain("billing_cycle IN");
    expect(renewalUpdateParams?.[0]).toBe("2026-02-08");
    expect(finalizeParams?.[0]).toBe("skipped");
  });

  it("marks partial channel failures as failed cron jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:00:00.000Z"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, message: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    let finalizeParams: unknown[] | null = null;
    const env = fakeEnv(({ sql, params, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) {
        return d1All([{ user_id: "usr_due" }]);
      }
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({ enabledChannels: ["serverchan", "telegram"], serverchanSendKey: "SCT123456" })) };
      }
      if (method === "all" && sql.includes("auto_renew = 1")) return d1All([]);
      if (method === "all" && sql.includes("FROM subscriptions")) return d1All([subscriptionRow()]);
      if (method === "first" && sql.includes("FROM notification_jobs")) return null;
      if (method === "run" && sql.includes("INSERT OR IGNORE INTO notification_jobs")) return d1Run(1);
      if (method === "run" && sql.includes("UPDATE notification_jobs SET status")) {
        finalizeParams = params;
        return d1Run(1);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(finalizeParams?.[0]).toBe("failed");
    const result = JSON.parse(String(finalizeParams?.[3])) as { channels: { succeeded: string[]; failed: Array<{ channel: string }> } };
    expect(result.channels.succeeded).toEqual(["serverchan"]);
    expect(result.channels.failed.map((failure) => failure.channel)).toEqual(["telegram"]);
  });

  it("retries only failed channels for failed cron jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:01:00.000Z"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let markSendingParams: unknown[] | null = null;
    let finalizeParams: unknown[] | null = null;
    const existing = notificationJobRow({
      status: "failed",
      attempts: 1,
      result_json: JSON.stringify({
        source: "cron",
        channels: {
          attempted: ["serverchan", "telegram"],
          succeeded: ["serverchan"],
          failed: [{ channel: "telegram", error: "old telegram failure" }],
        },
      }),
      updated_at: "2026-01-09T08:00:00.000Z",
    });
    const env = fakeEnv(({ sql, params, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) return d1All([{ user_id: "usr_due" }]);
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({ enabledChannels: ["serverchan", "telegram"], serverchanSendKey: "SCT123456" })) };
      }
      if (method === "all" && sql.includes("auto_renew = 1")) return d1All([]);
      if (method === "all" && sql.includes("FROM subscriptions")) return d1All([subscriptionRow()]);
      if (method === "first" && sql.includes("FROM notification_jobs")) return existing;
      if (method === "run" && sql.includes("SET status = 'sending'")) {
        markSendingParams = params;
        return d1Run(1);
      }
      if (method === "run" && sql.includes("UPDATE notification_jobs SET status")) {
        finalizeParams = params;
        return d1Run(1);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markSendingParams?.[0]).toBe(2);
    expect(finalizeParams?.[0]).toBe("failed");
    expect(finalizeParams?.[1]).toBe(2);
    const result = JSON.parse(String(finalizeParams?.[3])) as { channels: { succeeded: string[]; failed: Array<{ channel: string }> } };
    expect(result.channels.succeeded).toEqual(["serverchan"]);
    expect(result.channels.failed.map((failure) => failure.channel)).toEqual(["telegram"]);
  });

  it("does not take over fresh sending cron jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:02:00.000Z"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const writes: string[] = [];
    const env = fakeEnv(({ sql, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) return d1All([{ user_id: "usr_due" }]);
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({ enabledChannels: ["serverchan"], serverchanSendKey: "SCT123456" })) };
      }
      if (method === "all" && sql.includes("auto_renew = 1")) return d1All([]);
      if (method === "all" && sql.includes("FROM subscriptions")) return d1All([subscriptionRow()]);
      if (method === "first" && sql.includes("FROM notification_jobs")) {
        return notificationJobRow({ status: "sending", attempts: 1, updated_at: "2026-01-09T07:58:00.000Z" });
      }
      if (method === "run") {
        writes.push(sql);
        return d1Run(1);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("takes over stale sending cron jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:02:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    let markSendingParams: unknown[] | null = null;
    let finalizeParams: unknown[] | null = null;
    const env = fakeEnv(({ sql, params, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) return d1All([{ user_id: "usr_due" }]);
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({ enabledChannels: ["serverchan"], serverchanSendKey: "SCT123456" })) };
      }
      if (method === "all" && sql.includes("auto_renew = 1")) return d1All([]);
      if (method === "all" && sql.includes("FROM subscriptions")) return d1All([subscriptionRow()]);
      if (method === "first" && sql.includes("FROM notification_jobs")) {
        return notificationJobRow({ status: "sending", attempts: 1, updated_at: "2026-01-09T07:40:00.000Z" });
      }
      if (method === "run" && sql.includes("SET status = 'sending'")) {
        markSendingParams = params;
        return d1Run(1);
      }
      if (method === "run" && sql.includes("UPDATE notification_jobs SET status")) {
        finalizeParams = params;
        return d1Run(1);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(markSendingParams?.[0]).toBe(2);
    expect(finalizeParams?.[0]).toBe("sent");
    expect(finalizeParams?.[1]).toBe(2);
  });

  it("builds ServerChan endpoints for Turbo and ServerChan 3 SendKeys", () => {
    expect(serverChanEndpoint("SCT123456")).toBe("https://sctapi.ftqq.com/SCT123456.send");
    expect(serverChanEndpoint("sctp123tabcdef")).toBe("https://123.push.ft07.com/send/sctp123tabcdef.send");
    expect(() => serverChanEndpoint("sctpabcdef", "zh-CN")).toThrow("Server酱 SendKey 格式无效");
  });

  it("sends ServerChan JSON payloads and requires code zero", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://sctapi.ftqq.com/SCT123456.send");
      expect(init?.method).toBe("POST");
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({
        title: "Renewlet test",
        desp: "Channel works\n\n2026-05-14 08:00 UTC",
      });
      return new Response(JSON.stringify({ code: 0, message: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendServerChan(
      { ...createDefaultAppSettings(), serverchanSendKey: "SCT123456" },
      { title: "Renewlet test", content: "Channel works", timestamp: "2026-05-14 08:00 UTC", hasPayload: true, items: [] },
      "zh-CN",
    )).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends ServerChan 3 SendKeys to the derived ft07 host", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("https://456.push.ft07.com/send/sctp456tabcdef.send");
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendServerChan(
      { ...createDefaultAppSettings(), serverchanSendKey: "sctp456tabcdef" },
      { title: "Renewlet test", content: "Channel works", timestamp: "2026-05-14 08:00 UTC", hasPayload: true, items: [] },
      "zh-CN",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats ServerChan business failures as channel errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 40001,
      message: "SCTsecret disabled",
      detail: "secret should not appear",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(sendServerChan(
      { ...createDefaultAppSettings(), serverchanSendKey: "SCTsecret" },
      { title: "Renewlet test", content: "Channel works", timestamp: "2026-05-14 08:00 UTC", hasPayload: true, items: [] },
      "zh-CN",
    )).rejects.toThrow("[redacted] disabled");
  });

  it("keeps raw ServerChan HTTP failures in upstream details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("SCTsecret upstream", { status: 502, statusText: "Bad Gateway" })));

    let error: unknown;
    await sendServerChan(
      { ...createDefaultAppSettings(), serverchanSendKey: "SCTsecret" },
      { title: "Renewlet test", content: "Channel works", timestamp: "2026-05-14 08:00 UTC", hasPayload: true, items: [] },
      "zh-CN",
    ).catch((caught: unknown) => {
      error = caught;
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("[redacted] upstream");
    const details = notificationChannelErrorDetails(error);
    expect(details).toMatchObject({
      rawResponseText: "[redacted] upstream",
    });
    expect(JSON.stringify(details)).not.toContain("SCTsecret");
  });

  it("keeps malformed ServerChan success responses in upstream details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("SCTsecret raw response", { status: 200 })));

    let error: unknown;
    await sendServerChan(
      { ...createDefaultAppSettings(), serverchanSendKey: "SCTsecret" },
      { title: "Renewlet test", content: "Channel works", timestamp: "2026-05-14 08:00 UTC", hasPayload: true, items: [] },
      "zh-CN",
    ).catch((caught: unknown) => {
      error = caught;
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("[redacted] raw response");
    const details = notificationChannelErrorDetails(error);
    expect(details).toMatchObject({
      rawResponseText: "[redacted] raw response",
    });
    expect(JSON.stringify(details)).not.toContain("SCTsecret");
  });

});
