import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { useBulkPublicVisibility } from "@/hooks/use-bulk-public-visibility";
import { subscriptionIndexQueryOptions } from "@/hooks/use-subscriptions";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import type { SubscriptionListFilters } from "@/services/subscription-service";
import type { SubscriptionCollectionItem } from "@/types/subscription";

interface SubscriptionBulkVisibilityToolbarProps {
  subscriptions: readonly SubscriptionCollectionItem[];
  filters: SubscriptionListFilters | undefined;
  total: number;
  selectedIds: ReadonlySet<string>;
  onSelectionChange: Dispatch<SetStateAction<Set<string>>>;
  onBusyChange: (busy: boolean) => void;
}

export function SubscriptionBulkVisibilityToolbar({
  subscriptions, filters, total, selectedIds, onSelectionChange, onBusyChange,
}: SubscriptionBulkVisibilityToolbarProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const mutation = useBulkPublicVisibility();
  const selectPageId = useId();
  const [target, setTarget] = useState<boolean | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      // 筛选切换会重建工具栏；旧全选请求或提交结果不得覆盖新筛选下的选择意图。
      active.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);
  const pending = mutation.isPending || selectingAll;
  const selectedCount = selectedIds.size;
  const visibleSelectionCount = subscriptions.filter((item) => selectedIds.has(item.id)).length;
  const allVisibleSelected = subscriptions.length > 0 && visibleSelectionCount === subscriptions.length;
  const someVisibleSelected = visibleSelectionCount > 0 && !allVisibleSelected;

  async function selectAllMatching() {
    setSelectingAll(true);
    onBusyChange(true);
    try {
      // 只有显式跨页全选才读取索引，复用列表的筛选、5000 条上限与 AbortSignal；不串行遍历分页。
      const result = await queryClient.fetchQuery({ ...subscriptionIndexQueryOptions(filters), staleTime: 0 });
      if (active.current) {
        // 等待期间的逐条勾选优先于旧全选意图，不能用迟到索引抹掉用户的新选择。
        onSelectionChange((current) => current === selectedIds ? new Set(result.subscriptions.map((item) => item.id)) : current);
      }
    } catch (error) {
      if (active.current) toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusUpdateFailedDescription")),
      });
    } finally {
      if (active.current) {
        setSelectingAll(false);
        onBusyChange(false);
      }
    }
  }

  async function handleSelectAllChange(checked: boolean | "indeterminate") {
    if (checked !== true) {
      onSelectionChange((current) => {
        // 全量选择完成后取消应清空全部；分页三态取消只撤销当前页，保留其他页选择意图。
        if (total > subscriptions.length && selectedCount === total) return new Set();
        const next = new Set(current);
        for (const item of subscriptions) next.delete(item.id);
        return next;
      });
      return;
    }
    if (total <= subscriptions.length) {
      onSelectionChange((current) => {
        const next = new Set(current);
        for (const item of subscriptions) next.add(item.id);
        return next;
      });
      return;
    }
    await selectAllMatching();
  }

  async function applyVisibility() {
    if (target === null || selectedCount === 0) return;
    onBusyChange(true);
    try {
      const result = await mutation.mutateAsync({ selection: { ids: [...selectedIds] }, publicHidden: target, dryRun: false });
      if (!active.current) return;
      setTarget(null);
      if (result.failedIds.length > 0) {
        onSelectionChange(new Set(result.failedIds));
        toast.error(t("subscriptions.bulkVisibilityPartial", { changed: result.changedCount, failed: result.failedIds.length }));
      } else {
        if (result.changedCount === 0) {
          toast.success(t("subscriptions.bulkVisibilityUnchanged"));
        } else {
          toast.success(t("settings.publicStatusBulkVisibilityDone", { count: result.changedCount }));
          onSelectionChange(new Set());
        }
      }
    } catch (error) {
      if (active.current) toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusUpdateFailedDescription")),
      });
    } finally {
      if (active.current) onBusyChange(false);
    }
  }

  return (
    <>
      <div className="mb-6 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-2" data-testid="public-visibility-selection-summary">
        <div className="flex shrink-0 items-center gap-2">
          <Checkbox
            id={selectPageId}
            checked={someVisibleSelected ? "indeterminate" : allVisibleSelected}
            onCheckedChange={(checked) => { void handleSelectAllChange(checked); }}
            disabled={pending || subscriptions.length === 0}
            aria-label={t("subscriptions.bulkVisibilitySelectLoaded")}
            className="border-muted-foreground data-[state=checked]:border-primary"
          />
          <Label htmlFor={selectPageId} className="flex min-h-11 cursor-pointer items-center pr-1 text-muted-foreground">
            {t("subscriptions.bulkVisibilitySelectPage")}
          </Label>
          <span aria-hidden="true" className="h-4 w-px bg-border" />
          <Button type="button" size="sm" variant="ghost" className="min-h-11 text-muted-foreground" onClick={() => onSelectionChange(new Set())} disabled={pending || selectedCount === 0}>
            {t("subscriptions.bulkVisibilityClear")}
          </Button>
        </div>
      </div>
      {selectedCount > 0 ? (
        // 固定容器负责视口居中与 safe-area 留白；父页面同步底部占位和回到顶部偏移，避免遮挡列表末项。
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] sm:bottom-6" data-testid="public-visibility-bulk-dock-container">
          <div className="public-visibility-dock pointer-events-auto flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-primary/40 bg-card/95 p-3 text-card-foreground shadow-card backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:rounded-lg sm:px-4" role="toolbar" aria-label={t("subscriptions.bulkPublicVisibility")} data-testid="public-visibility-bulk-dock">
            <div className="flex min-w-0 items-center gap-2.5 text-sm font-medium">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-3 w-3" aria-hidden="true" /></span>
              <span className="truncate">{t("subscriptions.bulkVisibilitySelected", { count: selectedCount })}</span>
            </div>
            {/* 这两个按钮是批量命令，不代表当前选中状态；混合选中时不能用 pressed 或主按钮样式误导用户。 */}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:justify-end">
              <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-0 gap-2 px-2 text-xs sm:min-h-9 sm:w-auto sm:px-3 sm:text-sm" disabled={pending} onClick={() => setTarget(true)}><EyeOff className="h-4 w-4" aria-hidden="true" />{t("subscription.publicHide")}</Button>
              <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-0 gap-2 px-2 text-xs sm:min-h-9 sm:w-auto sm:px-3 sm:text-sm" disabled={pending} onClick={() => setTarget(false)}><Eye className="h-4 w-4" aria-hidden="true" />{t("subscription.publicShow")}</Button>
              <Button type="button" size="icon" variant="ghost" className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9" aria-label={t("subscriptions.bulkVisibilityClear")} onClick={() => onSelectionChange(new Set())} disabled={pending}><X className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          </div>
        </div>
      ) : null}
      <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open && !pending) setTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{target ? t("subscriptions.bulkVisibilityConfirmHideTitle") : t("subscriptions.bulkVisibilityConfirmShowTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("subscriptions.bulkVisibilityConfirmSelected", { count: selectedCount })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={(event) => { event.preventDefault(); void applyVisibility(); }}>{target ? t("subscription.publicHide") : t("subscription.publicShow")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
