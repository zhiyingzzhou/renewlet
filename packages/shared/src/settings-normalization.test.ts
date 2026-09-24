import { describe, expect, it } from "vitest";
import { createDefaultAppSettings } from "./settings-defaults";
import { mergeAppSettingsPatch, normalizeSettingsValue, normalizeStoredSettingsPatch } from "./settings-normalization";

describe("settings normalization", () => {
  it("recovers known dirty stored settings without dropping unrelated fields", () => {
    const defaults = createDefaultAppSettings();
    const settings = normalizeSettingsValue({
      localePreference: "auto",
      defaultCurrency: "USD",
      monthlyBudget: 2333,
      telegramMessageFormat: "markdown",
      dingtalkMessageType: "actionCard",
      dingtalkTitleTemplate: "x".repeat(501),
      dingtalkContentTemplate: 42,
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "usd",
    }, defaults);

    expect(settings.defaultCurrency).toBe("USD");
    expect(settings.monthlyBudget).toBe("2333");
    expect(settings.telegramMessageFormat).toBe("plain");
    expect(settings.dingtalkMessageType).toBe("markdown");
    expect(settings.dingtalkTitleTemplate).toBe("");
    expect(settings.dingtalkContentTemplate).toBe("");
    expect(settings.subscriptionPriceReferenceEnabled).toBe(true);
    expect(settings.subscriptionPriceReferenceCurrency).toBe("default");
  });

  it("fills the lunar display default when reading historical settings", () => {
    const settings = normalizeSettingsValue({ localePreference: "auto", defaultCurrency: "USD" }, createDefaultAppSettings());

    expect(settings.showLunarCalendar).toBe(false);
    expect(normalizeSettingsValue({ localePreference: "auto", showLunarCalendar: true }, createDefaultAppSettings()).showLunarCalendar).toBe(true);
  });

  it("merges nested settings patches from one shared source", () => {
    const current = createDefaultAppSettings();
    const settings = mergeAppSettingsPatch(current, {
      builtInIconSources: {
        thesvg: { enabled: false },
      },
      onlineIconSources: {
        appStore: { storefronts: ["cn"] },
      },
      aiRecognition: {
        ...current.aiRecognition,
        model: "gpt-test",
      },
    });

    expect(settings.builtInIconSources.thesvg).toEqual({ enabled: false, variantsEnabled: true });
    expect(settings.builtInIconSources.selfhst).toEqual(current.builtInIconSources.selfhst);
    expect(settings.onlineIconSources.appStore).toEqual({ enabled: true, storefronts: ["cn"] });
    expect(settings.aiRecognition).toMatchObject({
      providerType: current.aiRecognition.providerType,
      model: "gpt-test",
    });
  });

  it("rejects non-record stored values at the migrated persistence boundary", () => {
    expect(normalizeStoredSettingsPatch(null)).toBeNull();
    expect(() => normalizeSettingsValue(null, createDefaultAppSettings())).toThrow();
  });
});
