import { useEffect, useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Activity, Coins, CreditCard, FolderKanban, Settings2 } from "lucide-react";
import { DeferredImportDataDialog } from "@/components/import-data-dialog-loader";
import { RawErrorResponseDialog } from "@/components/raw-error-response-dialog";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { TimePicker } from "@/components/ui/time-picker";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useI18n } from "@/i18n/I18nProvider";
import { CLOUD_BACKUP_MAX_SNAPSHOT_BYTES } from "@/lib/api/schemas/cloud-backup";
import { createTimeZoneSelectOptions } from "@/lib/searchable-options";
import { assertLocalTime } from "@/lib/time/local-time";
import { getSupportedTimeZones } from "@/lib/time/time-zone";
import { ConfigManagerDialog } from "@/modules/custom-config/presentation/config-manager-dialog";
import { isBuiltInPaymentMethodValue } from "@/types/config";
import {
  MAX_REMINDER_DAYS,
  type NotificationChannel,
  type PublicStatusCurrency,
  type SubscriptionPriceReferenceCurrency,
} from "@/types/subscription";
import { useCloudBackupController } from "../application/use-cloud-backup-controller";
import { useCalendarFeedSettingsController } from "../application/use-calendar-feed-settings-controller";
import type { SettingsFormController } from "../application/use-settings-form-controller";
import { useUploadedAssetsManager } from "../application/use-uploaded-assets-manager";
import { getLocalSubscriptionPriceReferenceCurrencyPreference } from "../domain/subscription-price-reference-currency-local-preference";
import { AIRecognitionSettingsSection } from "./ai-recognition-settings-section";
import { BuiltInIconSourcesSection } from "./built-in-icon-sources-section";
import { CalendarFeedSection } from "./calendar-feed-section";
import { CloudBackupSection } from "./cloud-backup-section";
import { ExchangeRatesSection } from "./exchange-rates-section";
import { NotificationChannelConfigPanel } from "./notification-channel-config-panel";
import { NotificationChannelList } from "./notification-channel-list";
import { NotificationHistoryPanel } from "./notification-history-panel";
import { PublicApiSection } from "./public-api-section";
import { PublicStatusPageSection } from "./public-status-page-section";
import { SETTINGS_SECTION_FRAME_CLASS, SETTINGS_SECTION_SCROLL_CLASS } from "./settings-layout";
import { UploadedIconsSection } from "./uploaded-icons-section";

export function SettingsAdvancedSections({
  controller,
  onReady,
}: {
  controller: SettingsFormController;
  onReady?: (() => void) | undefined;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const {
    settings,
    secretStatus,
    clearSecret,
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
    updateSetting,
    monthlyBudgetInput,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange,
    toggleChannel,
    handleRefreshRates,
    handleUpdateCurrencies,
    handleDefaultCurrencyChange,
    handleExchangeRateProviderChange,
    testingChannel,
    handleTestConnection,
    notificationTestErrorDetails,
    notificationTestErrorDetailsOpen,
    setNotificationTestErrorDetailsOpen,
    notificationHistory,
    builtInIconIndex,
    publicStatusPage,
    publicApi,
    telegramBotCommands,
    externalIntegrationsDisabled,
  } = controller;
  const [selectedNotificationChannel, setSelectedNotificationChannel] = useState<NotificationChannel | null>(null);
  const [notificationReminderDaysInput, setNotificationReminderDaysInput] = useState(String(settings.notificationReminderDays));
  const [cloudBackupImportOpen, setCloudBackupImportOpen] = useState(false);
  const [cloudBackupRestoreFile, setCloudBackupRestoreFile] = useState<File | null>(null);
  const cloudBackup = useCloudBackupController((file) => {
    setCloudBackupRestoreFile(file);
    setCloudBackupImportOpen(true);
  });
  const uploadedAssets = useUploadedAssetsManager();
  // 高级设置挂载时并行读取全局状态与单订阅首屏；后续单订阅页只响应“加载更多”。
  const calendarFeed = useCalendarFeedSettingsController();
  const timezoneOptions = createTimeZoneSelectOptions(getSupportedTimeZones());
  const defaultCurrencyOptions = useManagedCurrencyOptions({
    currencies: customConfig.currencies,
    includeDisabledCurrent: settings.defaultCurrency,
    locale,
  });
  const effectivePublicStatusCurrency = settings.publicStatusCurrency === "inherit"
    ? settings.defaultCurrency
    : settings.publicStatusCurrency;
  const explicitPublicStatusCurrency = settings.publicStatusCurrency === "inherit"
    ? null
    : settings.publicStatusCurrency;
  const managedPublicStatusCurrencyOptions = useManagedCurrencyOptions({
    currencies: customConfig.currencies,
    includeDisabledCurrent: explicitPublicStatusCurrency,
    locale,
  });
  // inherit/default 是设置项哨兵，不属于真实货币；只能在宿主层 prepend，后续货币继续服从货币管理顺序。
  const publicStatusCurrencyOptions: SearchableSelectOption[] = [
    {
      value: "inherit",
      label: t("settings.publicStatusCurrencyInherit", { currency: settings.defaultCurrency }),
      keywords: ["inherit", settings.defaultCurrency],
    },
    ...managedPublicStatusCurrencyOptions,
  ];
  const effectiveSubscriptionPriceReferenceCurrency = settings.subscriptionPriceReferenceCurrency === "default"
    ? settings.defaultCurrency
    : settings.subscriptionPriceReferenceCurrency;
  const explicitSubscriptionPriceReferenceCurrency = settings.subscriptionPriceReferenceCurrency === "default"
    ? null
    : settings.subscriptionPriceReferenceCurrency;
  const managedSubscriptionPriceReferenceCurrencyOptions = useManagedCurrencyOptions({
    currencies: customConfig.currencies,
    includeDisabledCurrent: explicitSubscriptionPriceReferenceCurrency,
    locale,
  });
  const subscriptionPriceReferenceCurrencyOptions: SearchableSelectOption[] = [
    {
      value: "default",
      label: t("settings.subscriptionPriceReferenceCurrencyDefault", { currency: settings.defaultCurrency }),
      keywords: ["default", settings.defaultCurrency],
    },
    ...managedSubscriptionPriceReferenceCurrencyOptions,
  ];
  const localSubscriptionPriceReferenceCurrencyPreference =
    getLocalSubscriptionPriceReferenceCurrencyPreference()?.currency ?? null;
  // 本机偏好仍必须经过货币管理选项过滤，不能把用户禁用的币种重新暴露成快捷按钮。
  const subscriptionPriceReferenceCurrencyLocalPreference = localSubscriptionPriceReferenceCurrencyPreference
    && subscriptionPriceReferenceCurrencyOptions.some((option) => option.value === localSubscriptionPriceReferenceCurrencyPreference && !option.disabled)
    ? localSubscriptionPriceReferenceCurrencyPreference
    : null;
  const activeNotificationChannel = selectedNotificationChannel ?? settings.enabledChannels[0] ?? "telegram";

  useLayoutEffect(() => {
    // 云备份会从局部 loading boundary 切到完整表单；只有读取与草稿同步完成后的 commit 才能代表高级区块最终几何。
    if (cloudBackup.isInitialLayoutReady) onReady?.();
  }, [cloudBackup.isInitialLayoutReady, onReady]);

  useEffect(() => {
    setNotificationReminderDaysInput(String(settings.notificationReminderDays));
  }, [settings.notificationReminderDays]);

  const handleNotificationChannelToggle = (channel: NotificationChannel) => {
    setSelectedNotificationChannel(channel);
    toggleChannel(channel);
  };
  const handleNotificationReminderDaysInputChange = (value: string) => {
    setNotificationReminderDaysInput(value);
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_REMINDER_DAYS) return;
    updateSetting("notificationReminderDays", parsed);
  };

  return (
    <>
      <BuiltInIconSourcesSection
        id="settings-icon-sources"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        sources={settings.builtInIconSources}
        onChange={(sources) => updateSetting("builtInIconSources", sources)}
        onlineSources={settings.onlineIconSources}
        onOnlineChange={(sources) => updateSetting("onlineIconSources", sources)}
        iconIndex={builtInIconIndex}
      />

      <UploadedIconsSection
        id="settings-uploaded-icons"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        controller={uploadedAssets}
      />

      <AIRecognitionSettingsSection
        id="settings-ai-recognition"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        settings={settings.aiRecognition}
        onChange={(aiRecognition) => updateSetting("aiRecognition", aiRecognition)}
        apiKeyConfigured={secretStatus["aiRecognition.apiKey"].configured}
        onClearApiKey={() => clearSecret("aiRecognition.apiKey")}
        disabled={externalIntegrationsDisabled}
      />

      <section id="settings-budget" className={SETTINGS_SECTION_FRAME_CLASS}>
        <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.budget")}</h2>
        <div className="grid gap-4">
          <FormField
            id="monthlyBudget"
            label={t("settings.monthlyBudget")}
            description={t("settings.monthlyBudgetHelp")}
            error={monthlyBudgetError}
          >
            {(field) => (
              <div className="flex flex-col gap-2 min-[380px]:flex-row min-[380px]:items-center min-[380px]:gap-3">
                <NumericInput
                  id={field.id}
                  name={field.id}
                  allowNegative={false}
                  allowedDecimalSeparators={[".", "。"]}
                  inputMode="decimal"
                  enterKeyHint="done"
                  value={monthlyBudgetInput}
                  onRawValueChange={handleMonthlyBudgetInputChange}
                  className="w-full border-border bg-secondary min-[380px]:w-[min(12.5rem,100%)]"
                  placeholder="1500"
                  thousandSeparator
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                />
                <span className="text-sm text-muted-foreground">
                  {getCurrencySymbol(settings.defaultCurrency)} {settings.defaultCurrency} {t("settings.perMonth")}
                </span>
              </div>
            )}
          </FormField>
        </div>
      </section>

      <section id="settings-data-config" className={SETTINGS_SECTION_FRAME_CLASS}>
        <div className="mb-4 flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">{t("settings.dataConfig")}</h2>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">{t("settings.dataConfigDescription")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ConfigManagerDialog
            title={t("settings.categoryManager")}
            description={t("settings.categoryManagerDescription")}
            items={customConfig.categories}
            onUpdate={updateCategories}
            showColor
            maxItems={200}
            icon={<FolderKanban className="h-4 w-4" />}
            getDeleteBlockReason={(item) => {
              if (customConfig.categories.length <= 1) return t("settings.categoryKeepOne");
              // 删除校验依赖订阅数据；在加载/失败时先阻止删除，避免误判。
              if (subscriptionFacets.isInitialLoading) return t("settings.categoryChecking");
              if (subscriptionFacets.error && !subscriptionFacets.hasData) return t("settings.categoryCheckFailed");
              const usedCount = categoryUsageCount.get(item.value) ?? 0;
              return usedCount > 0 ? t("settings.categoryUsed", { count: usedCount }) : null;
            }}
          />
          <ConfigManagerDialog
            title={t("settings.statusManager")}
            description={t("settings.statusManagerDescription")}
            items={customConfig.statuses}
            onUpdate={updateStatuses}
            showColor
            readOnly
            icon={<Activity className="h-4 w-4" />}
          />
          <ConfigManagerDialog
            title={t("settings.paymentManager")}
            description={t("settings.paymentManagerDescription")}
            items={customConfig.paymentMethods}
            onUpdate={updatePaymentMethods}
            icon={<CreditCard className="h-4 w-4" />}
            showIcon
            maxItems={200}
            isItemReadOnly={(item) => isBuiltInPaymentMethodValue(item.value)}
          />
          <ConfigManagerDialog
            title={t("settings.currencyManager")}
            description={t("settings.currencyManagerDescription")}
            items={customConfig.currencies}
            onUpdate={handleUpdateCurrencies}
            icon={<Coins className="h-4 w-4" />}
            toggleMode
            searchable
            searchPlaceholder={t("settings.currencySearch")}
            searchEmptyMessage={t("settings.currencyEmpty")}
          />
        </div>
      </section>

      <CloudBackupSection
        id="settings-cloud-backup"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        controller={cloudBackup}
        disabled={externalIntegrationsDisabled}
      />

      <ExchangeRatesSection
        id="settings-exchange"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        settings={settings}
        customConfig={customConfig}
        rates={rates}
        activeRateProvider={activeRateProvider}
        ratesRefreshPending={ratesRefreshPending}
        ratesError={ratesError}
        ratesErrorDetails={ratesErrorDetails}
        ratesWarning={ratesWarning}
        reportBasisStatus={reportBasisStatus}
        lastUpdated={lastUpdated}
        defaultCurrencyOptions={defaultCurrencyOptions}
        subscriptionPriceReferenceCurrencyOptions={subscriptionPriceReferenceCurrencyOptions}
        effectiveSubscriptionPriceReferenceCurrency={effectiveSubscriptionPriceReferenceCurrency}
        subscriptionPriceReferenceCurrencyLocalPreference={subscriptionPriceReferenceCurrencyLocalPreference}
        handleRefreshRates={handleRefreshRates}
        handleDefaultCurrencyChange={handleDefaultCurrencyChange}
        handleSubscriptionPriceReferenceEnabledChange={(checked) => updateSetting("subscriptionPriceReferenceEnabled", checked)}
        handleSubscriptionPriceReferenceCurrencyChange={(value) => updateSetting("subscriptionPriceReferenceCurrency", value as SubscriptionPriceReferenceCurrency)}
        handleExchangeRateProviderChange={handleExchangeRateProviderChange}
      />

      <CalendarFeedSection
        id="settings-calendar-feed"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        controller={calendarFeed}
      />

      <PublicStatusPageSection
        id="settings-public-status"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        status={publicStatusPage.status}
        visibility={publicStatusPage.visibility}
        publicStatusCurrency={settings.publicStatusCurrency}
        effectivePublicStatusCurrency={effectivePublicStatusCurrency}
        publicStatusCurrencyOptions={publicStatusCurrencyOptions}
        isCreating={publicStatusPage.isCreating}
        isDeleting={publicStatusPage.isDeleting}
        isUpdating={publicStatusPage.isUpdating}
        onCreate={publicStatusPage.createOrRotate}
        onCopy={publicStatusPage.copyUrl}
        onDelete={publicStatusPage.revoke}
        onOpenPage={publicStatusPage.openPage}
        onRegenerate={publicStatusPage.regenerate}
        onShowPricesChange={publicStatusPage.updateShowPrices}
        onHideExpiredChange={publicStatusPage.updateHideExpired}
        onHideLifetimeChange={publicStatusPage.updateHideLifetime}
        onBulkPublicVisibility={publicStatusPage.bulkPublicVisibility}
        onManageVisibility={() => navigate("/subscriptions?publicVisibility=manage", {
          state: { publicVisibilityReturnTo: "/settings#settings-public-status" },
        })}
        onPublicStatusCurrencyChange={(value) => updateSetting("publicStatusCurrency", value as PublicStatusCurrency)}
      />

      <PublicApiSection
        id="settings-public-api"
        className={SETTINGS_SECTION_SCROLL_CLASS}
        controller={publicApi}
      />

      <section id="settings-timezone" className={SETTINGS_SECTION_FRAME_CLASS}>
        <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.timezone")}</h2>
        <div className="grid gap-2">
          <Label htmlFor="timezone">{t("settings.timezoneSelect")}</Label>
          <SearchableSelect
            value={settings.timezone}
            onValueChange={(value) => updateSetting("timezone", value)}
            options={timezoneOptions}
            placeholder={t("settings.timezonePlaceholder")}
            searchPlaceholder={t("settings.timezoneSearch")}
            emptyMessage={t("settings.timezoneEmpty")}
            className="w-full max-w-md border-border bg-secondary"
            contentClassName="max-w-md"
            aria-label={t("settings.timezoneSelect")}
          />
          <p className="text-xs text-muted-foreground">{t("settings.timezoneHelp")}</p>
        </div>
      </section>

      <section id="settings-notifications" className={SETTINGS_SECTION_FRAME_CLASS}>
        <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.notifications")}</h2>
        <div className="grid gap-6">
          <div className="grid gap-6">
            <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2 sm:gap-x-6">
              <FormField
                id="notificationTimeLocal"
                label={t("settings.notificationTime")}
                description={t("settings.notificationTimeHelp")}
              >
                {({ id: fieldId, describedBy }) => (
                  <TimePicker
                    id={fieldId}
                    value={settings.notificationTimeLocal}
                    onChange={(value) => updateSetting("notificationTimeLocal", assertLocalTime(value))}
                    className="w-full"
                    ariaLabel={t("settings.notificationTime")}
                    ariaDescribedBy={describedBy}
                  />
                )}
              </FormField>
              <FormField
                id="notificationReminderDays"
                label={t("settings.notificationReminderDays")}
                description={t("settings.notificationReminderDaysHelp")}
              >
                {({ id: fieldId, describedBy }) => (
                  <NumericInput
                    id={fieldId}
                    name="notificationReminderDays"
                    allowNegative={false}
                    decimalScale={0}
                    inputMode="numeric"
                    enterKeyHint="done"
                    value={notificationReminderDaysInput}
                    onRawValueChange={handleNotificationReminderDaysInputChange}
                    className="border-border bg-secondary"
                    aria-describedby={describedBy}
                  />
                )}
              </FormField>
            </FormFieldRow>
            <div className="grid content-start gap-2">
              <Label>{t("settings.tip")}</Label>
              <p className="text-xs text-muted-foreground">{t("settings.cronTip")}</p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_1fr]">
            <NotificationChannelList
              settings={settings}
              activeChannel={activeNotificationChannel}
              onSelect={setSelectedNotificationChannel}
              onToggle={handleNotificationChannelToggle}
              disabled={externalIntegrationsDisabled}
            />
            <NotificationChannelConfigPanel
              channel={activeNotificationChannel}
              settings={settings}
              enabled={settings.enabledChannels.includes(activeNotificationChannel)}
              updateSetting={updateSetting}
              testingChannel={testingChannel}
              onTest={handleTestConnection}
              disabled={externalIntegrationsDisabled}
              telegramBotCommands={telegramBotCommands}
              secretStatus={secretStatus}
              onClearSecret={clearSecret}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="testPhone">{t("settings.testPhone")}</Label>
            <Input
              id="testPhone"
              name="testPhone"
              type="tel"
              inputMode="tel"
              enterKeyHint="done"
              autoComplete="tel"
              placeholder={t("settings.testPhonePlaceholder")}
              value={settings.testPhone}
              disabled={externalIntegrationsDisabled}
              onChange={(event) => updateSetting("testPhone", event.target.value)}
              className="border-border bg-secondary"
            />
            <p className="text-xs text-muted-foreground">{t("settings.testPhoneHelp")}</p>
          </div>

          <NotificationHistoryPanel controller={notificationHistory} />
        </div>
      </section>

      <DeferredImportDataDialog
        open={cloudBackupImportOpen}
        onOpenChange={setCloudBackupImportOpen}
        settings={settings}
        config={customConfig}
        initialFile={cloudBackupRestoreFile}
        initialFileMaxBytes={CLOUD_BACKUP_MAX_SNAPSHOT_BYTES}
        onInitialFileConsumed={() => setCloudBackupRestoreFile(null)}
      />

      <RawErrorResponseDialog
        open={notificationTestErrorDetailsOpen}
        details={notificationTestErrorDetails}
        onOpenChange={setNotificationTestErrorDetailsOpen}
        title={t("rawErrorResponse.title")}
        description={t("rawErrorResponse.description")}
        testId="notification-test-raw-error-response-dialog"
      />
    </>
  );
}
