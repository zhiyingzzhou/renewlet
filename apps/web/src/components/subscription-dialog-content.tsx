// 单次 open session 独占表单草稿；本层只编排字段、自动日期和提交转换，不拥有 Radix modal 生命周期。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "@/lib/api-client";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SubscriptionFormFields } from "@/components/subscription-form-fields";
import {
  createSubscriptionFormLoadingSlots,
  SubscriptionFormScaffold,
  type SubscriptionFormLoadingStructure,
} from "@/components/subscription-form-scaffold";
import {
  costSharingCollectionReminderIsAllowedForBillingCycle,
  getSubscriptionFormValidationIssues,
  normalizeTagsArray,
  parseTagsInput,
  subscriptionFormValidationIssuesToErrors,
  toSubscriptionFormSubmission,
} from "@/lib/subscription-form";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useExchangeRates } from "@/hooks/use-exchange-rates";
import { useSubscriptionDialogSession } from "@/hooks/use-subscription-dialog-session";
import { useSubscriptionFormAutoDates } from "@/hooks/use-subscription-form-auto-dates";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";
import { useSettings } from "@/hooks/use-settings";
import {
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  type Subscription,
  type SubscriptionCollectionItem,
} from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import { useI18n } from "@/i18n/I18nProvider";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { getSystemTimeZone } from "@/lib/time/time-zone";
import type { SubscriptionDialogContentProps } from "@/components/subscription-dialog-types";

type SubscriptionFormLoadingPreview = Subscription | SubscriptionCollectionItem | SubscriptionFormState | null;

function resolveLoadingStructure(preview: SubscriptionFormLoadingPreview): SubscriptionFormLoadingStructure {
  if (!preview) {
    return { balanceEnabled: false, cycle: "recurring", reminderEnabled: true, repeatReminderEnabled: false };
  }
  if ("oneTimeMode" in preview) {
    return {
      cycle: preview.billingCycle === "custom"
        ? "custom"
        : preview.billingCycle !== "one-time"
          ? "recurring"
          : preview.oneTimeMode === "term"
            ? "one-time-fixed-term"
            : "one-time-buyout",
      balanceEnabled: preview.balanceEnabled,
      reminderEnabled: preview.reminderType !== "disabled",
      repeatReminderEnabled: preview.repeatReminderEnabled,
    };
  }
  return {
    cycle: preview.billingCycle === "custom"
      ? "custom"
      : preview.billingCycle !== "one-time"
        ? "recurring"
        : "oneTimeTermCount" in preview && typeof preview.oneTimeTermCount === "number"
          ? "one-time-fixed-term"
          : "one-time-buyout",
    balanceEnabled: preview.balance !== undefined,
    reminderEnabled: preview.reminderDays !== DISABLED_REMINDER_DAYS,
    repeatReminderEnabled:
      "repeatReminderEnabled" in preview && preview.repeatReminderEnabled,
  };
}

export function SubscriptionDialogContent(props: SubscriptionDialogContentProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [focusValidation, setFocusValidation] = useState(0);
  useLayoutEffect(() => {
    if (focusValidation === 0) return;
    // 错误节点 commit 后才能定位首错，避免提交时查询到上一轮 DOM。
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
  }, [focusValidation]);
  const { config } = useCustomConfigState();
  const { data: settings } = useSettings();
  const { t, locale } = useI18n();
  const initialCreateSubscription = props.mode === "create" ? props.initialSubscription ?? null : null;
  const isCloneCreateMode = Boolean(initialCreateSubscription);
  const statisticCurrency = settings?.defaultCurrency ?? "CNY";
  const notificationReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const { convert: convertCurrency } = useExchangeRates(settings?.exchangeRateProvider);

  // 统计货币可能已被货币管理禁用；新建草稿必须选择第一个仍可提交的货币。
  const enabledCurrencyValues = useMemo(
    () => config.currencies.filter((currency) => currency.enabled !== false).map((currency) => currency.value),
    [config.currencies],
  );
  const defaultCreateCurrency = useMemo(() => {
    if (enabledCurrencyValues.includes(statisticCurrency)) return statisticCurrency;
    return enabledCurrencyValues[0] ?? statisticCurrency;
  }, [enabledCurrencyValues, statisticCurrency]);
  const editSubscription = props.mode === "edit" ? props.subscription : null;
  const billingReferenceDate = useMemo(
    () => todayDateOnlyInTimeZone(new Date(), settings?.timezone ?? getSystemTimeZone("UTC")),
    [settings?.timezone],
  );
  const {
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
  } = useSubscriptionDialogSession({
    mode: props.mode,
    open: props.open,
    editSubscription,
    initialSubscription: initialCreateSubscription,
    defaultCreateCurrency,
    enabledCurrencyValues,
  });
  const resolveInitialFocus = useCallback(
    () => formRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled])') ?? null,
    [],
  );
  useDeferredDialogInitialFocus(props.open, props.loading !== true, "subscription-form", resolveInitialFocus);
  const idPrefix = props.mode === "edit" ? "edit-" : "";
  // 主表单和家庭共享成员管理器复用同一选项数组，避免嵌套弹层在顺序或禁用当前项回显上分叉。
  const balanceCurrencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: formData.balanceCurrency || formData.currency,
    locale,
  });
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: formData.currency,
    locale,
  });
  const collectionReminderAllowed = costSharingCollectionReminderIsAllowedForBillingCycle({
    billingCycle: formData.billingCycle,
    oneTimeMode: formData.oneTimeMode,
  });
  const collectionReminderEnabled = formData.costSharing?.collectionReminder?.enabled ?? false;

  useEffect(() => {
    if (collectionReminderAllowed || !collectionReminderEnabled) return;
    // 买断 one-time 没有可推进的收款周期；草稿进入该模式时立即关闭，避免提交阶段出现一个不会生效的开关。
    setFormData((previous) => {
      if (
        costSharingCollectionReminderIsAllowedForBillingCycle(previous)
        || !previous.costSharing?.collectionReminder?.enabled
      ) {
        return previous;
      }
      return {
        ...previous,
        costSharing: {
          ...previous.costSharing,
          collectionReminder: { ...previous.costSharing.collectionReminder, enabled: false },
        },
      };
    });
  }, [collectionReminderAllowed, collectionReminderEnabled, setFormData]);

  useSubscriptionFormAutoDates(formData, setFormData, billingReferenceDate);

  const getSubmissionFormData = useCallback(() => {
    const pendingTags = Array.from(
      formRef.current?.querySelectorAll<HTMLInputElement>("[data-subscription-tag-pending-input]") ?? [],
    ).flatMap((input) => parseTagsInput(input.value));
    if (pendingTags.length === 0) return formData;
    return {
      ...formData,
      tags: normalizeTagsArray([...formData.tags, ...pendingTags]),
    };
  }, [formData]);

  const validateForm = useCallback(
    (nextFormData: SubscriptionFormState) => (
      subscriptionFormValidationIssuesToErrors(getSubscriptionFormValidationIssues(nextFormData), t)
    ),
    [t],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (logoUploadStatus === "uploading" || submittingRef.current || props.loading) return;

    const submissionFormData = getSubmissionFormData();
    if (submissionFormData !== formData) {
      // 提交是标签输入状态进入订阅草稿的最后边界；不能要求用户必须先按 Enter 或触发 blur。
      setFormData(submissionFormData);
    }

    const nextErrors = validateForm(submissionFormData);
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      setSubmitError(null);
      setFocusValidation((request) => request + 1);
      return;
    }

    setFormErrors({});
    const submission = toSubscriptionFormSubmission(submissionFormData);
    if (!submission) {
      setSubmitError(t("subscription.formIncomplete"));
      return;
    }
    setSubmitError(null);

    if (props.mode === "edit" && !props.subscription) return;
    // ref 同步阻止同一事件周期的重复写入；shell 同时阻止关闭，失败时保留完整会话。
    submittingRef.current = true;
    setSubmitting(true);
    props.onSubmittingChange(true);
    try {
      await props.onSubmit(submission);
      props.onSubmittingChange(false);
      props.onRequestClose();
    } catch (error) {
      // 网络中断或响应校验失败不证明服务端未提交；保留草稿并提示先核对，不能自动重试写入。
      const uncertainOutcome = error instanceof ApiError && (error.status === 0 || error.code === "invalid_response");
      setSubmitError(!uncertainOutcome && error instanceof Error && error.message ? error.message : t("subscription.saveError"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      props.onSubmittingChange(false);
    }
  };

  const submitDisabled = submitting || logoUploadStatus === "uploading";
  const loadingPreview = props.mode === "create"
    ? props.initialSubscription ?? props.loadingPreview ?? formData
    : props.loadingPreview;
  const loadingSlots = props.loading
    ? createSubscriptionFormLoadingSlots({
        label: t("common.loading"),
        structure: { ...resolveLoadingStructure(loadingPreview), ...(props.mode === "create" ? { balanceEnabled: false } : {}) },
      })
    : null;

  return (
    <SubscriptionFormScaffold
      formRef={formRef}
      fieldsDisabled={submitting}
      onSubmit={handleSubmit}
      noValidate
      data-testid={props.loading ? "subscription-form-data-loading" : undefined}
      fields={loadingSlots?.fields ?? (
        <SubscriptionFormFields
          idPrefix={idPrefix}
          config={config}
          formData={formData}
          setFormData={setFormData}
          currencyOptions={currencyOptions}
          balanceCurrencyOptions={balanceCurrencyOptions}
          hasStoredBalance={hasStoredBalance}
          availableTags={props.availableTags}
          onLogoUploadStatusChange={setLogoUploadStatus}
          onFieldChange={handleFieldChange}
          errors={formErrors}
          onClearFieldError={clearFieldError}
          notificationReminderDays={notificationReminderDays}
          costSharingCurrencyConvert={convertCurrency}
          onNestedDialogOpenChange={props.onNestedDialogOpenChange}
        />
      )}
      actions={loadingSlots?.actions ?? (
        <>
          {submitError ? (
            <p role="alert" className="w-full min-w-0 wrap-break-word text-center text-sm text-destructive sm:mr-auto sm:w-auto sm:text-left">
              {submitError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={props.onRequestClose}
            disabled={submitting}
            className="w-full border-border sm:w-auto"
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={submitDisabled}
            className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto"
          >
            {submitDisabled ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {props.mode === "create"
              ? isCloneCreateMode
                ? t("subscription.cloneSubmit")
                : t("subscription.dialogCreateSubmit")
              : t("subscription.dialogEditSubmit")}
          </Button>
        </>
      )}
    />
  );
}
