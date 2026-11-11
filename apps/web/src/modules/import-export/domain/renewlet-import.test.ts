// Renewlet 导入测试保护正式导出格式，旧导入桥删除后不能再放宽自导入契约。
import { describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS, type Subscription } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import { renewletExportV1Schema } from "@/lib/api/schemas/import-export";
import { parseJsonText } from "./wallos-import";
import { IMPORT_MESSAGE_CODES, subscriptionToExportRow } from "./import-export-model";
import { buildFromRenewletExport } from "./wallos-import-mapping";
import { parseImportBytes } from "./wallos-import-worker";
import v0322ExportJson from "./fixtures/v0.3.22-renewlet-export-v1.json?raw";
import v0322ExportZipBase64 from "./fixtures/v0.3.22-renewlet-export-v1.zip.base64?raw";

const context = {
  config: DEFAULT_CUSTOM_CONFIG,
  settings: DEFAULT_SETTINGS,
  today: assertDateOnly("2026-05-21"),
};

const currentExportSubscription = {
  id: "current-1",
  name: "Current Backup",
  logo: undefined,
  price: "42",
  currency: "USD",
  balance: "0.000001",
  balanceCurrency: "EUR",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  category: "developer_tools",
  status: "active",
  pinned: true,
  publicHidden: false,
  paymentMethod: undefined,
  startDate: assertDateOnly("2026-05-01"),
  nextBillingDate: assertDateOnly("2026-06-01"),
  autoRenew: true,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: undefined,
  notes: undefined,
  tags: [],
  reminderDays: 3,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
} satisfies Subscription;

describe("renewlet import", () => {
  it("previews the immutable v0.3.22 v1 JSON and ZIP samples", async () => {
    const jsonPrepared = await parseJsonText(v0322ExportJson, context);
    const zipBytes = Uint8Array.from(atob(v0322ExportZipBase64.trim()), (character) => character.charCodeAt(0));
    const zipPrepared = await parseImportBytes("v0.3.22-fixture", zipBytes, context);

    for (const prepared of [jsonPrepared, zipPrepared]) {
      expect(prepared.payload.subscriptions[0]?.name).toBe("v0.3.22 Backup");
      expect(prepared.payload.subscriptions[0]?.balance).toBeUndefined();
      expect(prepared.payload.settings).toMatchObject({ localePreference: "zh-CN", defaultCurrency: "USD" });
    }
  });

  it("rejects legacy Renewlet bare subscription arrays", async () => {
    await expect(parseJsonText(JSON.stringify([
      {
        id: "03v2x7u3pyafogh",
        name: "Docker",
        price: "10",
        currency: "USD",
        category: "productivity",
        status: "active",
        startDate: "2026-04-16",
        nextBillingDate: "2026-06-16",
        autoCalculateNextBillingDate: true,
        trialEndDate: null,
        tags: [],
        reminderDays: 3,
        repeatReminderEnabled: false,
        repeatReminderInterval: "1h",
        repeatReminderWindow: "72h",
        billingCycle: "monthly",
      },
    ]), context)).rejects.toThrow(IMPORT_MESSAGE_CODES.unrecognizedFile);
  });

  it("rejects legacy Renewlet object wrappers", async () => {
    await expect(parseJsonText(JSON.stringify({
      data: {
        subscriptions: [{
          id: "legacy-1",
          name: "Legacy Netflix",
          price: "15.99",
          currency: "USD",
          billingCycle: "monthly",
          category: "streaming",
          status: "active",
          startDate: "2026-01-01",
          nextBillingDate: "2026-06-01",
        }],
      },
    }), context)).rejects.toThrow(IMPORT_MESSAGE_CODES.unrecognizedFile);
  });

  it("builds current Renewlet v1 export rows that satisfy schema and keep pinned", () => {
    const row = subscriptionToExportRow(currentExportSubscription);

    const parsed = renewletExportV1Schema.parse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [row],
        settings: { defaultCurrency: "USD" },
        customConfig: DEFAULT_CUSTOM_CONFIG,
        assets: [],
      },
    });

    expect(row.pinned).toBe(true);
    expect(parsed.data.subscriptions[0]?.pinned).toBe(true);
  });

  it("keeps current Renewlet v1 exports on the schema-backed path", async () => {
    const prepared = await parseJsonText(JSON.stringify({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [currentExportSubscription],
        settings: { locale: "zh-CN", defaultCurrency: "USD" },
        customConfig: DEFAULT_CUSTOM_CONFIG,
        assets: [],
      },
    }), context);

    expect(prepared.payload.subscriptions[0]).toMatchObject({ balance: "0.000001", balanceCurrency: "EUR" });
    expect(prepared.payload.source).toBe("renewlet");
    expect(prepared.payload.subscriptions[0]?.extra.import).toEqual({
      source: "renewlet",
      sourceId: "current-1",
      confidence: "high",
    });
    expect(prepared.payload.subscriptions[0]?.pinned).toBe(true);
    expect(prepared.payload.settings?.defaultCurrency).toBe("USD");
    expect(prepared.payload.settings?.localePreference).toBe("zh-CN");
    expect(prepared.payload.customConfig?.statuses.some((item) => item.value === "expired")).toBe(true);
    expect(prepared.warnings).toHaveLength(0);
  });

  it("stages payment method icons from Renewlet ZIP assets and removes missing ZIP icon paths", () => {
    const parsed = renewletExportV1Schema.parse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [currentExportSubscription],
        settings: { defaultCurrency: "USD" },
        customConfig: {
          ...DEFAULT_CUSTOM_CONFIG,
          paymentMethods: [
            { id: "pm_card", value: "card", labels: { "zh-CN": "Card", "en-US": "Card" }, icon: "assets/asset_icon.svg" },
            { id: "pm_missing", value: "wallet", labels: { "zh-CN": "Wallet", "en-US": "Wallet" }, icon: "assets/missing.svg" },
          ],
        },
        assets: [{ id: "asset_icon", path: "assets/asset_icon.svg", mimeType: "image/svg+xml", sizeBytes: 7 }],
      },
    });

    const assetBuffer = new TextEncoder().encode("<svg />").buffer;
    const prepared = buildFromRenewletExport(parsed, context, new Map([[
      "assets/asset_icon.svg",
      { buffer: assetBuffer, mimeType: "image/svg+xml" },
    ]]));

    expect(prepared.assets).toEqual([{
      target: { type: "paymentMethodIcon", paymentMethodIndex: 0 },
      kind: "icon",
      filename: "asset_icon.svg",
      buffer: assetBuffer,
      mimeType: "image/svg+xml",
    }]);
    expect(prepared.payload.customConfig?.paymentMethods[0]).not.toHaveProperty("icon");
    expect(prepared.payload.customConfig?.paymentMethods[1]).not.toHaveProperty("icon");
  });

  it("does not overwrite the target preference when a v1 backup has no locale", async () => {
    const prepared = await parseJsonText(JSON.stringify({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [],
        settings: { defaultCurrency: "USD" },
      },
    }), {
      ...context,
      settings: { ...context.settings, localePreference: "en-US" },
    });

    expect(prepared.payload.settings).toEqual({ defaultCurrency: "USD" });
  });
});
