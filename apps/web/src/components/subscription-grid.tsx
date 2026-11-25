import { useCallback, useMemo } from "react";
import { SubscriptionCard, type SubscriptionCardLookup } from "@/components/subscription-card";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { buildSubscriptionGridRows } from "@/modules/subscriptions/domain/subscription-grid-rows";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import type { DateOnly } from "@/lib/time/date-only";

const SUBSCRIPTION_GRID_ROW_GAP = 16;
const SUBSCRIPTION_GRID_ROW_ESTIMATE = 220;
const SUBSCRIPTION_LIST_ROW_ESTIMATE = 174;
const CATEGORY_HEADING_ESTIMATE = 28;

type SubscriptionGridProps = {
  subscriptions: SubscriptionCollectionItem[];
  viewMode: "grid" | "list";
  groupByCategory: boolean;
  today: DateOnly | string;
  inheritedReminderDays: number;
  currencyConvert: (amount: number | string, fromCurrency: string, toCurrency: string) => number;
  currencyRatesReady: boolean;
  priceReferenceCurrency: string | null;
  categoryByValue: SubscriptionCardLookup;
  paymentMethodByValue: SubscriptionCardLookup;
  onEdit: (id: string, intent?: "resume", trigger?: HTMLElement | null) => void;
  onPause?: (id: string, status: "active" | "trial", trigger: HTMLElement | null) => Promise<void>;
  onDelete: (id: string) => void;
  onClone: (id: string) => void;
  onTogglePinned: (id: string) => void;
  onTogglePublicHidden: (id: string) => void;
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelect?: (id: string, selected: boolean) => void;
  onRenew: (id: string, restoreTarget?: HTMLElement | null) => void;
  onViewDetails: (id: string) => void;
  onAddToCalendar: (id: string) => void;
  onPrefetchDetails: (id: string) => void;
};

function getRootScrollElement() {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

function getSubscriptionColumnCount(viewMode: "grid" | "list", isTwoColumnGrid: boolean, isThreeColumnGrid: boolean) {
  if (viewMode === "list") return 1;
  if (isThreeColumnGrid) return 3;
  if (isTwoColumnGrid) return 2;
  return 1;
}

export function SubscriptionGrid({
  subscriptions,
  viewMode,
  groupByCategory,
  today,
  inheritedReminderDays,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
  categoryByValue,
  paymentMethodByValue,
  onEdit,
  onPause,
  onDelete,
  onClone,
  onTogglePinned,
  onTogglePublicHidden,
  selectionMode = false,
  selectedIds,
  onSelect,
  onRenew,
  onViewDetails,
  onAddToCalendar,
  onPrefetchDetails,
}: SubscriptionGridProps) {
  const { label, t } = useI18n();
  const isTwoColumnGrid = useMediaQuery("(min-width: 640px)");
  const isThreeColumnGrid = useMediaQuery("(min-width: 1024px)");
  const columnCount = getSubscriptionColumnCount(viewMode, isTwoColumnGrid, isThreeColumnGrid);
  const rows = useMemo(() => buildSubscriptionGridRows(
    subscriptions, columnCount, groupByCategory ? categoryByValue.keys() : undefined,
  ), [subscriptions, columnCount, groupByCategory, categoryByValue]);
  const cardRowSize = viewMode === "grid" ? SUBSCRIPTION_GRID_ROW_ESTIMATE : SUBSCRIPTION_LIST_ROW_ESTIMATE;
  const estimatedRowSize = useCallback(
    (index: number) => rows[index]?.kind === "heading" ? CATEGORY_HEADING_ESTIMATE : cardRowSize,
    [rows, cardRowSize],
  );
  const getRowKey = useCallback(
    (rowIndex: number) => `${viewMode}:${columnCount}:${rows[rowIndex]?.key ?? rowIndex}`,
    [rows, viewMode, columnCount],
  );
  const renderRow = useCallback((rowIndex: number) => {
    const row = rows[rowIndex];
    if (!row) return null;
    if (row.kind === "heading") {
      const category = categoryByValue.get(row.category);
      return (
        <h2 className={cn("col-span-full flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-semibold text-foreground", rowIndex > 0 && "pt-2")}>
          <span className="min-w-0 wrap-anywhere">{category ? label(category.labels) : row.category}</span>{" "}
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{t("subscriptions.display.groupCount", { count: row.count })}</span>
        </h2>
      );
    }

    return row.items.map((subscription) => (
      <div key={subscription.id} className="h-full">
        <SubscriptionCard
          subscription={subscription}
          viewMode={viewMode}
          today={today}
          inheritedReminderDays={inheritedReminderDays}
          currencyConvert={currencyConvert}
          currencyRatesReady={currencyRatesReady}
          priceReferenceCurrency={priceReferenceCurrency}
          categoryByValue={categoryByValue}
          paymentMethodByValue={paymentMethodByValue}
          onEdit={onEdit}
          onPause={onPause}
          onDelete={onDelete}
          onClone={onClone}
          onTogglePinned={onTogglePinned}
          onTogglePublicHidden={onTogglePublicHidden}
          selectionMode={selectionMode}
          selected={selectedIds?.has(subscription.id) ?? false}
          onSelect={onSelect}
          onRenew={onRenew}
          onViewDetails={onViewDetails}
          onAddToCalendar={onAddToCalendar}
          onPrefetchDetails={onPrefetchDetails}
        />
      </div>
    ));
  }, [
    categoryByValue,
    currencyConvert,
    currencyRatesReady,
    inheritedReminderDays,
    label,
    onAddToCalendar,
    onClone,
    onDelete,
    onEdit,
    onPause,
    onPrefetchDetails,
    onRenew,
    onSelect,
    onTogglePinned,
    onTogglePublicHidden,
    onViewDetails,
    paymentMethodByValue,
    priceReferenceCurrency,
    rows,
    selectedIds,
    selectionMode,
    t,
    today,
    viewMode,
  ]);

  // 分页列表始终使用同一虚拟化模型，避免加载更多时切换 DOM 导致浏览器滚动锚点漂移。
  return (
    <VirtualizedList
      count={rows.length}
      estimatedItemSize={estimatedRowSize}
      gap={SUBSCRIPTION_GRID_ROW_GAP}
      getItemKey={getRowKey}
      getScrollElement={getRootScrollElement}
      retainKeyboardFocus={groupByCategory}
      itemClassName={cn(
        "grid items-stretch gap-4",
        viewMode === "grid" ? "sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-1",
      )}
      testId="virtualized-subscription-list"
      renderItem={renderRow}
    />
  );
}
