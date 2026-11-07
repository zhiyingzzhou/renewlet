import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { useI18n } from "@/i18n/I18nProvider";
import type { RenewalMemberDate } from "@/lib/renewal-cost-sharing";
import type { DateOnly } from "@/lib/time/date-only";

export function RenewSubscriptionMemberDates({ members, errors, startDate, nextBillingDate, onChange }: {
  members: RenewalMemberDate[];
  errors: ReadonlySet<string>;
  startDate: DateOnly;
  nextBillingDate: DateOnly;
  onChange: (id: string, value: DateOnly | undefined) => void;
}) {
  const { t, formatDateOnly } = useI18n();
  if (members.length === 0) return null;
  const rows = Array.from({ length: Math.ceil(members.length / 2) }, (_, index) => members.slice(index * 2, index * 2 + 2));
  const rangeError = t("subscription.renew.memberDates.invalid", { start: formatDateOnly(startDate), end: formatDateOnly(nextBillingDate) });
  return (
    <section aria-labelledby="renew-member-dates-heading" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-md border border-border bg-secondary/40 p-3">
      <div className="min-w-0 space-y-1">
        <h3 id="renew-member-dates-heading" className="text-sm font-medium">{t("subscription.renew.memberDates.title")}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("subscription.renew.memberDates.help")}</p>
      </div>
      {rows.map((row, rowIndex) => (
        <FormFieldRow key={row[0]!.id} alignAt="sm" rowClassName="sm:grid-cols-2" errors={row.map((member, columnIndex) => ({
          id: `renew-member-date-${rowIndex * 2 + columnIndex}-error`, message: errors.has(member.id) ? rangeError : undefined,
        }))}>
          {row.map((member, columnIndex) => {
            const id = `renew-member-date-${rowIndex * 2 + columnIndex}`;
            return (
              <FormField key={member.id} id={id} label={t("subscription.renew.memberDates.label", { name: member.name })} labelId={`${id}-label`} labelClassName="wrap-anywhere leading-5" renderError={false}
                description={t("subscription.renew.memberDates.original", { date: formatDateOnly(member.originalDate) })}
                error={errors.has(member.id) ? rangeError : undefined}>
                {(field) => (
                  <DateOnlyPickerField id={field.id} labelId={`${id}-label`} valueId={`${id}-value`}
                    value={member.joinedDate} onChange={(value) => onChange(member.id, value)}
                    placeholder={t("subscription.placeholder.date")} describedBy={field.describedBy} invalid={field.invalid}
                    minDate={startDate} maxDate={nextBillingDate} defaultMonth={member.joinedDate} size="large" />
                )}
              </FormField>
            );
          })}
        </FormFieldRow>
      ))}
    </section>
  );
}
