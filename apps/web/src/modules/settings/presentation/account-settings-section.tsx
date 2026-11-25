/**
 * 账号设置展示区。
 *
 * 架构位置：渲染邮箱、密码、账号安全与 PocketBase Admin 入口；密码修改流程由 application hook 管理。
 *
 * 注意： 不要在展示层缓存密码字段，关闭弹窗时必须交给 controller 清理。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from '@/components/ui/button';
import { FormField, FormFieldRow } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import Link from '@/components/router-link';
import { useI18n } from '@/i18n/I18nProvider';
import { ExternalLink } from 'lucide-react';
import { passkeyService } from "@/services/passkey-service";
import { PasswordChangeDialog } from './password-change-dialog';
import { AccountMfaSection } from './account-mfa-section';
import { OidcCard } from "./oidc-card";
import { AccountPasskeysSection } from './account-passkeys-section';
import { DeferredAccountSecurityDialogs } from "./account-security-dialogs-loader";
import { PASSKEYS_QUERY_KEY } from "./account-security-query-keys";
import type { AccountSecurityDialogState, MfaPasswordAction } from "./account-security-dialog-state";
import { getSettingsSectionClassName } from './settings-layout';
import type { Passkey } from "@/lib/api/schemas/auth";
import { toSettingsReadState } from "../application/settings-read-state";

export interface AccountSettingsSectionProps {
  id?: string;
  className?: string;
  accountEmail: string | null;
  canManageUsers: boolean;
  canAccessPocketBaseAdmin: boolean;
  passwordResetEnabled: boolean;
  passwordDialogOpen: boolean;
  setPasswordDialogOpen: (open: boolean) => void;
  handlePasswordDialogOpenChange: (open: boolean) => void;
  currentPassword: string;
  setCurrentPassword: (value: string) => void;
  newPassword: string;
  setNewPassword: (value: string) => void;
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  isUpdatingPassword: boolean;
  updatePassword: () => void | Promise<void>;
  oidcEnabled?: boolean;
  passwordDisabled?: boolean;
  accountSecurityDemoDisabled?: boolean;
}

export function AccountSettingsSection({
  id,
  className,
  accountEmail,
  canManageUsers,
  canAccessPocketBaseAdmin,
  passwordResetEnabled,
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
  oidcEnabled = false,
  passwordDisabled = false,
  accountSecurityDemoDisabled = false,
}: AccountSettingsSectionProps) {
  const { t } = useI18n();
  const [accountSecurityDialog, setAccountSecurityDialog] = useState<AccountSecurityDialogState>({ type: "none" });
  const passkeysQuery = useQuery({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: ({ signal }) => passkeyService.list(signal),
    staleTime: 30_000,
  });
  const passkeys = toSettingsReadState<Passkey[]>(passkeysQuery);

  const openAccountSecurityDialog = (nextState: AccountSecurityDialogState) => {
    if (passwordDisabled && nextState.type !== "none") return;
    setAccountSecurityDialog((current) => (current.type === "passkeys_manager" && nextState.type !== "none" ? current : nextState));
  };
  const openMfaPasswordAction = (action: MfaPasswordAction) => {
    openAccountSecurityDialog({ type: "mfa_password", action });
  };
  const handlePasskeysManagerOpenChange = (open: boolean) => {
    openAccountSecurityDialog(open ? { type: "passkeys_manager" } : { type: "none" });
  };
  useEffect(() => {
    if (passwordDisabled && accountSecurityDialog.type !== "none") {
      setAccountSecurityDialog({ type: "none" });
    }
  }, [passwordDisabled, accountSecurityDialog.type]);

  return (
    <>
      <section id={id} className={getSettingsSectionClassName(className)}>
        <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.account")}</h2>
        <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2 sm:gap-x-6">
          <FormField
            id="username"
            label={t("settings.username")}
            description={t("settings.usernameHelp")}
          >
            {({ id: fieldId, describedBy }) => (
              <>
                <Input
                  id={fieldId}
                  value={accountEmail ?? ""}
                  placeholder={accountEmail === null ? t("settings.emailLoading") : t("settings.emailMissing")}
                  readOnly
                  className="border-border bg-secondary"
                  aria-describedby={describedBy}
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {canManageUsers ? (
                    <Link href="/admin/users" className="inline-flex text-xs text-primary hover:underline">
                      {t("settings.manageUsers")}
                    </Link>
                  ) : null}
                  {canAccessPocketBaseAdmin ? (
                    <a
                      href="/_/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      {t("settings.pocketBaseAdmin")}
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              </>
            )}
          </FormField>
          <FormField
            id="password"
            label={t("auth.password")}
            description={t("settings.passwordHelp")}
          >
            {({ id: fieldId, describedBy }) => (
              <>
                <Input
                  id={fieldId}
                  type="password"
                  placeholder="••••••••"
                  readOnly
                  className="border-border bg-secondary"
                  aria-describedby={describedBy}
                />
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-primary/40 text-primary hover:bg-primary/10"
                    onClick={() => setPasswordDialogOpen(true)}
                    disabled={passwordDisabled}
                  >
                    {t("settings.changePassword")}
                  </Button>
                  {passwordResetEnabled ? (
                    <Link
                      href="/forgot-password"
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {t("auth.forgotPassword")}
                    </Link>
                  ) : null}
                </div>
              </>
            )}
          </FormField>
        </FormFieldRow>
        <div className="mt-6 grid gap-4">
          {accountSecurityDemoDisabled ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {t("settings.accountSecurityDemoDisabled")}
            </p>
          ) : null}
          <AccountMfaSection
            disabled={passwordDisabled}
            onSetupReady={(setup) => openAccountSecurityDialog({ type: "mfa_setup", setup })}
            onPasswordAction={openMfaPasswordAction}
          />
          <AccountPasskeysSection
            disabled={passwordDisabled}
            state={passkeys}
            onManagePasskeys={() => openAccountSecurityDialog({ type: "passkeys_manager" })}
          />
          {oidcEnabled && <OidcCard disabled={passwordDisabled} />}
        </div>
      </section>

      <PasswordChangeDialog
        open={passwordDialogOpen}
        onOpenChange={handlePasswordDialogOpenChange}
        currentPassword={currentPassword}
        onCurrentPasswordChange={setCurrentPassword}
        newPassword={newPassword}
        onNewPasswordChange={setNewPassword}
        confirmPassword={confirmPassword}
        onConfirmPasswordChange={setConfirmPassword}
        isUpdating={isUpdatingPassword}
        onSubmit={updatePassword}
      />
      <DeferredAccountSecurityDialogs
        state={accountSecurityDialog}
        onStateChange={openAccountSecurityDialog}
        onPasskeysOpenChange={handlePasskeysManagerOpenChange}
        accountEmail={accountEmail}
        disabled={passwordDisabled}
        passkeys={passkeys}
      />
    </>
  );
}
