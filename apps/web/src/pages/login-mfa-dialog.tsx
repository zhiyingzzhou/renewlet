import type { FormEvent } from "react";
import { useRef } from "react";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nProvider";
import type { AuthenticatorMfaMethod, MfaRequiredResponse } from "@renewlet/shared/schemas/auth";

export type LoginMfaState = MfaRequiredResponse & { email: string };
export type LoginMfaErrors = Partial<Record<"code", string>>;

interface LoginMfaDialogProps {
  open: boolean;
  state: LoginMfaState | null;
  method: AuthenticatorMfaMethod;
  code: string;
  errors: LoginMfaErrors;
  isVerifying: boolean;
  isPasskeyLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnFocus: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onMethodChange: (method: AuthenticatorMfaMethod) => void;
  onCodeChange: (code: string) => void;
  onPasskeyLogin: () => void;
}

export function LoginMfaDialog({
  open,
  state,
  method,
  code,
  errors,
  isVerifying,
  isPasskeyLoading,
  onOpenChange,
  onReturnFocus,
  onSubmit,
  onMethodChange,
  onCodeChange,
  onPasskeyLogin,
}: LoginMfaDialogProps) {
  const { t } = useI18n();
  const codeInputRef = useRef<HTMLInputElement>(null);
  const hasTotp = Boolean(state?.methods.includes("totp"));
  const hasRecoveryCode = Boolean(state?.methods.includes("recovery_code"));
  const hasCodeMfaMethod = Boolean(state?.methods.length);
  const isBusy = isVerifying || isPasskeyLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {state ? (
        <DialogContent
          closeLabel={t("common.close")}
          dismissMode="explicit"
          className="max-h-[calc(var(--app-viewport-height)-2rem)] overflow-y-auto border-border bg-card sm:max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            codeInputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("auth.mfaTitle")}</DialogTitle>
            <DialogDescription>{t("auth.mfaSubtitle")}</DialogDescription>
          </DialogHeader>

          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            {state.email && <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 truncate">{state.email}</span>
              </div>
            </div>}

            {hasCodeMfaMethod ? (
              <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
                <Button
                  type="button"
                  variant={method === "totp" ? "default" : "outline"}
                  className="min-h-12 min-w-0 w-full px-3"
                  aria-pressed={method === "totp"}
                  disabled={!hasTotp || isBusy}
                  onClick={() => onMethodChange("totp")}
                >
                  <ShieldCheck className="h-4 w-4" />
                  <span className="min-w-0 truncate">{t("auth.mfaTotp")}</span>
                </Button>
                <Button
                  type="button"
                  variant={method === "recovery_code" ? "default" : "outline"}
                  className="min-h-12 min-w-0 w-full px-3"
                  aria-pressed={method === "recovery_code"}
                  disabled={!hasRecoveryCode || isBusy}
                  onClick={() => onMethodChange("recovery_code")}
                >
                  <KeyRound className="h-4 w-4" />
                  <span className="min-w-0 truncate">{t("auth.mfaRecoveryCode")}</span>
                </Button>
              </div>
            ) : null}

            {hasCodeMfaMethod ? (
              <FormField
                id="login-mfa-code"
                label={method === "recovery_code" ? t("auth.mfaRecoveryCode") : t("auth.mfaCode")}
                error={errors.code}
              >
                {(field) => (
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={codeInputRef}
                      id={field.id}
                      name="mfa-code"
                      inputMode={method === "totp" ? "numeric" : "text"}
                      autoComplete="one-time-code"
                      enterKeyHint="done"
                      placeholder={method === "recovery_code" ? t("auth.mfaRecoveryPlaceholder") : t("auth.mfaCodePlaceholder")}
                      value={code}
                      onChange={(event) => onCodeChange(event.target.value)}
                      className="pl-10 bg-secondary border-border"
                      aria-invalid={field.invalid}
                      aria-describedby={field.describedBy}
                      required
                    />
                  </div>
                )}
              </FormField>
            ) : null}

            <div className="grid gap-2 pt-3">
              {hasCodeMfaMethod ? (
                <Button
                  type="submit"
                  className="w-full bg-primary text-primary-foreground hover:bg-primary-glow"
                  disabled={isBusy}
                >
                  {isVerifying ? t("auth.mfaVerifying") : t("auth.mfaVerify")}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={isBusy}
                onClick={onPasskeyLogin}
              >
                <KeyRound className="h-4 w-4" />
                {isPasskeyLoading ? t("auth.passkeyLoggingIn") : t("auth.passkeyLogin")}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
