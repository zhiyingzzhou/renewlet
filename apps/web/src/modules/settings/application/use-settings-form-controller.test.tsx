// Settings controller 测试保护远端设置、本地草稿、主题/i18n 预览和保存副作用的唯一应用层写入口。
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import {
  APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_THEME_MODE_STORAGE_KEY,
} from "@/lib/theme-storage";
import {
  BASE_SETTINGS,
  mocks,
  renderSettingsFormController,
  setupSettingsFormControllerTestEnvironment,
} from "./use-settings-form-controller.test-utils";

describe("useSettingsFormController", () => {
  setupSettingsFormControllerTestEnvironment();

  it("starts clean and does not save or refresh when the exchange-rate source only changes draft", () => {
    const { result } = renderSettingsFormController();

    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => {
      result.current.handleExchangeRateProviderChange("exchange-api");
    });

    expect(result.current.settings.exchangeRateProvider).toBe("exchange-api");
    expect(result.current.hasUnsavedChanges).toBe(true);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
    expect(mocks.refreshRates).not.toHaveBeenCalled();
  });

  it("reports only successful manual exchange-rate refreshes", async () => {
    const { result } = renderSettingsFormController();

    await act(async () => {
      await result.current.handleRefreshRates();
    });

    expect(mocks.refreshRates).toHaveBeenCalledWith(BASE_SETTINGS.exchangeRateProvider);
    expect(mocks.toast.success).toHaveBeenCalledWith("最新汇率数据已获取");
  });

  it("does not report success when a manual exchange-rate refresh fails", async () => {
    mocks.refreshRates.mockResolvedValue({
      status: "failed",
      error: "网络请求失败",
      errorDetails: null,
    });
    const { result } = renderSettingsFormController();

    await act(async () => {
      await result.current.handleRefreshRates();
    });

    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("does not expose the PocketBase admin entry in Cloudflare runtime", () => {
    mocks.isCloudflareRuntime = true;

    const { result } = renderSettingsFormController();

    expect(result.current.canAccessPocketBaseAdmin).toBe(false);
  });

  it("does not expose user management capability for banned admins", () => {
    mocks.accountIdentity = { email: "admin@example.com", role: "admin", banned: true };

    const { result } = renderSettingsFormController();

    expect(result.current.canManageUsers).toBe(false);
    expect(result.current.canAccessPocketBaseAdmin).toBe(false);
  });

  it("keeps auth security changes out of the main settings draft", async () => {
    mocks.authSecuritySettings = {
      data: { turnstile: { enabled: false, siteKey: "", secretConfigured: false } },
      isLoading: false,
    };
    const { result } = renderSettingsFormController();

    await waitFor(() => expect(result.current.authSecurity.draft.siteKey).toBe(""));
    act(() => {
      result.current.authSecurity.setSiteKey("site-key");
    });

    expect(result.current.authSecurity.hasChanges).toBe(true);
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
  });

  it("prefills an empty recipient email from the current account email without marking the form dirty", async () => {
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      recipientEmail: "",
    };

    const { result } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.settings.recipientEmail).toBe("alice@example.com");
    });
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("does not prefill or mutate external integration settings in demo mode", async () => {
    mocks.appStatus = { status: "ready", data: { setupRequired: false, setupEnabled: false, demoMode: true, passwordReset: false, oidc: false, turnstile: { enabled: false, siteKey: "" } }, error: null, isLoading: false, isRefreshing: false, isReady: true, retry: vi.fn() };
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      enabledChannels: [],
      recipientEmail: "",
    };

    const { result } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.externalIntegrationsDisabled).toBe(true);
      expect(result.current.sensitiveAccountActionsDisabled).toBe(true);
      expect(result.current.sensitiveAccountActionsDemoDisabled).toBe(true);
    });
    expect(result.current.settings.recipientEmail).toBe("");

    act(() => {
      result.current.updateSetting("recipientEmail", "billing@example.com");
      result.current.updateSetting("discordWebhookUrl", "https://discord.com/api/webhooks/123/secret");
      result.current.updateSetting("pushplusToken", "push-token");
      result.current.toggleChannel("telegram");
      result.current.toggleChannel("discord");
      void result.current.handleTestConnection("telegram");
      void result.current.handleTestConnection("discord");
    });

    expect(result.current.settings.recipientEmail).toBe("");
    expect(result.current.settings.discordWebhookUrl).toBe("");
    expect(result.current.settings.pushplusToken).toBe("");
    expect(result.current.settings.enabledChannels).toEqual([]);
    expect(mocks.testConnection).not.toHaveBeenCalled();
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("fails closed without clearing settings when app status is unavailable", async () => {
    mocks.appStatus = {
      status: "error",
      data: null,
      error: new Error("status unavailable"),
      isLoading: false,
      isRefreshing: false,
      isReady: false,
      retry: vi.fn(),
    };
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      recipientEmail: "saved@example.com",
    };

    const { result } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.externalIntegrationsDisabled).toBe(true);
      expect(result.current.sensitiveAccountActionsDisabled).toBe(true);
      expect(result.current.appStatusHasError).toBe(true);
      expect(result.current.appStatusHasData).toBe(false);
    });
    expect(result.current.settings.recipientEmail).toBe("saved@example.com");
  });

  it("marks the form dirty when the prefilled recipient email is changed", async () => {
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      recipientEmail: "",
    };

    const { result } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.settings.recipientEmail).toBe("alice@example.com");
    });

    act(() => {
      result.current.updateSetting("recipientEmail", "billing@example.com");
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
  });

  it("keeps an existing recipient email from remote settings", async () => {
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      recipientEmail: "billing@example.com",
    };

    const { result } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.settings.recipientEmail).toBe("billing@example.com");
    });
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("does not mark settings dirty when the global header theme changes", async () => {
    localStorage.setItem(APPEARANCE_PENDING_STORAGE_KEY, "1");
    const { result, rerender } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.settings.themeMode).toBe(BASE_SETTINGS.themeMode);
    });
    expect(result.current.effectiveThemeMode).toBe("dark");
    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => {
      mocks.theme = BASE_SETTINGS.themeMode === "dark" ? "light" : "dark";
      rerender();
    });

    expect(result.current.settings.themeMode).toBe(BASE_SETTINGS.themeMode);
    expect(result.current.effectiveThemeMode).toBe(BASE_SETTINGS.themeMode === "dark" ? "light" : "dark");
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("keeps the current header theme when saving non-appearance settings", async () => {
    mocks.theme = "dark";
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      themeMode: "light",
    };
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.handleExchangeRateProviderChange("exchange-api");
    });

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    const command = mocks.updateSettingsMutateAsync.mock.calls.at(0)?.at(0);
    expect(command?.patch.exchangeRateProvider).toBe("exchange-api");
    expect(mocks.setTheme).not.toHaveBeenCalled();
  });

  it("includes the current effective theme when editing a theme variant", async () => {
    mocks.theme = "dark";
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      themeMode: "light",
    };
    const { result } = renderSettingsFormController();

    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => {
      result.current.handleThemeVariantChange("ocean");
    });

    expect(result.current.settings.themeMode).toBe("dark");
    expect(result.current.settings.themeVariant).toBe("ocean");
    expect(result.current.hasUnsavedChanges).toBe(true);
    expect(localStorage.getItem(SETTINGS_THEME_MODE_STORAGE_KEY)).toBe("dark");
  });

  it("restores unsaved settings appearance from the dedicated pending draft", async () => {
    localStorage.setItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY, "1");
    localStorage.setItem(SETTINGS_THEME_MODE_STORAGE_KEY, "light");

    const { result } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.settings.themeMode).toBe("light");
    });
    expect(result.current.hasUnsavedChanges).toBe(BASE_SETTINGS.themeMode !== "light");
  });

  it("prefills the recipient email when the account email arrives after settings without marking the form dirty", async () => {
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      recipientEmail: "",
    };
    mocks.accountIdentity = { email: null, role: "admin", banned: false };
    const { result, rerender } = renderSettingsFormController();

    expect(result.current.settings.recipientEmail).toBe("");

    act(() => {
      mocks.accountIdentity = { email: "late@example.com", role: "admin", banned: false };
      rerender();
    });

    await waitFor(() => {
      expect(result.current.settings.recipientEmail).toBe("late@example.com");
    });
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("does not refill after the user clears the default recipient email", async () => {
    mocks.remoteSettings = {
      ...BASE_SETTINGS,
      recipientEmail: "",
    };
    const { result, rerender } = renderSettingsFormController();

    await waitFor(() => {
      expect(result.current.settings.recipientEmail).toBe("alice@example.com");
    });

    act(() => {
      result.current.updateSetting("recipientEmail", "");
    });

    expect(result.current.settings.recipientEmail).toBe("");
    expect(result.current.hasUnsavedChanges).toBe(true);

    act(() => {
      mocks.remoteSettings = {
        ...BASE_SETTINGS,
        recipientEmail: "",
      };
      rerender();
    });

    expect(result.current.settings.recipientEmail).toBe("");
    expect(result.current.hasUnsavedChanges).toBe(true);
  });

  it("saves draft settings and refreshes rates only after the provider is saved", async () => {
    mocks.refreshRates.mockResolvedValue({
      status: "failed",
      error: "网络请求失败",
      errorDetails: null,
    });
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.handleExchangeRateProviderChange("exchange-api");
    });

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    const command = mocks.updateSettingsMutateAsync.mock.calls.at(0)?.at(0);
    expect(command?.patch.exchangeRateProvider).toBe("exchange-api");
    expect(mocks.refreshRates).toHaveBeenCalledWith("exchange-api");
    expect(result.current.settings.exchangeRateProvider).toBe("exchange-api");
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.toast.success).toHaveBeenCalledWith("设置已保存");
    expect(mocks.toast.success).not.toHaveBeenCalledWith("最新汇率数据已获取");
  });

  it("saves settings appearance changes and clears the dedicated pending draft", async () => {
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.handleThemeModeChange("light");
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
    expect(localStorage.getItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY)).toBe("1");
    expect(localStorage.getItem(SETTINGS_THEME_MODE_STORAGE_KEY)).toBe("light");

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    const command = mocks.updateSettingsMutateAsync.mock.calls.at(0)?.at(0);
    expect(command?.patch.themeMode).toBe("light");
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(localStorage.getItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(SETTINGS_THEME_MODE_STORAGE_KEY)).toBeNull();
    expect(mocks.clearThemeModeOverride).toHaveBeenCalled();
    expect(mocks.setTheme).toHaveBeenCalledWith("light", { localOverride: false });
  });

  it("remembers explicit locale preference only after saving a locale change", async () => {
    const { result } = renderSettingsFormController();
    const nextPreference = BASE_SETTINGS.localePreference === "en-US" ? "zh-CN" : "en-US";

    act(() => {
      result.current.updateSetting("localePreference", nextPreference);
    });

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    const command = mocks.updateSettingsMutateAsync.mock.calls.at(0)?.at(0);
    expect(command?.patch.localePreference).toBe(nextPreference);
    expect(mocks.commitLocalePreference).toHaveBeenLastCalledWith(nextPreference);
  });

  it("keeps the draft dirty and shows the server restart hint when saving the provider hits PocketBase 400", async () => {
    mocks.updateSettingsMutateAsync.mockRejectedValue({
      status: 400,
      message: "Failed to update record.",
      response: {
        status: 400,
        message: "Failed to update record.",
        data: {},
      },
    });
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.handleExchangeRateProviderChange("exchange-api");
    });

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    expect(mocks.refreshRates).not.toHaveBeenCalled();
    expect(result.current.settings.exchangeRateProvider).toBe("exchange-api");
    expect(result.current.hasUnsavedChanges).toBe(true);
    expect(mocks.toast.error).toHaveBeenCalledWith("保存失败", {
      description: "无法保存汇率来源。服务端可能还没更新或重启，请重启后端服务后再试。",
    });
  });

  it("rolls back only the locale preview to the latest remote baseline when saving settings fails", async () => {
    const { result, rerender } = renderSettingsFormController();

    act(() => {
      mocks.remoteSettings = {
        ...BASE_SETTINGS,
        localePreference: "en-US",
        recipientEmail: "updated@example.com",
      };
      rerender();
    });

    await waitFor(() => {
      expect(result.current.settings.localePreference).toBe("en-US");
      expect(result.current.settings.recipientEmail).toBe("updated@example.com");
    });
    expect(result.current.hasUnsavedChanges).toBe(false);
    mocks.updateSettingsMutateAsync.mockRejectedValue(new Error("save failed"));

    act(() => {
      result.current.updateSetting("localePreference", "zh-CN");
      result.current.updateSetting("monthlyBudget", "2333");
    });

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    expect(result.current.settings.localePreference).toBe("en-US");
    expect(result.current.settings.recipientEmail).toBe("updated@example.com");
    expect(result.current.settings.monthlyBudget).toBe("2333");
    expect(result.current.hasUnsavedChanges).toBe(true);
    expect(mocks.syncRemoteLocalePreference).toHaveBeenLastCalledWith("en-US");
    expect(mocks.commitLocalePreference).not.toHaveBeenCalled();
  });

  it("discards draft settings and restores locale/theme previews", () => {
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.handleThemeModeChange("light");
      result.current.updateSetting("localePreference", "en-US");
    });
    expect(result.current.hasUnsavedChanges).toBe(true);
    expect(localStorage.getItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY)).toBe("1");
    expect(localStorage.getItem(SETTINGS_THEME_MODE_STORAGE_KEY)).toBe("light");

    act(() => {
      result.current.handleDiscardChanges();
    });

    expect(result.current.settings.themeMode).toBe(BASE_SETTINGS.themeMode);
    expect(result.current.settings.localePreference).toBe(BASE_SETTINGS.localePreference);
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.setTheme).toHaveBeenLastCalledWith(BASE_SETTINGS.themeMode, { localOverride: false });
    expect(mocks.syncRemoteLocalePreference).toHaveBeenLastCalledWith(BASE_SETTINGS.localePreference);
    expect(localStorage.getItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(SETTINGS_THEME_MODE_STORAGE_KEY)).toBeNull();
  });

  it("saves custom configuration changes through the unified save action", async () => {
    const nextCategories = [
      ...DEFAULT_CUSTOM_CONFIG.categories,
      {
        id: "custom",
        value: "custom",
        labels: { "zh-CN": "自定义", "en-US": "Custom" },
        color: "hsl(200 80% 50%)",
      },
    ];
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.updateCategories(nextCategories);
    });

    expect(result.current.hasUnsavedChanges).toBe(true);

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      categories: nextCategories,
    }));
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("shows a localized message when the server rejects disabling every built-in icon source", async () => {
    mocks.updateSettingsMutateAsync.mockRejectedValue({
      code: "BUILT_IN_ICON_SOURCE_REQUIRED",
      message: "BUILT_IN_ICON_SOURCE_REQUIRED",
    });
    const { result } = renderSettingsFormController();

    act(() => {
      result.current.updateSetting("builtInIconSources", {
        thesvg: { enabled: false, variantsEnabled: true },
        selfhst: { enabled: false, variantsEnabled: true },
        dashboardIcons: { enabled: false, variantsEnabled: true },
      });
    });

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    expect(mocks.toast.error).toHaveBeenCalledWith("保存失败", {
      description: "请至少启用一个内置图标来源",
    });
  });

});
