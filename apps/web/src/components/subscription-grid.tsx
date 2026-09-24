import { useCallback, useMemo } from "react";
import { SubscriptionCard, type SubscriptionCardLookup } from "@/components/subscription-card";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import type { DateOnly } from "@/lib/time/date-only";

const SUBSCRIPTION_GRID_ROW_GAP = 16;
const SUBSCRIPTION_GRID_ROW_ESTIMATE = 220;
const SUBSCRIPTION_LIST_ROW_ESTIMATE = 174;

type SubscriptionGridProps = {
  subscriptions: SubscriptionCollectionItem[];
  viewMode: "grid" | "list";
  today: DateOnly | string;
  inheritedReminderDays: number;
  currencyConvert: (amount: number | string, fromCurrency: string, toCurrency: string) => number;
  currencyRatesReady: boolean;
  priceReferenceCurrency: string | null;
  categoryByValue: SubscriptionCardLookup;
  paymentMethodByValue: SubscriptionCardLookup;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onClone: (id: string) => void;
  onTogglePinned: (id: string) => void;
  onTogglePublicHidden: (id: string) => void;
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelect?: (id: string, selected: boolean) => void;
  onRenew: (id: string) => void;
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

function chunkSubscriptions(subscriptions: SubscriptionCollectionItem[], columnCount: number) {
  const rows: SubscriptionCollectionItem[][] = [];
  for (let index = 0; index < subscriptions.length; index += columnCount) {
    rows.push(subscriptions.slice(index, index + columnCount));
  }
  return rows;
}

export function SubscriptionGrid({
  subscriptions,
  viewMode,
  today,
  inheritedReminderDays,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
  categoryByValue,
  paymentMethodByValue,
  onEdit,
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
  const isTwoColumnGrid = useMediaQuery("(min-width: 640px)");
  const isThreeColumnGrid = useMediaQuery("(min-width: 1024px)");
  const columnCount = getSubscriptionColumnCount(viewMode, isTwoColumnGrid, isThreeColumnGrid);
  const rows = useMemo(() => chunkSubscriptions(subscriptions, columnCount), [columnCount, subscriptions]);
  const estimatedRowSize = viewMode === "grid" ? SUBSCRIPTION_GRID_ROW_ESTIMATE : SUBSCRIPTION_LIST_ROW_ESTIMATE;
  const getRowKey = useCallback(
    (rowIndex: number) => rows[rowIndex]?.map((subscription) => subscription.id).join("|") ?? rowIndex,
    [rows],
  );
  const renderRow = useCallback((rowIndex: number) => {
    const row = rows[rowIndex];
    if (!row) return null;

    return row.map((subscription) => (
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
    onAddToCalendar,
    onClone,
    onDelete,
    onEdit,
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
      itemClassName={cn(
        "grid items-stretch gap-4",
        viewMode === "grid" ? "sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-1",
      )}
      testId="virtualized-subscription-list"
      renderItem={renderRow}
    />
  );
}
