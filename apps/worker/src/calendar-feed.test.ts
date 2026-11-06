// Worker 日历 Feed 测试保护 D1 token scope、公开 ICS 路由和撤销语义，必须与 Go 后端行为保持一致。
import { describe, expect, it } from "vitest";
import labelFixtures from "../../../packages/shared/src/contract-fixtures/config-label-locales.json";
import { readSuccessData } from "./api-test-helpers";
import {
  calendarFeedIcs,
  createCalendarFeed,
  createSubscriptionCalendarFeed,
  deleteCalendarFeed,
  deleteSubscriptionCalendarFeed,
  downloadSubscriptionCalendarIcs,
  readCalendarFeed,
} from "./calendar-feed";
import {
  authorizedCalendarFeedRequest as authorizedRequest,
  calendarFeedRow,
  createCalendarFeedTestCustomConfig,
  createCalendarFeedTestEnv,
  subscriptionRow,
} from "./calendar-feed-test-env";

function expectCalendarIcsLineEndings(value: string) {
  expect(value).toContain("\r\n");
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      expect(value[index - 1], `bare LF at index ${index}`).toBe("\r");
    }
  }
}

function unfoldIcsText(value: string): string {
  return value.replace(/\r\n[ \t]/g, "");
}

function calendarEventSection(ics: string, marker: string): string {
  const index = ics.indexOf(marker);
  expect(index, `expected ICS to contain ${marker}`).toBeGreaterThanOrEqual(0);
  const start = ics.lastIndexOf("BEGIN:VEVENT", index);
  const end = ics.indexOf("END:VEVENT", index);
  expect(start, `expected ${marker} to be inside VEVENT`).toBeGreaterThanOrEqual(0);
  expect(end, `expected ${marker} to be inside VEVENT`).toBeGreaterThanOrEqual(0);
  return ics.slice(start, end + "END:VEVENT".length);
}

describe("calendar feed worker handlers", () => {
  it("creates a reusable global feed, returns the URL on status, renders filtered ICS by token, and revokes the URL", async () => {
    const env = await createCalendarFeedTestEnv();
    env.__state.subscriptions[0]!.balance = "987654321.123456";
    env.__state.subscriptions[0]!.balance_currency = "EUR";
    const request = authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      headers: { "accept-language": "en-US", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
      method: "POST",
    });

    const createResponse = await createCalendarFeed(request, env);
    expect(createResponse.status).toBe(200);
    expect(createResponse.headers.get("cache-control")).toBe("no-store");
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string; enabled: boolean } }>(createResponse);
    expect(created.calendarFeed.enabled).toBe(true);
    expect(created.calendarFeed.feedUrl).toMatch(/^https:\/\/renewlet\.example\/calendar\/renewals\.ics\?token=/);

    const token = new URL(created.calendarFeed.feedUrl).searchParams.get("token") ?? "";
    expect(token).not.toBe("");
    const storedFeed = env.__state.feeds[0];
    expect(storedFeed?.scope).toBe("all");
    expect(storedFeed?.token).toBe(token);

    const statusResponse = await readCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed"), env);
    expect(statusResponse.headers.get("cache-control")).toBe("no-store");
    const status = await readSuccessData<{ calendarFeed: Record<string, unknown> }>(statusResponse);
    expect(status.calendarFeed).toMatchObject({ enabled: true, feedUrl: created.calendarFeed.feedUrl });

    const icsResponse = await calendarFeedIcs(new Request(created.calendarFeed.feedUrl), env);
    expect(icsResponse.status).toBe(200);
    const ics = await icsResponse.text();
    const unfoldedIcs = unfoldIcsText(ics);
    expectCalendarIcsLineEndings(ics);
    expect(unfoldedIcs).toContain("BEGIN:VCALENDAR");
    expect(unfoldedIcs).not.toMatch(/balance|987654321/i);
    expect(unfoldedIcs).toContain("SUMMARY:Active Plan");
    expect(unfoldedIcs).toContain("SUMMARY:Fixed Term Plan");
    expect(unfoldedIcs).toContain("SUMMARY:Quiet Plan");
    expect(unfoldedIcs).toContain("DTSTART;VALUE=DATE:20990602");
    expect(unfoldedIcs).toContain("DTSTART;VALUE=DATE:20990605");
    expect(unfoldedIcs).toContain("UID:renewlet-expiry-");
    expect(unfoldedIcs).toContain("Category: Developer Tools");
    expect(unfoldedIcs).toContain("Payment method: Credit Card");
    expect(unfoldedIcs).toContain("CATEGORIES:Developer Tools");
    expect(unfoldedIcs).toContain("TRIGGER:-P5D");
    expect(calendarEventSection(unfoldedIcs, "SUMMARY:Quiet Plan")).not.toContain("BEGIN:VALARM");
    expect(unfoldedIcs).not.toContain("developer_tools");
    expect(unfoldedIcs).not.toContain("credit_card");
    expect(unfoldedIcs).not.toContain("Paused Plan");
    expect(unfoldedIcs).not.toContain("Cancelled Plan");
    expect(unfoldedIcs).not.toContain("Expired Plan");
    expect(unfoldedIcs).not.toContain("One Time Plan");

    const rotateResponse = await createCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env);
    const rotated = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(rotateResponse);
    expect(rotated.calendarFeed.feedUrl).toBe(created.calendarFeed.feedUrl);

    const deleteResponse = await deleteCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed", { method: "DELETE" }), env);
    expect(deleteResponse.status).toBe(200);
    await expect(calendarFeedIcs(new Request(rotated.calendarFeed.feedUrl), env)).rejects.toMatchObject({ status: 404 });
  });

  it("creates one reusable subscription-scoped feed token and revokes it", async () => {
    const env = await createCalendarFeedTestEnv();

    const firstResponse = await createSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_paused/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env, "sub_paused");
    const secondResponse = await createSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_paused/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env, "sub_paused");
    const first = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(firstResponse);
    const second = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(secondResponse);

    expect(first.calendarFeed.feedUrl).toBe(second.calendarFeed.feedUrl);
    expect(env.__state.feeds.filter((feed) => feed.scope === "subscription" && feed.subscription_id === "sub_paused")).toHaveLength(1);

    const firstIcs = await (await calendarFeedIcs(new Request(first.calendarFeed.feedUrl), env)).text();
    const secondIcs = await (await calendarFeedIcs(new Request(second.calendarFeed.feedUrl), env)).text();
    const unfoldedFirstIcs = unfoldIcsText(firstIcs);
    const unfoldedSecondIcs = unfoldIcsText(secondIcs);
    expectCalendarIcsLineEndings(firstIcs);
    expectCalendarIcsLineEndings(secondIcs);
    expect(unfoldedFirstIcs).toContain("NAME:Renewlet - Paused Plan");
    expect(unfoldedFirstIcs).toContain("SUMMARY:Paused Plan");
    expect(unfoldedFirstIcs).toContain("Category: Developer Tools");
    expect(unfoldedFirstIcs).toContain("Payment method: Credit Card");
    expect(unfoldedFirstIcs).toContain("CATEGORIES:Developer Tools");
    expect(unfoldedFirstIcs).not.toContain("developer_tools");
    expect(unfoldedFirstIcs).not.toContain("credit_card");
    expect(unfoldedFirstIcs).not.toContain("Active Plan");
    expect(unfoldedSecondIcs).toContain("SUMMARY:Paused Plan");

    const deleteResponse = await deleteSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_paused/calendar-feed", { method: "DELETE" }), env, "sub_paused");
    expect(deleteResponse.status).toBe(200);
    await expect(calendarFeedIcs(new Request(first.calendarFeed.feedUrl), env)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects one-time buyout subscription feeds but accepts fixed-term expiry feeds", async () => {
    const env = await createCalendarFeedTestEnv();

    await expect(createSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_once/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env, "sub_once")).rejects.toMatchObject({ status: 404 });

    const fixedTermResponse = await createSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_fixed_term/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env, "sub_fixed_term");
    expect(fixedTermResponse.status).toBe(200);
    const fixedTerm = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(fixedTermResponse);
    const ics = await (await calendarFeedIcs(new Request(fixedTerm.calendarFeed.feedUrl), env)).text();
    const unfoldedIcs = unfoldIcsText(ics);

    expect(unfoldedIcs).toContain("SUMMARY:Fixed Term Plan");
    expect(unfoldedIcs).toContain("UID:renewlet-expiry-");
    expect(unfoldedIcs).not.toContain("One Time Plan");
  });

  it("downloads authenticated one-off subscription ICS without feed metadata", async () => {
    const env = await createCalendarFeedTestEnv();

    const response = await downloadSubscriptionCalendarIcs(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_paused/calendar.ics"), env, "sub_paused");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="renewlet-sub_paused.ics"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const ics = await response.text();
    const unfoldedIcs = unfoldIcsText(ics);

    expectCalendarIcsLineEndings(ics);
    expect(unfoldedIcs).toContain("NAME:Renewlet - Paused Plan");
    expect(unfoldedIcs).toContain("SUMMARY:Paused Plan");
    expect(unfoldedIcs).toContain("Category: Developer Tools");
    expect(unfoldedIcs).toContain("Payment method: Credit Card");
    expect(unfoldedIcs).toContain("CATEGORIES:Developer Tools");
    expect(unfoldedIcs).not.toContain("SOURCE;VALUE=URI");
    expect(unfoldedIcs).not.toContain("REFRESH-INTERVAL");
    expect(unfoldedIcs).not.toContain("X-PUBLISHED-TTL");
    expect(unfoldedIcs).not.toContain("Active Plan");
  });

  it("rejects non-owner and buyout one-off ICS downloads but accepts fixed-term expiry downloads", async () => {
    const env = await createCalendarFeedTestEnv();
    env.__state.subscriptions.push({
      ...subscriptionRow("sub_other", "Other User Plan", "active", "monthly", "2099-06-05"),
      user_id: "usr_other",
    });

    await expect(downloadSubscriptionCalendarIcs(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_other/calendar.ics"), env, "sub_other"))
      .rejects.toMatchObject({ status: 404 });
    await expect(downloadSubscriptionCalendarIcs(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_once/calendar.ics"), env, "sub_once"))
      .rejects.toMatchObject({ status: 404 });

    const fixedTermResponse = await downloadSubscriptionCalendarIcs(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_fixed_term/calendar.ics"), env, "sub_fixed_term");
    expect(fixedTermResponse.status).toBe(200);
    const fixedTermIcs = unfoldIcsText(await fixedTermResponse.text());
    expect(fixedTermIcs).toContain("SUMMARY:Fixed Term Plan");
    expect(fixedTermIcs).toContain("UID:renewlet-expiry-");
  });

  it("does not create the feed table when downloading authenticated one-off ICS", async () => {
    const env = await createCalendarFeedTestEnv({ calendarFeedsTableExists: false });

    const response = await downloadSubscriptionCalendarIcs(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_paused/calendar.ics"), env, "sub_paused");

    expect(response.status).toBe(200);
    expect(env.__state.calendarFeedsTableExists).toBe(false);
  });

  it("returns a valid empty ICS when a downloaded subscription has an invalid date-only value", async () => {
    const env = await createCalendarFeedTestEnv({
      subscriptions: [
        subscriptionRow("sub_invalid_date", "Invalid Date Plan", "active", "monthly", "not-a-date"),
      ],
    });

    const response = await downloadSubscriptionCalendarIcs(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_invalid_date/calendar.ics"), env, "sub_invalid_date");
    const ics = await response.text();

    expect(response.status).toBe(200);
    expectCalendarIcsLineEndings(ics);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("rejects subscription-scoped feed creation for another user's subscription", async () => {
    const env = await createCalendarFeedTestEnv();
    env.__state.subscriptions.push({
      ...subscriptionRow("sub_other", "Other User Plan", "active", "monthly", "2099-06-05"),
      user_id: "usr_other",
    });

    await expect(createSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_other/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env, "sub_other")).rejects.toMatchObject({ status: 404 });
  });

  it("returns 404 when a subscription-scoped feed points at a removed subscription", async () => {
    const env = await createCalendarFeedTestEnv();
    const response = await createSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_active/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env, "sub_active");
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(response);

    env.__state.subscriptions = env.__state.subscriptions.filter((subscription) => subscription.id !== "sub_active");

    await expect(calendarFeedIcs(new Request(created.calendarFeed.feedUrl), env)).rejects.toMatchObject({ status: 404 });
  });

  it("self-repairs a missing calendar feed table before creating a feed", async () => {
    const env = await createCalendarFeedTestEnv({ calendarFeedsTableExists: false });
    const request = authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      headers: { "accept-language": "en-US" },
      method: "POST",
    });

    const createResponse = await createCalendarFeed(request, env);
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string; enabled: boolean } }>(createResponse);

    expect(createResponse.status).toBe(200);
    expect(created.calendarFeed.enabled).toBe(true);
    expect(env.__state.calendarFeedsTableExists).toBe(true);
    expect(env.__state.calendarFeedScopedSchema).toBe(true);
    expect(env.__state.feeds).toHaveLength(1);
  });

  it("self-repairs a legacy hash-only calendar feed table by dropping unrecoverable old feeds", async () => {
    const env = await createCalendarFeedTestEnv({
      calendarFeedScopedSchema: false,
      feeds: [calendarFeedRow({
        id: "",
        scope: "all",
        subscription_id: null,
        token: "legacy-token",
      })],
    });

    const response = await createSubscriptionCalendarFeed(authorizedRequest("https://renewlet.example/api/app/subscriptions/sub_active/calendar-feed", {
      body: "{}",
      method: "POST",
    }), env, "sub_active");

    expect(response.status).toBe(200);
    expect(env.__state.calendarFeedScopedSchema).toBe(true);
    expect(env.__state.feeds.some((feed) => feed.scope === "all" && feed.token === "legacy-token")).toBe(false);
    expect(env.__state.feeds.some((feed) => feed.scope === "subscription" && feed.subscription_id === "sub_active")).toBe(true);
  });

  it("returns a stable migration-required error when the calendar feed table cannot be repaired", async () => {
    const env = await createCalendarFeedTestEnv({
      calendarFeedSchemaError: new Error("D1_ERROR: permission denied"),
      calendarFeedsTableExists: false,
    });
    const request = authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      headers: { "accept-language": "en-US" },
      method: "POST",
    });

    await expect(createCalendarFeed(request, env)).rejects.toMatchObject({
      code: "MIGRATION_REQUIRED",
      message: "Calendar feed storage is not ready. Re-run the Cloudflare D1 migrations and try again.",
      status: 500,
    });
    expect(env.__state.feeds).toHaveLength(0);
  });

  it("does not create the calendar feed table from the public ICS endpoint", async () => {
    const env = await createCalendarFeedTestEnv({ calendarFeedsTableExists: false });

    await expect(calendarFeedIcs(new Request("https://renewlet.example/calendar/renewals.ics?token=missing"), env)).rejects.toMatchObject({ status: 404 });
    expect(env.__state.calendarFeedsTableExists).toBe(false);
  });

  it.each(labelFixtures)("renders Russian ICS labels for $name", async ({ labels, expected, key, value }) => {
    const customConfig = createCalendarFeedTestCustomConfig();
    // 测试内置支付方式时使用事实源的官方英文值，才能验证“未改名才翻译”的约束。
    customConfig.paymentMethods[0] = {
      ...customConfig.paymentMethods[0],
      id: "credit_card",
      value: "credit_card",
      labels: { "zh-CN": "信用卡", "en-US": "Credit card" },
    };
    const isPayment = key?.startsWith("payment.");
    if (isPayment) {
      customConfig.paymentMethods[0] = { ...customConfig.paymentMethods[0], value, id: value, labels };
    } else {
      customConfig.categories[0] = { ...customConfig.categories[0], value, id: value, labels, color: "hsl(265 68% 58%)" };
    }
    const env = await createCalendarFeedTestEnv({
      localePreference: "ru-RU",
      customConfigJson: JSON.stringify(customConfig),
      subscriptions: [subscriptionRow("sub_ru", "Plan", "active", "monthly", "2099-06-02", {
        category: isPayment ? "developer_tools" : value,
        payment_method: isPayment ? value : "credit_card",
      })],
    });
    const response = await createCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}", method: "POST",
    }), env);
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(response);
    const ics = unfoldIcsText(await (await calendarFeedIcs(new Request(created.calendarFeed.feedUrl), env)).text());
    expect(ics).toContain(`CATEGORIES:${isPayment ? "Инструменты разработчика" : expected["ru-RU"]}`);
    expect(ics).toContain(`Способ оплаты: ${isPayment ? expected["ru-RU"] : "Кредитная карта"}`);
    expect(env.__state.customConfigJson).toBe(JSON.stringify(customConfig));
  });

  it("falls back to built-in labels when custom config is missing", async () => {
    const env = await createCalendarFeedTestEnv({
      customConfigJson: null,
      localePreference: "zh-CN",
      subscriptions: [
        subscriptionRow("sub_sentry", "Sentry Team", "active", "monthly", "2099-06-02", {
          category: "developer_tools",
          payment_method: "bank_transfer",
        }),
      ],
    });
    const response = await createCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      headers: { "accept-language": "zh-CN" },
      method: "POST",
    }), env);
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(response);

    const ics = await (await calendarFeedIcs(new Request(created.calendarFeed.feedUrl), env)).text();
    const unfoldedIcs = unfoldIcsText(ics);

    expect(unfoldedIcs).toContain("分类：开发工具");
    expect(unfoldedIcs).toContain("支付方式：银行转账");
    expect(unfoldedIcs).toContain("CATEGORIES:开发工具");
    expect(unfoldedIcs).not.toContain("developer_tools");
    expect(unfoldedIcs).not.toContain("bank_transfer");
  });

  it("describes custom cycle units in ICS details", async () => {
    const env = await createCalendarFeedTestEnv({
      localePreference: "zh-CN",
      subscriptions: [
        subscriptionRow("sub_custom_year", "Three Year Plan", "active", "custom", "2099-06-02", {
          custom_days: 3,
          custom_cycle_unit: "year",
          price: "360",
        }),
      ],
    });
    const response = await createCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      headers: { "accept-language": "zh-CN" },
      method: "POST",
    }), env);
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(response);

    const ics = await (await calendarFeedIcs(new Request(created.calendarFeed.feedUrl), env)).text();
    const unfoldedIcs = unfoldIcsText(ics);

    expect(unfoldedIcs).toContain("周期：每 3 年");
  });

  it("falls back to built-in labels when legacy custom config misses an entry", async () => {
    const customConfig = createCalendarFeedTestCustomConfig();
    customConfig.categories = [];
    customConfig.paymentMethods = [];
    const env = await createCalendarFeedTestEnv({
      customConfigJson: JSON.stringify(customConfig),
      localePreference: "zh-CN",
      subscriptions: [
        subscriptionRow("sub_missing_config", "Missing Config Plan", "active", "monthly", "2099-06-02", {
          category: "developer_tools",
          payment_method: "bank_transfer",
        }),
      ],
    });
    const response = await createCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      headers: { "accept-language": "zh-CN" },
      method: "POST",
    }), env);
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(response);

    const ics = await (await calendarFeedIcs(new Request(created.calendarFeed.feedUrl), env)).text();
    const unfoldedIcs = unfoldIcsText(ics);

    expect(unfoldedIcs).toContain("分类：开发工具");
    expect(unfoldedIcs).toContain("支付方式：银行转账");
    expect(unfoldedIcs).not.toContain("developer_tools");
    expect(unfoldedIcs).not.toContain("bank_transfer");
  });

  it("preserves unknown values when neither custom config nor built-in labels can describe them", async () => {
    const env = await createCalendarFeedTestEnv({
      customConfigJson: null,
      subscriptions: [
        subscriptionRow("sub_unknown", "Unknown Plan", "active", "monthly", "2099-06-02", {
          category: "internal_ops",
          payment_method: "wire_custom",
        }),
      ],
    });
    const response = await createCalendarFeed(authorizedRequest("https://renewlet.example/api/app/calendar-feed", {
      body: "{}",
      headers: { "accept-language": "en-US" },
      method: "POST",
    }), env);
    const created = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(response);

    const ics = await (await calendarFeedIcs(new Request(created.calendarFeed.feedUrl), env)).text();
    const unfoldedIcs = unfoldIcsText(ics);

    expect(unfoldedIcs).toContain("Category: internal_ops");
    expect(unfoldedIcs).toContain("Payment method: wire_custom");
    expect(unfoldedIcs).toContain("CATEGORIES:internal_ops");
  });
});
