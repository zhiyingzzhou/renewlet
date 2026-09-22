import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AdvancedFilterGroupDialog, AdvancedOptionSelectionDialog, AdvancedSelectionEntry } from "@/components/subscription-advanced-selection-picker";
import { DeferredSubscriptionAdvancedDateRangeFields } from "@/components/subscription-advanced-date-range-fields-loader";
import { TagFilterChip } from "@/components/subscription-tag-filter-drawer";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { getAdvancedOptionLabel, getAdvancedSelectionPreview, type SubscriptionAdvancedFilterOption } from "@/modules/subscriptions/domain/subscription-advanced-filter-options";
import { DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS, type SubscriptionAdvancedFilterState, type SubscriptionBooleanFilter, type SubscriptionReminderModeFilter } from "@/modules/subscriptions/domain/subscription-filters";
import type { SubscriptionAdvancedFilterBaseProps } from "@/components/subscription-advanced-filter";

type AdvancedFilterSectionId = "billingCycle" | "paymentMethod" | "currency" | "nextBilling" | "flags";
type AdvancedFilterLayout = "desktop" | "mobile";
type AdvancedFilterSectionConfig = {
  id: AdvancedFilterSectionId;
  title: string;
  summary: string;
  preview?: string | undefined;
  content?: ReactNode;
  desktopEntry?: ReactNode;
  onOpen?: (() => void) | undefined;
};

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function replaceAdvancedFilters(
  filters: SubscriptionAdvancedFilterState,
  patch: Partial<SubscriptionAdvancedFilterState>,
): SubscriptionAdvancedFilterState {
  return { ...filters, ...patch };
}

function summarizeLabels(labels: readonly string[], t: ReturnType<typeof useI18n>["t"]): string {
  if (labels.length === 0) return t("subscriptions.advanced.any");
  if (labels.length === 1) return labels[0] ?? t("subscriptions.advanced.any");
  return t("subscriptions.advanced.selectionCount", { count: labels.length });
}

function summarizeSelectedValues(
  values: readonly string[],
  options: readonly SubscriptionAdvancedFilterOption[],
  t: ReturnType<typeof useI18n>["t"],
): string {
  return summarizeLabels(values.map((value) => getAdvancedOptionLabel(options, value)), t);
}

function previewLabels(labels: readonly string[], t: ReturnType<typeof useI18n>["t"]): string | undefined {
  if (labels.length === 0) return undefined;
  const visibleLabels = labels.slice(0, 3);
  const overflowCount = labels.length - visibleLabels.length;
  const preview = visibleLabels.join(t("subscriptions.advanced.previewSeparator"));
  return overflowCount > 0 ? `${preview} ${t("subscriptions.advanced.previewOverflow", { count: overflowCount })}` : preview;
}

function summarizeDateRange(
  filters: SubscriptionAdvancedFilterState,
  t: ReturnType<typeof useI18n>["t"],
  formatDateOnly: ReturnType<typeof useI18n>["formatDateOnly"],
): string {
  // 这里仅格式化展示文案；筛选状态和 API 查询仍保持 date-only 的 YYYY-MM-DD 契约。
  if (filters.nextBillingFrom && filters.nextBillingTo) {
    return t("subscriptions.advanced.rangeSummary", {
      from: formatDateOnly(filters.nextBillingFrom, "short"),
      to: formatDateOnly(filters.nextBillingTo, "short"),
    });
  }
  if (filters.nextBillingFrom) return t("subscriptions.advanced.chipFrom", { date: formatDateOnly(filters.nextBillingFrom, "short") });
  if (filters.nextBillingTo) return t("subscriptions.advanced.chipTo", { date: formatDateOnly(filters.nextBillingTo, "short") });
  return t("subscriptions.advanced.any");
}

function flagFilterLabels({
  filters,
  pinnedOptions,
  publicOptions,
  reminderModeOptions,
  repeatReminderOptions,
}: {
  filters: SubscriptionAdvancedFilterState;
  pinnedOptions: Array<SubscriptionAdvancedFilterOption<SubscriptionBooleanFilter>>;
  publicOptions: Array<SubscriptionAdvancedFilterOption<SubscriptionBooleanFilter>>;
  reminderModeOptions: Array<SubscriptionAdvancedFilterOption<SubscriptionReminderModeFilter>>;
  repeatReminderOptions: Array<SubscriptionAdvancedFilterOption<SubscriptionBooleanFilter>>;
}) {
  const labels: string[] = [];
  if (filters.pinnedFilter !== "all") labels.push(getAdvancedOptionLabel(pinnedOptions, filters.pinnedFilter));
  if (filters.publicHiddenFilter !== "all") labels.push(getAdvancedOptionLabel(publicOptions, filters.publicHiddenFilter));
  if (filters.reminderModeFilter !== "all") labels.push(getAdvancedOptionLabel(reminderModeOptions, filters.reminderModeFilter));
  if (filters.repeatReminderFilter !== "all") labels.push(getAdvancedOptionLabel(repeatReminderOptions, filters.repeatReminderFilter));
  return labels;
}

function AdvancedSelect({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Array<SubscriptionAdvancedFilterOption>;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger aria-label={label} className="h-10 border-border bg-secondary" tooltipContent={getAdvancedOptionLabel(options, value)}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent mobileTitle={label}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AdvancedSectionList({
  sections,
}: {
  sections: AdvancedFilterSectionConfig[];
}) {
  const { t } = useI18n();

  return (
    <nav aria-label={t("subscriptions.advanced.sectionListLabel")} className="grid gap-1 px-3 py-3">
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          data-testid={`advanced-section-${section.id}-entry`}
          className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          onClick={section.onOpen}
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center justify-between gap-3">
              <span className="truncate text-sm font-semibold text-foreground">{section.title}</span>
              <span data-testid={`advanced-section-${section.id}-summary`} className="max-w-32 shrink-0 truncate text-right text-xs text-muted-foreground">
                {section.summary}
              </span>
            </span>
            {section.preview ? (
              <span
                data-testid={`advanced-section-${section.id}-preview`}
                className="mt-1 block line-clamp-2 text-xs leading-5 text-muted-foreground"
              >
                {section.preview}
              </span>
            ) : null}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}

function DesktopSection({ section }: { section: AdvancedFilterSectionConfig }) {
  if (section.desktopEntry) {
    return (
      <section className="border-b border-border pb-5 last:border-b-0 last:pb-0">
        {section.desktopEntry}
      </section>
    );
  }

  return (
    <section className="space-y-3 border-b border-border pb-5 last:border-b-0 last:pb-0">
      {/* 桌面摘要必须吃剩余空间；固定宽度截断会让完整日期范围在空间足够时仍显示省略号。 */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 className="shrink-0 text-sm font-semibold text-foreground">{section.title}</h3>
        <span data-testid={`advanced-section-${section.id}-summary`} className="min-w-0 flex-1 wrap-break-word text-right text-xs leading-5 text-muted-foreground">
          {section.summary}
        </span>
      </div>
      {section.content}
    </section>
  );
}

export function AdvancedFilterContent({
  filters,
  onChange,
  billingCycleOptions,
  paymentMethodOptions,
  currencyOptions,
  layout,
}: SubscriptionAdvancedFilterBaseProps & {
  layout: AdvancedFilterLayout;
}) {
  const { t, formatDateOnly } = useI18n();
  const [activeDialog, setActiveDialog] = useState<AdvancedFilterSectionId | null>(null);
  const booleanOptions = useMemo<Array<SubscriptionAdvancedFilterOption<SubscriptionBooleanFilter>>>(() => [
    { value: "all", label: t("subscriptions.advanced.any") },
    { value: "yes", label: t("subscriptions.advanced.yes") },
    { value: "no", label: t("subscriptions.advanced.no") },
  ], [t]);
  const pinnedOptions = useMemo<Array<SubscriptionAdvancedFilterOption<SubscriptionBooleanFilter>>>(() => [
    { value: "all", label: t("subscriptions.advanced.any") },
    { value: "yes", label: t("subscriptions.advanced.pinnedOnly") },
    { value: "no", label: t("subscriptions.advanced.unpinnedOnly") },
  ], [t]);
  const publicOptions = useMemo<Array<SubscriptionAdvancedFilterOption<SubscriptionBooleanFilter>>>(() => [
    { value: "all", label: t("subscriptions.advanced.any") },
    { value: "yes", label: t("subscriptions.advanced.publicHiddenOnly") },
    { value: "no", label: t("subscriptions.advanced.publicVisibleOnly") },
  ], [t]);
  const reminderModeOptions = useMemo<Array<SubscriptionAdvancedFilterOption<SubscriptionReminderModeFilter>>>(() => [
    { value: "all", label: t("subscriptions.advanced.any") },
    { value: "disabled", label: t("subscriptions.advanced.reminderDisabled") },
    { value: "inherit", label: t("subscriptions.advanced.reminderInherit") },
    { value: "custom", label: t("subscriptions.advanced.reminderCustom") },
  ], [t]);
  const update = (patch: Partial<SubscriptionAdvancedFilterState>) => onChange(replaceAdvancedFilters(filters, patch));
  const flagLabels = flagFilterLabels({
    filters,
    pinnedOptions,
    publicOptions,
    reminderModeOptions,
    repeatReminderOptions: booleanOptions,
  });
  const paymentMethodSummary = summarizeSelectedValues(filters.selectedPaymentMethods, paymentMethodOptions, t);
  const paymentMethodPreview = getAdvancedSelectionPreview({
    values: filters.selectedPaymentMethods,
    options: paymentMethodOptions,
    separator: t("subscriptions.advanced.previewSeparator"),
    overflowLabel: (count) => t("subscriptions.advanced.previewOverflow", { count }),
  });
  const currencySummary = summarizeSelectedValues(filters.selectedCurrencies, currencyOptions, t);
  const currencyPreview = getAdvancedSelectionPreview({
    values: filters.selectedCurrencies,
    options: currencyOptions,
    separator: t("subscriptions.advanced.previewSeparator"),
    overflowLabel: (count) => t("subscriptions.advanced.previewOverflow", { count }),
  });
  const nextBillingSummary = summarizeDateRange(filters, t, formatDateOnly);
  // 移动首页右侧摘要保持紧凑，完整日期范围放到第二行 preview，避免小屏再次被硬截断。
  const nextBillingPreview = filters.nextBillingFrom || filters.nextBillingTo ? nextBillingSummary : undefined;
  const billingCycleSummary = summarizeSelectedValues(filters.selectedBillingCycles, billingCycleOptions, t);
  const billingCyclePreview = getAdvancedSelectionPreview({
    values: filters.selectedBillingCycles,
    options: billingCycleOptions,
    separator: t("subscriptions.advanced.previewSeparator"),
    overflowLabel: (count) => t("subscriptions.advanced.previewOverflow", { count }),
  });
  const flagsSummary = summarizeLabels(flagLabels, t);
  const flagsPreview = previewLabels(flagLabels, t);
  const renderBillingCycleContent = (
    currentFilters: SubscriptionAdvancedFilterState,
    onPatch: (patch: Partial<SubscriptionAdvancedFilterState>) => void,
    contentLayout: AdvancedFilterLayout,
  ) => (
    <div className="flex flex-wrap gap-2">
      {billingCycleOptions.map((option) => (
        <TagFilterChip
          key={option.value}
          tag={option.label}
          selected={currentFilters.selectedBillingCycles.includes(option.value)}
          onToggle={() => onPatch({ selectedBillingCycles: toggleValue(currentFilters.selectedBillingCycles, option.value) })}
          className={cn("px-3 text-sm", contentLayout === "mobile" ? "min-h-11" : "min-h-9")}
        />
      ))}
    </div>
  );
  const renderNextBillingContent = (
    currentFilters: SubscriptionAdvancedFilterState,
    onPatch: (patch: Partial<SubscriptionAdvancedFilterState>) => void,
    contentLayout: AdvancedFilterLayout,
  ) => <DeferredSubscriptionAdvancedDateRangeFields filters={currentFilters} onChange={onPatch} mobile={contentLayout === "mobile"} />;
  const renderFlagsContent = (
    currentFilters: SubscriptionAdvancedFilterState,
    onPatch: (patch: Partial<SubscriptionAdvancedFilterState>) => void,
  ) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <AdvancedSelect
        label={t("subscriptions.advanced.pinned")}
        value={currentFilters.pinnedFilter}
        onValueChange={(value) => onPatch({ pinnedFilter: value as SubscriptionBooleanFilter })}
        options={pinnedOptions}
      />
      <AdvancedSelect
        label={t("subscriptions.advanced.publicHidden")}
        value={currentFilters.publicHiddenFilter}
        onValueChange={(value) => onPatch({ publicHiddenFilter: value as SubscriptionBooleanFilter })}
        options={publicOptions}
      />
      <AdvancedSelect
        label={t("subscriptions.advanced.reminderMode")}
        value={currentFilters.reminderModeFilter}
        onValueChange={(value) => onPatch({ reminderModeFilter: value as SubscriptionReminderModeFilter })}
        options={reminderModeOptions}
      />
      <AdvancedSelect
        label={t("subscriptions.advanced.repeatReminder")}
        value={currentFilters.repeatReminderFilter}
        onValueChange={(value) => onPatch({ repeatReminderFilter: value as SubscriptionBooleanFilter })}
        options={booleanOptions}
      />
    </div>
  );
  const sections: AdvancedFilterSectionConfig[] = [
    {
      id: "billingCycle",
      title: t("subscriptions.advanced.billingCycle"),
      summary: billingCycleSummary,
      preview: billingCyclePreview,
      onOpen: layout === "mobile" ? () => setActiveDialog("billingCycle") : undefined,
      content: renderBillingCycleContent(filters, update, layout),
    },
    ...(paymentMethodOptions.length > 0 ? [{
      id: "paymentMethod" as const,
      title: t("subscriptions.advanced.paymentMethod"),
      summary: paymentMethodSummary,
      preview: paymentMethodPreview,
      onOpen: layout === "mobile" ? () => setActiveDialog("paymentMethod") : undefined,
      desktopEntry: (
        <AdvancedSelectionEntry
          title={t("subscriptions.advanced.paymentMethod")}
          summary={paymentMethodSummary}
          preview={paymentMethodPreview}
          onOpen={() => setActiveDialog("paymentMethod")}
          testId="advanced-payment-method-entry"
        />
      ),
    }] : []),
    ...(currencyOptions.length > 0 ? [{
      id: "currency" as const,
      title: t("subscriptions.advanced.currency"),
      summary: currencySummary,
      preview: currencyPreview,
      onOpen: layout === "mobile" ? () => setActiveDialog("currency") : undefined,
      desktopEntry: (
        <AdvancedSelectionEntry
          title={t("subscriptions.advanced.currency")}
          summary={currencySummary}
          preview={currencyPreview}
          onOpen={() => setActiveDialog("currency")}
          testId="advanced-currency-entry"
        />
      ),
    }] : []),
    {
      id: "nextBilling",
      title: t("subscriptions.advanced.nextBilling"),
      summary: nextBillingSummary,
      preview: nextBillingPreview,
      onOpen: layout === "mobile" ? () => setActiveDialog("nextBilling") : undefined,
      content: renderNextBillingContent(filters, update, layout),
    },
    {
      id: "flags",
      title: t("subscriptions.advanced.moreState"),
      summary: flagsSummary,
      preview: flagsPreview,
      onOpen: layout === "mobile" ? () => setActiveDialog("flags") : undefined,
      content: renderFlagsContent(filters, update),
    },
  ];
  const selectionDialogs = (
    <>
      <AdvancedOptionSelectionDialog
        layout={layout}
        open={activeDialog === "paymentMethod"}
        title={t("subscriptions.advanced.editPaymentMethod")}
        selectedValues={filters.selectedPaymentMethods}
        onOpenChange={(nextOpen) => setActiveDialog(nextOpen ? "paymentMethod" : null)}
        onApply={(values) => update({ selectedPaymentMethods: values })}
        options={paymentMethodOptions}
        searchPlaceholder={t("subscriptions.advanced.filterPaymentMethod")}
        searchResultsLabel={t("subscriptions.advanced.searchResults")}
        allOptionsLabel={t("subscriptions.advanced.allPaymentMethods")}
        emptyMessage={t("subscriptions.advanced.emptyPaymentMethod")}
        alwaysShowSearch
        pickerTestId="advanced-payment-method-picker"
        testId="advanced-payment-method-dialog"
      />
      <AdvancedOptionSelectionDialog
        layout={layout}
        open={activeDialog === "currency"}
        title={t("subscriptions.advanced.editCurrency")}
        selectedValues={filters.selectedCurrencies}
        onOpenChange={(nextOpen) => setActiveDialog(nextOpen ? "currency" : null)}
        onApply={(values) => update({ selectedCurrencies: values })}
        options={currencyOptions}
        searchPlaceholder={t("subscriptions.advanced.filterCurrency")}
        searchResultsLabel={t("subscriptions.advanced.searchResults")}
        allOptionsLabel={t("subscriptions.advanced.allCurrencies")}
        emptyMessage={t("subscriptions.advanced.emptyCurrency")}
        alwaysShowSearch
        pickerTestId="advanced-currency-picker"
        testId="advanced-currency-dialog"
      />
    </>
  );
  const groupDialogs = layout === "mobile" ? (
    <>
      <AdvancedFilterGroupDialog
        layout="mobile"
        open={activeDialog === "billingCycle"}
        title={t("subscriptions.advanced.billingCycle")}
        value={filters}
        onOpenChange={(nextOpen) => setActiveDialog(nextOpen ? "billingCycle" : null)}
        onApply={onChange}
        isActive={(draft) => draft.selectedBillingCycles.length > 0}
        clearValue={(draft) => replaceAdvancedFilters(draft, { selectedBillingCycles: [] })}
        testId="advanced-billing-cycle-dialog"
      >
        {(draft, setDraft) => renderBillingCycleContent(
          draft,
          (patch) => setDraft(replaceAdvancedFilters(draft, patch)),
          "mobile",
        )}
      </AdvancedFilterGroupDialog>
      <AdvancedFilterGroupDialog
        layout="mobile"
        open={activeDialog === "nextBilling"}
        title={t("subscriptions.advanced.nextBilling")}
        value={filters}
        onOpenChange={(nextOpen) => setActiveDialog(nextOpen ? "nextBilling" : null)}
        onApply={onChange}
        isActive={(draft) => Boolean(draft.nextBillingFrom || draft.nextBillingTo)}
        clearValue={(draft) => replaceAdvancedFilters(draft, { nextBillingFrom: "", nextBillingTo: "" })}
        testId="advanced-next-billing-dialog"
      >
        {(draft, setDraft) => renderNextBillingContent(
          draft,
          (patch) => setDraft(replaceAdvancedFilters(draft, patch)),
          "mobile",
        )}
      </AdvancedFilterGroupDialog>
      <AdvancedFilterGroupDialog
        layout="mobile"
        open={activeDialog === "flags"}
        title={t("subscriptions.advanced.moreState")}
        value={filters}
        onOpenChange={(nextOpen) => setActiveDialog(nextOpen ? "flags" : null)}
        onApply={onChange}
        isActive={(draft) => flagFilterLabels({
          filters: draft,
          pinnedOptions,
          publicOptions,
          reminderModeOptions,
          repeatReminderOptions: booleanOptions,
        }).length > 0}
        clearValue={(draft) => replaceAdvancedFilters(draft, {
          pinnedFilter: "all",
          publicHiddenFilter: "all",
          reminderModeFilter: "all",
          repeatReminderFilter: "all",
        })}
        testId="advanced-flags-dialog"
      >
        {(draft, setDraft) => renderFlagsContent(
          draft,
          (patch) => setDraft(replaceAdvancedFilters(draft, patch)),
        )}
      </AdvancedFilterGroupDialog>
    </>
  ) : null;

  if (layout === "mobile") {
    return (
      <>
        <AdvancedSectionList sections={sections} />
        {/* 移动端每个分组都是独立子任务；完成只写回父级草稿，主工作区“确定”才触发最终全库筛选。 */}
        {groupDialogs}
        {selectionDialogs}
      </>
    );
  }

  return (
    <>
      <div className="space-y-5">
        {sections.map((section) => (
          <DesktopSection key={section.id} section={section} />
        ))}
      </div>
      {selectionDialogs}
    </>
  );
}
