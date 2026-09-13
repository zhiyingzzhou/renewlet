/**
 * 登录/注册页（/login）。
 *
 * 支持：
 * - 邮箱 + 密码登录
 * - 自愿启用后的身份验证器二阶段登录（TOTP / 恢复码）
 * - 独立 Passkey / 通行密钥登录
 *
 * 跳转逻辑：
 * - 通过查询参数 `next` 传入登录后要跳转的站内路径（例如：/settings）
 * - 为安全起见，仅允许以 `/` 开头的站内相对路径
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Link from '@/components/router-link';
import { useRouter } from '@/lib/router';
import { ArrowRight, Eye, EyeOff, KeyRound, Lock, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from "@/components/ui/form-field";
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RenewletBrandLockup } from '@/components/brand/renewlet-brand-mark';
import { TurnstileWidget } from '@/components/turnstile-widget';
import { toast } from '@/components/ui/sonner';
import { authClient } from '@/lib/auth-client';
import { getAuthDisplayMessage } from '@/lib/display-error';
import { sanitizeNextPath } from '@/lib/redirect';
import { reportClientError } from "@/lib/report-client-error";
import { useTheme } from "@/lib/theme-provider";
import { usePasswordResetAvailability } from '@/hooks/use-password-reset-availability';
import { useSetupStatus } from '@/hooks/use-setup-status';
import { useRouteReady } from '@/components/route-progress';
import { useI18n } from '@/i18n/I18nProvider';
import { LoginMfaDialog, type LoginMfaErrors, type LoginMfaState } from "@/pages/login-mfa-dialog";
import type { AuthenticatorMfaMethod } from "@renewlet/shared/schemas/auth";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REMEMBERED_LOGIN_EMAIL_STORAGE_KEY = "renewlet_login_email";

type LoginErrors = Partial<Record<"email" | "password" | "turnstile", string>>;

function readRememberedLoginEmail(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(REMEMBERED_LOGIN_EMAIL_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function rememberLoginEmail(email: string) {
  try {
    window.localStorage.setItem(REMEMBERED_LOGIN_EMAIL_STORAGE_KEY, email);
  } catch {
    // 邮箱缓存只是表单便利，不参与认证；隐私模式或存储受限时静默退化为不记住账号。
  }
}

function forgetRememberedLoginEmail() {
  try {
    window.localStorage.removeItem(REMEMBERED_LOGIN_EMAIL_STORAGE_KEY);
  } catch {
    // 同上，清理失败不应阻断登录流程。
  }
}

const Login = () => {
  const router = useRouter();
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const turnstileFieldRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const passkeyFlowRef = useRef(0);
  const mfaVerifyFlowRef = useRef(0);
  const suppressConditionalPasskeyRef = useRef(false);
  const handlePasskeyLoginRef = useRef<((options?: { useBrowserAutofill?: boolean; silent?: boolean }) => Promise<void>) | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);
  const [email, setEmail] = useState(readRememberedLoginEmail);
  const [password, setPassword] = useState('');
  const [rememberEmail, setRememberEmail] = useState(true);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);
  const [errors, setErrors] = useState<LoginErrors>({});
  const [mfaState, setMfaState] = useState<LoginMfaState | null>(null);
  const [mfaMethod, setMfaMethod] = useState<AuthenticatorMfaMethod>("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaErrors, setMfaErrors] = useState<LoginMfaErrors>({});
  const passwordResetEnabled = usePasswordResetAvailability();
  const setupStatus = useSetupStatus();
  useRouteReady(setupStatus.isLoading);
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const showSetupPrompt = setupStatus.setupRequired && setupStatus.setupEnabled;
  // /api/app/status 是登录页唯一的 Turnstile siteKey 来源；配置不完整时后端会收敛成 enabled=false。
  const turnstileRequired = setupStatus.turnstile.enabled && setupStatus.turnstile.siteKey.trim().length > 0;
  const isBusy = isLoading || isPasskeyLoading;

  const invalidatePasskeyFlows = useCallback(() => {
    passkeyFlowRef.current += 1;
  }, []);

  const cancelPasskeyCeremony = useCallback(() => {
    // flowRef 只能阻止旧 Promise 回写 React/session；conditional UI 是浏览器悬挂的 WebAuthn ceremony，路由切走前必须显式 abort。
    invalidatePasskeyFlows();
    authClient.cancelPasskeyCeremony();
  }, [invalidatePasskeyFlows]);

  const isPasskeyFlowActive = useCallback((flowId: number) => mountedRef.current && passkeyFlowRef.current === flowId, []);

  const invalidateMfaVerifyFlows = useCallback(() => {
    mfaVerifyFlowRef.current += 1;
  }, []);

  const isMfaVerifyFlowActive = useCallback((flowId: number) => mountedRef.current && mfaVerifyFlowRef.current === flowId, []);

  useEffect(() => {
    mountedRef.current = true;
    suppressConditionalPasskeyRef.current = false;
    return () => {
      mountedRef.current = false;
      cancelPasskeyCeremony();
      invalidateMfaVerifyFlows();
    };
  }, [cancelPasskeyCeremony, invalidateMfaVerifyFlows]);

  /** 读取并校验 next 跳转路径；登录页是开放路由，必须在这里防止开放重定向。 */
  const getNextPath = useCallback(() => {
    if (typeof window === "undefined") return "/";
    const raw = new URLSearchParams(window.location.search).get("next");
    return sanitizeNextPath(raw);
  }, []);

  const validate = () => {
    const trimmedEmail = email.trim();
    const nextErrors: LoginErrors = {};

    if (!trimmedEmail) {
      nextErrors.email = t("auth.validation.emailRequired");
    } else if (!emailPattern.test(trimmedEmail)) {
      nextErrors.email = t("auth.validation.emailInvalid");
    }
    if (!password) nextErrors.password = t("auth.validation.passwordRequired");
    if (turnstileRequired && !turnstileToken) nextErrors.turnstile = t("auth.turnstileRequired");

    return { nextErrors, trimmedEmail };
  };

  const focusFirstError = (nextErrors: LoginErrors) => {
    if (nextErrors.email) {
      emailInputRef.current?.focus();
      return;
    }
    if (nextErrors.password) {
      passwordInputRef.current?.focus();
      return;
    }
    if (nextErrors.turnstile) {
      turnstileFieldRef.current?.scrollIntoView({ block: "center" });
    }
  };

  const clearError = (field: keyof LoginErrors) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const finishSuccessfulSession = useCallback((loginEmail: string) => {
    suppressConditionalPasskeyRef.current = true;
    cancelPasskeyCeremony();
    invalidateMfaVerifyFlows();
    if (rememberEmail) {
      rememberLoginEmail(loginEmail);
    } else {
      forgetRememberedLoginEmail();
    }
    // 登录成功后只跳转 sanitize 后的站内路径，避免 next 参数把 token/session 状态带到外站。
    router.push(getNextPath());
  }, [cancelPasskeyCeremony, getNextPath, invalidateMfaVerifyFlows, rememberEmail, router]);

  const resetTurnstile = useCallback(() => {
    // Turnstile token 单次有效且会过期；登录失败、进入 MFA 或 challenge 异常后必须换新 token。
    setTurnstileToken("");
    setTurnstileResetSignal((value) => value + 1);
  }, []);

  const handleTurnstileTokenChange = useCallback((token: string) => {
    setTurnstileToken(token);
    if (token) clearError("turnstile");
  }, []);

  const handlePasskeyLogin = useCallback(async (options: { useBrowserAutofill?: boolean; silent?: boolean } = {}) => {
    if (!options.silent) {
      cancelPasskeyCeremony();
    }
    const flowId = passkeyFlowRef.current + 1;
    passkeyFlowRef.current = flowId;
    if (!options.silent) {
      suppressConditionalPasskeyRef.current = true;
      invalidateMfaVerifyFlows();
      // 显式 Passkey 可从 MFA 弹窗启动；启动 ceremony 时不能清 mfaState，否则取消会丢掉“密码已通过”的上下文。
      setIsPasskeyLoading(true);
    }
    const isCurrentFlow = () => isPasskeyFlowActive(flowId);
    try {
      const passkeyOptions = typeof options.useBrowserAutofill === "boolean"
        ? { useBrowserAutofill: options.useBrowserAutofill }
        : {};
      // 条件式 Passkey Promise 可能晚于密码登录返回；silent 模式用持久化守卫阻止旧流程写 session。
      const { data, error, cancelled } = await authClient.signIn.passkey(options.silent
        ? { ...passkeyOptions, shouldPersistSession: () => isCurrentFlow() }
        : passkeyOptions);
      if (!isCurrentFlow()) return;
      if (cancelled) return;
      if (error) {
        if (!options.silent) {
          reportClientError(error, { source: "login-passkey" });
          toast.error(t("auth.loginFailed"), {
            description: getAuthDisplayMessage(error),
          });
        }
        return;
      }
      if (data?.user.email) finishSuccessfulSession(data.user.email);
    } catch (err: unknown) {
      if (!isCurrentFlow()) return;
      if (!options.silent) {
        reportClientError(err, { source: "login-passkey" });
        toast.error(t("auth.loginFailed"), {
          description: getAuthDisplayMessage(err),
        });
      }
    } finally {
      if (!options.silent && mountedRef.current) setIsPasskeyLoading(false);
    }
  }, [cancelPasskeyCeremony, finishSuccessfulSession, invalidateMfaVerifyFlows, isPasskeyFlowActive, t]);

  useEffect(() => {
    handlePasskeyLoginRef.current = handlePasskeyLogin;
  }, [handlePasskeyLogin]);

  useEffect(() => {
    if (mfaState || typeof window === "undefined" || !("PublicKeyCredential" in window)) return;
    const credentialCtor = window.PublicKeyCredential as typeof PublicKeyCredential & {
      isConditionalMediationAvailable?: () => Promise<boolean>;
    };
    let cancelled = false;
    const flowGeneration = passkeyFlowRef.current;
    void (async () => {
      try {
        const available = await credentialCtor.isConditionalMediationAvailable?.();
        if (available && !cancelled && !suppressConditionalPasskeyRef.current && passkeyFlowRef.current === flowGeneration) {
          // 条件式 Passkey UI 是浏览器悬挂的认证前流程；密码输入会频繁 render，但同一密码阶段只能启动一次。
          await handlePasskeyLoginRef.current?.({ useBrowserAutofill: true, silent: true });
        }
      } catch {
        // 浏览器/平台不支持条件式 UI 时保留普通密码表单和显式 Passkey 按钮。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mfaState]);

  const handleLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { nextErrors, trimmedEmail } = validate();
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      focusFirstError(nextErrors);
      return;
    }

    suppressConditionalPasskeyRef.current = true;
    cancelPasskeyCeremony();
    setIsLoading(true);
    setErrors({});
    try {
      const { data, error } = await authClient.signIn.email({
        email: trimmedEmail,
        password,
        // Turnstile 只保护邮箱密码提交；Passkey、MFA verify 和首次 setup 都不读取这个 token。
        ...(turnstileRequired ? { turnstileToken } : {}),
      });
      if (error) {
        resetTurnstile();
        reportClientError(error, { source: "login" });
        toast.error(t("auth.loginFailed"), {
          description: getAuthDisplayMessage(error),
        });
        return;
      }
      if (data?.type === "mfa_required") {
        const preferredMfaMethod: AuthenticatorMfaMethod = data.methods.includes("totp")
          ? "totp"
          : data.methods.includes("recovery_code")
            ? "recovery_code"
            : data.methods[0] ?? "totp";
        // MFA ticket 只代表“密码已通过，等待身份验证器/恢复码”；Passkey 有独立 challenge，不写入这里。
        cancelPasskeyCeremony();
        invalidateMfaVerifyFlows();
        resetTurnstile();
        setMfaState({ ...data, email: trimmedEmail });
        setMfaMethod(preferredMfaMethod);
        setMfaCode("");
        setPassword("");
        return;
      }
      finishSuccessfulSession(trimmedEmail);
    } catch (err: unknown) {
      resetTurnstile();
      reportClientError(err, { source: "login" });
      toast.error(t("auth.loginFailed"), {
        description: getAuthDisplayMessage(err),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleMfaSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mfaState) return;
    suppressConditionalPasskeyRef.current = true;
    cancelPasskeyCeremony();
    const flowId = mfaVerifyFlowRef.current + 1;
    mfaVerifyFlowRef.current = flowId;
    const isCurrentFlow = () => isMfaVerifyFlowActive(flowId);
    const trimmedCode = mfaCode.trim();
    if (mfaMethod === "totp" && !/^\d{6}$/.test(trimmedCode)) {
      setMfaErrors({ code: t("auth.mfaInvalidTotp") });
      return;
    }
    if (mfaMethod === "recovery_code" && trimmedCode.length < 6) {
      setMfaErrors({ code: t("auth.mfaInvalidRecovery") });
      return;
    }

    setIsLoading(true);
    setMfaErrors({});
    try {
      const body = mfaMethod === "recovery_code"
        ? { method: "recovery_code" as const, ticketId: mfaState.ticketId, code: trimmedCode }
        : { method: "totp" as const, ticketId: mfaState.ticketId, code: trimmedCode };
      const { error } = await authClient.verifyMfa(body, {
        shouldPersistSession: () => isCurrentFlow(),
      });
      if (!isCurrentFlow()) return;
      if (error) {
        reportClientError(error, { source: "login-mfa", method: mfaMethod });
        toast.error(t("auth.mfaFailed"), {
          description: getAuthDisplayMessage(error),
        });
        return;
      }
      finishSuccessfulSession(mfaState.email);
    } catch (err: unknown) {
      if (!isCurrentFlow()) return;
      reportClientError(err, { source: "login-mfa", method: mfaMethod });
      toast.error(t("auth.mfaFailed"), {
        description: getAuthDisplayMessage(err),
      });
    } finally {
      if (isCurrentFlow()) setIsLoading(false);
    }
  };

  const focusPasswordInput = useCallback(() => {
    passwordInputRef.current?.focus();
  }, []);

  const closeMfaDialog = useCallback(() => {
    // MFA ticket 是密码已通过后的短生命周期内存凭据；关闭弹窗即废弃，不能让旧 verify 回写 session。
    invalidateMfaVerifyFlows();
    setMfaState(null);
    setMfaCode("");
    setMfaErrors({});
    setIsLoading(false);
  }, [invalidateMfaVerifyFlows]);

  const handleMfaDialogOpenChange = useCallback((open: boolean) => {
    if (!open) closeMfaDialog();
  }, [closeMfaDialog]);

  const handleMfaMethodChange = useCallback((nextMethod: AuthenticatorMfaMethod) => {
    setMfaMethod(nextMethod);
    setMfaCode("");
    setMfaErrors({});
  }, []);

  const handleMfaCodeChange = useCallback((nextCode: string) => {
    setMfaCode(nextCode);
    setMfaErrors({});
  }, []);

  return (
    <div className="app-page bg-background theme-gradient flex">
      <div className="hidden lg:flex lg:w-1/2 bg-linear-to-br from-primary/20 via-primary/10 to-background items-center justify-center p-12">
        <div className="max-w-md grid gap-8">
          <RenewletBrandLockup
            title="Renewlet"
            subtitle={t("app.tagline")}
            markSize="lg"
            titleClassName="text-3xl font-extrabold tracking-tight"
            subtitleClassName="text-sm"
          />
          
          <div className="grid gap-4">
            <h2 className="text-2xl font-semibold text-foreground">
              {t("auth.heroTitle")}
            </h2>
            <ul className="grid gap-3 text-muted-foreground">
              <li className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t("auth.heroTrackCosts")}
              </li>
              <li className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t("auth.heroRenewalReminder")}
              </li>
              <li className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t("auth.heroAnalyzeSpending")}
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="auth-form-panel flex-1 flex items-center justify-center">
        <div className="w-full max-w-md grid gap-8">
          <RenewletBrandLockup
            title="Renewlet"
            subtitle={t("app.tagline")}
            className="justify-center lg:hidden"
            titleClassName="text-2xl font-extrabold tracking-tight"
          />

          <div className="text-center lg:text-left">
            <h2 className="text-2xl font-bold text-foreground">{t("auth.welcomeBack")}</h2>
            <p className="mt-2 text-muted-foreground">
              {t("auth.loginSubtitle")}
            </p>
          </div>

          <div className="grid gap-6">
            <form onSubmit={handleLogin} className="grid gap-4" noValidate>
              <FormField id="login-email" label={t("auth.email")} error={errors.email}>
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
                    autoComplete="username webauthn"
                    enterKeyHint="next"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="your@email.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      clearError("email");
                    }}
                    className="pl-10 bg-secondary border-border"
                    aria-invalid={field.invalid}
                    aria-describedby={field.describedBy}
                    required
                  />
                </div>
                  </>
                )}
              </FormField>

              <FormField
                id="login-password"
                error={errors.password}
                labelSlot={(
                  <div className="flex items-center justify-between">
                  <Label htmlFor="login-password">{t("auth.password")}</Label>
                  {passwordResetEnabled ? (
                    <Link href="/forgot-password" className="text-xs text-primary hover:underline">
                      {t("auth.forgotPassword")}
                    </Link>
                  ) : null}
                </div>
                )}
              >
                {(field) => (
                  <>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={passwordInputRef}
                    id={field.id}
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    enterKeyHint="done"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      clearError("password");
                    }}
                    className="pl-10 pr-10 bg-secondary border-border"
                    aria-invalid={field.invalid}
                    aria-describedby={field.describedBy}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                  </>
                )}
              </FormField>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="remember-login-email"
                  checked={rememberEmail}
                  onCheckedChange={(checked) => {
                    const nextRememberEmail = checked === true;
                    setRememberEmail(nextRememberEmail);
                    if (!nextRememberEmail) forgetRememberedLoginEmail();
                  }}
                />
                <Label htmlFor="remember-login-email" className="cursor-pointer text-sm font-normal text-muted-foreground">
                  {t("auth.rememberEmail")}
                </Label>
              </div>

              {turnstileRequired ? (
                <div ref={turnstileFieldRef}>
                  <TurnstileWidget
                    siteKey={setupStatus.turnstile.siteKey}
                    theme={resolvedTheme}
                    errorId="login-turnstile-error"
                    resetSignal={turnstileResetSignal}
                    error={errors.turnstile}
                    onTokenChange={handleTurnstileTokenChange}
                  />
                </div>
              ) : null}

              <div className="pt-3">
                <Button
                  type="submit"
                  className="w-full bg-primary text-primary-foreground hover:bg-primary-glow"
                  disabled={isBusy}
                >
                  {isLoading ? t("auth.loggingIn") : t("auth.login")}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2 w-full"
                  disabled={isBusy}
                  onClick={() => void handlePasskeyLogin()}
                >
                  <KeyRound className="h-4 w-4" />
                  {isPasskeyLoading ? t("auth.passkeyLoggingIn") : t("auth.passkeyLogin")}
                </Button>
              </div>
            </form>
            {showSetupPrompt ? (
              <p className="text-center text-xs text-muted-foreground">
                {t("auth.firstDeploy")} <Link href="/setup" className="text-primary hover:underline">{t("auth.setupAdminLink")}</Link>
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <LoginMfaDialog
        open={Boolean(mfaState)}
        state={mfaState}
        method={mfaMethod}
        code={mfaCode}
        errors={mfaErrors}
        isVerifying={isLoading}
        isPasskeyLoading={isPasskeyLoading}
        onOpenChange={handleMfaDialogOpenChange}
        onReturnFocus={focusPasswordInput}
        onSubmit={handleMfaSubmit}
        onMethodChange={handleMfaMethodChange}
        onCodeChange={handleMfaCodeChange}
        onPasskeyLogin={() => void handlePasskeyLogin()}
      />
    </div>
  );
};

export default Login;
