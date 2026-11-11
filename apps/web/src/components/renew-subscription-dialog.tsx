import { useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";
import { Loader2 } from "lucide-react";
import {
  createRenewSubscriptionLoadingSlots,
  RenewSubscriptionScaffold,
} from "@/components/renew-subscription-scaffold";
import { Button } from "@/components/ui/button";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { NumericInput } from "@/components/ui/numeric-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { RenewSubscriptionMemberDates } from "@/components/renew-subscription-member-dates";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useI18n } from "@/i18n/I18nProvider";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";
import { type DateOnly } from "@/lib/time/date-only";
import { useRenewSubscriptionForm } from "@/hooks/use-renew-subscription-form";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";

type RenewMode = SubscriptionRenewBody["mode"];

export interface RenewSubscriptionDialogProps {
  subscription: Subscription | null;
  loadingPreview: SubscriptionCollectionItem | null;
  open: boolean;
  today: DateOnly;
  submitting: boolean;
  error?: unknown;
  onRefresh?: (() => Promise<Subscription | null>) | undefined;
  onEdit?: (() => void) | undefined;
  restoreFocusRef?: RefObject<HTMLElement | null> | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: SubscriptionRenewBody) => Promise<void> | void;
  loading?: boolean | undefined;
}

export function RenewSubscriptionDialogContent({
  subscription: latestSubscription,
  open,
  today,
  submitting,
  error,
  onOpenChange,
  onSubmit,
  onRefresh,
  onEdit,
  loading,
  loadingPreview,
}: RenewSubscriptionDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const { config } = useCustomConfigState();
  const { t, locale, formatDateOnly } = useI18n();
  const enabledCurrencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    locale,
  });
  const {
    source: subscription, currentForm, errors, setField, switchMode,
    memberDates, memberDateErrors, setMemberDate,
    handleRestartStartDateChange, handleNextBillingDateChange, submit,
    refresh, refreshing, saving, notice, submitError, calculationError, metadataError, recoveryRequired,
  } = useRenewSubscriptionForm({ subscription: latestSubscription, today, submitting, currencyOptions: enabledCurrencyOptions, formRef, onSubmit, onRefresh });
  const currencyOptions = useManagedCurrencyOptions({ currencies: config.currencies, includeDisabledCurrent: currentForm?.currency ?? null, locale });
  const busy = submitting || saving || refreshing;
  const visibleError = submitError ?? calculationError ?? metadataError ?? (error ? getDisplayErrorMessage(error) : null);
  const titleSubscription = subscription ?? loadingPreview;
  const title = titleSubscription
    ? t("subscription.renew.title", { name: titleSubscription.name })
    : t("subscription.renew");
  const description = t("subscription.renew.description");
  const resolveInitialFocus = useCallback(
    () => formRef.current?.querySelector<HTMLElement>('[role="radio"][data-state="checked"]') ?? null,
    [],
  );
  useDeferredDialogInitialFocus(
    open,
    !loading && currentForm !== null,
    subscription?.id ?? "renew-subscription",
    resolveInitialFocus,
  );
  const restartMode = currentForm?.mode === "restart";
  const submitLabel = restartMode ? t("subscription.renew.restartSubmit") : t("subscription.renew.submit");
  const modeDescription = useMemo(() => {
    if (!currentForm) return "";
    return currentForm.mode === "continue"
      ? t("subscription.renew.modeContinueHelp")
      : t("subscription.renew.modeRestartHelp");
  }, [currentForm, t]);

  const loadingSlots = loading
    ? createRenewSubscriptionLoadingSlots({ label: t("common.loading"), restartMode })
    : null;


  return (
    <RenewSubscriptionScaffold
      formRef={formRef}
      disabled={busy}
      onSubmit={submit}
      noValidate
      data-testid={loading ? "renew-subscription-data-loading" : undefined}
      heading={title}
      description={description}
      mode={loadingSlots?.mode ?? (currentForm ? (
        <FormField id="renew-mode" label={t("subscription.renew.mode")} description={modeDescription}>
          {(field) => (
            <RadioGroup
              value={currentForm.mode}
              onValueChange={(value) => switchMode(value as RenewMode)}
              aria-describedby={field.describedBy}
              className="grid gap-2 sm:grid-cols-2"
            >
              {(["continue", "restart"] as const).map((mode) => {
                const optionId = `renew-mode-${mode}`;
                return (
                  <label
                    key={mode}
                    htmlFor={optionId}
                    className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-border bg-secondary p-3 text-sm transition-colors hover:bg-accent"
                  >
                    <RadioGroupItem id={optionId} value={mode} className="mt-0.5 shrink-0" />
                    <span className="grid min-w-0 gap-1">
                      <span className="font-medium text-foreground">
                        {mode === "continue" ? t("subscription.renew.modeContinue") : t("subscription.renew.modeRestart")}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {mode === "continue" ? t("subscription.renew.modeContinueShort") : t("subscription.renew.modeRestartShort")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
          )}
        </FormField>
      ) : null)}
      pricing={loadingSlots?.pricing ?? (currentForm ? (
        <FormFieldRow
          alignAt="sm"
          rowClassName="sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]"
          errors={[
            { id: "renew-price-error", message: errors.price },
            { id: "renew-currency-error", message: errors.currency },
          ]}
        >
          <FormField id="renew-price" label={t("subscription.field.price")} error={errors.price} renderError={false}>
            {(field) => (
              <NumericInput
                id={field.id}
                value={currentForm.price}
                onRawValueChange={(value) => setField("price", value)}
                decimalScale={6}
                allowNegative={false}
                thousandSeparator
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-11 border-border bg-secondary"
              />
            )}
          </FormField>
          <FormField id="renew-currency" label={t("subscription.field.currency")} error={errors.currency} renderError={false}>
            {(field) => (
              <SearchableSelect
                id={field.id}
                value={currentForm.currency}
                onValueChange={(value) => setField("currency", value)}
                options={currencyOptions}
                placeholder={t("subscription.placeholder.currency")}
                searchPlaceholder={t("subscription.search.currency")}
                emptyMessage={t("subscription.empty.currency")}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-11 border-border bg-secondary"
              />
            )}
          </FormField>
        </FormFieldRow>
      ) : null)}
      schedule={loadingSlots?.schedule ?? (currentForm ? (
        <>
          {notice ? <p role="status" className="text-sm leading-6 text-muted-foreground">{notice}</p> : null}
          {restartMode ? (
            <FormFieldRow
              alignAt="sm"
              rowClassName="sm:grid-cols-2"
              errors={[
                { id: "renew-start-date-error", message: errors.startDate },
                { id: "renew-next-billing-date-error", message: errors.nextBillingDate },
              ]}
            >
              <FormField
                id="renew-start-date"
                label={t("subscription.field.startDate")}
                labelId="renew-start-date-label"
                error={errors.startDate}
                renderError={false}
              >
                {(field) => (
                  <DateOnlyPickerField
                    id={field.id}
                    labelId="renew-start-date-label"
                    valueId="renew-start-date-value"
                    value={currentForm.startDate ?? undefined}
                    onChange={handleRestartStartDateChange}
                    placeholder={t("subscription.placeholder.date")}
                    describedBy={field.describedBy}
                    invalid={field.invalid}
                    minDate={today}
                    defaultMonth={currentForm.startDate ?? today}
                    size="large"
                  />
                )}
              </FormField>
              <FormField
                id="renew-next-billing-date"
                label={t("subscription.field.nextBillingDate")}
                labelId="renew-next-billing-date-label"
                error={errors.nextBillingDate}
                renderError={false}
              >
                {(field) => (
                  <DateOnlyPickerField
                    id={field.id}
                    labelId="renew-next-billing-date-label"
                    valueId="renew-next-billing-date-value"
                    value={currentForm.nextBillingDate}
                    onChange={handleNextBillingDateChange}
                    placeholder={t("subscription.placeholder.date")}
                    describedBy={field.describedBy}
                    invalid={field.invalid}
                    minDate={currentForm.startDate ?? today}
                    defaultMonth={currentForm.nextBillingDate}
                    size="large"
                  />
                )}
              </FormField>
            </FormFieldRow>
          ) : (
            <div className="grid gap-3 rounded-md border border-border bg-secondary/40 p-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-xs leading-5 text-muted-foreground">{t("subscription.renew.currentNextBillingDate")}</p>
                  <p className="font-medium text-foreground">{subscription ? formatDateOnly(subscription.nextBillingDate) : "-"}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs leading-5 text-muted-foreground">{t("subscription.renew.continueNextBillingDate")}</p>
                  <p className="font-medium text-foreground">{formatDateOnly(currentForm.nextBillingDate)}</p>
                </div>
              </div>
            </div>
          )}
          {restartMode && currentForm.startDate ? <RenewSubscriptionMemberDates members={memberDates} errors={memberDateErrors}
            startDate={currentForm.startDate} nextBillingDate={currentForm.nextBillingDate} onChange={setMemberDate} /> : null}
        </>
      ) : null)}
      actions={loadingSlots?.actions ?? (
        <>
          {visibleError ? <p role="alert" className="w-full min-w-0 wrap-break-word text-sm text-destructive">{visibleError}</p> : null}
          {onRefresh && (visibleError || !currentForm) ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()} className="w-full sm:w-auto">
              {t("subscription.renew.refresh")}
            </Button>
          ) : null}
          {calculationError && onEdit ? <Button type="button" variant="outline" disabled={busy} onClick={onEdit}>{t("common.edit")}</Button> : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full border-border sm:w-auto" disabled={busy}>
            {t("common.cancel")}
          </Button>
          {currentForm ? <Button type="submit" disabled={busy || recoveryRequired || Boolean(calculationError || metadataError)} className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {submitLabel}
          </Button> : null}
        </>
      )}
    />
  );
}
