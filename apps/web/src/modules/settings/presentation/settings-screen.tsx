import { useMemo, useState } from "react";
import { Palette } from "lucide-react";
import { BackToTopFloatButton } from "@/components/back-to-top-float-button";
import { Header } from "@/components/header";
import { ThemeSelector } from "@/components/theme-selector";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nProvider";
import { useLunarCalendar } from "@/contexts/CustomConfigContext";
import { isLocalePreference } from "@renewlet/shared/i18n-config";
import { cn } from "@/lib/utils";
import { useSettingsFormController } from "../application/use-settings-form-controller";
import { AccessSecuritySection } from "./access-security-section";
import { AccountSettingsSection } from "./account-settings-section";
import {
  DeferredSettingsAdvancedSections,
  preloadSettingsAdvancedSections,
} from "./settings-advanced-sections-loader";
import { ADVANCED_SETTINGS_SECTION_IDS, isAdvancedSettingsSection } from "./settings-section-groups";
import {
  DesktopSettingsSectionNav,
  MobileSettingsSectionDrawer,
  createSettingsSections,
  useSettingsSectionNavigation,
  useUnsavedChangesGuard,
} from "./settings-section-navigation";
import {
  SETTINGS_SECTION_FRAME_CLASS,
  SETTINGS_SECTION_SCROLL_CLASS,
  settingsLayout,
} from "./settings-layout";
import { CheckboxSettingRow, LoadingButtonContent } from "./settings-shared-controls";

/** 设置页同步层只保留首屏区块、目录和统一保存状态；低频高级区块按滚动/导航 intent 装载。 */
export function SettingsScreen() {
  const { t, previewLocalePreference } = useI18n();
  const lunarCalendar = useLunarCalendar();
  const controller = useSettingsFormController();
  const {
    settings,
    effectiveThemeMode,
    accountEmail,
    canManageUsers,
    canAccessPocketBaseAdmin,
    updateSetting,
    monthlyBudgetError,
    hasUnsavedChanges,
    handleSaveChanges,
    handleDiscardChanges,
    handleThemeModeChange,
    handleThemeVariantChange,
    handleThemeCustomColorChange,
    isSavingSettings,
    authSecurity,
    password,
    passwordResetEnabled,
    sensitiveAccountActionsDisabled,
    sensitiveAccountActionsDemoDisabled,
  } = controller;
  const {
    passwordDialogOpen,
    setPasswordDialogOpen,
    handlePasswordDialogOpenChange,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    isUpdatingPassword,
    updatePassword,
  } = password;
  const [mobileSectionNavOpen, setMobileSectionNavOpen] = useState(false);
  const settingsSections = useMemo(
    () => createSettingsSections({ canManageAccessSecurity: authSecurity.canManage }),
    [authSecurity.canManage],
  );
  const {
    activeSectionId,
    handleSectionClick,
    markDeferredSectionsReady,
  } = useSettingsSectionNavigation(settingsSections, {
    deferredSectionIds: ADVANCED_SETTINGS_SECTION_IDS,
  });
  const unsavedChangesGuard = useUnsavedChangesGuard(hasUnsavedChanges, handleDiscardChanges);
  const handleLocaleChange = (value: string) => {
    if (!isLocalePreference(value)) return;
    updateSetting("localePreference", value);
    previewLocalePreference(value);
  };
  const handleSectionIntent = (id: Parameters<typeof handleSectionClick>[0]) => {
    if (isAdvancedSettingsSection(id)) preloadSettingsAdvancedSections();
  };

  return (
    <div className="app-page flex flex-col bg-background">
      <Header />

      <main className={cn("flex-1", hasUnsavedChanges && "h5-bottom-bar-space")} data-testid="settings-main">
        <div className="app-main mx-auto max-w-7xl">
          <div className={settingsLayout.pageGrid} data-testid="settings-page-layout">
            <aside className="hidden lg:block" data-testid="settings-section-nav-aside">
              <DesktopSettingsSectionNav
                sections={settingsSections}
                activeSectionId={activeSectionId}
                onSectionClick={handleSectionClick}
                onSectionIntent={handleSectionIntent}
              />
            </aside>

            <div className={settingsLayout.content} data-testid="settings-section-content">
              <MobileSettingsSectionDrawer
                sections={settingsSections}
                activeSectionId={activeSectionId}
                onSectionClick={handleSectionClick}
                onSectionIntent={handleSectionIntent}
                open={mobileSectionNavOpen}
                onOpenChange={setMobileSectionNavOpen}
              />

              <div className={settingsLayout.desktopHeader}>
                <h1 className="text-2xl font-bold text-foreground">{t("settings.title")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settings.subtitle")}</p>
              </div>

              <AccountSettingsSection
                id="settings-account"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                accountEmail={accountEmail}
                canManageUsers={canManageUsers}
                canAccessPocketBaseAdmin={canAccessPocketBaseAdmin}
                passwordResetEnabled={passwordResetEnabled}
                passwordDialogOpen={passwordDialogOpen}
                setPasswordDialogOpen={setPasswordDialogOpen}
                handlePasswordDialogOpenChange={handlePasswordDialogOpenChange}
                currentPassword={currentPassword}
                setCurrentPassword={setCurrentPassword}
                newPassword={newPassword}
                setNewPassword={setNewPassword}
                confirmPassword={confirmPassword}
                setConfirmPassword={setConfirmPassword}
                isUpdatingPassword={isUpdatingPassword}
                updatePassword={updatePassword}
                passwordDisabled={sensitiveAccountActionsDisabled}
                accountSecurityDemoDisabled={sensitiveAccountActionsDemoDisabled}
              />

              <AccessSecuritySection
                id="settings-access-security"
                className={SETTINGS_SECTION_SCROLL_CLASS}
                controller={authSecurity}
              />

              <section id="settings-appearance" className={SETTINGS_SECTION_FRAME_CLASS}>
                <div className="mb-6 flex items-center gap-2">
                  <Palette className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold text-foreground">{t("settings.appearance")}</h2>
                </div>
                <ThemeSelector
                  mode={effectiveThemeMode}
                  variant={settings.themeVariant}
                  customColor={settings.themeCustomColor}
                  onModeChange={handleThemeModeChange}
                  onVariantChange={handleThemeVariantChange}
                  onCustomColorChange={handleThemeCustomColorChange}
                />
              </section>

              <section id="settings-display" className={SETTINGS_SECTION_FRAME_CLASS}>
                <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.display")}</h2>
                <div className="grid gap-6">
                  <div className="grid gap-2">
                    <Label htmlFor="locale">{t("settings.language")}</Label>
                    <Select value={settings.localePreference} onValueChange={handleLocaleChange}>
                      <SelectTrigger id="locale" className="w-full border-border bg-secondary sm:w-[min(14rem,100%)]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t("locale.auto")}</SelectItem>
                        <SelectItem value="zh-CN">{t("locale.zhCN")}</SelectItem>
                        <SelectItem value="en-US">{t("locale.enUS")}</SelectItem>
                        <SelectItem value="ru-RU">{t("locale.ruRU")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("settings.languageHelp")}</p>
                  </div>
                  <CheckboxSettingRow
                    id="showExpired"
                    checked={settings.showExpired}
                    onCheckedChange={(checked) => updateSetting("showExpired", checked)}
                    label={t("settings.showExpired")}
                    description={t("settings.showExpiredHelp")}
                  />
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <Label htmlFor="showLunarCalendar" className="text-base font-medium">
                        {t("settings.showLunarCalendar")}
                      </Label>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {lunarCalendar.supported
                          ? t("settings.showLunarCalendarHelp")
                          : t("settings.showLunarCalendarUnsupported")}
                      </p>
                    </div>
                    <Switch
                      id="showLunarCalendar"
                      checked={settings.showLunarCalendar}
                      disabled={!lunarCalendar.supported}
                      onCheckedChange={(checked) => updateSetting("showLunarCalendar", checked)}
                      aria-label={t("settings.showLunarCalendar")}
                    />
                  </div>
                </div>
              </section>

              <DeferredSettingsAdvancedSections
                controller={controller}
                activeSectionId={activeSectionId}
                onReady={markDeferredSectionsReady}
              />
            </div>
          </div>
        </div>
      </main>

      <BackToTopFloatButton
        bottomOffsetClassName={hasUnsavedChanges
          ? "bottom-[calc(11rem+env(safe-area-inset-bottom))] sm:bottom-[calc(5.75rem+env(safe-area-inset-bottom))]"
          : undefined}
      />

      <AlertDialog open={unsavedChangesGuard.pendingLeave} onOpenChange={(open) => {
        if (!open) unsavedChangesGuard.cancelLeave();
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.unsavedLeaveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.unsavedLeaveDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={unsavedChangesGuard.confirmLeave}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.unsavedLeaveConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {hasUnsavedChanges ? (
        <div
          className="h5-bottom-bar fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card/95 shadow-[0_-8px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm"
          data-testid="settings-save-bar"
        >
          <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-foreground">{t("settings.unsavedChanges")}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={handleDiscardChanges}
                disabled={isSavingSettings}
              >
                {t("settings.discardChanges")}
              </Button>
              <Button
                type="button"
                className="relative bg-primary text-primary-foreground hover:bg-primary-glow"
                onClick={handleSaveChanges}
                disabled={isSavingSettings || Boolean(monthlyBudgetError)}
                aria-busy={isSavingSettings ? true : undefined}
              >
                <LoadingButtonContent loading={isSavingSettings} loadingLabel={t("common.saving")}>
                  {t("settings.saveChanges")}
                </LoadingButtonContent>
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
