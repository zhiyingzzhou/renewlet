/**
 * 订阅弹窗表单 session 管理。
 *
 * 架构位置：SubscriptionDialog 负责 UI/提交转换，本 hook 负责 create/edit 表单草稿生命周期。
 *
 * 状态链路：
 * - create：打开 -> 空白草稿 -> 用户编辑 -> 关闭后结束 session
 * - edit：打开 -> 从订阅快照初始化 -> 用户编辑 -> 关闭后丢弃未保存修改
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SubscriptionFormErrors } from "@/components/subscription-form-fields-model";
import type { UploadStatus as LogoUploadStatus } from "@/components/logo-picker";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import type { Subscription } from "@/types/subscription";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS, REMINDER_DAYS_OPTIONS } from "@/types/subscription";
import { createSubscriptionFormState, type SubscriptionFormState } from "@/types/subscription-form";
import { isOneTimeFixedTerm } from "@/lib/subscription-billing";

type SubscriptionDialogSessionMode = "create" | "edit";

interface UseSubscriptionDialogSessionParams {
  mode: SubscriptionDialogSessionMode;
  open: boolean;
  editSubscription: Subscription | null;
  initialSubscription?: Subscription | null | undefined;
  defaultCreateCurrency: string;
  enabledCurrencyValues: readonly string[];
}

interface SubscriptionDialogSession {
  formData: SubscriptionFormState;
  hasStoredBalance: boolean;
  setFormData: Dispatch<SetStateAction<SubscriptionFormState>>;
  logoUploadStatus: LogoUploadStatus;
  setLogoUploadStatus: Dispatch<SetStateAction<LogoUploadStatus>>;
  submitError: string | null;
  setSubmitError: Dispatch<SetStateAction<string | null>>;
  formErrors: SubscriptionFormErrors;
  setFormErrors: Dispatch<SetStateAction<SubscriptionFormErrors>>;
  clearFieldError: (field: keyof SubscriptionFormErrors) => void;
  handleFieldChange: (key: keyof SubscriptionFormState) => void;
}

export function useSubscriptionDialogSession({
  mode,
  open,
  editSubscription,
  initialSubscription,
  defaultCreateCurrency,
  enabledCurrencyValues,
}: UseSubscriptionDialogSessionParams): SubscriptionDialogSession {
  const pendingCreateSessionResetRef = useRef(false);
  const initializedSnapshotRef = useRef<string | null>(null);
  const [hasStoredBalance, setHasStoredBalance] = useState(mode === "edit" && editSubscription?.balance !== undefined);
  const [logoUploadStatus, setLogoUploadStatus] = useState<LogoUploadStatus>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<SubscriptionFormErrors>({});
  const [createCurrencyManuallySelected, setCreateCurrencyManuallySelected] = useState(false);
  const [formData, setFormData] = useState<SubscriptionFormState>(() =>
    mode === "create"
      ? createCreateFormState(defaultCreateCurrency, initialSubscription)
      : editSubscription
        ? subscriptionToFormState(editSubscription)
        : createSubscriptionFormState(),
  );

  const resetTransientState = useCallback(() => {
    setLogoUploadStatus("idle");
    setSubmitError(null);
    setFormErrors({});
  }, []);

  const resetCreateSession = useCallback(() => {
    setFormData(createCreateFormState(defaultCreateCurrency, initialSubscription));
    setCreateCurrencyManuallySelected(false);
    resetTransientState();
  }, [defaultCreateCurrency, initialSubscription, resetTransientState]);

  const resetClosedSession = useCallback(() => {
    pendingCreateSessionResetRef.current = false;
    if (mode === "create") {
      resetCreateSession();
      return;
    }
    resetTransientState();
  }, [mode, resetCreateSession, resetTransientState]);
  const { scheduleCleanup, cancelCleanup } = useDeferredDialogCleanup(resetClosedSession);

  useLayoutEffect(() => {
    if (!open) return;
    cancelCleanup();
    if (mode !== "create" || !pendingCreateSessionResetRef.current) return;

    pendingCreateSessionResetRef.current = false;
    // create 弹窗重新打开代表新建任务开始；即使关闭动画清理尚未触发，也不能复用上一轮未提交草稿。
    resetCreateSession();
  }, [cancelCleanup, mode, open, resetCreateSession]);

  useEffect(() => {
    if (open) return;
    initializedSnapshotRef.current = null;
    if (mode === "create") {
      pendingCreateSessionResetRef.current = true;
    }
    scheduleCleanup();
  }, [mode, open, scheduleCleanup]);

  useEffect(() => {
    if (mode !== "create") return;
    if (!open) return;
    if (initialSubscription) return;

    const isPristine = isCreateFormPristine(formData);
    const shouldSync = !createCurrencyManuallySelected && isPristine;

    // 只在空白态同步默认货币，避免 settings 异步刷新覆盖用户正在输入的新增草稿。
    if (shouldSync && formData.currency !== defaultCreateCurrency) {
      setFormData((prev) => ({ ...prev, currency: defaultCreateCurrency }));
    }
  }, [
    createCurrencyManuallySelected,
    defaultCreateCurrency,
    enabledCurrencyValues,
    formData,
    initialSubscription,
    mode,
    open,
  ]);

  useLayoutEffect(() => {
    if (mode !== "create") return;
    if (!open) return;
    if (!initialSubscription) return;

    if (initializedSnapshotRef.current === initialSubscription.id) return;
    initializedSnapshotRef.current = initialSubscription.id;
    // 详情只在本次打开首次到达时初始化，后台刷新和写请求结果不得覆盖会话草稿。
    setFormData(createCreateFormState(defaultCreateCurrency, initialSubscription));
    setCreateCurrencyManuallySelected(false);
    resetTransientState();
  }, [defaultCreateCurrency, initialSubscription, mode, open, resetTransientState]);

  useLayoutEffect(() => {
    if (mode !== "edit") return;
    if (!open) return;
    if (!editSubscription) return;

    if (initializedSnapshotRef.current === editSubscription.id) return;
    initializedSnapshotRef.current = editSubscription.id;
    // 未保存修改属于本次会话；同一对象的缓存刷新不能重新初始化输入。
    setHasStoredBalance(editSubscription.balance !== undefined);
    setFormData(subscriptionToFormState(editSubscription));
    setCreateCurrencyManuallySelected(false);
    resetTransientState();
  }, [editSubscription, mode, open, resetTransientState]);

  const clearFieldError = useCallback((field: keyof SubscriptionFormErrors) => {
    setSubmitError(null);
    setFormErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const handleFieldChange = useCallback((key: keyof SubscriptionFormState) => {
    if (mode === "create" && key === "currency") {
      setCreateCurrencyManuallySelected(true);
    }
  }, [mode]);

  return {
    formData,
    hasStoredBalance,
    setFormData,
    logoUploadStatus,
    setLogoUploadStatus,
    submitError,
    setSubmitError,
    formErrors,
    setFormErrors,
    clearFieldError,
    handleFieldChange,
  };
}

function createCreateFormState(defaultCreateCurrency: string, initialSubscription?: Subscription | null): SubscriptionFormState {
  return initialSubscription
    ? { ...subscriptionToFormState(initialSubscription), balanceEnabled: false, balance: "", balanceCurrency: "" }
    : createSubscriptionFormState({ currency: defaultCreateCurrency });
}

function isCreateFormPristine(formData: SubscriptionFormState): boolean {
  const baseline = createSubscriptionFormState({ currency: formData.currency });
  return (
    formData.name === baseline.name &&
    formData.logo === baseline.logo &&
    formData.price === baseline.price &&
    formData.balanceEnabled === baseline.balanceEnabled &&
    formData.balance === baseline.balance &&
    formData.balanceCurrency === baseline.balanceCurrency &&
    formData.billingCycle === baseline.billingCycle &&
    formData.customDays === baseline.customDays &&
    formData.customCycleUnit === baseline.customCycleUnit &&
    formData.oneTimeMode === baseline.oneTimeMode &&
    formData.oneTimeTermCount === baseline.oneTimeTermCount &&
    formData.oneTimeTermUnit === baseline.oneTimeTermUnit &&
    formData.category === baseline.category &&
    formData.status === baseline.status &&
    formData.publicHidden === baseline.publicHidden &&
    formData.paymentMethod === baseline.paymentMethod &&
    formData.startDate === baseline.startDate &&
    formData.nextBillingDate === baseline.nextBillingDate &&
    formData.autoRenew === baseline.autoRenew &&
    formData.autoCalculate === baseline.autoCalculate &&
    formData.reminderType === baseline.reminderType &&
    formData.reminderDays === baseline.reminderDays &&
    formData.customReminderDays === baseline.customReminderDays &&
    formData.repeatReminderEnabled === baseline.repeatReminderEnabled &&
    formData.repeatReminderInterval === baseline.repeatReminderInterval &&
    formData.repeatReminderWindow === baseline.repeatReminderWindow &&
    formData.costSharing === baseline.costSharing &&
    formData.website === baseline.website &&
    formData.notes === baseline.notes &&
    formData.tags.length === 0
  );
}

function subscriptionToFormState(subscription: Subscription): SubscriptionFormState {
  const isDisabledReminder = subscription.reminderDays === DISABLED_REMINDER_DAYS;
  const isInheritReminder = subscription.reminderDays === INHERIT_REMINDER_DAYS;
  const isPresetReminder = REMINDER_DAYS_OPTIONS.some((opt) => opt.value === subscription.reminderDays);
  const isFixedTerm = isOneTimeFixedTerm(subscription);

  return {
    name: subscription.name,
    logo: subscription.logo,
    price: subscription.price.toString(),
    currency: subscription.currency,
    balanceEnabled: subscription.balance !== undefined,
    balance: subscription.balance ?? "",
    balanceCurrency: subscription.balanceCurrency ?? "",
    billingCycle: subscription.billingCycle,
    customDays: subscription.customDays?.toString() || "",
    customCycleUnit: subscription.billingCycle === "custom" ? subscription.customCycleUnit : "day",
    oneTimeMode: isFixedTerm ? "term" : "buyout",
    oneTimeTermCount: isFixedTerm ? String(subscription.oneTimeTermCount) : "1",
    oneTimeTermUnit: subscription.billingCycle === "one-time" ? subscription.oneTimeTermUnit ?? "month" : "month",
    category: subscription.category,
    status: subscription.status,
    publicHidden: subscription.publicHidden,
    paymentMethod: subscription.paymentMethod || "",
    startDate: subscription.startDate ?? undefined,
    nextBillingDate: subscription.nextBillingDate,
    autoRenew: subscription.billingCycle === "one-time" ? false : subscription.autoRenew,
    autoCalculate: subscription.autoCalculateNextBillingDate,
    reminderType: isDisabledReminder ? "disabled" : isInheritReminder ? "inherit" : isPresetReminder ? "preset" : "custom",
    reminderDays: isDisabledReminder ? String(DISABLED_REMINDER_DAYS) : isInheritReminder ? String(INHERIT_REMINDER_DAYS) : isPresetReminder ? subscription.reminderDays.toString() : "3",
    customReminderDays: !isDisabledReminder && !isInheritReminder && !isPresetReminder ? subscription.reminderDays.toString() : "",
    repeatReminderEnabled: isDisabledReminder ? false : subscription.repeatReminderEnabled,
    repeatReminderInterval: subscription.repeatReminderInterval,
    repeatReminderWindow: subscription.repeatReminderWindow,
    costSharing: subscription.costSharing,
    website: subscription.website ?? "",
    notes: subscription.notes ?? "",
    tags: subscription.tags,
  };
}
