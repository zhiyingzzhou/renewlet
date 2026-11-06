import { memo, useCallback } from "react";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { compareDateOnly } from "@/lib/time/date-only";
import { LogoPicker } from "@/components/logo-picker";
import { SubscriptionBalanceFields } from "@/components/subscription-balance-fields";
import { CostSharingFields } from "@/components/subscription-cost-sharing-fields";
import { SubscriptionFormDateFields } from "@/components/subscription-form-date-fields";
import { SubscriptionPaymentMethodSelect } from "@/components/subscription-payment-method-select";
import { SubscriptionTagInput } from "@/components/subscription-tag-input";
import type {
  BillingCycle,
  CostSharing,
  RepeatReminderInterval,
  RepeatReminderWindow,
  SubscriptionStatus,
} from "@/types/subscription";
import {
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  CUSTOM_CYCLE_UNITS,
  CYCLE_LABELS,
  REMINDER_DAYS_OPTIONS,
  REPEAT_REMINDER_INTERVAL_OPTIONS,
  REPEAT_REMINDER_SENTENCE_INTERVAL_LABELS,
  REPEAT_REMINDER_WINDOW_OPTIONS,
} from "@/types/subscription";
import type { SubscriptionFormReminderType, SubscriptionFormState } from "@/types/subscription-form";
import { toReminderDays } from "@/lib/subscription-form";
import { customCycleUnitLabelKey } from "@/lib/subscription-billing";
import { useI18n } from "@/i18n/I18nProvider";
import { localizedLabel } from "@/i18n/locales";
import { getErrorFieldsToClearForFormChange, type SubscriptionFormErrors, type SubscriptionFormFieldsProps } from "@/components/subscription-form-fields-model";

export type { SubscriptionFormReminderType };
export type { SubscriptionFormState };
export type { SubscriptionFormErrors, SubscriptionFormFieldsProps };

function disabledReminderFields(): Pick<SubscriptionFormState, "reminderType" | "reminderDays" | "repeatReminderEnabled"> {
  return {
    reminderType: "disabled",
    reminderDays: String(DISABLED_REMINDER_DAYS),
    repeatReminderEnabled: false,
  };
}

function inheritedReminderFields(): Pick<SubscriptionFormState, "reminderType" | "reminderDays"> {
  return {
    reminderType: "inherit",
    reminderDays: String(INHERIT_REMINDER_DAYS),
  };
}

function disableCollectionReminder(costSharing: CostSharing | undefined): CostSharing | undefined {
  if (!costSharing?.collectionReminder?.enabled) return costSharing;
  return {
    ...costSharing,
    collectionReminder: { ...costSharing.collectionReminder, enabled: false },
  };
}

export const SubscriptionFormFields = memo(function SubscriptionFormFields({
  idPrefix,
  config,
  formData,
  setFormData,
  currencyOptions,
  balanceCurrencyOptions,
  hasStoredBalance = false,
  availableTags = [],
  showLogoField = true,
  onLogoUploadStatusChange,
  onFieldChange,
  pendingStatusConfirmation = false,
  errors = {},
  onClearFieldError,
  notificationReminderDays,
  costSharingCurrencyConvert,
  onNestedDialogOpenChange,
}: SubscriptionFormFieldsProps) {
  const { t, locale, label } = useI18n();

  const update = useCallback(<K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) => {
    setFormData((prev) => {
      if (key === "balanceEnabled") {
        // 同次会话关掉再开恢复输入；仅首次开启从订阅币种取默认值，后续独立维护。
        return { ...prev, balanceEnabled: Boolean(value), balanceCurrency: prev.balanceCurrency || prev.currency };
      }
      if (key === "billingCycle") {
        const nextBillingCycle = value as BillingCycle;
        const leavingImplicitBuyoutReminder =
          prev.billingCycle === "one-time" && prev.oneTimeMode === "buyout" && prev.reminderType === "disabled";
        return {
          ...prev,
          billingCycle: nextBillingCycle,
          customDays: nextBillingCycle === "custom" ? prev.customDays : "",
          customCycleUnit: nextBillingCycle === "custom" ? prev.customCycleUnit : "day",
          // one-time 无服务期是通知/日历契约里的买断语义，默认静默，避免把购买日误当成到期提醒边界。
          oneTimeMode: nextBillingCycle === "one-time" ? "buyout" : prev.oneTimeMode,
          oneTimeTermCount: nextBillingCycle === "one-time" ? prev.oneTimeTermCount || "1" : prev.oneTimeTermCount,
          oneTimeTermUnit: nextBillingCycle === "one-time" ? prev.oneTimeTermUnit || "month" : prev.oneTimeTermUnit,
          // autoRenew 默认关闭；从 one-time 切回周期时保留用户当前选择，不把沉默状态改成自动续订。
          autoRenew: nextBillingCycle === "one-time" ? false : prev.autoRenew,
          autoCalculate: nextBillingCycle === "one-time" ? false : prev.autoCalculate,
          nextBillingDate: nextBillingCycle === "one-time" ? prev.startDate : prev.nextBillingDate,
          costSharing: nextBillingCycle === "one-time" ? disableCollectionReminder(prev.costSharing) : prev.costSharing,
          ...(nextBillingCycle === "one-time"
            ? disabledReminderFields()
            : leavingImplicitBuyoutReminder
              ? inheritedReminderFields()
              : {}),
        };
      }
      if (key === "oneTimeMode") {
        const nextOneTimeMode = value as SubscriptionFormState["oneTimeMode"];
        return {
          ...prev,
          oneTimeMode: nextOneTimeMode,
          oneTimeTermCount: nextOneTimeMode === "term" ? prev.oneTimeTermCount || "1" : prev.oneTimeTermCount,
          oneTimeTermUnit: nextOneTimeMode === "term" ? prev.oneTimeTermUnit || "month" : prev.oneTimeTermUnit,
          autoCalculate: false,
          nextBillingDate: nextOneTimeMode === "buyout" ? prev.startDate : prev.nextBillingDate,
          costSharing: nextOneTimeMode === "buyout" ? disableCollectionReminder(prev.costSharing) : prev.costSharing,
          ...(nextOneTimeMode === "buyout" ? disabledReminderFields() : inheritedReminderFields()),
        };
      }
      if (key === "startDate") {
        const nextStartDate = value as SubscriptionFormState["startDate"];
        return {
          ...prev,
          startDate: nextStartDate,
          // 开始日后移后，原手动到期日可能变成非法值；清空比静默改成同一天更能保留用户意图。
          // 比较保持在 DateOnly 字符串语义内，避免本地 Date 时区换算导致跨天误判。
          nextBillingDate:
            prev.billingCycle === "one-time"
              ? nextStartDate
              : nextStartDate &&
                  prev.nextBillingDate &&
                  compareDateOnly(prev.nextBillingDate, nextStartDate) < 0
                ? undefined
                : prev.nextBillingDate,
        };
      }
      return { ...prev, [key]: value };
    });
    for (const errorField of getErrorFieldsToClearForFormChange(key)) {
      onClearFieldError?.(errorField);
    }
    // 外层用该事件消费“用户明确修改”语义，例如停止默认货币同步或确认 AI 缺省字段；程序化回写不能冒充用户确认。
    onFieldChange?.(key, value);
  }, [onClearFieldError, onFieldChange, setFormData]);

  const id = (name: string) => `${idPrefix}${name}`;
  const categoryId = id("category");

  const statusLabel = config.statuses.find((status) => status.value === formData.status)?.labels;
  const categoryLabel = config.categories.find((category) => category.value === formData.category)?.labels;
  const paymentMethodLabel =
    config.paymentMethods.find((method) => method.value === formData.paymentMethod)?.labels;
  const repeatReminderSentenceInterval = label(REPEAT_REMINDER_SENTENCE_INTERVAL_LABELS[formData.repeatReminderInterval]);
  const repeatReminderWindowHours =
    formData.repeatReminderWindow === "full" ? null : Number.parseInt(formData.repeatReminderWindow, 10);
  const isReminderDisabled = formData.reminderType === "disabled";
  const isOneTimeBuyout = formData.billingCycle === "one-time" && formData.oneTimeMode === "buyout";
  const reminderDaysForPreview = isReminderDisabled || formData.reminderType === "inherit"
    ? notificationReminderDays
    : toReminderDays(formData);
  const repeatReminderPreview =
    repeatReminderWindowHours === null || reminderDaysForPreview * 24 <= repeatReminderWindowHours
      ? t("subscription.repeatReminderPreview.afterFirst", { interval: repeatReminderSentenceInterval })
      : t("subscription.repeatReminderPreview.finalWindow", { hours: repeatReminderWindowHours });

  return (
    <>
      <FormField id={id("name")} label={t("subscription.field.name")} error={errors.name} errorId={id("name-error")}>
        {(field) => (
          <Input
            id={field.id} name={field.id} enterKeyHint="next"
            placeholder={t("subscription.placeholder.name")}
            value={formData.name}
            onChange={(e) => update("name", e.target.value)}
            required
            aria-invalid={field.invalid}
            aria-describedby={field.describedBy}
            className="border-border bg-secondary"
          />
        )}
      </FormField>

      {showLogoField ? (
        <LogoPicker
          value={formData.logo}
          onChange={(logo) => update("logo", logo)}
          onUploadStatusChange={onLogoUploadStatusChange}
          serviceName={formData.name}
          website={formData.website}
        />
      ) : null}

      <FormFieldRow
        alignAt="sm"
        rowClassName="sm:grid-cols-2"
        errors={[
          { id: id("price-error"), message: errors.price },
          { id: id("currency-error"), message: errors.currency },
        ]}
      >
        <FormField
          id={id("price")}
          label={t("subscription.field.price")}
          error={errors.price}
          errorId={id("price-error")}
          renderError={false}
        >
          {(field) => (
            <NumericInput
              id={field.id} name={field.id}
              allowNegative={false}
              allowedDecimalSeparators={[".", "。"]}
              inputMode="decimal" enterKeyHint="next"
              placeholder="0.00"
              thousandSeparator
              value={formData.price}
              onRawValueChange={(value: string) => update("price", value)}
              required
              aria-invalid={field.invalid}
              aria-describedby={field.describedBy}
              className="border-border bg-secondary"
            />
          )}
        </FormField>
        <FormField
          id={id("currency")}
          label={t("subscription.field.currency")}
          error={errors.currency}
          errorId={id("currency-error")}
          renderError={false}
        >
          {(field) => (
            <SearchableSelect
              id={field.id}
              value={formData.currency}
              onValueChange={(value) => update("currency", value)}
              options={currencyOptions}
              placeholder={t("subscription.placeholder.currency")}
              searchPlaceholder={t("subscription.search.currency")}
              emptyMessage={t("subscription.empty.currency")}
              className={cn(
                "border-border bg-secondary",
                errors.currency && "border-destructive focus:ring-destructive/40",
              )}
              aria-label={t("subscription.placeholder.currency")}
              aria-invalid={field.invalid}
              aria-describedby={field.describedBy}
            />
          )}
        </FormField>
      </FormFieldRow>

      <SubscriptionBalanceFields
        idPrefix={idPrefix}
        formData={formData}
        update={update}
        currencyOptions={balanceCurrencyOptions}
        hasStoredBalance={hasStoredBalance}
        errors={errors}
      />

      <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
        <FormField
          id={id("status")}
          label={t("subscription.field.status")}
        >
          {({ id: fieldId }) => (
            <Select value={formData.status} onValueChange={(value) => update("status", value as SubscriptionStatus)}>
              <SelectTrigger
                id={fieldId}
                className={cn(
                  "border-border bg-secondary",
                  pendingStatusConfirmation && "border-amber-500/70 focus:ring-amber-500/40",
                )}
                tooltipContent={statusLabel ? label(statusLabel) : formData.status}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {config.statuses.map((status) => (
                  <SelectItem key={status.id} value={status.value}>
                    {label(status.labels)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>

        <FormField id={categoryId} label={t("subscription.field.category")}>
          {({ id: fieldId }) => (
            <Select value={formData.category} onValueChange={(value) => update("category", value)}>
              <SelectTrigger id={fieldId} className="border-border bg-secondary" tooltipContent={categoryLabel ? label(categoryLabel) : formData.category}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {config.categories.map((category) => (
                  <SelectItem key={category.id} value={category.value}>
                    {label(category.labels)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      </FormFieldRow>

      <FormFieldRow
        alignAt="sm"
        rowClassName="sm:grid-cols-2"
        errors={[
          { id: id("billingCycle-error"), message: errors.billingCycle },
          { id: id("customDays-error"), message: errors.customDays },
        ]}
      >
        <FormField
          id={id("cycle")}
          label={t("subscription.field.billingCycle")}
          error={errors.billingCycle}
          errorId={id("billingCycle-error")}
          renderError={false}
        >
          {(field) => (
            <Select
              value={formData.billingCycle}
              onValueChange={(value) => update("billingCycle", value as BillingCycle)}
            >
              <SelectTrigger
                id={field.id}
                className={cn(
                  "border-border bg-secondary",
                  errors.billingCycle && "border-destructive focus:ring-destructive/40",
                )}
                aria-label={t("subscription.field.billingCycle")}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CYCLE_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {localizedLabel(label, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>

        {formData.billingCycle === "custom" ? (
          <FormField
            id={id("customDays")}
            label={t("subscription.field.customCycle")}
            error={errors.customDays}
            errorId={id("customDays-error")}
            renderError={false}
          >
            {(field) => (
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_5rem] items-center gap-2" data-testid="custom-cycle-inline-control">
                <span className="whitespace-nowrap text-sm text-muted-foreground">{t("subscription.customCycleEvery")}</span>
                <NumericInput
                  id={field.id} name={field.id}
                  allowNegative={false}
                  decimalScale={0}
                  inputMode="numeric" enterKeyHint="next"
                  placeholder={t("subscription.customCycleCountPlaceholder")}
                  value={formData.customDays}
                  onRawValueChange={(value: string) => update("customDays", value)}
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  className="min-w-0 border-border bg-secondary"
                />
                <Select
                  value={formData.customCycleUnit}
                  onValueChange={(value) => update("customCycleUnit", value as SubscriptionFormState["customCycleUnit"])}
                >
                  <SelectTrigger
                    id={id("customCycleUnit")}
                    className="h-10 min-w-0 overflow-hidden border-border bg-secondary px-2"
                    aria-label={t("subscription.field.customCycleUnit")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CUSTOM_CYCLE_UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {t(customCycleUnitLabelKey(unit))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </FormField>
        ) : formData.billingCycle === "one-time" ? (
          <FormField
            id={id("oneTimeMode")}
            labelSlot={(
              <span id={id("oneTimeMode-label")} className="text-sm font-medium leading-none">
                {t("subscription.field.oneTimeMode")}
              </span>
            )}
          >
            {() => (
              <div
                className="grid grid-cols-2 rounded-md border border-border bg-secondary p-1"
                role="group"
                aria-labelledby={id("oneTimeMode-label")}
              >
                {(["term", "buyout"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cn(
                      "inline-flex min-h-8 min-w-0 items-center justify-center whitespace-nowrap rounded-sm px-2 text-sm font-medium transition-colors",
                      formData.oneTimeMode === mode
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={formData.oneTimeMode === mode}
                    onClick={() => update("oneTimeMode", mode)}
                  >
                    {mode === "term" ? t("subscription.oneTimeMode.term") : t("subscription.oneTimeMode.buyout")}
                  </button>
                ))}
              </div>
            )}
          </FormField>
        ) : (
          <FormField id={id("paymentMethod")} label={t("subscription.field.paymentMethod")}>
            {({ id: fieldId }) => (
              <SubscriptionPaymentMethodSelect
                id={fieldId}
                value={formData.paymentMethod}
                methods={config.paymentMethods}
                labelFor={label}
                placeholder={t("subscription.placeholder.paymentMethod")}
                tooltipContent={paymentMethodLabel ? label(paymentMethodLabel) : undefined}
                onValueChange={(value) => update("paymentMethod", value)}
              />
            )}
          </FormField>
        )}
      </FormFieldRow>

      {formData.billingCycle === "one-time" && formData.oneTimeMode === "term" ? (
        <FormField
          id={id("oneTimeTermCount")}
          label={t("subscription.field.oneTimeTerm")}
          description={t("subscription.oneTimeTermHelp")}
          error={errors.oneTimeTerm}
          errorId={id("oneTimeTerm-error")}
        >
          {(field) => (
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_5rem] items-center gap-2" data-testid="one-time-term-inline-control">
              <span className="whitespace-nowrap text-sm text-muted-foreground">{t("subscription.oneTimeTermFor")}</span>
              <NumericInput
                id={field.id} name={field.id}
                allowNegative={false}
                decimalScale={0}
                inputMode="numeric" enterKeyHint="next"
                placeholder={t("subscription.customCycleCountPlaceholder")}
                value={formData.oneTimeTermCount}
                onRawValueChange={(value: string) => update("oneTimeTermCount", value)}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="min-w-0 border-border bg-secondary"
              />
              <Select
                value={formData.oneTimeTermUnit}
                onValueChange={(value) => update("oneTimeTermUnit", value as SubscriptionFormState["oneTimeTermUnit"])}
              >
                <SelectTrigger
                  id={id("oneTimeTermUnit")}
                  className="h-10 min-w-0 overflow-hidden border-border bg-secondary px-2"
                  aria-label={t("subscription.field.oneTimeTermUnit")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_CYCLE_UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {t(customCycleUnitLabelKey(unit))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </FormField>
      ) : null}

      {(formData.billingCycle === "custom" || formData.billingCycle === "one-time") && (
        <div className="grid gap-2">
          <Label htmlFor={id("paymentMethod")}>{t("subscription.field.paymentMethod")}</Label>
          <SubscriptionPaymentMethodSelect
            id={id("paymentMethod")}
            value={formData.paymentMethod}
            methods={config.paymentMethods}
            labelFor={label}
            placeholder={t("subscription.placeholder.paymentMethod")}
            tooltipContent={paymentMethodLabel ? label(paymentMethodLabel) : undefined}
            onValueChange={(value) => update("paymentMethod", value)}
          />
        </div>
      )}

      {formData.billingCycle !== "one-time" ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-3">
          <div className="min-w-0">
            <Label htmlFor={id("autoRenew")} className="cursor-pointer text-sm font-medium">
              {t("subscription.autoRenew")}
            </Label>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("subscription.autoRenewHelp")}</p>
          </div>
          <Switch
            id={id("autoRenew")}
            checked={formData.autoRenew}
            onCheckedChange={(checked) => update("autoRenew", checked)}
            aria-label={t("subscription.autoRenew")}
          />
        </div>
      ) : null}

      <SubscriptionFormDateFields id={id} formData={formData} update={update} errors={errors} />

      {isOneTimeBuyout ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium">{t("subscription.field.reminder")}</Label>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("subscription.oneTimeBuyoutReminderHelp")}</p>
          </div>
          <span className="shrink-0 text-sm font-medium text-muted-foreground">{t("subscription.reminderDisabledStatus")}</span>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-3">
            <div className="min-w-0">
              <Label htmlFor={id("reminderEnabled")} className="cursor-pointer text-sm font-medium">
                {t("subscription.field.reminder")}
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {isReminderDisabled ? t("subscription.reminderDisabledHelp") : t("subscription.reminderEnabledHelp")}
              </p>
            </div>
            <Switch
              id={id("reminderEnabled")}
              checked={!isReminderDisabled}
              onCheckedChange={(checked) => {
                if (checked) {
                  update("reminderType", "inherit");
                  update("reminderDays", String(INHERIT_REMINDER_DAYS));
                  update("repeatReminderEnabled", false);
                } else {
                  update("reminderType", "disabled");
                  update("reminderDays", String(DISABLED_REMINDER_DAYS));
                  update("repeatReminderEnabled", false);
                }
              }}
              aria-label={t("subscription.field.reminder")}
            />
          </div>

          {!isReminderDisabled ? (
            <>
              <div className="grid gap-2">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Select
                    value={formData.reminderType === "custom" ? "custom" : formData.reminderType === "inherit" ? String(INHERIT_REMINDER_DAYS) : formData.reminderDays}
                    onValueChange={(value) => {
                      if (value === "custom") {
                        update("reminderType", "custom");
                      } else if (value === String(INHERIT_REMINDER_DAYS)) {
                        update("reminderType", "inherit");
                        update("reminderDays", String(INHERIT_REMINDER_DAYS));
                      } else {
                        update("reminderType", "preset");
                        update("reminderDays", value);
                      }
                    }}
                  >
                    <SelectTrigger
                      id={id("reminderDays")}
                      className={cn(
                        "w-full border-border bg-secondary sm:flex-1",
                        errors.reminderDays && "border-destructive focus:ring-destructive/40",
                      )}
                      aria-invalid={Boolean(errors.reminderDays)}
                      aria-describedby={errors.reminderDays ? id("reminder-error") : undefined}
                      aria-label={t("subscription.field.reminder")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={String(INHERIT_REMINDER_DAYS)}>
                        {t("subscription.reminderInherit", { days: notificationReminderDays })}
                      </SelectItem>
                      {REMINDER_DAYS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value.toString()}>
                          {label(option.labels)}
                        </SelectItem>
                      ))}
                      <SelectItem value="custom">{t("subscription.reminderCustom")}</SelectItem>
                    </SelectContent>
                  </Select>

                  {formData.reminderType === "custom" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground whitespace-nowrap">{t("subscription.reminderBefore")}</span>
                      <NumericInput
                        name={id("customReminderDays")} allowNegative={false}
                        decimalScale={0}
                        inputMode="numeric" enterKeyHint="next"
                        placeholder={t("subscription.daysPlaceholder")}
                        value={formData.customReminderDays}
                        onRawValueChange={(value: string) => update("customReminderDays", value)}
                        aria-invalid={Boolean(errors.reminderDays)}
                        aria-describedby={errors.reminderDays ? id("reminder-error") : undefined}
                        className="w-20 border-border bg-secondary"
                      />
                      <span className="text-sm text-muted-foreground">{t("subscription.daysUnit")}</span>
                    </div>
                  )}
                </div>
                <FieldError id={id("reminder-error")} message={errors.reminderDays} />
              </div>

              <div className="flex items-center gap-2">
                <Label htmlFor={id("repeatReminderEnabled")} className="text-sm text-muted-foreground cursor-pointer">
                  {t("subscription.repeatReminder")}
                </Label>
                <Switch
                  id={id("repeatReminderEnabled")}
                  checked={formData.repeatReminderEnabled}
                  onCheckedChange={(checked) => update("repeatReminderEnabled", checked)}
                />
              </div>

              {formData.repeatReminderEnabled && (
                <FormFieldRow
                  alignAt="sm"
                  className="rounded-lg border border-border bg-secondary/30 p-3"
                  rowClassName="sm:grid-cols-2"
                >
                  <FormField id={id("repeatReminderInterval")} label={t("subscription.repeatReminderInterval")}>
                    {({ id: fieldId }) => (
                      <Select
                        value={formData.repeatReminderInterval}
                        onValueChange={(value) => update("repeatReminderInterval", value as RepeatReminderInterval)}
                      >
                        <SelectTrigger id={fieldId} className="border-border bg-secondary">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REPEAT_REMINDER_INTERVAL_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {label(option.labels)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                  <FormField
                    id={id("repeatReminderWindow")}
                    label={t("subscription.repeatReminderWindow")}
                    description={repeatReminderPreview}
                  >
                    {({ id: fieldId, describedBy }) => (
                      <Select
                        value={formData.repeatReminderWindow}
                        onValueChange={(value) => update("repeatReminderWindow", value as RepeatReminderWindow)}
                      >
                        <SelectTrigger id={fieldId} className="border-border bg-secondary" aria-describedby={describedBy}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REPEAT_REMINDER_WINDOW_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {label(option.labels)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                </FormFieldRow>
              )}
            </>
          ) : null}
        </div>
      )}

      <CostSharingFields
        id={id}
        formData={formData}
        update={update}
        error={errors.costSharing}
        currencyOptions={currencyOptions}
        currencyConvert={costSharingCurrencyConvert}
        notificationReminderDays={notificationReminderDays}
        collectionReminderAllowed={!isOneTimeBuyout}
        onNestedDialogOpenChange={onNestedDialogOpenChange}
      />

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-3">
        <div className="min-w-0">
          <Label htmlFor={id("publicHidden")} className="cursor-pointer text-sm font-medium">
            {t("subscription.publicHidden")}
          </Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("subscription.publicHiddenHelp")}</p>
        </div>
        <Switch
          id={id("publicHidden")}
          checked={formData.publicHidden}
          onCheckedChange={(checked) => update("publicHidden", checked)}
          aria-label={t("subscription.publicHidden")}
        />
      </div>

      <FormField id={id("website")} label={t("subscription.field.website")} error={errors.website} errorId={id("website-error")}>
        {(field) => (
          <Input
            id={field.id} name={field.id} type="url" inputMode="url" enterKeyHint="next" autoCapitalize="none" spellCheck={false}
            placeholder="https://example.com"
            value={formData.website}
            onChange={(e) => update("website", e.target.value)}
            aria-invalid={field.invalid}
            aria-describedby={field.describedBy}
            className="border-border bg-secondary"
          />
        )}
      </FormField>

      <FormField id={id("notes")} label={t("subscription.field.notes")}>
        {(field) => (
          <Input
            id={field.id} name={field.id} enterKeyHint="done" maxLength={5000}
            placeholder={t("subscription.placeholder.notes")}
            value={formData.notes}
            onChange={(e) => update("notes", e.target.value)}
            aria-describedby={field.describedBy}
            className="border-border bg-secondary"
          />
        )}
      </FormField>

      <div className="grid gap-2">
        <Label htmlFor={id("tags")}>{t("subscription.field.tags")}</Label>
        <SubscriptionTagInput
          id={id("tags")}
          value={formData.tags}
          onChange={(tags) => update("tags", tags)}
          suggestions={availableTags}
          error={errors.tags}
          errorId={id("tags-error")}
          onClearError={() => onClearFieldError?.("tags")}
        />
      </div>
    </>
  );
});
