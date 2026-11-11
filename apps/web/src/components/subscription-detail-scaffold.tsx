import type { HTMLAttributes, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SubscriptionDetailScaffoldProps extends HTMLAttributes<HTMLDivElement> {
  actions: ReactNode;
  extensions?: ReactNode;
  facts: ReactNode;
  summary: ReactNode;
}

export type SubscriptionDetailScaffoldSlots = Pick<
  SubscriptionDetailScaffoldProps,
  "actions" | "extensions" | "facts" | "summary"
>;

export interface SubscriptionDetailLoadingStructure {
  showCalendarAction: boolean;
  showCostSharing: boolean;
  showBalance: boolean;
  showDailyAverage: boolean;
  showNextBillingDate: boolean;
  showPaymentMethod: boolean;
  showStartDate: boolean;
  showTrialEndDate: boolean;
}

export function SubscriptionDetailScaffold({
  actions,
  className,
  extensions,
  facts,
  summary,
  ...props
}: SubscriptionDetailScaffoldProps) {
  return (
    <div
      className={cn("grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden", className)}
      {...props}
    >
      {/* 外层 Dialog/Drawer 提供确定高度；正文独占可收缩轨道，footer 始终留在滚动区之外。 */}
      <div
        className="h5-mobile-sheet-scroll grid min-w-0 content-start gap-5 px-5 py-4 sm:p-6"
        data-dialog-scroll-region="subscription-detail"
        data-subscription-dialog-scroll=""
      >
        <div
          className="flex items-center justify-between rounded-lg bg-secondary/50 p-4"
          data-dialog-region="subscription-summary"
        >
          {summary}
        </div>
        <div className="grid gap-3" data-dialog-region="subscription-facts">
          {facts}
          {extensions}
        </div>
      </div>
      <footer
        className="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:px-6 sm:pb-4"
        data-dialog-region="subscription-actions"
        data-subscription-dialog-footer=""
      >
        {actions}
      </footer>
    </div>
  );
}

function FactSkeleton() {
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-5 w-full sm:ml-auto sm:w-32" />
    </div>
  );
}

export function createSubscriptionDetailLoadingSlots({
  canEdit,
  canRenew,
  label,
  structure,
}: {
  canEdit: boolean;
  canRenew: boolean;
  label: string;
  structure: SubscriptionDetailLoadingStructure;
}): SubscriptionDetailScaffoldSlots {
  return {
    summary: (
      <>
        <div className="grid min-w-0 gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-6 w-16 rounded-full" />
      </>
    ),
    facts: (
      <>
        <span className="sr-only">{label}</span>
        {structure.showDailyAverage ? <FactSkeleton /> : null}
        {structure.showBalance ? <FactSkeleton /> : null}
        {structure.showCostSharing ? <Skeleton className="h-28 w-full rounded-lg" /> : null}
        <FactSkeleton />
        {structure.showPaymentMethod ? <FactSkeleton /> : null}
        {structure.showNextBillingDate ? <FactSkeleton /> : null}
        {structure.showStartDate ? <FactSkeleton /> : null}
        {structure.showTrialEndDate ? <FactSkeleton /> : null}
        <FactSkeleton />
        <FactSkeleton />
        <FactSkeleton />
      </>
    ),
    actions: (
      <>
        <Skeleton className="h-10 w-full sm:w-20" />
        {structure.showCalendarAction ? <Skeleton className="h-10 w-full sm:w-28" /> : null}
        {canRenew ? <Skeleton className="h-10 w-full sm:w-24" /> : null}
        {canEdit ? <Skeleton className="h-10 w-full sm:w-20" /> : null}
      </>
    ),
  };
}
