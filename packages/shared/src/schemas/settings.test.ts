import { describe, expect, it } from "vitest";
import { mergeOnlineIconSourceSettings } from "../online-icon-sources";
import { createDefaultAppSettings } from "../settings-defaults";
import {
  applySettingsSecretUpdates,
  appSettingsSchema,
  persistedSettingsBackupSchema,
  settingsUpdateBodySchema,
  toEditableAppSettings,
  toPublicAppSettings,
} from "./settings";

describe("settings schema", () => {
  it("uses Frankfurter as the default exchange-rate provider", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.exchangeRateProvider).toBe("frankfurter");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "frankfurter" }).exchangeRateProvider).toBe("frankfurter");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "floatrates" }).exchangeRateProvider).toBe("floatrates");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "exchange-api" }).exchangeRateProvider).toBe("exchange-api");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "unknown" }).exchangeRateProvider).toBe("frankfurter");
  });

  it("keeps subscription price reference disabled by default and validates its target currency", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.subscriptionPriceReferenceEnabled).toBe(false);
    expect(defaults.subscriptionPriceReferenceCurrency).toBe("default");

    expect(settingsUpdateBodySchema.parse({
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "USD",
    })).toMatchObject({
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "USD",
    });
    expect(settingsUpdateBodySchema.parse({ subscriptionPriceReferenceCurrency: "default" }).subscriptionPriceReferenceCurrency).toBe("default");
    expect(settingsUpdateBodySchema.safeParse({ subscriptionPriceReferenceCurrency: "usd" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ subscriptionPriceReferenceCurrency: "USDT" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ subscriptionPriceReferenceEnabled: "true" }).success).toBe(false);
  });

  it("defaults the Chinese lunar calendar helper to off and validates boolean patches", () => {
    expect(createDefaultAppSettings().showLunarCalendar).toBe(false);
    expect(settingsUpdateBodySchema.parse({ showLunarCalendar: true }).showLunarCalendar).toBe(true);
    expect(settingsUpdateBodySchema.safeParse({ showLunarCalendar: "true" }).success).toBe(false);
    expect(persistedSettingsBackupSchema.parse({ localePreference: "auto" }).showLunarCalendar).toBeUndefined();
  });

  it("accepts online App icon source settings with App Store enabled by default", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.onlineIconSources.appStore.enabled).toBe(true);
    expect(defaults.onlineIconSources.appStore.storefronts).toEqual(["us"]);

    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: { enabled: false },
      },
    }).onlineIconSources).toEqual({
      appStore: { enabled: false },
    });
    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: { storefronts: ["cn"] },
      },
    }).onlineIconSources).toEqual({
      appStore: { storefronts: ["cn"] },
    });
    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: { storefronts: ["cn", "us"] },
      },
    }).onlineIconSources).toEqual({
      appStore: { storefronts: ["us", "cn"] },
    });
    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: {},
      },
    }).onlineIconSources).toEqual({
      appStore: {},
    });
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { enabled: true, variantsEnabled: true },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { storefronts: [] },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { storefronts: ["us", "us"] },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { storefronts: ["jp"] },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        googlePlay: { enabled: true },
      },
    }).success).toBe(false);

    expect(mergeOnlineIconSourceSettings({
      appStore: { enabled: true, storefronts: ["cn"] },
    }, {
      appStore: { enabled: false },
    }).appStore).toEqual({ enabled: false, storefronts: ["cn"] });
  });

  it("accepts partial nested icon sources at the persisted settings boundary", () => {
    expect(persistedSettingsBackupSchema.parse({
      defaultCurrency: "USD",
      builtInIconSources: { thesvg: { enabled: false } },
      onlineIconSources: { appStore: { storefronts: ["cn"] } },
    })).toEqual({
      defaultCurrency: "USD",
      builtInIconSources: { thesvg: { enabled: false } },
      onlineIconSources: { appStore: { storefronts: ["cn"] } },
    });
  });

  it("keeps public settings while restoring write-only fields as empty editor drafts", () => {
    const stored = createDefaultAppSettings();
    stored.testPhone = "8613800000000";
    stored.telegramBotToken = "telegram-secret";
    stored.webhookUrl = "https://hooks.example.com/renewlet";
    stored.aiRecognition = {
      ...stored.aiRecognition,
      model: "gpt-5-mini",
      modelInputMode: "manual",
      apiKey: "ai-secret",
    };

    const editable = toEditableAppSettings(toPublicAppSettings(stored));

    expect(editable.testPhone).toBe("8613800000000");
    expect(editable.aiRecognition.model).toBe("gpt-5-mini");
    expect(editable.telegramBotToken).toBe("");
    expect(editable.webhookUrl).toBe("");
    expect(editable.aiRecognition.apiKey).toBe("");
  });

  it("supports only plain or html Telegram message formats", () => {
    expect(createDefaultAppSettings().telegramMessageFormat).toBe("plain");
    expect(appSettingsSchema.pick({ telegramMessageFormat: true }).parse({ telegramMessageFormat: "plain" }).telegramMessageFormat).toBe("plain");
    expect(appSettingsSchema.pick({ telegramMessageFormat: true }).parse({ telegramMessageFormat: "html" }).telegramMessageFormat).toBe("html");
    expect(appSettingsSchema.pick({ telegramMessageFormat: true }).safeParse({ telegramMessageFormat: "markdown" }).success).toBe(false);
  });

  it("accepts Discord and PushPlus settings while keeping URLs HTTPS-only", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.discordWebhookUrl).toBe("");
    expect(defaults.discordBotUsername).toBe("");
    expect(defaults.discordBotAvatarUrl).toBe("");
    expect(defaults.pushplusToken).toBe("");

    const parsed = settingsUpdateBodySchema.parse({
      enabledChannels: ["discord", "pushplus"],
      discordBotUsername: "Renewlet",
      discordBotAvatarUrl: "https://cdn.example.com/avatar.png",
      secretUpdates: {
        discordWebhookUrl: { action: "set", value: "https://discord.com/api/webhooks/123/token" },
        pushplusToken: { action: "set", value: "pushplus-token" },
      },
    });

    expect(parsed.enabledChannels).toEqual(["discord", "pushplus"]);
    expect(parsed.discordBotUsername).toBe("Renewlet");
    expect(parsed.secretUpdates?.discordWebhookUrl).toEqual({ action: "set", value: "https://discord.com/api/webhooks/123/token" });
    const insecureWebhook = settingsUpdateBodySchema.parse({ secretUpdates: { discordWebhookUrl: { action: "set", value: "http://discord.com/api/webhooks/123/token" } } });
    expect(() => applySettingsSecretUpdates(defaults, insecureWebhook.secretUpdates)).toThrow();
    expect(settingsUpdateBodySchema.safeParse({ discordWebhookUrl: "https://discord.com/api/webhooks/123/token" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ discordBotAvatarUrl: "http://cdn.example.com/avatar.png" }).success).toBe(false);
    const oversizedToken = settingsUpdateBodySchema.parse({ secretUpdates: { pushplusToken: { action: "set", value: "x".repeat(257) } } });
    expect(() => applySettingsSecretUpdates(defaults, oversizedToken.secretUpdates)).toThrow();
    expect(settingsUpdateBodySchema.safeParse({ secretUpdates: { pushplusToken: { action: "set", value: "pushplus-token" }, pushplusSecret: { action: "set", value: "unexpected" } } }).success).toBe(false);
  });

  it("accepts DingTalk settings with HTTPS webhook and markdown default", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.enabledChannels).toEqual([]);
    expect(defaults.dingtalkWebhookUrl).toBe("");
    expect(defaults.dingtalkSecret).toBe("");
    expect(defaults.dingtalkKeyword).toBe("");
    expect(defaults.dingtalkMessageType).toBe("markdown");
    expect(defaults.dingtalkTitleTemplate).toBe("");
    expect(defaults.dingtalkContentTemplate).toBe("");

    const parsed = settingsUpdateBodySchema.parse({
      enabledChannels: ["dingtalk"],
      dingtalkKeyword: "Renewlet",
      dingtalkMessageType: "text",
      dingtalkTitleTemplate: "{brand} - {title}",
      dingtalkContentTemplate: "{keyword}\n{content}\n{timestamp}",
      secretUpdates: {
        dingtalkWebhookUrl: { action: "set", value: "https://oapi.dingtalk.com/robot/send?access_token=token" },
        dingtalkSecret: { action: "set", value: "SECabcdef" },
      },
    });

    expect(parsed.enabledChannels).toEqual(["dingtalk"]);
    expect(parsed.dingtalkMessageType).toBe("text");
    expect(parsed.dingtalkTitleTemplate).toBe("{brand} - {title}");
    expect(parsed.dingtalkContentTemplate).toBe("{keyword}\n{content}\n{timestamp}");
    expect(settingsUpdateBodySchema.safeParse({ dingtalkTitleTemplate: "💡".repeat(500) }).success).toBe(true);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkWebhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=token" }).success).toBe(false);
    const insecureWebhook = settingsUpdateBodySchema.parse({ secretUpdates: { dingtalkWebhookUrl: { action: "set", value: "http://oapi.dingtalk.com/robot/send?access_token=token" } } });
    expect(() => applySettingsSecretUpdates(defaults, insecureWebhook.secretUpdates)).toThrow();
    expect(settingsUpdateBodySchema.safeParse({ dingtalkMessageType: "actionCard" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkKeyword: "x".repeat(101) }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkTitleTemplate: "x".repeat(501) }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkContentTemplate: "x".repeat(20_001) }).success).toBe(false);
  });
});
