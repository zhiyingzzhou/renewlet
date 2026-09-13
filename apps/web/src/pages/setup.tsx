/**
 * 首次安装页面。
 *
 * 架构位置：检查 setup 状态后调用 `/api/app/setup` 创建初始管理员；
 * 是否允许初始化、是否同步 PocketBase superuser 由后端最终裁决。
 *
 * 注意： 这里的表单校验只是 UX，不能放宽后端 strict JSON 和安装状态检查。
 */
import { type FormEvent, useRef, useState } from "react";
import { useRouter } from '@/lib/router';
import { ArrowRight, Lock, Mail, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { RenewletBrandLockup } from "@/components/brand/renewlet-brand-mark";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { setupCreateResponseSchema } from "@/lib/api/schemas/app";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useSetupStatus } from "@/hooks/use-setup-status";
import { useRouteReady } from "@/components/route-progress";
import { useI18n } from "@/i18n/I18nProvider";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SetupErrors = Partial<Record<"name" | "email" | "password", string>>;

export default function SetupPage() {
  const router = useRouter();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const { setupRequired, isLoading: isSetupStatusLoading } = useSetupStatus();
  useRouteReady(isSetupStatusLoading);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [name, setName] = useState("Admin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<SetupErrors>({});
  const { t } = useI18n();

  const validate = () => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const nextErrors: SetupErrors = {};

    if (!trimmedName) nextErrors.name = t("setup.validation.nameRequired");
    if (!trimmedEmail || !emailPattern.test(trimmedEmail)) nextErrors.email = t("setup.validation.emailInvalid");
    if (password.length < 8) nextErrors.password = t("setup.validation.passwordLength");

    return { nextErrors, trimmedName, trimmedEmail };
  };

  const focusFirstError = (nextErrors: SetupErrors) => {
    if (nextErrors.email) {
      emailInputRef.current?.focus();
      return;
    }
    if (nextErrors.password) {
      passwordInputRef.current?.focus();
      return;
    }
    if (nextErrors.name) {
      nameInputRef.current?.focus();
    }
  };

  const clearError = (field: keyof SetupErrors) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const { nextErrors, trimmedName, trimmedEmail } = validate();
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      focusFirstError(nextErrors);
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    try {
      await apiFetch("/api/app/setup", setupCreateResponseSchema, {
        authMode: "none",
        method: "POST",
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail, password }),
      });

      toast.success(t("setup.adminCreated"));
      router.replace("/login");
    } catch (error: unknown) {
      toast.error(t("setup.failed"), {
        description: getDisplayErrorMessage(error, t("setup.failedDescription")),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isSetupStatusLoading && setupRequired === false) {
    return (
      <div className="auth-page bg-background theme-gradient">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-card sm:p-8">
          <h1 className="text-xl font-semibold text-foreground">{t("setup.completedTitle")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("setup.completedDescription")}</p>
          <Button className="mt-6 w-full" onClick={() => router.replace("/login")}>
            {t("setup.goToLogin")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page bg-background theme-gradient">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-card sm:p-8">
        <RenewletBrandLockup
          title={t("setup.title")}
          subtitle={t("setup.subtitle")}
          className="mb-8"
          titleClassName="text-xl"
        />

        <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
          <FormField id="email" label={t("setup.loginEmail")} error={errors.email} errorId="setup-email-error">
            {(field) => (
              <>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={emailInputRef}
                id={field.id}
                name="email"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError("email");
                }}
                className="pl-10"
                autoComplete="email"
                enterKeyHint="next"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                required
              />
            </div>
              </>
            )}
          </FormField>

          <FormField id="password" label={t("auth.password")} error={errors.password} errorId="setup-password-error">
            {(field) => (
              <>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={passwordInputRef}
                id={field.id}
                name="password"
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearError("password");
                }}
                className="pl-10"
                autoComplete="new-password"
                enterKeyHint="next"
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                required
              />
            </div>
              </>
            )}
          </FormField>

          <FormField id="name" label={t("setup.displayName")} error={errors.name} errorId="setup-name-error">
            {(field) => (
              <>
            <div className="relative">
              <UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={nameInputRef}
                id={field.id}
                name="name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearError("name");
                }}
                className="pl-10"
                autoComplete="name"
                enterKeyHint="done"
                spellCheck={false}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                required
              />
            </div>
              </>
            )}
          </FormField>

          <div className="pt-3">
            <Button type="submit" className="w-full" disabled={isSubmitting || isSetupStatusLoading}>
              {isSubmitting ? t("common.creating") : t("setup.createAdmin")}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
