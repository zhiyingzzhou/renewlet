import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SubscriptionFormScaffoldProps extends ComponentPropsWithoutRef<"form"> {
  fields: ReactNode;
  actions: ReactNode;
  formRef?: Ref<HTMLFormElement>;
  fieldsDisabled?: boolean;
}

export type SubscriptionFormScaffoldSlots = Pick<
  SubscriptionFormScaffoldProps,
  "actions" | "fields"
>;

// 该 scaffold 是等待态与真实表单的布局所有者；显式单列 minmax(0,1fr) 防止长币种/俄语文案撑开窄屏滚动区。
export function SubscriptionFormScaffold({
  fields,
  actions,
  formRef,
  fieldsDisabled = false,
  className,
  ...formProps
}: SubscriptionFormScaffoldProps) {
  return (
    <form
      ref={formRef}
      className={cn("h5-subscription-dialog-form overflow-hidden", className)}
      {...formProps}
    >
      <fieldset
        disabled={fieldsDisabled}
        data-subscription-dialog-scroll=""
        data-dialog-region="subscription-fields"
        className="h5-mobile-sheet-scroll h5-subscription-dialog-scroll grid min-w-0 grid-cols-1 gap-5 px-6 py-4"
      >
        {fields}
      </fieldset>
      <div
        data-subscription-dialog-footer=""
        data-dialog-region="subscription-actions"
        className="h5-subscription-dialog-footer flex shrink-0 flex-col gap-3 border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end md:p-6 md:pt-4"
      >
        {actions}
      </div>
    </form>
  );
}

export interface SubscriptionFormLoadingStructure {
  cycle: "recurring" | "custom" | "one-time-buyout" | "one-time-fixed-term";
  reminderEnabled: boolean;
  balanceEnabled: boolean;
  repeatReminderEnabled: boolean;
}

function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function PairSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FieldSkeleton />
      <FieldSkeleton />
    </div>
  );
}

function PanelSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-20 w-full rounded-lg", className)} />;
}

export function createSubscriptionFormLoadingSlots({
  label,
  structure,
}: {
  label: string;
  structure: SubscriptionFormLoadingStructure;
}): SubscriptionFormScaffoldSlots {
  const oneTime = structure.cycle === "one-time-buyout" || structure.cycle === "one-time-fixed-term";
  const fixedTerm = structure.cycle === "one-time-fixed-term";

  return {
    fields: (
      <>
        <span className="sr-only">{label}</span>
        <FieldSkeleton />
        <PanelSkeleton className="h-24" />
        <PairSkeleton />
        <div className="grid gap-3 rounded-lg border border-border bg-secondary/30 p-3">
          <PanelSkeleton className="h-12" />
          {structure.balanceEnabled ? <PairSkeleton /> : null}
        </div>
        <PairSkeleton />
        <PairSkeleton />
        {fixedTerm ? <FieldSkeleton /> : null}
        {(structure.cycle === "custom" || oneTime) ? <FieldSkeleton /> : null}
        {!oneTime ? <PanelSkeleton /> : null}
        <PairSkeleton />
        <PanelSkeleton />
        {structure.reminderEnabled ? <FieldSkeleton /> : null}
        {structure.repeatReminderEnabled ? <PanelSkeleton className="h-24" /> : null}
        <PanelSkeleton className="h-24" />
        <PanelSkeleton />
        <FieldSkeleton />
        <PanelSkeleton className="h-28" />
        <FieldSkeleton />
      </>
    ),
    actions: (
      <>
        <Skeleton className="h-10 w-full sm:w-24" />
        <Skeleton className="h-10 w-full sm:w-24" />
      </>
    ),
  };
}
