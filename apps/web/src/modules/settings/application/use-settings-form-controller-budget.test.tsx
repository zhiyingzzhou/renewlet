// 月度预算测试保护输入态字符串与业务态 number 的分离；清空只能停留为无效草稿，保存/放弃/远端同步才重置。
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/subscription";
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
import { useSettingsFormController } from "./use-settings-form-controller";
import type { SettingsNotificationHistoryController } from "./use-notification-history";

const BASE_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  recipientEmail: "alice@example.com",
};

type SettingsMutationCommand = { patch: AppSettings; secretUpdates: SettingsSecretUpdates };
type AppToast = (typeof import("@/components/ui/sonner"))["toast"];

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

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettingsEnvelope: () => ({
    data: { settings: mocks.remoteSettings, secretStatus: mocks.remoteSecretStatus },
  }),
  useUpdateSettings: () => ({ mutateAsync: mocks.updateSettingsMutateAsync }),
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
    getCurrencySymbol: () => "¥",
  }),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useSubscriptionFacets: () => ({
    data: { total: 0, categoryCounts: {}, tags: [], visibleCount: 0, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 },
    isPending: false,
    status: "success",
  }),
}));

vi.mock("@/hooks/use-password-reset-availability", () => ({
  usePasswordResetAvailability: () => true,
}));

vi.mock("@/hooks/use-built-in-icon-index", () => ({
  useBuiltInIconIndexStatus: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
  useCheckBuiltInIconIndexProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRefreshBuiltInIconIndexProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-public-status-page", () => ({
  usePublicStatusPageStatus: () => mocks.publicStatusPageStatus,
  useCreatePublicStatusPage: () => ({ mutateAsync: mocks.createPublicStatusPageMutateAsync, isPending: false }),
  useUpdatePublicStatusPage: () => ({ mutateAsync: mocks.updatePublicStatusPageMutateAsync, isPending: false }),
  useDeletePublicStatusPage: () => ({ mutateAsync: mocks.deletePublicStatusPageMutateAsync, isPending: false }),
}));

vi.mock("@/hooks/use-public-api-tokens", () => ({
  usePublicApiTokens: () => mocks.publicApiTokens,
  useCreatePublicApiToken: () => ({ mutateAsync: mocks.createPublicApiTokenMutateAsync, isPending: false }),
  useDeletePublicApiToken: () => ({ mutateAsync: mocks.deletePublicApiTokenMutateAsync, isPending: false, variables: null }),
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
  useTheme: () => ({ theme: mocks.theme, setTheme: mocks.setTheme }),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({ config: mocks.customConfig }),
  useCustomConfigActions: () => ({ saveConfig: mocks.saveConfig }),
}));

vi.mock("@/services/runtime", () => ({
  get isCloudflareRuntime() {
    return mocks.isCloudflareRuntime;
  },
}));

vi.mock("@/i18n/I18nProvider", () => {
  const messages: Record<string, string> = {
    "settings.saved": "设置已保存",
    "settings.saveFailed": "保存失败",
    "settings.budgetInvalid": "预算金额无效",
    "settings.telegramBotCommandsConfigMissing": "请先填写并保存 Bot Token 和 Chat ID。",
    "settings.telegramBotCommandsHttpsRequired": "Telegram Webhook 需要 HTTPS 外部访问地址。",
  };

  return {
    useI18n: () => ({
      t: (key: string) => messages[key] ?? key,
      commitLocalePreference: mocks.commitLocalePreference,
      syncRemoteLocalePreference: mocks.syncRemoteLocalePreference,
    }),
  };
});

vi.mock("./use-account-email", () => ({
  useAccountIdentity: () => mocks.accountIdentity,
}));

vi.mock("./use-notification-test", () => ({
  useNotificationTest: () => ({ testingChannel: null, testConnection: mocks.testConnection }),
}));

vi.mock("./use-password-change", () => ({
  usePasswordChange: () => ({
    passwordDialogOpen: false,
    setPasswordDialogOpen: vi.fn(),
    handlePasswordDialogOpenChange: vi.fn(),
    currentPassword: "",
    setCurrentPassword: vi.fn(),
    newPassword: "",
    setNewPassword: vi.fn(),
    confirmPassword: "",
    setConfirmPassword: vi.fn(),
    isUpdatingPassword: false,
    updatePassword: vi.fn(),
  }),
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

describe("useSettingsFormController monthly budget input", () => {
  beforeEach(() => {
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.updateSettingsMutateAsync.mockReset();
    mocks.refreshRates.mockReset();
    mocks.refetchNotificationHistory.mockReset().mockResolvedValue(undefined);
    mocks.saveConfig.mockReset();
    mocks.createPublicApiTokenMutateAsync.mockReset();
    mocks.deletePublicApiTokenMutateAsync.mockReset();
    mocks.telegramBotCommands.refetch.mockReset();
    mocks.installTelegramBotCommandsMutateAsync.mockReset();
    mocks.installTelegramBotCommandsIsPending = false;
    mocks.deleteTelegramBotCommandsMutateAsync.mockReset();
    mocks.deleteTelegramBotCommandsIsPending = false;
    mocks.setTheme.mockReset();
    mocks.clearThemeModeOverride.mockReset();
    mocks.theme = "dark";
    mocks.commitLocalePreference.mockReset();
    mocks.syncRemoteLocalePreference.mockReset();
    localStorage.removeItem(APPEARANCE_PENDING_STORAGE_KEY);
    localStorage.removeItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY);
    localStorage.removeItem(SETTINGS_THEME_MODE_STORAGE_KEY);
    mocks.remoteSettings = BASE_SETTINGS;
    mocks.remoteSecretStatus = appSettingsSecretStatus(BASE_SETTINGS);
    mocks.customConfig = DEFAULT_CUSTOM_CONFIG;
    mocks.publicApiTokens = { data: [], isLoading: false };
    mocks.telegramBotCommands = { data: undefined, isLoading: false, refetch: vi.fn().mockResolvedValue(undefined) };
    mocks.isCloudflareRuntime = false;
    mocks.accountIdentity = { email: "alice@example.com", role: "admin", banned: false };
    mocks.appStatus = { setupRequired: false, setupEnabled: true, demoMode: false, turnstile: { enabled: false, siteKey: "" }, isLoading: false };
    mocks.updateSettingsMutateAsync.mockImplementation(async (command: SettingsMutationCommand) => settingsMutationResult(command));
    mocks.saveConfig.mockImplementation(async (config: CustomConfig) => config);
    mocks.refreshRates.mockResolvedValue({ status: "succeeded", warning: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an emptied monthly budget as an invalid edit instead of writing zero", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    act(() => {
      result.current.handleMonthlyBudgetInputChange("");
    });

    expect(result.current.monthlyBudgetInput).toBe("");
    expect(result.current.settings.monthlyBudget).toBe(BASE_SETTINGS.monthlyBudget);
    expect(result.current.monthlyBudgetError).toBe("预算金额无效");
    expect(result.current.hasUnsavedChanges).toBe(true);

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith("保存失败", {
      description: "预算金额无效",
    });
  });

  it("updates the monthly budget only when the numeric input is valid", () => {
    const { result } = renderHook(() => useSettingsFormController());

    act(() => {
      result.current.handleMonthlyBudgetInputChange("0");
    });
    expect(result.current.monthlyBudgetInput).toBe("0");
    expect(result.current.settings.monthlyBudget).toBe("0");
    expect(result.current.monthlyBudgetError).toBeNull();

    act(() => {
      result.current.handleMonthlyBudgetInputChange("1000.5");
    });
    expect(result.current.monthlyBudgetInput).toBe("1000.5");
    expect(result.current.settings.monthlyBudget).toBe("1000.5");
    expect(result.current.monthlyBudgetError).toBeNull();
  });

  it("normalizes monthly budget input after saving or discarding edits", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    act(() => {
      result.current.handleMonthlyBudgetInputChange("1500.0");
    });
    expect(result.current.monthlyBudgetInput).toBe("1500.0");
    expect(result.current.hasUnsavedChanges).toBe(true);

    await act(async () => {
      await result.current.handleSaveChanges();
    });

    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
    expect(result.current.monthlyBudgetInput).toBe("1500");
    expect(result.current.monthlyBudgetError).toBeNull();
    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => {
      result.current.handleMonthlyBudgetInputChange("");
    });
    expect(result.current.monthlyBudgetInput).toBe("");
    expect(result.current.monthlyBudgetError).toBe("预算金额无效");

    act(() => {
      result.current.handleDiscardChanges();
    });

    expect(result.current.monthlyBudgetInput).toBe("1500");
    expect(result.current.monthlyBudgetError).toBeNull();
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("syncs monthly budget input from remote settings while the form is clean", async () => {
    const { result, rerender } = renderHook(() => useSettingsFormController());

    mocks.remoteSettings = { ...BASE_SETTINGS, monthlyBudget: "2500" };
    rerender();

    await waitFor(() => {
      expect(result.current.settings.monthlyBudget).toBe("2500");
    });
    expect(result.current.monthlyBudgetInput).toBe("2500");
    expect(result.current.hasUnsavedChanges).toBe(false);
  });
});

vi.mock("@/hooks/use-bulk-public-visibility", () => ({
  useBulkPublicVisibility: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
