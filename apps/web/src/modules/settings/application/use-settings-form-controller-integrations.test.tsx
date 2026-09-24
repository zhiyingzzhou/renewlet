// 设置页 controller 的独立集成入口，覆盖不应撑大主草稿/保存测试文件的外部能力。
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/subscription";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import {
  applySettingsSecretUpdates,
  appSettingsSecretStatus,
  type SettingsSecretUpdates,
} from "@renewlet/shared/schemas/settings";
import {
  APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_THEME_MODE_STORAGE_KEY,
} from "@/lib/theme-storage";
import { SETTINGS_INTEGRATION_TEST_MESSAGES } from "./settings-form-controller-test-messages";
import { useSettingsFormController } from "./use-settings-form-controller";
import type { SettingsNotificationHistoryController } from "./use-notification-history";

const BASE_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  recipientEmail: "alice@example.com",
};
type SettingsMutationCommand = { patch: AppSettings; secretUpdates: SettingsSecretUpdates };
type AppToast = (typeof import("@/components/ui/sonner"))["toast"];
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

function providerStatusFixtures(counts: Record<BuiltInIconProvider, number>) {
  return BUILT_IN_ICON_PROVIDERS.map((provider) => ({
    provider,
    current: {
      sourceRef: "embedded",
      displayVersion: "bundled",
      commitSha: null,
      commitShortSha: null,
      commitDate: null,
      releaseTag: null,
      releasePublishedAt: null,
    },
    latest: null,
    iconCount: counts[provider],
    checkedAt: null,
    refreshedAt: null,
    lastError: null,
    refreshing: false,
    updateAvailable: false,
  }));
}

const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn<AppToast["success"]>(),
    error: vi.fn<AppToast["error"]>(),
  },
  updateSettingsMutateAsync: vi.fn<(command: SettingsMutationCommand) => Promise<unknown>>(),
  refreshRates: vi.fn(),
  remoteSettings: undefined as unknown,
  remoteSecretStatus: undefined as unknown,
  customConfig: undefined as unknown,
  saveConfig: vi.fn(),
  setTheme: vi.fn(),
  clearThemeModeOverride: vi.fn(),
  theme: "dark",
  commitLocalePreference: vi.fn(),
  syncRemoteLocalePreference: vi.fn(),
  testConnection: vi.fn(),
  refetchNotificationHistory: vi.fn<() => Promise<void>>(),
  publicStatusPageStatus: { data: { enabled: false, pageUrl: undefined as string | undefined, showPrices: false, hideExpired: false, hideLifetime: false }, isLoading: false },
  createPublicStatusPageMutateAsync: vi.fn(),
  updatePublicStatusPageMutateAsync: vi.fn(),
  deletePublicStatusPageMutateAsync: vi.fn(),
  publicApiTokens: { data: [], isLoading: false },
  createPublicApiTokenMutateAsync: vi.fn(),
  deletePublicApiTokenMutateAsync: vi.fn(),
  telegramBotCommands: { data: undefined as unknown, isLoading: false, refetch: vi.fn() },
  installTelegramBotCommandsMutateAsync: vi.fn(),
  installTelegramBotCommandsIsPending: false,
  deleteTelegramBotCommandsMutateAsync: vi.fn(),
  deleteTelegramBotCommandsIsPending: false,
  builtInIconIndexStatus: {
    data: {
      source: "embedded",
      hash: "embedded-hash",
      iconCount: 100,
      providerCounts: { thesvg: 40, selfhst: 30, dashboardIcons: 30 },
      checkedAt: null,
      updatedAt: null,
      refreshing: false,
      providers: [] as ReturnType<typeof providerStatusFixtures>,
    },
    isLoading: false,
    refetch: vi.fn(),
  },
  checkBuiltInIconIndexProviderMutateAsync: vi.fn(),
  checkBuiltInIconIndexProviderIsPending: false,
  refreshBuiltInIconIndexProviderMutateAsync: vi.fn(),
  refreshBuiltInIconIndexProviderIsPending: false,
  writeClipboard: vi.fn(),
  fetch: vi.fn(),
  openWindow: vi.fn(),
  isCloudflareRuntime: false,
  accountIdentity: { email: "alice@example.com" as string | null, role: "admin", banned: false },
  appStatus: { setupRequired: false, setupEnabled: true, demoMode: false, turnstile: { enabled: false, siteKey: "" }, isLoading: false },
  authSecurityController: { canManage: true, disabled: false, isLoading: false, isSaving: false, isClearingSecret: false, isTesting: false, secretConfigured: false, hasChanges: false, draft: { enabled: false, siteKey: "", secret: "" }, testDialogOpen: false, testDialogSiteKey: "", testResetSignal: 0, testError: undefined, setEnabled: vi.fn(), setSiteKey: vi.fn(), setSecret: vi.fn(), discard: vi.fn(), save: vi.fn(), clearSecret: vi.fn(), startTest: vi.fn(), handleTestDialogOpenChange: vi.fn(), handleTestTokenChange: vi.fn() },
}));

function settingsMutationResult(command: SettingsMutationCommand) {
  const persisted = applySettingsSecretUpdates(command.patch, command.secretUpdates);
  const secretStatus = appSettingsSecretStatus(persisted);
  mocks.remoteSecretStatus = secretStatus;
  return { settings: command.patch, secretStatus };
}

function checkedIconProviders(): BuiltInIconProvider[] {
  return mocks.checkBuiltInIconIndexProviderMutateAsync.mock.calls.map((call) => call[0] as BuiltInIconProvider);
}

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettingsEnvelope: () => ({
    data: {
      settings: mocks.remoteSettings,
      secretStatus: mocks.remoteSecretStatus,
    },
  }),
  useUpdateSettings: () => ({
    mutateAsync: mocks.updateSettingsMutateAsync,
  }),
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => mocks.appStatus,
}));

vi.mock("./use-auth-security-settings-controller", () => ({
  useAuthSecuritySettingsController: () => mocks.authSecurityController,
}));

vi.mock("@/hooks/use-report-exchange-rates", () => ({
  useReportExchangeRates: () => ({
    rates: {},
    activeProvider: "floatrates",
    loading: false,
    isRefreshing: false,
    lastUpdated: null,
    refresh: mocks.refreshRates,
    error: null,
    reportBasisStatus: { month: "2026-08", locked: true, sourceDate: "2026-08-01", capturedAt: "2026-08-06T00:00:00Z" },
    getCurrencySymbol: (currency: string) => currency,
  }),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useSubscriptionFacets: () => ({
    data: { total: 0, categoryCounts: {}, tags: [], visibleCount: 0, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 },
    isPending: false,
    status: "success",
  }),
}));

vi.mock("@/hooks/use-public-status-page", () => ({
  usePublicStatusPageStatus: () => mocks.publicStatusPageStatus,
  useCreatePublicStatusPage: () => ({
    mutateAsync: mocks.createPublicStatusPageMutateAsync,
    isPending: false,
  }),
  useUpdatePublicStatusPage: () => ({
    mutateAsync: mocks.updatePublicStatusPageMutateAsync,
    isPending: false,
  }),
  useDeletePublicStatusPage: () => ({
    mutateAsync: mocks.deletePublicStatusPageMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-public-api-tokens", () => ({
  usePublicApiTokens: () => mocks.publicApiTokens,
  useCreatePublicApiToken: () => ({
    mutateAsync: mocks.createPublicApiTokenMutateAsync,
    isPending: false,
  }),
  useDeletePublicApiToken: () => ({
    mutateAsync: mocks.deletePublicApiTokenMutateAsync,
    isPending: false,
    variables: null,
  }),
}));

vi.mock("@/hooks/use-telegram-bot-commands", () => ({
  useTelegramBotCommands: () => mocks.telegramBotCommands,
  useInstallTelegramBotCommands: () => ({
    mutateAsync: mocks.installTelegramBotCommandsMutateAsync,
    isPending: mocks.installTelegramBotCommandsIsPending,
  }),
  useDeleteTelegramBotCommands: () => ({
    mutateAsync: mocks.deleteTelegramBotCommandsMutateAsync,
    isPending: mocks.deleteTelegramBotCommandsIsPending,
  }),
}));

vi.mock("@/lib/theme-provider", () => ({
  clearThemeModeOverride: mocks.clearThemeModeOverride,
  useTheme: () => ({
    theme: mocks.theme,
    setTheme: mocks.setTheme,
  }),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({ config: mocks.customConfig }),
  useCustomConfigActions: () => ({ saveConfig: mocks.saveConfig }),
}));

vi.mock("@/services/runtime", () => ({
  isCloudflareRuntime: () => mocks.isCloudflareRuntime,
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string | ((params: Record<string, unknown>) => string)> = {
        "settings.builtInIconIndexUpdated": ({ source, count }) => `${source} 已更新，${count} 个图标可用于 Logo 和图标搜索。`,
        "settings.builtInIconIndexRefreshFailed": "图标索引更新失败",
        "settings.builtInIconIndexRefreshFailedDescription": ({ source }) => `无法更新 ${source}，请稍后重试。`,
        "settings.builtInIconSourceShort.thesvg": "TheSVG",
        "settings.builtInIconSourceShort.selfhst": "selfh.st",
        "settings.builtInIconSourceShort.dashboardIcons": "Dashboard",
        "settings.publicStatusGenerated": "公开展示已生成",
        "settings.publicStatusCopied": "URL 已复制",
        "settings.publicStatusRegenerated": "公开展示已重新生成",
        "settings.publicStatusRevoked": "公开展示已撤销",
        "settings.publicStatusPricesEnabled": "公开页会显示价格和币种。",
        "settings.publicStatusPricesDisabled": "公开页将隐藏金额字段。",
        "settings.publicStatusFailed": "公开展示操作失败",
        "settings.publicStatusFailedDescription": "无法生成公开展示链接，请稍后重试。",
        "settings.publicStatusCopyFailed": "复制失败",
        "settings.publicStatusCopyFailedDescription": "当前一键复制不可用，请手动选择并复制 URL。",
        "settings.publicStatusRevokeFailedDescription": "无法撤销公开展示，请稍后重试。",
        "settings.publicStatusUpdateFailedDescription": "无法更新公开展示设置，请稍后重试。",
        ...SETTINGS_INTEGRATION_TEST_MESSAGES,
      };
      const message = messages[key] ?? key;
      return typeof message === "function" ? message(params ?? {}) : message;
    },
    commitLocalePreference: mocks.commitLocalePreference,
    syncRemoteLocalePreference: mocks.syncRemoteLocalePreference,
  }),
}));

vi.mock("./use-account-email", () => ({
  useAccountIdentity: () => mocks.accountIdentity,
}));

vi.mock("./use-notification-test", () => ({
  useNotificationTest: () => ({
    testingChannel: null,
    testConnection: mocks.testConnection,
  }),
}));

vi.mock("./use-password-change", () => ({
  usePasswordChange: () => ({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    error: null,
    isSubmitting: false,
    setCurrentPassword: vi.fn(),
    setNewPassword: vi.fn(),
    setConfirmPassword: vi.fn(),
    submit: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-password-reset-availability", () => ({
  usePasswordResetAvailability: () => false,
}));

vi.mock("./use-notification-history", () => ({
  useNotificationHistory: (): SettingsNotificationHistoryController => ({
    overview: {
      data: undefined,
      hasData: false,
      error: null,
      isInitialLoading: false,
      isRefreshing: false,
      retry: mocks.refetchNotificationHistory,
    },
    history: {
      data: undefined,
      hasData: false,
      error: null,
      isInitialLoading: false,
      isRefreshing: false,
      retry: mocks.refetchNotificationHistory,
    },
    historyStatus: "all",
    setStatus: vi.fn(),
    limit: 20,
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-built-in-icon-index", () => ({
  useBuiltInIconIndexStatus: () => mocks.builtInIconIndexStatus,
  useCheckBuiltInIconIndexProvider: () => ({
    mutateAsync: mocks.checkBuiltInIconIndexProviderMutateAsync,
    isPending: mocks.checkBuiltInIconIndexProviderIsPending,
  }),
  useRefreshBuiltInIconIndexProvider: () => ({
    mutateAsync: mocks.refreshBuiltInIconIndexProviderMutateAsync,
    isPending: mocks.refreshBuiltInIconIndexProviderIsPending,
  }),
}));

describe("useSettingsFormController integrations", () => {
  beforeEach(() => {
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.updateSettingsMutateAsync.mockReset();
    mocks.refreshRates.mockReset();
    mocks.saveConfig.mockReset();
    mocks.setTheme.mockReset();
    mocks.clearThemeModeOverride.mockReset();
    mocks.theme = "dark";
    mocks.commitLocalePreference.mockReset();
    mocks.syncRemoteLocalePreference.mockReset();
    mocks.refetchNotificationHistory.mockReset().mockResolvedValue(undefined);
    mocks.createPublicStatusPageMutateAsync.mockReset();
    mocks.updatePublicStatusPageMutateAsync.mockReset();
    mocks.deletePublicStatusPageMutateAsync.mockReset();
    mocks.createPublicApiTokenMutateAsync.mockReset();
    mocks.deletePublicApiTokenMutateAsync.mockReset();
    mocks.telegramBotCommands.refetch.mockReset();
    mocks.installTelegramBotCommandsMutateAsync.mockReset();
    mocks.installTelegramBotCommandsIsPending = false;
    mocks.deleteTelegramBotCommandsMutateAsync.mockReset();
    mocks.deleteTelegramBotCommandsIsPending = false;
    mocks.checkBuiltInIconIndexProviderMutateAsync.mockReset();
    mocks.checkBuiltInIconIndexProviderIsPending = false;
    mocks.refreshBuiltInIconIndexProviderMutateAsync.mockReset();
    mocks.refreshBuiltInIconIndexProviderIsPending = false;
    mocks.writeClipboard.mockReset();
    mocks.fetch.mockReset();
    mocks.openWindow.mockReset();
    localStorage.removeItem(APPEARANCE_PENDING_STORAGE_KEY);
    localStorage.removeItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY);
    localStorage.removeItem(SETTINGS_THEME_MODE_STORAGE_KEY);
    mocks.publicStatusPageStatus = { data: { enabled: false, pageUrl: undefined, showPrices: false, hideExpired: false, hideLifetime: false }, isLoading: false };
    mocks.publicApiTokens = { data: [], isLoading: false };
    mocks.telegramBotCommands = { data: undefined, isLoading: false, refetch: vi.fn().mockResolvedValue(undefined) };
    mocks.builtInIconIndexStatus = {
      data: {
        source: "embedded",
        hash: "embedded-hash",
        iconCount: 100,
        providerCounts: { thesvg: 40, selfhst: 30, dashboardIcons: 30 },
        checkedAt: null,
        updatedAt: null,
        refreshing: false,
        providers: providerStatusFixtures({ thesvg: 40, selfhst: 30, dashboardIcons: 30 }),
      },
      isLoading: false,
      refetch: vi.fn(),
    };
    mocks.remoteSettings = BASE_SETTINGS;
    mocks.remoteSecretStatus = appSettingsSecretStatus(BASE_SETTINGS);
    mocks.customConfig = DEFAULT_CUSTOM_CONFIG;
    mocks.isCloudflareRuntime = false;
    mocks.accountIdentity = { email: "alice@example.com", role: "admin", banned: false };
    mocks.appStatus = { setupRequired: false, setupEnabled: true, demoMode: false, turnstile: { enabled: false, siteKey: "" }, isLoading: false };
    mocks.updateSettingsMutateAsync.mockImplementation(async (command: SettingsMutationCommand) => settingsMutationResult(command));
    mocks.saveConfig.mockImplementation(async (config: CustomConfig) => config);
    mocks.refreshRates.mockResolvedValue({ status: "succeeded", warning: null });
    mocks.createPublicStatusPageMutateAsync.mockResolvedValue({
      enabled: true,
      createdAt: "2026-06-07T00:00:00Z",
      updatedAt: "2026-06-07T00:00:00Z",
      pageUrl: "https://example.com/status/secret",
      showPrices: false, hideExpired: false, hideLifetime: false,
    });
    mocks.updatePublicStatusPageMutateAsync.mockResolvedValue({
      enabled: true,
      createdAt: "2026-06-07T00:00:00Z",
      updatedAt: "2026-06-07T00:00:00Z",
      pageUrl: "https://example.com/status/secret",
      showPrices: true, hideExpired: false, hideLifetime: false,
    });
    mocks.deletePublicStatusPageMutateAsync.mockResolvedValue({});
    mocks.createPublicApiTokenMutateAsync.mockResolvedValue({
      token: {
        id: "tok_test",
        name: "Telegram Bot",
        tokenPrefix: "rlt_test123",
        scopes: ["read"],
        createdAt: "2026-06-20T00:00:00Z",
      },
      plainToken: "rlt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12",
    });
    mocks.deletePublicApiTokenMutateAsync.mockResolvedValue({});
    mocks.installTelegramBotCommandsMutateAsync.mockResolvedValue({
      configComplete: true,
      installed: true,
      status: "installed",
      chatId: "123456",
      installedAt: "2026-06-20T00:00:00Z",
      lastUsedAt: null,
    });
    mocks.deleteTelegramBotCommandsMutateAsync.mockResolvedValue(undefined);
    mocks.checkBuiltInIconIndexProviderMutateAsync.mockImplementation(async (provider: BuiltInIconProvider) => ({
      status: {
        ...(mocks.builtInIconIndexStatus.data as object),
      },
      provider: providerStatusFixtures({ thesvg: 40, selfhst: 30, dashboardIcons: 30 }).find((item) => item.provider === provider),
    }));
    mocks.refreshBuiltInIconIndexProviderMutateAsync.mockResolvedValue({
      status: {
        source: "runtime",
        hash: "runtime-hash",
        iconCount: 321,
        providerCounts: { thesvg: 120, selfhst: 100, dashboardIcons: 101 },
        checkedAt: "2026-06-11T00:00:00Z",
        updatedAt: "2026-06-11T00:00:00Z",
        refreshing: false,
        providers: providerStatusFixtures({ thesvg: 120, selfhst: 100, dashboardIcons: 101 }),
      },
      provider: providerStatusFixtures({ thesvg: 120, selfhst: 100, dashboardIcons: 101 })[0],
      job: { id: "docker-thesvg-20260611000000", provider: "thesvg", status: "succeeded", queuedAt: "2026-06-11T00:00:00Z", startedAt: "2026-06-11T00:00:00Z", finishedAt: "2026-06-11T00:00:00Z", attempts: 1, error: null, indexHash: "a".repeat(64) },
    });
    mocks.writeClipboard.mockResolvedValue(undefined);
    mocks.fetch.mockResolvedValue(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8" },
    }));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mocks.writeClipboard },
      configurable: true,
    });
    vi.stubGlobal("fetch", mocks.fetch);
    Object.defineProperty(window, "open", {
      value: mocks.openWindow,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalExecCommandDescriptor) {
      Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    localStorage.clear();
  });

  it("refreshes the built-in icon index without marking settings dirty", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    expect(result.current.builtInIconIndex.canManage).toBe(true);
    expect(result.current.hasUnsavedChanges).toBe(false);

    await act(async () => {
      await result.current.builtInIconIndex.refreshProvider("thesvg");
    });

    expect(mocks.refreshBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledWith("thesvg");
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith("TheSVG 已更新，120 个图标可用于 Logo 和图标搜索。");
  });

  it("checks a single built-in icon provider without marking settings dirty", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await result.current.builtInIconIndex.checkProvider("selfhst");
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledWith("selfhst");
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
  });

  it("checks all built-in icon providers from the sources dialog without marking settings dirty", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await result.current.builtInIconIndex.checkAllProviders();
    });

    expect(checkedIconProviders()).toEqual([
      "thesvg",
      "selfhst",
      "dashboardIcons",
    ]);
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
  });

  it("deduplicates dialog-level provider checks while keeping manual retry available", async () => {
    const { result } = renderHook(() => useSettingsFormController());
    let releaseFirstBatch: (() => void) | null = null;
    mocks.checkBuiltInIconIndexProviderMutateAsync.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    }));

    let firstBatch!: Promise<void>;
    let secondBatch!: Promise<void>;
    act(() => {
      firstBatch = result.current.builtInIconIndex.checkAllProviders();
      secondBatch = result.current.builtInIconIndex.checkAllProviders();
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenLastCalledWith("thesvg");

    await act(async () => {
      releaseFirstBatch?.();
      await firstBatch;
      await secondBatch;
    });

    expect(checkedIconProviders()).toEqual([
      "thesvg",
      "selfhst",
      "dashboardIcons",
    ]);

    await act(async () => {
      await result.current.builtInIconIndex.checkProvider("dashboardIcons");
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledTimes(4);
    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenLastCalledWith("dashboardIcons");
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("skips dialog-level provider checks for non-admin, pending, or refreshing providers", async () => {
    mocks.accountIdentity = { email: "alice@example.com", role: "user", banned: false };
    const { result: userResult } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await userResult.current.builtInIconIndex.checkAllProviders();
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).not.toHaveBeenCalled();

    mocks.accountIdentity = { email: "alice@example.com", role: "admin", banned: false };
    mocks.checkBuiltInIconIndexProviderIsPending = true;
    const { result: pendingResult } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await pendingResult.current.builtInIconIndex.checkAllProviders();
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).not.toHaveBeenCalled();

    mocks.checkBuiltInIconIndexProviderIsPending = false;
    mocks.builtInIconIndexStatus = {
      ...mocks.builtInIconIndexStatus,
      data: {
        ...mocks.builtInIconIndexStatus.data,
        providers: providerStatusFixtures({ thesvg: 40, selfhst: 30, dashboardIcons: 30 }).map((providerStatus) => (
          providerStatus.provider === "dashboardIcons" ? { ...providerStatus, refreshing: true } : providerStatus
        )),
      },
    };
    const { result: refreshingResult } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await refreshingResult.current.builtInIconIndex.checkAllProviders();
    });

    expect(checkedIconProviders()).toEqual([
      "thesvg",
      "selfhst",
    ]);
    expect(refreshingResult.current.hasUnsavedChanges).toBe(false);
  });

  it("shows a destructive toast when the built-in icon index refresh fails", async () => {
    mocks.refreshBuiltInIconIndexProviderMutateAsync.mockRejectedValue(new Error("Registry offline"));
    const { result } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await result.current.builtInIconIndex.refreshProvider("thesvg");
    });

    expect(mocks.toast.error).toHaveBeenCalledWith("图标索引更新失败", {
      description: "Registry offline",
    });
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("saves Telegram message format through the regular settings draft", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    act(() => {
      result.current.updateSetting("telegramMessageFormat", "html");
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
    await act(async () => {
      await result.current.handleSaveChanges();
    });

    const command = mocks.updateSettingsMutateAsync.mock.calls.at(0)?.at(0);
    expect(command?.patch.telegramMessageFormat).toBe("html");
    expect(mocks.telegramBotCommands.refetch).toHaveBeenCalledTimes(1);
  });

  it("manages the public status page URL and price visibility", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    expect(result.current.publicStatusPage.status.data?.enabled).toBe(false);
    expect(result.current.publicStatusPage.status.data?.pageUrl).toBeUndefined();
    await act(async () => {
      await result.current.publicStatusPage.createOrRotate();
    });
    expect(mocks.createPublicStatusPageMutateAsync).toHaveBeenCalledTimes(1);
    mocks.publicStatusPageStatus = {
      data: {
        enabled: true,
        pageUrl: "https://example.com/status/secret",
        showPrices: false, hideExpired: false, hideLifetime: false,
      },
      isLoading: false,
    };
    const { result: enabledResult } = renderHook(() => useSettingsFormController());
    expect(enabledResult.current.publicStatusPage.status.data?.pageUrl).toBe("https://example.com/status/secret");
    await act(async () => {
      await enabledResult.current.publicStatusPage.copyUrl();
    });
    expect(mocks.writeClipboard).toHaveBeenCalledWith("https://example.com/status/secret");
    await act(async () => {
      await enabledResult.current.publicStatusPage.openPage();
    });
    expect(mocks.openWindow).toHaveBeenCalledWith("https://example.com/status/secret", "_blank", "noopener,noreferrer");
    await act(async () => {
      await enabledResult.current.publicStatusPage.updateShowPrices(true);
    });
    expect(mocks.updatePublicStatusPageMutateAsync).toHaveBeenCalledWith({ showPrices: true, hideExpired: false, hideLifetime: false });
    await act(async () => {
      await enabledResult.current.publicStatusPage.regenerate();
    });
    expect(mocks.deletePublicStatusPageMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createPublicStatusPageMutateAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      await enabledResult.current.publicStatusPage.revoke();
    });
    expect(mocks.deletePublicStatusPageMutateAsync).toHaveBeenCalledTimes(2);
  });

});

vi.mock("@/hooks/use-bulk-public-visibility", () => ({
  useBulkPublicVisibility: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
