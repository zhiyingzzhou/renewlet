/**
 * 管理员用户管理页。
 *
 * 架构位置：
 * - 通过 /api/app/admin/users 自定义 API 管理用户，不直接写 PocketBase collection。
 * - 前端负责表单体验、乐观禁用和基础校验；后端负责授权、schema 和最后管理员保护。
 *
 * 状态链路：
 *   挂载/loadUsers -> users
 *   创建/重置/删除/patch -> updating ids/dialogs -> 重新加载 users
 *   角色/状态/删除控件 -> 当前用户 + 最后一个启用管理员的双重保护
 *
 * 注意： 不要只依赖前端禁用来保护管理员账号；这里的保护是 UX，安全边界仍在 Go route。
 */
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { useRouteReady } from "@/components/route-progress";
import { Shield, UserPlus } from "lucide-react";
import { Header } from "@/components/header";
import { AdminUsersRowsSkeleton } from "@/components/loading-skeleton";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  adminDeleteUserResponseSchema,
  adminPatchUserResponseSchema,
  adminResetUserPasskeysResponseSchema,
  adminResetUserMfaResponseSchema,
  adminUserResponseSchema,
  adminUsersResponseSchema,
  type AdminUser,
  type UserRole,
} from "@/lib/api/schemas/admin";
import { authClient } from "@/lib/auth-client";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useI18n } from "@/i18n/I18nProvider";
import { usePasswordChange } from "@/modules/settings/application/use-password-change";
import { PasswordChangeDialog } from "@/modules/settings/presentation/password-change-dialog";
import { AdminUserRow } from "./admin-user-row";
import { CreateUserDialog, DeleteUserDialog, ResetMfaDialog, ResetPasskeysDialog, ResetPasswordDialog } from "./user-dialogs";
import {
  DEFAULT_CREATE_FORM,
  emailPattern,
  isEnabledAdmin,
  type AdminPatchUserPayload,
  type CreateUserErrors,
  type CreateUserFormState,
  type LoadUsersOptions,
  type ResetPasswordErrors,
} from "./types";

function showErrorToast(title: string, error: unknown, fallback: string) {
  toast.error(title, {
    description: getDisplayErrorMessage(error, fallback),
  });
}

export default function AdminUsersPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { data: sessionData } = authClient.useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  useRouteReady(isInitialLoading);
  const [isRefreshingUsers, setIsRefreshingUsers] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateUserFormState>(() => ({ ...DEFAULT_CREATE_FORM }));
  const [createErrors, setCreateErrors] = useState<CreateUserErrors>({});
  const [isCreating, setIsCreating] = useState(false);
  const [resetPasswordUser, setResetPasswordUser] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetPasswordErrors, setResetPasswordErrors] = useState<ResetPasswordErrors>({});
  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUser | null>(null);
  const [resetMfaTarget, setResetMfaTarget] = useState<AdminUser | null>(null);
  const [resetPasskeysTarget, setResetPasskeysTarget] = useState<AdminUser | null>(null);
  const [updatingUserIds, setUpdatingUserIds] = useState<Set<string>>(() => new Set());
  const passwordChange = usePasswordChange();
  const { setPasswordDialogOpen } = passwordChange;

  const createNameInputRef = useRef<HTMLInputElement>(null);
  const createEmailInputRef = useRef<HTMLInputElement>(null);
  const createPasswordInputRef = useRef<HTMLInputElement>(null);
  const createConfirmPasswordInputRef = useRef<HTMLInputElement>(null);
  const resetPasswordInputRef = useRef<HTMLInputElement>(null);
  const resetConfirmPasswordInputRef = useRef<HTMLInputElement>(null);
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const loadUsers = useCallback(async ({ signal, initial = false }: LoadUsersOptions = {}) => {
    if (initial) {
      setIsInitialLoading(true);
    } else {
      setIsRefreshingUsers(true);
    }

    try {
      const data = await apiFetch(
        "/api/app/admin/users",
        adminUsersResponseSchema,
        signal ? { signal } : undefined,
      );
      setUsers(data.users);
    } catch (error: unknown) {
      // 初次加载会在卸载时 abort；把它静默处理，避免路由切换时出现误报 Toast。
      if (error instanceof ApiError && error.code === "aborted") return;
      if (error instanceof ApiError && error.status === 403) {
        // 403 说明后端 requireAdmin 已拒绝当前会话；这里按权限漂移兜底回设置页，不再展示误导性的加载失败。
        router.replace("/settings");
        return;
      }
      const currentT = tRef.current;
      showErrorToast(currentT("admin.loadFailed"), error, currentT("admin.loadFailedDescription"));
    } finally {
      if (!signal?.aborted) {
        if (initial) {
          setIsInitialLoading(false);
        } else {
          setIsRefreshingUsers(false);
        }
      }
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    void loadUsers({ signal: controller.signal, initial: true });
    return () => controller.abort();
  }, [loadUsers]);

  const enabledAdminCount = users.filter(isEnabledAdmin).length;

  const resetCreateForm = useCallback(() => {
    setCreateForm({ ...DEFAULT_CREATE_FORM });
    setCreateErrors({});
  }, []);

  const handleCreateDialogOpenChange = useCallback(
    (open: boolean) => {
      setCreateDialogOpen(open);
      if (!open) resetCreateForm();
    },
    [resetCreateForm],
  );

  const updateCreateForm = useCallback(
    <K extends keyof CreateUserFormState>(field: K, value: CreateUserFormState[K]) => {
      setCreateForm((prev) => ({ ...prev, [field]: value }));
      setCreateErrors({});
    },
    [],
  );

  const focusFirstCreateError = useCallback((errors: CreateUserErrors) => {
    if (errors.name) {
      createNameInputRef.current?.focus();
      return;
    }
    if (errors.email) {
      createEmailInputRef.current?.focus();
      return;
    }
    if (errors.password) {
      createPasswordInputRef.current?.focus();
      return;
    }
    if (errors.confirmPassword) {
      createConfirmPasswordInputRef.current?.focus();
    }
  }, []);

  const validateCreateUser = useCallback(() => {
    const errors: CreateUserErrors = {};
    const trimmedName = createForm.name.trim();
    const trimmedEmail = createForm.email.trim();

    if (!trimmedName) errors.name = t("admin.validation.nameRequired");
    if (!trimmedEmail) {
      errors.email = t("admin.validation.emailRequired");
    } else if (!emailPattern.test(trimmedEmail)) {
      errors.email = t("admin.validation.emailInvalid");
    }
    if (createForm.password.length < 8) {
      errors.password = t("admin.validation.initialPasswordLength");
    }
    if (!createForm.confirmPassword) {
      errors.confirmPassword = t("admin.validation.confirmInitial");
    } else if (createForm.password !== createForm.confirmPassword) {
      errors.confirmPassword = t("passwordReset.passwordMismatch");
    }

    return { errors, trimmedName, trimmedEmail };
  }, [createForm, t]);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isCreating) return;

    const { errors, trimmedName, trimmedEmail } = validateCreateUser();
    if (Object.keys(errors).length > 0) {
      setCreateErrors(errors);
      focusFirstCreateError(errors);
      return;
    }

    setIsCreating(true);
    try {
      await apiFetch("/api/app/admin/users", adminUserResponseSchema, {
        method: "POST",
        body: JSON.stringify({
          name: trimmedName,
          email: trimmedEmail,
          password: createForm.password,
          role: createForm.role,
        }),
      });
      toast.success(t("admin.createSuccess"));
      await loadUsers();
      setCreateDialogOpen(false);
      resetCreateForm();
    } catch (error: unknown) {
      showErrorToast(t("admin.createFailed"), error, t("admin.createFailedDescription"));
      setCreateForm((prev) => ({ ...prev, password: "", confirmPassword: "" }));
    } finally {
      setIsCreating(false);
    }
  };

  const patchUser = useCallback(async (id: string, payload: AdminPatchUserPayload) => {
    setUpdatingUserIds((prev) => new Set(prev).add(id));
    try {
      await apiFetch(`/api/app/admin/users/${id}`, adminPatchUserResponseSchema, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await loadUsers();
    } finally {
      setUpdatingUserIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [loadUsers]);

  const resetResetPasswordDialog = useCallback(() => {
    setResetPasswordUser(null);
    setResetPassword("");
    setResetConfirmPassword("");
    setResetPasswordErrors({});
  }, []);

  const handleResetPasswordDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) resetResetPasswordDialog();
    },
    [resetResetPasswordDialog],
  );

  const openResetPasswordDialog = useCallback((user: AdminUser) => {
    if (user.id === sessionData?.user?.id) {
      // 当前管理员改自己的密码必须走账号改密 API，避免 admin patch 成为绕过当前密码校验的弱入口。
      setPasswordDialogOpen(true);
      return;
    }
    setResetPasswordUser(user);
    setResetPassword("");
    setResetConfirmPassword("");
    setResetPasswordErrors({});
  }, [sessionData?.user?.id, setPasswordDialogOpen]);

  const focusFirstResetPasswordError = useCallback((errors: ResetPasswordErrors) => {
    if (errors.password) {
      resetPasswordInputRef.current?.focus();
      return;
    }
    if (errors.confirmPassword) {
      resetConfirmPasswordInputRef.current?.focus();
    }
  }, []);

  const validateResetPassword = useCallback(() => {
    const errors: ResetPasswordErrors = {};
    if (resetPassword.length < 8) {
      errors.password = t("passwordReset.passwordLength");
    }
    if (!resetConfirmPassword) {
      errors.confirmPassword = t("passwordReset.confirmRequired");
    } else if (resetPassword !== resetConfirmPassword) {
      errors.confirmPassword = t("passwordReset.passwordMismatch");
    }
    return errors;
  }, [resetConfirmPassword, resetPassword, t]);

  const submitResetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetPasswordUser) return;
    if (updatingUserIds.has(resetPasswordUser.id)) return;

    const errors = validateResetPassword();
    if (Object.keys(errors).length > 0) {
      setResetPasswordErrors(errors);
      focusFirstResetPasswordError(errors);
      return;
    }

    try {
      await patchUser(resetPasswordUser.id, { newPassword: resetPassword });
      toast.success(t("admin.resetSuccess"));
      resetResetPasswordDialog();
    } catch (error: unknown) {
      showErrorToast(t("admin.resetFailed"), error, t("admin.resetFailedDescription"));
      setResetPassword("");
      setResetConfirmPassword("");
    }
  };

  const handleDeleteUserDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setDeleteUserTarget(null);
  }, []);

  const openDeleteUserDialog = useCallback((user: AdminUser) => {
    setDeleteUserTarget(user);
  }, []);

  const handleResetMfaDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setResetMfaTarget(null);
  }, []);

  const handleResetPasskeysDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setResetPasskeysTarget(null);
  }, []);

  const openResetMfaDialog = useCallback((user: AdminUser) => {
    // 当前管理员不能从用户列表 reset 自己的 2FA；自证关闭必须走设置页当前密码流程。
    if (user.id === sessionData?.user?.id || !user.mfaEnabled) return;
    setResetMfaTarget(user);
  }, [sessionData?.user?.id]);

  const openResetPasskeysDialog = useCallback((user: AdminUser) => {
    // Passkey 是独立登录验证能力；管理员 reset 自己仍必须走设置页自证流程。
    if (user.id === sessionData?.user?.id || !user.passkeysEnabled) return;
    setResetPasskeysTarget(user);
  }, [sessionData?.user?.id]);

  const confirmDeleteUser = async () => {
    if (!deleteUserTarget) return;
    if (updatingUserIds.has(deleteUserTarget.id)) return;

    setUpdatingUserIds((prev) => new Set(prev).add(deleteUserTarget.id));
    try {
      await apiFetch(`/api/app/admin/users/${deleteUserTarget.id}`, adminDeleteUserResponseSchema, {
        method: "DELETE",
      });
      toast.success(t("admin.deleteSuccess"));
      setDeleteUserTarget(null);
      await loadUsers();
    } catch (error: unknown) {
      showErrorToast(t("admin.deleteFailed"), error, t("admin.deleteFailedDescription"));
    } finally {
      setUpdatingUserIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteUserTarget.id);
        return next;
      });
    }
  };

  const confirmResetMfa = async () => {
    if (!resetMfaTarget) return;
    if (updatingUserIds.has(resetMfaTarget.id)) return;

    setUpdatingUserIds((prev) => new Set(prev).add(resetMfaTarget.id));
    try {
      await apiFetch(`/api/app/admin/users/${resetMfaTarget.id}/mfa/reset`, adminResetUserMfaResponseSchema, {
        method: "POST",
        body: "{}",
      });
      toast.success(t("admin.resetMfaSuccess"));
      setResetMfaTarget(null);
      await loadUsers();
    } catch (error: unknown) {
      showErrorToast(t("admin.resetMfaFailed"), error, t("admin.resetMfaFailedDescription"));
    } finally {
      setUpdatingUserIds((prev) => {
        const next = new Set(prev);
        next.delete(resetMfaTarget.id);
        return next;
      });
    }
  };

  const confirmResetPasskeys = async () => {
    if (!resetPasskeysTarget) return;
    if (updatingUserIds.has(resetPasskeysTarget.id)) return;

    setUpdatingUserIds((prev) => new Set(prev).add(resetPasskeysTarget.id));
    try {
      await apiFetch(`/api/app/admin/users/${resetPasskeysTarget.id}/passkeys/reset`, adminResetUserPasskeysResponseSchema, {
        method: "POST",
        body: "{}",
      });
      toast.success(t("admin.resetPasskeysSuccess"));
      setResetPasskeysTarget(null);
      await loadUsers();
    } catch (error: unknown) {
      showErrorToast(t("admin.resetPasskeysFailed"), error, t("admin.resetPasskeysFailedDescription"));
    } finally {
      setUpdatingUserIds((prev) => {
        const next = new Set(prev);
        next.delete(resetPasskeysTarget.id);
        return next;
      });
    }
  };


  const handleRoleChange = useCallback((user: AdminUser, role: UserRole) => {
    void patchUser(user.id, { role }).catch((error: unknown) =>
      showErrorToast(t("admin.updateRoleFailed"), error, t("admin.updateRoleFailedDescription")),
    );
  }, [patchUser, t]);

  const handleStatusChange = useCallback((user: AdminUser, enabled: boolean) => {
    void patchUser(user.id, { banned: !enabled }).catch((error: unknown) =>
      showErrorToast(t("admin.updateStatusFailed"), error, t("admin.updateStatusFailedDescription")),
    );
  }, [patchUser, t]);

  return (
    <div className="app-page bg-background">
      <Header />
      <main className="app-main mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground">{t("admin.title")}</h1>
              <p className="text-sm text-muted-foreground">{t("admin.subtitle")}</p>
            </div>
          </div>
          <Button
            type="button"
            className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto"
            onClick={() => setCreateDialogOpen(true)}
          >
            <UserPlus className="h-4 w-4" />
            {t("admin.createUser")}
          </Button>
        </div>


        <CreateUserDialog
          open={createDialogOpen}
          onOpenChange={handleCreateDialogOpenChange}
          form={createForm}
          errors={createErrors}
          isCreating={isCreating}
          onSubmit={createUser}
          updateForm={updateCreateForm}
          nameInputRef={createNameInputRef}
          emailInputRef={createEmailInputRef}
          passwordInputRef={createPasswordInputRef}
          confirmPasswordInputRef={createConfirmPasswordInputRef}
        />

        <ResetPasswordDialog
          user={resetPasswordUser}
          updatingUserIds={updatingUserIds}
          password={resetPassword}
          confirmPassword={resetConfirmPassword}
          errors={resetPasswordErrors}
          onOpenChange={handleResetPasswordDialogOpenChange}
          onSubmit={submitResetPassword}
          onPasswordChange={setResetPassword}
          onConfirmPasswordChange={setResetConfirmPassword}
          clearErrors={() => setResetPasswordErrors({})}
          resetDialog={resetResetPasswordDialog}
          passwordInputRef={resetPasswordInputRef}
          confirmPasswordInputRef={resetConfirmPasswordInputRef}
        />

        <PasswordChangeDialog
          open={passwordChange.passwordDialogOpen}
          onOpenChange={passwordChange.handlePasswordDialogOpenChange}
          currentPassword={passwordChange.currentPassword}
          onCurrentPasswordChange={passwordChange.setCurrentPassword}
          newPassword={passwordChange.newPassword}
          onNewPasswordChange={passwordChange.setNewPassword}
          confirmPassword={passwordChange.confirmPassword}
          onConfirmPasswordChange={passwordChange.setConfirmPassword}
          isUpdating={passwordChange.isUpdatingPassword}
          onSubmit={passwordChange.updatePassword}
        />

        <DeleteUserDialog
          target={deleteUserTarget}
          updatingUserIds={updatingUserIds}
          onOpenChange={handleDeleteUserDialogOpenChange}
          onConfirm={confirmDeleteUser}
        />

        <ResetMfaDialog
          target={resetMfaTarget}
          updatingUserIds={updatingUserIds}
          onOpenChange={handleResetMfaDialogOpenChange}
          onConfirm={confirmResetMfa}
        />

        <ResetPasskeysDialog
          target={resetPasskeysTarget}
          updatingUserIds={updatingUserIds}
          onOpenChange={handleResetPasskeysDialogOpenChange}
          onConfirm={confirmResetPasskeys}
        />

        <section className="overflow-hidden rounded-xl border border-border bg-card" aria-busy={isInitialLoading || isRefreshingUsers}>
          <div className="hidden grid-cols-[minmax(0,1fr)_120px_108px_132px_132px_430px] gap-4 border-b border-border px-5 py-3 text-sm font-medium text-muted-foreground lg:grid">
            <span>{t("admin.user")}</span>
            <span>{t("admin.role")}</span>
            <span>{t("admin.status")}</span>
            <span>{t("admin.mfa")}</span>
            <span>{t("admin.passkeys")}</span>
            <span>{t("admin.actions")}</span>
          </div>
          {isInitialLoading ? (
            <AdminUsersRowsSkeleton />
          ) : (
            users.map((item) => (
              <AdminUserRow
                key={item.id}
                user={item}
                currentUserId={sessionData?.user?.id}
                enabledAdminCount={enabledAdminCount}
                isUpdating={updatingUserIds.has(item.id)}
                onRoleChange={handleRoleChange}
                onStatusChange={handleStatusChange}
                onResetPassword={openResetPasswordDialog}
                onResetMfa={openResetMfaDialog}
                onResetPasskeys={openResetPasskeysDialog}
                onDelete={openDeleteUserDialog}
              />
            ))
          )}
        </section>
      </main>
    </div>
  );
}
