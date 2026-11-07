import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { advanceSubscriptionRenewal, calculateNextBillingDate } from "@renewlet/shared/subscription-renewal";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";
import { ApiError } from "@/lib/api-client";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { renewalMemberDateFields } from "@/lib/renewal-cost-sharing";
import { compareDateOnly, type DateOnly } from "@/lib/time/date-only";
import { parseMoneyInput } from "@/lib/subscription-form";
import { useI18n } from "@/i18n/I18nProvider";
import type { SearchableSelectOption } from "@/lib/searchable-options";
import type { Subscription } from "@/types/subscription";

type RenewMode = SubscriptionRenewBody["mode"];
interface RenewFormState {
  mode: RenewMode;
  price: string;
  currency: string;
  startDate: DateOnly | null;
  nextBillingDate: DateOnly;
  autoCalculateNextBillingDate: boolean;
}
type RenewFormErrors = Partial<Record<"price" | "currency" | "startDate" | "nextBillingDate", string | undefined>>;

function restartDate(subscription: Subscription, start: DateOnly): DateOnly {
  return calculateNextBillingDate(start, subscription.billingCycle, subscription.customDays, undefined, subscription.customCycleUnit) as DateOnly;
}
function initialForm(subscription: Subscription, today: DateOnly): RenewFormState {
  let next = subscription.nextBillingDate;
  try { next = restartDate(subscription, today); } catch { /* 非法锚点由预览错误提供编辑入口，不能让弹窗抛到整页错误边界。 */ }
  return { mode: "continue", price: subscription.price, currency: subscription.currency, startDate: today, nextBillingDate: next, autoCalculateNextBillingDate: true };
}

export function useRenewSubscriptionForm({ subscription, today, submitting, currencyOptions, formRef, onSubmit, onRefresh }: {
  subscription: Subscription | null;
  today: DateOnly;
  submitting: boolean;
  currencyOptions: SearchableSelectOption[];
  formRef: RefObject<HTMLFormElement | null>;
  onSubmit: (payload: SubscriptionRenewBody) => Promise<void> | void;
  onRefresh?: (() => Promise<Subscription | null>) | undefined;
}) {
  const { t, formatCurrency, formatDateOnly } = useI18n();
  const [source, setSource] = useState(subscription);
  const [form, setForm] = useState<RenewFormState | null>(() => subscription ? initialForm(subscription, today) : null);
  const [errors, setErrors] = useState<RenewFormErrors>({});
  const [memberDateDrafts, setMemberDateDrafts] = useState<ReadonlyMap<string, DateOnly>>(() => new Map());
  const [memberDateErrors, setMemberDateErrors] = useState<ReadonlySet<string>>(() => new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const initialized = useRef(subscription !== null);
  const metadataRetried = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (initialized.current || !subscription) return;
    initialized.current = true;
    // 单次打开只接收首次详情；缓存和账号日期刷新不能覆盖续订草稿。
    setSource(subscription);
    setForm(initialForm(subscription, today));
  }, [subscription, today]);

  const refresh = useCallback(async () => {
    if (!onRefresh || lock.current) return;
    lock.current = true;
    setRefreshing(true);
    try {
      const latest = await onRefresh();
      if (!mounted.current || !latest) return;
      setSource(latest);
      setMemberDateErrors(new Set());
      if (!initialized.current) { initialized.current = true; setForm(initialForm(latest, today)); }
      setSubmitError(null);
      setRecoveryRequired(false);
      setNotice(t("subscription.renew.refreshed", { amount: formatCurrency(latest.price, latest.currency), date: formatDateOnly(latest.nextBillingDate) }));
    } catch (error) {
      if (mounted.current) setSubmitError(getDisplayErrorMessage(error, t("subscription.renew.loadFailed")));
    } finally {
      lock.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, [onRefresh, today, t, formatCurrency, formatDateOnly]);
  useEffect(() => {
    if (!source || source.updatedAt || metadataRetried.current || !onRefresh) return;
    metadataRetried.current = true;
    void refresh();
  }, [source, onRefresh, refresh]);

  let preview: DateOnly | null;
  try { preview = source ? advanceSubscriptionRenewal(source, today, "manual")?.nextBillingDate as DateOnly | undefined ?? null : null; } catch { preview = null; }
  const calculationError = source && !preview ? t("subscription.renew.invalidDate") : null;
  const metadataError = source && !source.updatedAt ? t("subscription.renew.missingVersion") : null;
  const currentForm = form ? { ...form, nextBillingDate: form.mode === "continue" ? preview ?? source!.nextBillingDate : form.nextBillingDate } : null;
  const memberDates = currentForm?.mode === "restart"
    ? renewalMemberDateFields(source?.costSharing, currentForm.startDate, currentForm.nextBillingDate, memberDateDrafts) : [];
  const setMemberDate = (id: string, value: DateOnly | undefined) => {
    if (!value) return;
    setMemberDateDrafts(current => new Map(current).set(id, value));
    setMemberDateErrors(current => { const next = new Set(current); next.delete(id); return next; });
    if (!recoveryRequired) setSubmitError(null);
  };

  const setField = <K extends keyof RenewFormState>(key: K, value: RenewFormState[K]) => {
    setForm(current => current ? { ...current, [key]: value } : current);
    setErrors(current => ({ ...current, [key]: undefined }));
    if (!recoveryRequired) setSubmitError(null);
  };
  const switchMode = (mode: RenewMode) => { setField("mode", mode); setErrors({}); setMemberDateErrors(new Set()); };
  const handleRestartStartDateChange = (value: DateOnly | undefined) => {
    if (!value || !source) return;
    setForm(current => {
      if (!current) return current;
      let next = current.nextBillingDate;
      try { if (current.autoCalculateNextBillingDate) next = restartDate(source, value); } catch { /* 保留可编辑日期，交给日期校验提示。 */ }
      return { ...current, startDate: value, nextBillingDate: next };
    });
    setErrors(current => ({ ...current, startDate: undefined, nextBillingDate: undefined }));
    setMemberDateErrors(new Set());
  };
  const handleNextBillingDateChange = (value: DateOnly | undefined) => {
    if (!value) return;
    setForm(current => current ? { ...current, nextBillingDate: value, autoCalculateNextBillingDate: false } : null);
    setErrors(current => ({ ...current, nextBillingDate: undefined }));
    setMemberDateErrors(new Set());
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!source || !currentForm || lock.current || submitting || recoveryRequired || metadataError || calculationError) return;
    const nextErrors: RenewFormErrors = {};
    const price = parseMoneyInput(currentForm.price);
    if (price === null) nextErrors.price = t("subscription.validation.amountInvalid");
    if (currentForm.currency !== source.currency && !currencyOptions.some(option => option.value === currentForm.currency && !option.disabled)) nextErrors.currency = t("subscription.renew.validation.currencyRequired");
    if (currentForm.mode === "restart" && !currentForm.startDate) nextErrors.startDate = t("subscription.renew.validation.startDateRequired");
    if (currentForm.mode === "restart" && currentForm.startDate && compareDateOnly(currentForm.nextBillingDate, currentForm.startDate) < 0) nextErrors.nextBillingDate = t("subscription.validation.dateOrderInvalid");
    setErrors(nextErrors);
    const invalidMembers = new Set(memberDates.filter(member => member.invalid).map(member => member.id));
    setMemberDateErrors(invalidMembers);
    if (Object.values(nextErrors).some(Boolean) || invalidMembers.size > 0 || price === null) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus());
      return;
    }
    lock.current = true;
    setSaving(true);
    setSubmitError(null);
    try {
      await onSubmit({
        expectedNextBillingDate: source.nextBillingDate, expectedUpdatedAt: source.updatedAt!,
        mode: currentForm.mode, price, currency: currentForm.currency,
        startDate: currentForm.mode === "restart" ? currentForm.startDate : null,
        nextBillingDate: currentForm.nextBillingDate,
        autoCalculateNextBillingDate: currentForm.mode === "restart" ? currentForm.autoCalculateNextBillingDate : false,
        ...(currentForm.mode === "restart" && memberDates.length > 0 ? {
          costSharingMemberJoinedDates: memberDates.map(({ id, joinedDate }) => ({ id, joinedDate })),
        } : {}),
      });
    } catch (error) {
      if (!mounted.current) return;
      // 超时/异常成功响应可能发生在提交之后；先核对服务端事实，绝不能自动重放一次推进命令。
      const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === "invalid_response";
      const stale = error instanceof ApiError && (error.status === 409 || error.code === "SUBSCRIPTION_RENEW_NOT_ALLOWED");
      setRecoveryRequired(uncertain || stale);
      setSubmitError(uncertain ? t("subscription.renew.resultUnknown") : getDisplayErrorMessage(error, t("subscription.renew.loadFailed")));
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return { source, currentForm, errors, setField, switchMode, handleRestartStartDateChange, handleNextBillingDateChange, submit,
    memberDates, memberDateErrors, setMemberDate,
    refresh, refreshing, saving, notice, submitError, calculationError, metadataError, recoveryRequired };
}
