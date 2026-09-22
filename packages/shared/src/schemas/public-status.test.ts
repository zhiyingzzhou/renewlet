// 公开状态 schema 测试保护隐私 allowlist 和 showPrices 金额投影，避免公开 API 半暴露账单字段。
import { describe, expect, it } from "vitest";
import {
  publicStatusPageCreateResponseSchema,
  publicStatusResponseSchema,
} from "./public-status";
import { appSettingsSchema } from "./settings";

const success = <T>(data: T) => ({ ok: true, data });

describe("public status schemas", () => {
  it("keeps owner filter settings out of the anonymous response", () => {
    // 过滤由服务端执行；管理端字段不进入匿名投影，不能为迁就错误夹具放宽公开 allowlist。
    const page = { title: "Renewlet", showPrices: false, asOf: "2026-06-07", generatedAt: "2026-06-07T00:00:00Z", truncated: false };
    expect(publicStatusResponseSchema.safeParse(success({ page, subscriptions: [] })).success).toBe(true);
    for (const field of ["hideExpired", "hideLifetime"]) {
      const result = publicStatusResponseSchema.safeParse(success({ page: { ...page, [field]: false }, subscriptions: [] }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ code: "unrecognized_keys", path: ["data", "page"], keys: [field] }));
    }
  });

  it("accepts minimal public status rows without prices", () => {
    expect(publicStatusResponseSchema.parse(success({
      page: {
        title: "Renewlet",
        showPrices: false,
        asOf: "2026-06-07",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Netflix",
        logo: "https://example.com/netflix.png",
        category: { value: "streaming", label: "Streaming", color: "#ef4444" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }],
    })).data.subscriptions[0]?.price).toBeUndefined();
    expect(publicStatusResponseSchema.safeParse({
      page: { title: "Renewlet", showPrices: false, asOf: "not-a-date", generatedAt: "2026-06-07T00:00:00.000Z", truncated: false },
      subscriptions: [],
    }).success).toBe(false);
  });

  it("accepts public status rows with unknown recurring start dates", () => {
    expect(publicStatusResponseSchema.parse(success({
      page: {
        title: "Renewlet",
        showPrices: false,
        asOf: "2026-06-07",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "QQ Music",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: null,
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }],
    })).data.subscriptions[0]?.startDate).toBeNull();
  });

  it("requires price and currency to be exposed together", () => {
    // showPrices 是公开账单字段唯一开关；schema 让金额、币种和周期同进同出，避免半公开账单信息。
    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewlet",
        showPrices: true,
        currency: "USD",
        asOf: "2026-06-07",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Netflix",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
        price: "9.99",
      }],
    })).success).toBe(false);
  });

  it("requires public page currency and billing cycle only when prices are visible", () => {
    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewlet",
        showPrices: true,
        currency: "USD",
        exchangeRateBasis: {
          status: "locked",
          month: "2026-06",
          base: "USD",
          rates: { USD: 1, CNY: 7.1 },
          sourceDate: "2026-06-06",
          capturedAt: "2026-06-07T00:00:00.000Z",
        },
        asOf: "2026-06-07",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Annual Plan",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
        price: "120",
        currency: "USD",
        billingCycle: "annual",
      }],
    })).success).toBe(true);

    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewlet",
        showPrices: false,
        currency: "USD",
        asOf: "2026-06-07",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [],
    })).success).toBe(false);

    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewlet",
        showPrices: false,
        exchangeRateBasis: { status: "live", month: "2026-06" },
        asOf: "2026-06-07",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [],
    })).success).toBe(false);
  });

  it("rejects incomplete or unrelated cycle-specific fields", () => {
    const publicResponse = (subscription: Record<string, unknown>) => success({
      page: {
        title: "Renewlet",
        showPrices: true,
        currency: "USD",
        asOf: "2026-06-07",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Custom Plan",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
        price: "12",
        currency: "USD",
        ...subscription,
      }],
    });

    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "custom",
      customDays: 3,
    })).success).toBe(false);
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "monthly",
      customDays: 3,
      customCycleUnit: "month",
    })).success).toBe(false);
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "month",
    })).success).toBe(true);
  });

  it("accepts inherited or explicit public status currency settings", () => {
    expect(appSettingsSchema.pick({ publicStatusCurrency: true }).parse({ publicStatusCurrency: "inherit" }).publicStatusCurrency).toBe("inherit");
    expect(appSettingsSchema.pick({ publicStatusCurrency: true }).parse({ publicStatusCurrency: "USD" }).publicStatusCurrency).toBe("USD");
    expect(appSettingsSchema.pick({ publicStatusCurrency: true }).safeParse({ publicStatusCurrency: "usd" }).success).toBe(false);
  });

  it("keeps management create responses on bearer URL shape", () => {
    expect(publicStatusPageCreateResponseSchema.safeParse(success({
      publicStatusPage: {
        enabled: true,
        createdAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
        pageUrl: "https://renewlet.example/status/abc123abc123abc123abc123abc123abc123abc123a",
        showPrices: false, hideExpired: false, hideLifetime: false,
      },
    })).success).toBe(true);
  });
});
