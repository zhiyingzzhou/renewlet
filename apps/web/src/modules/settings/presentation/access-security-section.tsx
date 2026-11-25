import { OidcCard } from "./oidc-card";
import { FlaskConical, KeyRound, ShieldCheck } from "lucide-react";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nProvider";
import { useTheme } from "@/lib/theme-provider";
import type { SettingsAuthSecurityController } from "../application/use-auth-security-settings-controller";
import { getSettingsSectionClassName } from "./settings-layout";
import { CheckboxSettingRow, LoadingButtonContent } from "./settings-shared-controls";
import { ManagerDataBoundary } from "./manager-data-boundary";
import { SettingsSectionHeader } from "./settings-section-header";

export interface AccessSecuritySectionProps {
  id?: string;
  className?: string;
  oidcEnabled?: boolean | undefined;
  controller: SettingsAuthSecurityController;
}

export function AccessSecuritySection({ id, className, controller, oidcEnabled }: AccessSecuritySectionProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const disabled = controller.disabled || controller.readState.isInitialLoading;
  const actionBusy = controller.isSaving || controller.isClearingSecret || controller.isTesting;
  // badge 展示的是可实际生效的完整配置，不是单纯开关状态；缺任一 key 都不能提示已启用。
  const enabled = controller.draft.enabled && controller.draft.siteKey.trim().length > 0 && (controller.secretConfigured || controller.draft.secret.trim().length > 0);
  const statusLabel = controller.readState.isInitialLoading
    ? t("common.loading")
    : !controller.readState.hasData && controller.readState.error
      ? t("settings.statusUnknown")
      : controller.readState.error
        ? t("settings.notUpdated")
        : enabled
          ? t("common.enabled")
          : t("common.disabled");

  if (!controller.canManage) return null;

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <SettingsSectionHeader
        className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
        icon={<ShieldCheck className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />}
        title={t("settings.accessSecurity")}
        help={t("settings.oidcAccessHelp")}
      />
      <div aria-labelledby="turnstile-heading" role="group" className="grid gap-4 rounded-md border border-border bg-secondary/20 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 id="turnstile-heading" className="text-sm font-semibold">{t("settings.turnstileTitle")}</h3>
          <Badge variant={enabled ? "default" : "secondary"}>{statusLabel}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.turnstileHelp")}</p>
        <ManagerDataBoundary state={controller.readState}>
          {controller.secretConfigured ? (
            <Badge variant="outline" className="w-fit">{t("settings.turnstileSecretConfigured")}</Badge>
          ) : null}

          <CheckboxSettingRow
            id="turnstile-enabled"
            checked={controller.draft.enabled}
            disabled={disabled}
            onCheckedChange={controller.setEnabled}
            label={t("settings.turnstileEnable")}
            description={t("settings.turnstileEnableHelp")}
          />

          <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
            <FormField
              id="turnstile-site-key"
              label={t("settings.turnstileSiteKey")}
              description={t("settings.turnstileSiteKeyHelp")}
            >
              {(field) => (
                <Input
                  id={field.id}
                  value={controller.draft.siteKey}
                  onChange={(event) => controller.setSiteKey(event.target.value)}
                  placeholder={t("settings.turnstileSiteKeyPlaceholder")}
                  disabled={disabled}
                  className="border-border bg-secondary"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={field.describedBy}
                />
              )}
            </FormField>

            <FormField
              id="turnstile-secret"
              label={t("settings.turnstileSecret")}
              description={controller.secretConfigured ? t("settings.turnstileSecretKeepHelp") : t("settings.turnstileSecretHelp")}
            >
              {(field) => (
                <Input
                  id={field.id}
                  type="password"
                  value={controller.draft.secret}
                  onChange={(event) => controller.setSecret(event.target.value)}
                  placeholder={controller.secretConfigured ? t("settings.turnstileSecretConfiguredPlaceholder") : t("settings.turnstileSecretPlaceholder")}
                  disabled={disabled}
                  className="border-border bg-secondary"
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-describedby={field.describedBy}
                />
              )}
            </FormField>
          </FormFieldRow>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || !controller.hasChanges || actionBusy}
              onClick={() => void controller.save()}
            >
              <LoadingButtonContent loading={controller.isSaving} loadingLabel={t("settings.turnstileSaving")}>
                <KeyRound className="h-4 w-4" />
                {t("settings.turnstileSave")}
              </LoadingButtonContent>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || controller.isSaving || controller.isClearingSecret || controller.isTesting}
              onClick={controller.startTest}
            >
              <LoadingButtonContent loading={controller.isTesting} loadingLabel={t("settings.turnstileTesting")}>
                <FlaskConical className="h-4 w-4" />
                {t("settings.turnstileTest")}
              </LoadingButtonContent>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || !controller.hasChanges || actionBusy}
              onClick={controller.discard}
            >
              {t("settings.turnstileDiscard")}
            </Button>
            {controller.secretConfigured ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || actionBusy}
                onClick={() => void controller.clearSecret()}
              >
                <LoadingButtonContent loading={controller.isClearingSecret} loadingLabel={t("settings.turnstileClearing")}>
                  {t("settings.turnstileClearSecret")}
                </LoadingButtonContent>
              </Button>
            ) : null}
          </div>
        </ManagerDataBoundary>
      </div>
      <div className="mt-4">
        <OidcCard site enabled={oidcEnabled} disabled={controller.disabled} />
      </div>

      <Dialog open={controller.testDialogOpen} onOpenChange={controller.handleTestDialogOpenChange}>
        <DialogContent
          closeLabel={t("common.close")}
          dismissMode="explicit"
          className="border-border bg-card sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>{t("settings.turnstileTestDialogTitle")}</DialogTitle>
            <DialogDescription>{t("settings.turnstileTestDialogDescription")}</DialogDescription>
          </DialogHeader>

          {controller.testDialogOpen ? (
            // 测试挑战只在弹窗打开时挂载；关闭后卸载 iframe，避免已消费 token 留在设置页主内容里。
            <TurnstileWidget
              siteKey={controller.testDialogSiteKey}
              theme={resolvedTheme}
              errorId="settings-turnstile-test-error"
              resetSignal={controller.testResetSignal}
              error={controller.testError}
              onTokenChange={controller.handleTestTokenChange}
            />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => controller.handleTestDialogOpenChange(false)}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
