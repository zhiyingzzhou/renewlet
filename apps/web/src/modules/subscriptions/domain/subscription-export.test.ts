// 订阅导出测试保护 CSV 公式注入防护和有效状态展示口径，JSON 备份仍保留原始字段。
import { describe, expect, it } from "vitest";
import { buildSubscriptionsCsv, escapeCsvCell } from "./subscription-export";
import type { Subscription } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { loadLocaleCatalog } from "@/i18n/messages";
import { moneyToNumber } from "@renewlet/shared/money";

describe("subscription-export", () => {
  it("escapes quotes and spreadsheet formula prefixes", () => {
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
    expect(escapeCsvCell("=cmd")).toBe('"\'=cmd"');
    expect(escapeCsvCell("+cmd")).toBe('"\'+cmd"');
    expect(escapeCsvCell("-cmd")).toBe('"\'-cmd"');
    expect(escapeCsvCell("@cmd")).toBe('"\'@cmd"');
    expect(escapeCsvCell("\tcmd")).toBe('"\'\tcmd"');
  });

  it("uses configured labels when building CSV rows", () => {
    const subscription: Subscription = makeSubscription();

    const csv = buildSubscriptionsCsv([subscription], {
      categoryLabelByValue: new Map([["productivity", "生产力"]]),
      statusLabelByValue: new Map([["active", "活跃"]]),
      locale: "zh-CN",
      today: assertDateOnly("2026-01-01"),
    });

    expect(csv).toContain('"\'=Formula"');
    expect(csv).toContain('"生产力"');
    expect(csv).toContain('"活跃"');
    expect(csv).toContain('"SaaS;Work"');
  });

  it.each(["zh-CN", "en-US", "ru-RU"] as const)("exports absent, zero and precise balances separately in %s CSV", async (locale) => {
    await loadLocaleCatalog(locale);
    const csv = buildSubscriptionsCsv([
      makeSubscription(),
      makeSubscription({ balance: "0", balanceCurrency: "EUR" }),
      makeSubscription({ balance: "999999999.123456", balanceCurrency: "JPY" }),
    ], { categoryLabelByValue: new Map(), statusLabelByValue: new Map(), locale, today: "2026-01-01" });
    const rows = csv.split("\n").map((row) => row.split(","));
    expect(rows[0]?.slice(3, 5)).toHaveLength(2);
    expect(rows[1]?.slice(3, 5)).toEqual(['""', '""']);
    expect(rows[2]?.slice(3, 5)).toEqual(['"0"', '"EUR"']);
    expect(rows[3]?.slice(3, 5)).toEqual(['"999999999.123456"', '"JPY"']);
    expect(csv).not.toContain("subscription.field.");
  });

  it("renders inherited reminder days as a user-facing CSV label", () => {
    const csv = buildSubscriptionsCsv([makeSubscription({ reminderDays: -1 })], {
      categoryLabelByValue: new Map([["productivity", "生产力"]]),
      statusLabelByValue: new Map([["active", "活跃"]]),
      locale: "zh-CN",
      today: assertDateOnly("2026-01-01"),
    });

    expect(csv).toContain('"默认值从设置中获取"');
    expect(csv).not.toContain('"-1"');
  });

  it("renders disabled reminder days as a user-facing CSV label", () => {
    const csv = buildSubscriptionsCsv([makeSubscription({ reminderDays: -2 })], {
      categoryLabelByValue: new Map([["productivity", "生产力"]]),
      statusLabelByValue: new Map([["active", "活跃"]]),
      locale: "zh-CN",
      today: assertDateOnly("2026-01-01"),
    });

    expect(csv).toContain('"不提醒"');
    expect(csv).not.toContain('"-2"');
  });

  it("renders concrete custom billing cycles in CSV", () => {
    const csv = buildSubscriptionsCsv([makeSubscription({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    })], {
      categoryLabelByValue: new Map([["productivity", "生产力"]]),
      statusLabelByValue: new Map([["active", "活跃"]]),
      locale: "zh-CN",
      today: assertDateOnly("2026-01-01"),
    });

    expect(csv).toContain('"每 3 年"');
    expect(csv).not.toContain('"自定义"');
  });

  it("exports cost sharing amounts converted to each subscription currency", () => {
    const csv = buildSubscriptionsCsv([makeSubscription({
      price: "50",
      currency: "CNY",
      costSharing: {
        enabled: true,
        splitMode: "custom",
        members: [
          { id: "eur", name: "EUR member", currency: "EUR", customAmount: "10" },
          { id: "usd", name: "USD member", currency: "USD", customAmount: "10" },
        ],
      },
    })], {
      categoryLabelByValue: new Map([["productivity", "生产力"]]),
      statusLabelByValue: new Map([["active", "活跃"]]),
      locale: "zh-CN",
      today: assertDateOnly("2026-01-01"),
      costSharingCalculation: {
        convert: (amount, from, to) => {
          const value = moneyToNumber(amount);
          if (to !== "CNY") return value;
          if (from === "EUR") return value * 8;
          if (from === "USD") return value * 7;
          return value;
        },
      },
    });

    expect(csv).toContain('"0","150"');
  });
});

function makeSubscription(overrides: SubscriptionFixtureOverrides<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "=Formula",
    logo: undefined,
    price: "10",
    currency: "USD",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    tags: ["SaaS", "Work"],
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}
