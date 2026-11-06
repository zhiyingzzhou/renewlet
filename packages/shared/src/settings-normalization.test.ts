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

  it("canonicalizes legacy AI settings without dropping credentials", () => {
    const defaults = createDefaultAppSettings();
    const legacy = normalizeSettingsValue({
      localePreference: "auto",
      aiRecognition: {
        provider: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-6.1-sol",
        modelInputMode: "manual",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "sk-legacy",
        defaultThinkingControl: { provider: "openai", effort: "minimal" },
      },
    }, defaults);

    expect(legacy.aiRecognition).toEqual({
      providerType: "openai",
      transportProtocol: "openai-responses",
      model: "gpt-6.1-sol",
      modelInputMode: "manual",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-legacy",
      defaultThinkingControl: null,
    });
    expect(normalizeSettingsValue(legacy, defaults)).toEqual(legacy);
  });

  it("keeps modern reasoning controls for new GPT-6 family model ids without a model-name branch", () => {
    const defaults = createDefaultAppSettings();
    const settings = normalizeSettingsValue({
      localePreference: "auto",
      aiRecognition: {
        provider: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-6.1-terra",
        modelInputMode: "manual",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "legacy-key",
        defaultThinkingControl: { provider: "openai", effort: "max" },
      },
    }, defaults);

    expect(settings.aiRecognition).toMatchObject({
      providerType: "openai",
      transportProtocol: "openai-responses",
      model: "gpt-6.1-terra",
      defaultThinkingControl: { provider: "openai", effort: "max" },
    });
    expect(normalizeSettingsValue(settings, defaults)).toEqual(settings);
  });

  it("keeps OpenAI-compatible on Chat while migrating provider aliases", () => {
    const settings = normalizeSettingsValue({
      localePreference: "auto",
      aiRecognition: {
        provider: "openai-compatible",
        model: "custom-model",
        modelInputMode: "manual",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "",
      },
    }, createDefaultAppSettings());

    expect(settings.aiRecognition).toMatchObject({
      providerType: "openai-compatible",
      transportProtocol: "openai-chat",
      model: "custom-model",
      modelInputMode: "manual",
      baseUrl: "https://gateway.example.com/v1",
    });
  });

  it("uses a valid legacy provider alias when the newer provider field is dirty", () => {
    const settings = normalizeSettingsValue({
      localePreference: "auto",
      aiRecognition: {
        providerType: "removed-provider",
        provider: "openai-compatible",
        model: "custom-model",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "legacy-key",
      },
    }, createDefaultAppSettings());

    expect(settings.aiRecognition).toMatchObject({
      providerType: "openai-compatible",
      transportProtocol: "openai-chat",
      model: "custom-model",
      apiKey: "legacy-key",
    });
  });

  it("keeps unknown legacy AI fields strict instead of silently dropping them", () => {
    expect(() => normalizeSettingsValue({
      localePreference: "auto",
      aiRecognition: {
        provider: "openai",
        model: "gpt-5.1",
        unexpected: true,
      },
    }, createDefaultAppSettings())).toThrow();
  });

  it("clears an invalid legacy thinking effort while preserving the rest of the AI config", () => {
    const settings = normalizeSettingsValue({
      localePreference: "auto",
      aiRecognition: {
        provider: "openai",
        model: "gpt-6.1-sol",
        modelInputMode: "manual",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "legacy-key",
        defaultThinkingControl: { provider: "openai", effort: "unsupported" },
      },
    }, createDefaultAppSettings());

    expect(settings.aiRecognition).toMatchObject({
      providerType: "openai",
      model: "gpt-6.1-sol",
      modelInputMode: "manual",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "legacy-key",
      defaultThinkingControl: null,
    });
  });

  it("keeps nested thinking fields strict while clearing invalid values", () => {
    expect(() => normalizeSettingsValue({
      localePreference: "auto",
      aiRecognition: {
        provider: "openai",
        model: "gpt-5.1",
        defaultThinkingControl: { provider: "openai", effort: "high", unexpected: true },
      },
    }, createDefaultAppSettings())).toThrow();
  });
});
