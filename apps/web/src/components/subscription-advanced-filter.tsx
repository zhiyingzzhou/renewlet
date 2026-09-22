import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";

import { AdvancedFilterFooter } from "@/components/subscription-advanced-filter-footer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  SideDrawerClose,
  SideDrawerContent,
  SideDrawerDescription,
  SideDrawerRoot,
  SideDrawerTitle,
  SideDrawerTrigger,
} from "@/components/ui/side-drawer";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import {
  getAdvancedOptionLabel,
  type SubscriptionAdvancedFilterOption,
} from "@/modules/subscriptions/domain/subscription-advanced-filter-options";
import {
  DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
  hasActiveSubscriptionAdvancedFilters,
  type SubscriptionAdvancedFilterState,
} from "@/modules/subscriptions/domain/subscription-filters";
import type { BillingCycle } from "@/types/subscription";

import { DialogModulePending } from "@/components/ui/dialog-module-pending";

// 外层保留 Radix 焦点/退场与筛选草稿；仅延迟面板内容，未打开时不下载各分组选择器。
const AdvancedFilterContent = lazy(() => import("@/components/subscription-advanced-filter-content").then((module) => ({ default: module.AdvancedFilterContent })));

export type { SubscriptionAdvancedFilterOption };

export interface SubscriptionAdvancedFilterBaseProps {
  filters: SubscriptionAdvancedFilterState;
  onChange: (filters: SubscriptionAdvancedFilterState) => void;
  billingCycleOptions: Array<SubscriptionAdvancedFilterOption<BillingCycle>>;
  paymentMethodOptions: SubscriptionAdvancedFilterOption[];
  currencyOptions: SubscriptionAdvancedFilterOption[];
}

type SubscriptionAdvancedFilterMode = "desktopSidePanel" | "mobileWorkspace";

interface SubscriptionAdvancedFilterProps extends SubscriptionAdvancedFilterBaseProps {
  mode: SubscriptionAdvancedFilterMode;
  className?: string;
}

interface SelectedAdvancedFilterScrollerProps extends SubscriptionAdvancedFilterBaseProps {
  className?: string;
  testId?: string;
}

export function SubscriptionAdvancedFilter({
  filters,
  onChange,
  billingCycleOptions,
  paymentMethodOptions,
  currencyOptions,
  mode,
  className,
}: SubscriptionAdvancedFilterProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState(filters);
  const activeCount = useMemo(() => countAdvancedFilters(filters), [filters]);
  const draftActive = hasActiveSubscriptionAdvancedFilters(draftFilters);
  const triggerLabel = activeCount > 0
    ? t("subscriptions.advanced.selectedCount", { count: activeCount })
    : t("subscriptions.advanced.open");

  useEffect(() => {
    if (!open) return;
    // 高级筛选统一走草稿提交，避免侧边面板/移动工作区里的连续选择触发多次全库筛选请求。
    setDraftFilters(filters);
  }, [filters, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraftFilters(filters);
    }
    setOpen(nextOpen);
  };
  const applyDraftFilters = () => {
    onChange(draftFilters);
    handleOpenChange(false);
  };
  const resetDraftFilters = () => setDraftFilters(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS);
  const contentProps = {
    filters: draftFilters,
    onChange: setDraftFilters,
    billingCycleOptions,
    paymentMethodOptions,
    currencyOptions,
  };

  if (mode === "mobileWorkspace") {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <div className={cn("min-w-0", className)} data-testid="mobile-advanced-filter">
          <DialogTrigger asChild>
            <Button variant="outline" className="h-11 w-full min-w-0 justify-start border-border bg-secondary px-3">
              <SlidersHorizontal className="h-4 w-4" />
              <span className="truncate">{triggerLabel}</span>
            </Button>
          </DialogTrigger>
        </div>

        {open ? (
          <DialogContent
            dismissMode="explicit"
            closeLabel={t("common.close")}
            className="h-(--app-viewport-height) max-h-(--app-viewport-height) w-full max-w-none gap-0 overflow-hidden rounded-none border-0 bg-card p-0"
            data-testid="mobile-advanced-filter-workspace"
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="border-b border-border px-5 pb-3 pr-14 pt-[calc(1rem+env(safe-area-inset-top))]">
                <DialogTitle className="text-base font-semibold text-foreground">
                  {t("subscriptions.advanced.drawerTitle")}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {t("subscriptions.advanced.panelDescription")}
                </DialogDescription>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <Suspense fallback={<DialogModulePending label={t("common.loading")} />}><AdvancedFilterContent {...contentProps} layout="mobile" /></Suspense>
              </div>
              <AdvancedFilterFooter
                active={draftActive}
                onClear={resetDraftFilters}
                onApply={applyDraftFilters}
                className="pb-[calc(1rem+env(safe-area-inset-bottom))]"
              />
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    );
  }

  return (
    <SideDrawerRoot open={open} onOpenChange={handleOpenChange}>
      <div className={cn("shrink-0", className)} data-testid="desktop-advanced-filter">
        <SideDrawerTrigger asChild>
          <Button variant="outline" className="h-10 shrink-0 border-border bg-secondary px-3">
            <SlidersHorizontal className="h-4 w-4" />
            <span>{triggerLabel}</span>
          </Button>
        </SideDrawerTrigger>
      </div>

      <SideDrawerContent
        side="right"
        className="w-[min(30rem,calc(100vw-2rem))]"
        data-testid="desktop-advanced-filter-panel"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <SideDrawerTitle className="text-base font-semibold text-foreground">
              {t("subscriptions.advanced.drawerTitle")}
            </SideDrawerTitle>
            <SideDrawerDescription className="sr-only">
              {t("subscriptions.advanced.panelDescription")}
            </SideDrawerDescription>
          </div>
          <SideDrawerClose asChild>
            <Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-10 w-10 text-muted-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">{t("common.close")}</span>
            </Button>
          </SideDrawerClose>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-testid="desktop-advanced-filter-scroll">
          <Suspense fallback={<DialogModulePending label={t("common.loading")} />}><AdvancedFilterContent {...contentProps} layout="desktop" /></Suspense>
        </div>
        <AdvancedFilterFooter
          active={draftActive}
          onClear={resetDraftFilters}
          onApply={applyDraftFilters}
          className="px-5"
        />
      </SideDrawerContent>
    </SideDrawerRoot>
  );
}

function countAdvancedFilters(filters: SubscriptionAdvancedFilterState): number {
  return filters.selectedBillingCycles.length +
    filters.selectedPaymentMethods.length +
    filters.selectedCurrencies.length +
    (filters.nextBillingFrom ? 1 : 0) +
    (filters.nextBillingTo ? 1 : 0) +
    (filters.pinnedFilter !== "all" ? 1 : 0) +
    (filters.publicHiddenFilter !== "all" ? 1 : 0) +
    (filters.reminderModeFilter !== "all" ? 1 : 0) +
    (filters.repeatReminderFilter !== "all" ? 1 : 0);
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

export function SelectedAdvancedFilterScroller({
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
