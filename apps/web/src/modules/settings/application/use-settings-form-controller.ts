/**
 * 设置页 application controller。
 *
 * 架构位置：
 * - presentation 只渲染 `SettingsScreen`，所有副作用都在这里收敛。
 * - domain 只提供纯规则（分类使用计数、货币启用策略），避免框架依赖进入业务规则。
 *
 * 关键依赖：
 * - React Query hooks：读取/保存 settings、subscriptions、自定义配置。
 * - 本地 ThemeProvider + theme-storage：处理“立即预览但稍后保存”的外观状态。
 * - toast/api hooks：把网络错误转成用户可理解的反馈。
 *
 * 状态流转：
 * ```
 * 远端 settings -> 首次初始化本地表单
 *              -> 若本地外观有 pending，则外观字段以 localStorage 为准
 * 用户编辑表单 -> draft state
 *              -> 保存更改 -> API -> React Query 缓存 + saved snapshot
 * ```
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aiRecognitionSettingsSchema } from "@renewlet/shared/schemas/ai-recognition";
import { clearThemeModeOverride, useTheme } from "@/lib/theme-provider";
import { useCustomConfigActions, useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useReportExchangeRates } from "@/hooks/use-report-exchange-rates";
import { useSettingsEnvelope, useUpdateSettings } from "@/hooks/use-settings";
import { useSubscriptionFacets } from "@/hooks/use-subscriptions";
import { usePasswordResetAvailability } from "@/hooks/use-password-reset-availability";
import { useSetupStatus } from "@/hooks/use-setup-status";
import { toast } from "@/components/ui/sonner";
import { getDisplayErrorMessage } from "@/lib/display-error";
import type { RawErrorResponseDetails } from "@/lib/raw-error-response";
import { applyThemeVariant } from "@/lib/theme-variant";
import {
  clearSettingsAppearanceDraftFromStorage,
  writeAppearancePendingToStorage,
  writeCustomThemeColorToStorage,
  writeSettingsThemeModeToStorage,
  writeThemeVariantToStorage,
} from "@/lib/theme-storage";
import type { ExchangeRateProvider } from "@/lib/api/schemas/exchange-rates";
import { DEFAULT_SETTINGS, type AppSettings, type NotificationChannel } from "@/types/subscription";
import { normalizePaymentMethods, type ConfigItem, type CustomConfig } from "@/types/config";
import type { CustomThemeColor, ThemeMode, ThemeVariant } from "@/types/theme";
import { parseMoneyInput } from "@/lib/subscription-form";
import { normalizeCustomConfig } from "@/modules/custom-config/domain/normalize-custom-config";
import { isCloudflareRuntime } from "@/services/runtime";
import { enforceCurrencyConfigPolicy } from "../domain/currency-config-policy";
import { useAccountIdentity } from "./use-account-email";
import { useNotificationTest } from "./use-notification-test";
import { usePasswordChange } from "./use-password-change";
import {
  areJsonSnapshotsEqual,
  createDraftSettingsFromRemote,
  createSavedSettingsBaseline,
  EXTERNAL_INTEGRATION_SETTING_KEYS,
  getExchangeRateProviderSaveErrorMessage,
} from "./settings-form-controller-utils";
import { usePublicStatusPageSettingsController } from "./use-public-status-page-settings-controller";
import { usePublicApiSettingsController } from "./use-public-api-settings-controller";
import { useTelegramBotCommandsController } from "./use-telegram-bot-commands-controller";
import { useSettingsBuiltInIconIndexController } from "./use-built-in-icon-index-controller";
import { useAuthSecuritySettingsController } from "./use-auth-security-settings-controller";
import { useNotificationHistory } from "./use-notification-history";
import { useI18n } from "@/i18n/I18nProvider";
import { type SettingsSecretKey } from "@/lib/api/schemas/settings";
import { EMPTY_SETTINGS_SECRET_STATUS } from "@/services/settings-service";
import { useSettingsSecretDrafts } from "./use-settings-secret-drafts";
import type { SettingsFormController } from "./settings-form-controller-types";
import { toSettingsReadState } from "./settings-read-state";
import { useRouteReady } from "@/components/route-progress";
export type { SettingsFormController } from "./settings-form-controller-types";

/**
 * 集中协调 Settings 页的远端状态、本地编辑态和跨模块用例。
 *
 * 注意： Settings 页只有这一处写入口。新增设置字段时，要同时检查：
 * settings schema、默认值、API merge 策略，以及是否应该纳入统一保存草稿。
 */
export function useSettingsFormController(): SettingsFormController {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [customConfig, setCustomConfig] = useState<CustomConfig>(() => normalizeCustomConfig(null));
  const [savedCustomConfig, setSavedCustomConfig] = useState<CustomConfig>(() => normalizeCustomConfig(null));
  const [hasInitializedCustomConfig, setHasInitializedCustomConfig] = useState(false);
  const [monthlyBudgetInput, setMonthlyBudgetInput] = useState(String(DEFAULT_SETTINGS.monthlyBudget));
  const [monthlyBudgetError, setMonthlyBudgetError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const accountIdentity = useAccountIdentity();
  const accountEmail = accountIdentity.email;
  const canManageUsers = accountIdentity.role === "admin" && !accountIdentity.banned;
  const { data: remoteEnvelope, isPending: settingsPending } = useSettingsEnvelope();
  const remoteSettings = remoteEnvelope?.settings;
  // settings 请求结束后还要等首份草稿提交，不能把默认设置的过渡帧当作页面就绪。
  useRouteReady(settingsPending || Boolean(remoteSettings && savedSettings === DEFAULT_SETTINGS));
  const secretStatus = remoteEnvelope?.secretStatus ?? EMPTY_SETTINGS_SECRET_STATUS;
  const subscriptionFacetsQuery = useSubscriptionFacets();
  const subscriptionFacets = toSettingsReadState(subscriptionFacetsQuery);
  const updateSettings = useUpdateSettings();
  const { theme, setTheme } = useTheme();
  const { config: persistedCustomConfig } = useCustomConfigState();
  const { saveConfig } = useCustomConfigActions();
  const {
    rates,
    activeProvider: activeRateProvider,
    loading: ratesLoading,
    isRefreshing: ratesRefreshing,
    lastUpdated,
    refresh: refreshRates,
    error: ratesError,
    errorDetails: ratesErrorDetails,
    warning: ratesWarning,
    reportBasisStatus,
    getCurrencySymbol,
  } = useReportExchangeRates(savedSettings.exchangeRateProvider);
  const ratesRefreshPending = ratesLoading || ratesRefreshing;
  const { t, commitLocalePreference, syncRemoteLocalePreference } = useI18n();
  const appStatus = useSetupStatus();
  const externalIntegrationsDisabled = appStatus.isLoading || appStatus.demoMode;
  // demo 模式同时禁用外部集成和账号安全写操作；这里拆成两个语义，避免后续把密码/MFA/Passkey 误归到外部集成策略里。
  const sensitiveAccountActionsDisabled = appStatus.isLoading || appStatus.demoMode;
  const sensitiveAccountActionsDemoDisabled = appStatus.demoMode;
  const password = usePasswordChange();
  const passwordResetEnabled = usePasswordResetAvailability();
  const {
    drafts: secretDrafts,
    cleared: clearedSecrets,
    settingsWithDrafts,
    dirty: secretsDirty,
    stageSetting: stageSecretSetting,
    clear: clearSecretDraft,
    updates: buildSecretUpdates,
    reset: resetSecretDrafts,
  } = useSettingsSecretDrafts(settings, externalIntegrationsDisabled);
  const notificationTest = useNotificationTest(
    settings,
    secretDrafts,
    clearedSecrets,
  );
  const notificationHistory = useNotificationHistory();
  const canRefreshBuiltInIconIndex = accountIdentity.role === "admin";
  const builtInIconIndex = useSettingsBuiltInIconIndexController(canRefreshBuiltInIconIndex);
  const authSecurity = useAuthSecuritySettingsController(canManageUsers, sensitiveAccountActionsDisabled);
  const refetchNotificationHistory = useCallback(async () => {
    await Promise.all([
      notificationHistory.overview.retry(),
      notificationHistory.history.retry(),
    ]);
  }, [notificationHistory.history, notificationHistory.overview]);
  const hasInitializedFromRemoteRef = useRef(false);
  const hasResolvedDefaultRecipientEmailRef = useRef(false);
  const settingsDirtyRef = useRef(false);
  const customConfigDirtyRef = useRef(false);

  const categoryUsageCount = useMemo(
    () => new Map(Object.entries(subscriptionFacetsQuery.data?.categoryCounts ?? {})),
    [subscriptionFacetsQuery.data?.categoryCounts],
  );
  const publicStatusPage = usePublicStatusPageSettingsController(subscriptionFacets);
  const publicApi = usePublicApiSettingsController();
  const telegramBotCommands = useTelegramBotCommandsController({
    settings: settingsWithDrafts,
    savedSettings,
    telegramTokenConfigured: secretStatus.telegramBotToken.configured,
    externalIntegrationsDisabled,
  });
  const { refetch: refetchTelegramBotCommands } = telegramBotCommands;

  const monthlyBudgetInputDirty = monthlyBudgetInput !== String(settings.monthlyBudget);
  const settingsDirty = useMemo(
    () => !areJsonSnapshotsEqual(settings, savedSettings)
      || secretsDirty,
    [secretsDirty, settings, savedSettings],
  );
  const settingsInputDirty = settingsDirty || monthlyBudgetInputDirty;
  const customConfigDirty = useMemo(
    () => !areJsonSnapshotsEqual(customConfig, savedCustomConfig),
    [customConfig, savedCustomConfig],
  );
  const hasUnsavedChanges = settingsInputDirty || customConfigDirty;
  const effectiveThemeMode: ThemeMode = theme;

  useEffect(() => {
    // effect 读取 ref 而不是把 draft 放入依赖，是为了在远端刷新时判断“当前是否仍可安全覆盖本地草稿”。
    settingsDirtyRef.current = settingsInputDirty;
  }, [settingsInputDirty]);

  useEffect(() => {
    // 自定义配置可能由独立 Provider 防抖保存回流；dirty ref 防止回流覆盖用户正在编辑的草稿。
    customConfigDirtyRef.current = customConfigDirty;
  }, [customConfigDirty]);

  useEffect(() => {
    if (!remoteSettings) return;
    // 收件人邮箱默认值必须和远端 settings 同步在同一条 effect 里生成，避免 Cloudflare session 先恢复时被下一轮远端草稿覆盖。
    const shouldDefaultRecipientEmail = !externalIntegrationsDisabled && !hasResolvedDefaultRecipientEmailRef.current;
    const nextDraft = createDraftSettingsFromRemote(
      remoteSettings,
      shouldDefaultRecipientEmail ? accountEmail : null,
      shouldDefaultRecipientEmail,
    );
    const nextSavedSettings = createSavedSettingsBaseline(remoteSettings, nextDraft);
    const hasResolvedRecipientEmail = Boolean(nextDraft.recipientEmail.trim());
    if (!hasInitializedFromRemoteRef.current) {
      setSavedSettings(nextSavedSettings);
      setSettings(nextDraft);
      setMonthlyBudgetInput(String(nextDraft.monthlyBudget));
      if (hasResolvedRecipientEmail) hasResolvedDefaultRecipientEmailRef.current = true;
      hasInitializedFromRemoteRef.current = true;
      return;
    }

    // 只有本地草稿未脏时才用远端刷新覆盖，避免 React Query 背景刷新吞掉用户未保存编辑。
    if (!settingsDirtyRef.current) {
      setSavedSettings(nextSavedSettings);
      setSettings(nextDraft);
      setMonthlyBudgetInput(String(nextDraft.monthlyBudget));
      if (hasResolvedRecipientEmail) hasResolvedDefaultRecipientEmailRef.current = true;
    } else if (remoteSettings.recipientEmail.trim()) {
      hasResolvedDefaultRecipientEmailRef.current = true;
    }
  }, [accountEmail, externalIntegrationsDisabled, remoteSettings]);

  useEffect(() => {
    const normalized = normalizeCustomConfig(persistedCustomConfig);
    if (!hasInitializedCustomConfig) {
      setSavedCustomConfig(normalized);
      setCustomConfig(normalized);
      setHasInitializedCustomConfig(true);
      return;
    }

    if (!customConfigDirtyRef.current) {
      // Provider 的防抖保存会回流远端配置；未脏时同步，脏时让用户继续编辑当前草稿。
      setSavedCustomConfig(normalized);
      setCustomConfig(normalized);
    }
  }, [hasInitializedCustomConfig, persistedCustomConfig]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    // Demo 置灰只是体验层；controller 也阻止本地草稿改动外部集成字段，真正安全边界仍在后端 route/hook。
    if (externalIntegrationsDisabled && EXTERNAL_INTEGRATION_SETTING_KEYS.has(key)) return;
    const secretResult = stageSecretSetting(key, value);
    if (secretResult === "blocked") return;
    if (secretResult === "staged" && key === "aiRecognition") {
      const aiRecognition = aiRecognitionSettingsSchema.parse(value);
      setSettings((prev) => ({
        ...prev,
        aiRecognition: { ...aiRecognition, apiKey: "" },
      }));
      return;
    }
    if (secretResult === "staged") return;
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, [externalIntegrationsDisabled, stageSecretSetting]);

  const clearSecret = useCallback((key: SettingsSecretKey) => {
    clearSecretDraft(key);
  }, [clearSecretDraft]);

  const handleMonthlyBudgetInputChange = useCallback(
    (rawValue: string) => {
      setMonthlyBudgetInput(rawValue);
      if (rawValue.trim() === "") {
        setMonthlyBudgetError(t("settings.budgetInvalid"));
        return;
      }

      const parsed = parseMoneyInput(rawValue);
      if (parsed === null) {
        setMonthlyBudgetError(t("settings.budgetInvalid"));
        return;
      }

      setMonthlyBudgetError(null);
      updateSetting("monthlyBudget", parsed);
    },
    [t, updateSetting],
  );

  const toggleChannel = useCallback((channel: NotificationChannel) => {
    if (externalIntegrationsDisabled) return;
    setSettings((prev) => ({
      ...prev,
      enabledChannels: prev.enabledChannels.includes(channel)
        ? prev.enabledChannels.filter((c) => c !== channel)
        : [...prev.enabledChannels, channel],
    }));
  }, [externalIntegrationsDisabled]);

  const updateCategories = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, categories: items }));
  }, []);

  const updateStatuses = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, statuses: items }));
  }, []);

  const updatePaymentMethods = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, paymentMethods: normalizePaymentMethods(items) }));
  }, []);

  const updateCurrencies = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, currencies: items }));
  }, []);

  const handleRefreshRates = useCallback(async () => {
    const result = await refreshRates(savedSettings.exchangeRateProvider);
    if (result.status === "succeeded") {
      toast.success(t("exchangeRates.updated"));
    }
  }, [refreshRates, savedSettings.exchangeRateProvider, t]);

  const handleUpdateCurrencies = useCallback(
    (items: ConfigItem[]) => {
      // 货币开关会影响新增订阅下拉和全站统计口径，因此策略放在 domain 层统一约束。
      const result = enforceCurrencyConfigPolicy(items, settings.defaultCurrency);
      if (result.ok) {
        updateCurrencies(result.items);
        return;
      }

      toast.error(
        result.reason === "none-enabled"
          ? t("settings.currencyPolicy.noneTitle")
          : t("settings.currencyPolicy.defaultTitle"),
        { description: result.reason === "none-enabled"
          ? t("settings.currencyPolicy.noneDescription")
          : t("settings.currencyPolicy.defaultDescription", { currency: settings.defaultCurrency }) },
      );

      if (result.items) updateCurrencies(result.items);
    },
    [settings.defaultCurrency, t, updateCurrencies],
  );

  const syncSavedPreviewState = useCallback(
    (nextSettings: AppSettings, options: { syncAppearance: boolean; rememberLocalePreference?: boolean }) => {
      if (options.syncAppearance) {
        clearThemeModeOverride();
        setTheme(nextSettings.themeMode, { localOverride: false });
        applyThemeVariant(nextSettings.themeVariant, nextSettings.themeCustomColor);
        writeThemeVariantToStorage(nextSettings.themeVariant);
        writeCustomThemeColorToStorage(nextSettings.themeCustomColor);
        clearSettingsAppearanceDraftFromStorage();
      }
      if (options.rememberLocalePreference) {
        commitLocalePreference(nextSettings.localePreference);
      } else {
        syncRemoteLocalePreference(nextSettings.localePreference);
      }
    },
    [commitLocalePreference, setTheme, syncRemoteLocalePreference],
  );

  // 保存失败使用完整远端基线驱动预览回滚，因此回调必须依赖整个 savedSettings 快照，不能按当前字段手工拆分。
  const handleSaveChanges = useCallback(async () => {
    if (isSavingSettings || !hasUnsavedChanges) return;
    if (monthlyBudgetError) {
      toast.error(t("settings.saveFailed"), { description: monthlyBudgetError });
      return;
    }

    setIsSavingSettings(true);
    const shouldSaveSettings = settingsDirty;
    const shouldSaveCustomConfig = customConfigDirty;
    const providerChanged = settings.exchangeRateProvider !== savedSettings.exchangeRateProvider;
    const localeChanged = settings.localePreference !== savedSettings.localePreference;
    const appearanceChanged = settings.themeMode !== savedSettings.themeMode
      || settings.themeVariant !== savedSettings.themeVariant
      || !areJsonSnapshotsEqual(settings.themeCustomColor, savedSettings.themeCustomColor);

    try {
      const secretUpdates = buildSecretUpdates();
      const settingsPromise = shouldSaveSettings
        ? updateSettings.mutateAsync({ patch: settings, secretUpdates })
        : Promise.resolve(null);
      const customConfigPromise: Promise<CustomConfig | null> = shouldSaveCustomConfig
        ? saveConfig(customConfig)
        : Promise.resolve(null);
      // settings 与 custom config 是两个持久化边界；allSettled 能保留部分成功结果并给出精确失败范围。
      // 不能用 Promise.all，否则其中一个失败会掩盖另一个已经成功的事实，导致 saved snapshot 与远端不一致。
      const [settingsResult, customConfigResult] = await Promise.allSettled([
        settingsPromise,
        customConfigPromise,
      ] as const);

      const failedScopes: string[] = [];
      let firstError: unknown = null;

      if (settingsResult.status === "fulfilled" && settingsResult.value) {
        const saved = settingsResult.value.settings;
        setSavedSettings(saved);
        setSettings(saved);
        resetSecretDrafts();
        setMonthlyBudgetInput(String(saved.monthlyBudget));
        setMonthlyBudgetError(null);
        syncSavedPreviewState(saved, { syncAppearance: appearanceChanged, rememberLocalePreference: localeChanged });
        void refetchNotificationHistory();
        // Bot 命令安装状态读取的是已保存凭据；保存 token/chat 后要主动刷新，不能等低频 query 自然过期。
        void refetchTelegramBotCommands();
        if (providerChanged) {
          // 汇率刷新必须使用服务端已接受的 provider；草稿值可能因后端旧版本或保存失败没有真正生效。
          void refreshRates(saved.exchangeRateProvider);
        }
      } else if (settingsResult.status === "rejected") {
        failedScopes.push(t("settings.appSettingsScope"));
        firstError = settingsResult.reason;
        // 保存失败仍通过 Provider request-id 状态机回滚，防止尚未完成的预览 catalog 迟到后重新覆盖远端事实。
        if (localeChanged) {
          setSettings((current) => ({ ...current, localePreference: savedSettings.localePreference }));
        }
        syncSavedPreviewState(savedSettings, { syncAppearance: appearanceChanged });
      }

      if (customConfigResult.status === "fulfilled" && customConfigResult.value) {
        const savedConfig = customConfigResult.value;
        setSavedCustomConfig(savedConfig);
        setCustomConfig(savedConfig);
      } else if (customConfigResult.status === "rejected") {
        failedScopes.push(t("settings.customConfigScope"));
        firstError ??= customConfigResult.reason;
      }

      if (failedScopes.length === 0) {
        const committedSettings = settingsResult.status === "fulfilled" && settingsResult.value
          ? settingsResult.value.settings
          : settings;
        setMonthlyBudgetInput(String(committedSettings.monthlyBudget));
        setMonthlyBudgetError(null);
        toast.success(t("settings.saved"));
        return;
      }

      const fallbackDescription = providerChanged && firstError
        ? getExchangeRateProviderSaveErrorMessage(firstError, t)
        : getDisplayErrorMessage(firstError, t("settings.saveFailedDescription"));
      toast.error(t("settings.saveFailed"), {
        description: failedScopes.length > 1
          ? t("settings.partialSaveFailedDescription", { scope: failedScopes.join(", ") })
          : fallbackDescription,
      });
    } finally {
      setIsSavingSettings(false);
    }
  }, [
    customConfig,
    customConfigDirty,
    hasUnsavedChanges,
    isSavingSettings,
    monthlyBudgetError,
    refetchNotificationHistory,
    refreshRates,
    saveConfig,
    savedSettings,
    settings,
    buildSecretUpdates,
    resetSecretDrafts,
    settingsDirty,
    syncSavedPreviewState,
    t,
    refetchTelegramBotCommands,
    updateSettings,
  ]);

  const handleDiscardChanges = useCallback(() => {
    setSettings(savedSettings);
    resetSecretDrafts();
    setMonthlyBudgetInput(String(savedSettings.monthlyBudget));
    setCustomConfig(savedCustomConfig);
    setMonthlyBudgetError(null);
    syncSavedPreviewState(savedSettings, { syncAppearance: true });
  }, [resetSecretDrafts, savedCustomConfig, savedSettings, syncSavedPreviewState]);

  const handleDefaultCurrencyChange = useCallback(
    (value: string) => {
      updateSetting("defaultCurrency", value);
    },
    [updateSetting],
  );

  const handleExchangeRateProviderChange = useCallback(
    (value: ExchangeRateProvider) => {
      updateSetting("exchangeRateProvider", value);
    },
    [updateSetting],
  );

  const handleThemeModeChange = useCallback(
    (value: ThemeMode) => {
      updateSetting("themeMode", value);
      setTheme(value);
      writeSettingsThemeModeToStorage(value);
      writeAppearancePendingToStorage(true);
    },
    [setTheme, updateSetting],
  );

  const handleThemeVariantChange = useCallback(
    (value: ThemeVariant) => {
      // 主题风格先写 DOM 再等待统一保存；这是为了让 Settings 页像控制面板一样即时反馈。
      setSettings((prev) => ({
        ...prev,
        themeMode: effectiveThemeMode,
        themeVariant: value,
      }));
      writeSettingsThemeModeToStorage(effectiveThemeMode);
      applyThemeVariant(value, settings.themeCustomColor);
      writeThemeVariantToStorage(value);
      writeAppearancePendingToStorage(true);
    },
    [effectiveThemeMode, settings.themeCustomColor],
  );

  const handleThemeCustomColorChange = useCallback(
    (value: CustomThemeColor) => {
      // 自定义色只有在 custom 主题下才需要立即覆写 CSS 变量，其他主题仅保存候选值。
      setSettings((prev) => ({
        ...prev,
        themeMode: effectiveThemeMode,
        themeCustomColor: value,
      }));
      writeSettingsThemeModeToStorage(effectiveThemeMode);
      writeCustomThemeColorToStorage(value);
      writeAppearancePendingToStorage(true);

      if (settings.themeVariant === "custom") {
        applyThemeVariant("custom", value);
      }
    },
    [effectiveThemeMode, settings.themeVariant],
  );

  const handleTestConnection = useCallback(
    (channel: NotificationChannel) => {
      if (externalIntegrationsDisabled) return;
      return notificationTest.testConnection(channel);
    },
    [externalIntegrationsDisabled, notificationTest],
  );

  return {
    settings: settingsWithDrafts,
    secretStatus,
    clearSecret,
    effectiveThemeMode,
    accountEmail,
    canManageUsers,
    canAccessPocketBaseAdmin: canManageUsers && !isCloudflareRuntime,
    customConfig,
    subscriptionFacets,
    categoryUsageCount,
    rates,
    activeRateProvider,
    ratesRefreshPending,
    lastUpdated,
    ratesError,
    ratesErrorDetails,
    ratesWarning,
    reportBasisStatus,
    getCurrencySymbol,
    updateCategories,
    updateStatuses,
    updatePaymentMethods,
    updateCurrencies,
    updateSetting,
    monthlyBudgetInput,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange,
    toggleChannel,
    handleRefreshRates,
    handleUpdateCurrencies,
    hasUnsavedChanges,
    handleSaveChanges,
    handleDiscardChanges,
    isSavingSettings,
    handleDefaultCurrencyChange,
    handleExchangeRateProviderChange,
    handleThemeModeChange,
    handleThemeVariantChange,
    handleThemeCustomColorChange,
    testingChannel: notificationTest.testingChannel,
    handleTestConnection,
    notificationTestErrorDetails: notificationTest.errorDetails,
    notificationTestErrorDetailsOpen: notificationTest.errorDetailsOpen,
    setNotificationTestErrorDetailsOpen: notificationTest.setErrorDetailsOpen,
    notificationHistory,
    builtInIconIndex,
    publicStatusPage,
    publicApi,
    telegramBotCommands,
    authSecurity,
    password,
    passwordResetEnabled,
    externalIntegrationsDisabled,
    sensitiveAccountActionsDisabled,
    sensitiveAccountActionsDemoDisabled,
  };
}
