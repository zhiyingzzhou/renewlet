import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import type { SubscriptionFormFieldUpdater, SubscriptionFormFieldsProps } from "@/components/subscription-form-fields-model";
import { useI18n } from "@/i18n/I18nProvider";

type BalanceFieldsProps = Pick<SubscriptionFormFieldsProps, "idPrefix" | "formData" | "currencyOptions" | "hasStoredBalance" | "errors"> & {
  update: SubscriptionFormFieldUpdater;
};

export function SubscriptionBalanceFields({ idPrefix, formData, update, currencyOptions, hasStoredBalance, errors = {} }: BalanceFieldsProps) {
  const { t } = useI18n();
  const id = (name: string) => `${idPrefix}${name}`;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label id={id("balance-label")} htmlFor={id("balance-enabled")} className="cursor-pointer text-sm font-medium">
            {t("subscription.balanceEnabled")}
          </Label>
          <p id={id("balance-description")} className="mt-1 text-xs leading-5 text-muted-foreground">
            {hasStoredBalance && !formData.balanceEnabled
              ? t("subscription.balanceRemoveHint")
              : t("subscription.balanceDescription")}
          </p>
        </div>
        <Switch
          id={id("balance-enabled")}
          checked={formData.balanceEnabled}
          onCheckedChange={(checked) => update("balanceEnabled", checked)}
          aria-labelledby={id("balance-label")}
          aria-describedby={id("balance-description")}
        />
      </div>
      {formData.balanceEnabled ? (
        <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2" errors={[
          { id: id("balance-error"), message: errors.balance },
          { id: id("balance-currency-error"), message: errors.balanceCurrency },
        ]}>
          <FormField id={id("balance")} label={t("subscription.field.balance")} error={errors.balance} errorId={id("balance-error")} renderError={false}>
            {(field) => (
              <NumericInput
                id={field.id} name={field.id} inputMode="decimal" enterKeyHint="next"
                allowNegative={false} allowedDecimalSeparators={[".", "。"]} thousandSeparator
                value={formData.balance} onRawValueChange={(value) => update("balance", value)}
                required aria-invalid={field.invalid} aria-describedby={field.describedBy}
                className="border-border bg-secondary"
              />
            )}
          </FormField>
          <FormField id={id("balance-currency")} label={t("subscription.field.balanceCurrency")} error={errors.balanceCurrency} errorId={id("balance-currency-error")} renderError={false}>
            {(field) => (
              <SearchableSelect
                id={field.id} value={formData.balanceCurrency}
                onValueChange={(value) => update("balanceCurrency", value)} options={currencyOptions}
                placeholder={t("subscription.placeholder.currency")}
                searchPlaceholder={t("subscription.search.currency")} emptyMessage={t("subscription.empty.currency")}
                aria-invalid={field.invalid} aria-describedby={field.describedBy}
                className="border-border bg-secondary"
              />
            )}
          </FormField>
        </FormFieldRow>
      ) : null}
    </div>
  );
}
