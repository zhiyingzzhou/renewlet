import type { ReactNode } from "react";
import { Grid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nProvider";

interface SubscriptionListHeaderProps {
  displayedTotal: number | undefined;
  unfilteredTotal: number | undefined;
  pending: boolean;
  publicVisibilitySelectionMode: boolean;
  groupByCategory: boolean;
  onGroupByCategoryChange: (enabled: boolean) => void;
  viewMode: "list" | "grid";
  onViewModeChange: (mode: "list" | "grid") => void;
  children: ReactNode;
}

export function SubscriptionListHeader({
  displayedTotal, unfilteredTotal, pending, publicVisibilitySelectionMode,
  groupByCategory, onGroupByCategoryChange, viewMode, onViewModeChange, children,
}: SubscriptionListHeaderProps) {
  const { t } = useI18n();
  const layoutActionLabel = t(viewMode === "grid" ? "subscriptions.display.switchToList" : "subscriptions.display.switchToGrid");
  return (
    <div className="mb-8 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      <h1 tabIndex={-1} data-subscription-list-heading="" className="text-2xl font-bold text-foreground">{t("subscriptions.title")}</h1>
      <div className="col-span-2 col-start-1 row-start-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:col-span-1">
        <p className="min-h-5 text-sm text-muted-foreground" aria-busy={pending}>
          {displayedTotal !== undefined && <>
            {t("subscriptions.count", { count: displayedTotal })}
            {unfilteredTotal !== undefined && ` ${t("subscriptions.filteredCount", { count: unfilteredTotal })}`}
            {publicVisibilitySelectionMode && " · "}
          </>}
          {publicVisibilitySelectionMode && t("subscriptions.publicVisibilityManagementDescription")}
        </p>
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground sm:min-h-8">
          <Switch checked={groupByCategory} onCheckedChange={onGroupByCategoryChange} />
          {t("subscriptions.display.groupByCategory")}
        </label>
      </div>
      <div className="col-start-2 row-start-1 flex items-center gap-2 sm:row-span-2">
        {children}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="border-border"
          aria-label={layoutActionLabel}
          title={layoutActionLabel}
          onClick={() => onViewModeChange(viewMode === "grid" ? "list" : "grid")}
        >
          {viewMode === "grid" ? <List aria-hidden="true" /> : <Grid aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}
