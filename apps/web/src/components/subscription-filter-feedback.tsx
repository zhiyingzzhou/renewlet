import { X } from "lucide-react";
import type { SubscriptionAdvancedFilterBaseProps } from "@/components/subscription-advanced-filter";
import { getAdvancedOptionLabel, type SubscriptionAdvancedFilterOption } from "@/modules/subscriptions/domain/subscription-advanced-filter-options";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import type { SubscriptionAdvancedFilterState } from "@/modules/subscriptions/domain/subscription-filters";
import type { BillingCycle } from "@/types/subscription";

interface SubscriptionFilterFeedbackProps {
  selectedTags: string[];
  onRemoveTag: (tag: string) => void;
  filters: SubscriptionAdvancedFilterState;
  onChangeAdvancedFilters: (filters: SubscriptionAdvancedFilterState) => void;
  billingCycleOptions: Array<SubscriptionAdvancedFilterOption<BillingCycle>>;
  paymentMethodOptions: SubscriptionAdvancedFilterOption[];
  currencyOptions: SubscriptionAdvancedFilterOption[];
  onClearFilters: () => void;
  tagTestId: string;
  advancedTestId: string;
  testId: string;
  className?: string;
}

export function SubscriptionFilterFeedback({
  selectedTags,
  onRemoveTag,
  filters,
  onChangeAdvancedFilters,
  billingCycleOptions,
  paymentMethodOptions,
  currencyOptions,
  onClearFilters,
  tagTestId,
  advancedTestId,
  testId,
  className,
}: SubscriptionFilterFeedbackProps) {
  const { t } = useI18n();

  return (
    <div data-testid={testId} className={cn("flex min-w-0 items-start gap-3", className)}>
      <div className="grid min-w-0 flex-1 gap-2">
        <SelectedTagScroller selectedTags={selectedTags} onRemoveTag={onRemoveTag} testId={tagTestId} />
        <SelectedAdvancedFilterScroller
          filters={filters}
          onChange={onChangeAdvancedFilters}
          billingCycleOptions={billingCycleOptions}
          paymentMethodOptions={paymentMethodOptions}
          currencyOptions={currencyOptions}
          testId={advancedTestId}
        />
      </div>
      {/* 清除入口属于已应用筛选反馈区；放回主工具条会在条件出现/消失时重新分配控件宽度。 */}
      <Button variant="ghost" size="sm" onClick={onClearFilters} className="shrink-0 text-muted-foreground">
        {t("subscriptions.clearFilters")}
      </Button>
    </div>
  );
}

interface SelectedTagScrollerProps {
  selectedTags: readonly string[];
  onRemoveTag: (tag: string) => void;
  className?: string;
  testId?: string;
}

function SelectedTagPill({ tag, onRemove }: { tag: string; onRemove: () => void }) {
  const { t } = useI18n();

  return (
    <span className="inline-flex h-9 shrink-0 items-center rounded-full border border-primary bg-primary/10 pl-3 pr-1 text-xs font-semibold text-primary">
      <span className="max-w-32 truncate">{tag}</span>
      <button
        type="button"
        aria-label={t("subscription.tags.remove", { tag })}
        className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

/** SelectedTagScroller 在窄屏保持横向滚动，避免多标签把筛选栏挤出首屏。 */
function SelectedTagScroller({
  selectedTags,
  onRemoveTag,
  className,
  testId = "mobile-selected-tags",
}: SelectedTagScrollerProps) {
  const { t } = useI18n();

  if (selectedTags.length === 0) {
    return null;
  }

  return (
    <div
      data-testid={testId}
      className={cn(
        "min-w-0 overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden",
        className,
      )}
      aria-label={t("subscriptions.tags.selectedCount", { count: selectedTags.length })}
    >
      <div className="flex w-max gap-2 pr-1">
        {selectedTags.map((tag) => (
          <SelectedTagPill key={tag} tag={tag} onRemove={() => onRemoveTag(tag)} />
        ))}
      </div>
    </div>
  );
}

interface SelectedAdvancedFilterScrollerProps extends SubscriptionAdvancedFilterBaseProps {
  className?: string;
  testId?: string;
}

function selectedAdvancedChips({
  filters,
  billingCycleOptions,
  paymentMethodOptions,
  currencyOptions,
  t,
  formatDateOnly,
}: Omit<SelectedAdvancedFilterScrollerProps, "onChange" | "className" | "testId"> & {
  t: ReturnType<typeof useI18n>["t"];
  formatDateOnly: ReturnType<typeof useI18n>["formatDateOnly"];
}) {
  const chips: Array<{ id: string; label: string; remove: Partial<SubscriptionAdvancedFilterState> }> = [];
  const dateChipLabel = (key: "subscriptions.advanced.chipFrom" | "subscriptions.advanced.chipTo", date: string) => (
    t(key, { date: formatDateOnly(date, "short") })
  );
  for (const value of filters.selectedBillingCycles) {
    chips.push({
      id: `cycle:${value}`,
      label: getAdvancedOptionLabel(billingCycleOptions, value),
      remove: { selectedBillingCycles: filters.selectedBillingCycles.filter((item) => item !== value) },
    });
  }
  for (const value of filters.selectedPaymentMethods) {
    chips.push({
      id: `payment:${value}`,
      label: getAdvancedOptionLabel(paymentMethodOptions, value),
      remove: { selectedPaymentMethods: filters.selectedPaymentMethods.filter((item) => item !== value) },
    });
  }
  for (const value of filters.selectedCurrencies) {
    chips.push({
      id: `currency:${value}`,
      label: getAdvancedOptionLabel(currencyOptions, value),
      remove: { selectedCurrencies: filters.selectedCurrencies.filter((item) => item !== value) },
    });
  }
  if (filters.nextBillingFrom) chips.push({ id: "nextBillingFrom", label: dateChipLabel("subscriptions.advanced.chipFrom", filters.nextBillingFrom), remove: { nextBillingFrom: "" } });
  if (filters.nextBillingTo) chips.push({ id: "nextBillingTo", label: dateChipLabel("subscriptions.advanced.chipTo", filters.nextBillingTo), remove: { nextBillingTo: "" } });
  if (filters.pinnedFilter !== "all") chips.push({ id: "pinned", label: filters.pinnedFilter === "yes" ? t("subscriptions.advanced.pinnedOnly") : t("subscriptions.advanced.unpinnedOnly"), remove: { pinnedFilter: "all" } });
  if (filters.publicHiddenFilter !== "all") chips.push({ id: "publicHidden", label: filters.publicHiddenFilter === "yes" ? t("subscriptions.advanced.publicHiddenOnly") : t("subscriptions.advanced.publicVisibleOnly"), remove: { publicHiddenFilter: "all" } });
  if (filters.reminderModeFilter !== "all") {
    const reminderLabel = {
      disabled: t("subscriptions.advanced.reminderDisabled"),
      inherit: t("subscriptions.advanced.reminderInherit"),
      custom: t("subscriptions.advanced.reminderCustom"),
    }[filters.reminderModeFilter];
    chips.push({ id: "reminderMode", label: reminderLabel, remove: { reminderModeFilter: "all" } });
  }
  if (filters.repeatReminderFilter !== "all") chips.push({ id: "repeatReminder", label: filters.repeatReminderFilter === "yes" ? t("subscriptions.advanced.repeatEnabled") : t("subscriptions.advanced.repeatDisabled"), remove: { repeatReminderFilter: "all" } });
  return chips;
}

function SelectedAdvancedFilterScroller({
  filters,
  onChange,
  billingCycleOptions,
  paymentMethodOptions,
  currencyOptions,
  className,
  testId = "selected-advanced-filters",
}: SelectedAdvancedFilterScrollerProps) {
  const { t, formatDateOnly } = useI18n();
  const chips = selectedAdvancedChips({ filters, billingCycleOptions, paymentMethodOptions, currencyOptions, t, formatDateOnly });

  if (chips.length === 0) return null;

  return (
    <div
      data-testid={testId}
      className={cn("min-w-0 overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden", className)}
      aria-label={t("subscriptions.advanced.selectedCount", { count: chips.length })}
    >
      <div className="flex w-max gap-2 pr-1">
        {chips.map((chip) => (
          <span key={chip.id} className="inline-flex h-9 shrink-0 items-center rounded-full border border-primary bg-primary/10 pl-3 pr-1 text-xs font-semibold text-primary">
            <span className="max-w-40 truncate">{chip.label}</span>
            <button
              type="button"
              aria-label={t("subscriptions.advanced.removeChip", { label: chip.label })}
              className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              onClick={() => onChange({ ...filters, ...chip.remove })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
