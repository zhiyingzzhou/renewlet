import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { apiSubscriptionSchema, type ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { isValidDateOnly, type DateOnly } from "@renewlet/shared/runtime";
import { describe, expect, it, vi } from "vitest";
import { listNotificationScheduleCandidateSubscriptions } from "./db";
import { collectNotificationItemsForLocalDate } from "./notifications";
import type { Env } from "./types";

vi.mock("./smtp", () => ({
  notificationSmtpConfig: () => {
    throw new Error("SMTP should not be used by collection reminder tests");
  },
  sendSmtpEmail: async () => undefined,
}));

function settings(overrides: Partial<ApiAppSettings> = {}): ApiAppSettings {
  return {
    ...createDefaultAppSettings(),
    timezone: "UTC",
    notificationReminderDays: 5,
    ...overrides,
  };
}

function dateOnly(value: string): DateOnly {
  if (!isValidDateOnly(value)) throw new Error(`Invalid test date: ${value}`);
  return value as DateOnly;
}

function subscription(overrides: Partial<ApiSubscription> = {}): ApiSubscription {
  return apiSubscriptionSchema.parse({
    id: "sub_family",
    name: "Family Plan",
    price: "30",
    currency: "USD",
    billingCycle: "monthly",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    startDate: "2025-12-01",
    nextBillingDate: "2026-01-10",
    autoRenew: false,
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

function d1All<T>(results: T[] = []): D1Result<T> {
  return { success: true, results, meta: {} as D1Meta } as D1Result<T>;
}

describe("Cloudflare cost sharing collection notifications", () => {
  it("emits collection reminders even when ordinary subscription reminders are disabled", () => {
    const items = collectNotificationItemsForLocalDate("2026-01-07", settings(), [
      subscription({
        reminderDays: -2,
        costSharing: {
          enabled: true,
          splitMode: "equal",
          collectionReminder: { enabled: true, reminderDays: 3 },
          members: [
            { id: "partner", name: "Partner", currency: "USD", joinedDate: dateOnly("2025-12-10") },
            { id: "child", name: "Child", currency: "USD", joinedDate: dateOnly("2025-12-10") },
          ],
        },
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        type: "costSharing",
        reminderDays: 3,
        costSharing: { memberName: "Partner", amount: "10", currency: "USD" },
      }),
      expect.objectContaining({
        type: "costSharing",
        reminderDays: 3,
        costSharing: { memberName: "Child", amount: "10", currency: "USD" },
      }),
    ]);
  });

  it.each(["paused", "cancelled"] as const)("keeps collection reminders for %s subscriptions while suppressing ordinary items", (status) => {
    const items = collectNotificationItemsForLocalDate("2026-01-07", settings(), [
      subscription({
        status,
        reminderDays: 3,
        nextBillingDate: "2026-01-10",
        costSharing: {
          enabled: true,
          splitMode: "equal",
          collectionReminder: { enabled: true, reminderDays: 3 },
          members: [{ id: "partner", name: "Partner", currency: "USD", joinedDate: dateOnly("2025-12-10") }],
        },
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        type: "costSharing",
        subscriptionId: "sub_family",
      }),
    ]);
  });

  it("uses member custom amount and currency without exchange-rate guessing", () => {
    const items = collectNotificationItemsForLocalDate("2026-01-05", settings(), [
      subscription({
        costSharing: {
          enabled: true,
          splitMode: "custom",
          collectionReminder: { enabled: true, reminderDays: -1 },
          members: [
            { id: "partner", name: "Partner", customAmount: "7.5", currency: "EUR", joinedDate: dateOnly("2025-12-10") },
          ],
        },
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        type: "costSharing",
        reminderDays: 5,
        costSharing: { memberName: "Partner", amount: "7.5", currency: "EUR" },
      }),
    ]);
  });

  it("skips one-time buyouts but keeps fixed-term one-time collection reminders", () => {
    const items = collectNotificationItemsForLocalDate("2026-01-07", settings(), [
      subscription({
        id: "sub_buyout",
        billingCycle: "one-time",
        startDate: "2025-12-10",
        nextBillingDate: "2025-12-10",
        autoCalculateNextBillingDate: false,
        costSharing: {
          enabled: true,
          splitMode: "equal",
          collectionReminder: { enabled: false, reminderDays: 3 },
          members: [{ id: "partner", name: "Partner", currency: "USD", joinedDate: dateOnly("2025-12-10") }],
        },
      }),
      subscription({
        id: "sub_fixed_term",
        billingCycle: "one-time",
        oneTimeTermCount: 1,
        oneTimeTermUnit: "month",
        startDate: "2025-12-10",
        nextBillingDate: "2026-01-10",
        autoCalculateNextBillingDate: false,
        costSharing: {
          enabled: true,
          splitMode: "equal",
          collectionReminder: { enabled: true, reminderDays: 3 },
          members: [{ id: "partner", name: "Partner", currency: "USD", joinedDate: dateOnly("2025-12-10") }],
        },
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        subscriptionId: "sub_fixed_term",
        type: "costSharing",
        costSharing: { memberName: "Partner", amount: "15", currency: "USD" },
      }),
    ]);
  });

  it("uses indexed D1 mirror columns for scheduled collection candidates", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...params: unknown[]) => {
            queries.push({ sql, params });
            return {
              all: async <T>() => d1All<T>([]),
            };
          },
        }),
      } as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } satisfies Env;

    await listNotificationScheduleCandidateSubscriptions(env, "usr_due", {
      scheduledLocalDate: "2026-01-07",
      includeExpired: true,
      showExpired: true,
    });

    const query = queries[0];
    expect(query?.sql).toContain("UNION");
    expect(query?.sql).toContain("status NOT IN ('paused', 'cancelled')");
    expect(query?.sql).toContain("cost_sharing_collection_reminder_enabled = 1");
    expect(query?.sql).toContain("cost_sharing_next_collection_reminder_date <= ?");
    expect(query?.sql).not.toMatch(/json_extract|json_valid|\$\.collectionReminder/);
    expect(query?.params).toEqual(expect.arrayContaining(["usr_due", -2, "2026-01-07"]));
  });
});
