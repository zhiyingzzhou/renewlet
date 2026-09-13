/**
 * 订阅列表页（/subscriptions）。
 *
 * 功能：
 * - 列表/网格两种视图
 * - 搜索/分类/状态/标签筛选
 * - 新增/编辑/删除订阅
 * - 导出 JSON / CSV
 *
 * 架构位置：
 * - 筛选、导出、CRUD 状态分别由 application hooks 管理。
 * - 页面保留视图模式和布局，不承载业务规则。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { BackToTopFloatButton } from '@/components/back-to-top-float-button';
import { SubscriptionGrid } from '@/components/subscription-grid';
import { SubscriptionDetailDialog } from '@/components/subscription-detail-dialog';
import { AddToCalendarDialog } from '@/components/add-to-calendar-dialog';
import { subscriptionFilterLayout } from '@/components/subscription-filter-layout';
import { AddSubscriptionDialog } from '@/components/add-subscription-dialog';
import { EditSubscriptionDialog } from '@/components/edit-subscription-dialog';
import { DeferredRenewSubscriptionDialog } from '@/components/renew-subscription-dialog-loader';
import { SubscriptionDialog } from '@/components/subscription-dialog';
import {
  DeferredImportDataDialog,
  preloadImportDataDialog,
} from '@/components/import-data-dialog-loader';
import {
  DeferredAIRecognizeSubscriptionDialog,
  preloadAIRecognizeSubscriptionDialog,
} from '@/components/ai-recognize-subscription-dialog-loader';
import { SubscriptionsPageSkeleton } from '@/components/loading-skeleton';
import { useRouteReady } from '@/components/route-progress';
import { SubscriptionCategoryFilter } from '@/components/subscription-category-filter';
import { SubscriptionFilterFeedback } from '@/components/subscription-filter-feedback';
import { QueryErrorState } from '@/components/query-error-state';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Subscription, SubscriptionCollectionItem, SubscriptionStatus } from '@/types/subscription';
import { BILLING_CYCLES, CYCLE_LABELS, DEFAULT_NOTIFICATION_REMINDER_DAYS, DEFAULT_SETTINGS } from '@/types/subscription';
import { Search, Plus, Grid, List as ListIcon, Download, Upload, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useInfiniteSubscriptions,
  useSubscriptionFacets,
  useSubscriptionIndex,
} from '@/hooks/use-subscriptions';
import { useCustomConfigState } from '@/contexts/CustomConfigContext';
import { useSettingsEnvelope } from '@/hooks/use-settings';
import { useSubscriptionCrud } from '@/modules/subscriptions/application/use-subscription-crud';
import { useSubscriptionExport } from '@/modules/subscriptions/application/use-subscription-export';
import { useSubscriptionFilters } from '@/modules/subscriptions/application/use-subscription-filters';
import { SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE, type SubscriptionPaymentTypeFilter, type SubscriptionSortOption } from '@/modules/subscriptions/domain/subscription-filters';
import { resolveSubscriptionPriceReferenceCurrency } from '@/modules/subscriptions/domain/subscription-price-reference';
import { useExchangeRates } from '@/hooks/use-exchange-rates';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useSubscriptionDetailDialog } from '@/hooks/use-subscription-detail-dialog';
import { useSubscriptionCalendarDialog } from '@/hooks/use-subscription-calendar-dialog';
import { useManagedCurrencyOptions } from '@/hooks/use-managed-currency-options';
import { useZonedToday } from '@/hooks/use-zoned-today';
import { syncSubscriptionCollectionBoundary } from '@/hooks/subscription-query-cache';
import {
  SubscriptionTagFilterDrawer,
  SubscriptionTagFilterPopover,
} from '@/components/subscription-tag-filter-drawer';
import {
  SubscriptionAdvancedFilter,
} from '@/components/subscription-advanced-filter';

/** 空订阅数组：用于在数据未加载完成时提供稳定引用，避免 useMemo 依赖抖动。 */
const EMPTY_SUBSCRIPTIONS: SubscriptionCollectionItem[] = [];
const SORT_OPTION_LABEL_KEYS: Record<SubscriptionSortOption, MessageKey> = {
  default: "subscriptions.sort.default",
  renewal_asc: "subscriptions.sort.renewalAsc",
  renewal_desc: "subscriptions.sort.renewalDesc",
  monthly_cost_desc: "subscriptions.sort.monthlyCostDesc",
  monthly_cost_asc: "subscriptions.sort.monthlyCostAsc",
  price_desc: "subscriptions.sort.priceDesc",
  price_asc: "subscriptions.sort.priceAsc",
  name_asc: "subscriptions.sort.nameAsc",
  name_desc: "subscriptions.sort.nameDesc",
};

const PAYMENT_TYPE_FILTER_LABEL_KEYS: Record<SubscriptionPaymentTypeFilter, MessageKey> = {
  all: "subscriptions.paymentTypeFilter.all",
  auto: "subscriptions.paymentTypeFilter.auto",
  manual: "subscriptions.paymentTypeFilter.manual",
  "one-time-buyout": "subscriptions.paymentTypeFilter.buyout",
  "one-time-fixed-term": "subscriptions.paymentTypeFilter.fixedTerm",
};

/** 订阅列表页组件。 */
const Subscriptions = () => {
  const settingsQuery = useSettingsEnvelope();
  const timeZone = settingsQuery.data?.settings.timezone ?? "UTC";
  const today = useZonedToday(timeZone);
  const queryClient = useQueryClient();
  const collectionBoundary = settingsQuery.data ? `${timeZone}:${today}` : null;
  useEffect(() => {
    if (collectionBoundary) void syncSubscriptionCollectionBoundary(queryClient, collectionBoundary);
  }, [collectionBoundary, queryClient]);

  const subscriptionsQuery = useInfiniteSubscriptions();
  const subscriptions = subscriptionsQuery.subscriptions ?? EMPTY_SUBSCRIPTIONS;
  const facetsQuery = useSubscriptionFacets();
  const { fetchNextPage } = subscriptionsQuery;
  const defaultCurrency = settingsQuery.data?.settings.defaultCurrency ?? "CNY";
  const exchangeRateProvider = settingsQuery.data?.settings.exchangeRateProvider;
  const inheritedReminderDays = settingsQuery.data?.settings.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const { config } = useCustomConfigState();
  const categoryByValue = useMemo(() => new Map(config.categories.map((category) => [category.value, category])), [config.categories]);
  const paymentMethodByValue = useMemo(() => new Map(config.paymentMethods.map((method) => [method.value, method])), [config.paymentMethods]);
  const { t, label, locale } = useI18n();
  const billingCycleOptions = useMemo(
    () => BILLING_CYCLES.map((value) => ({ value, label: label(CYCLE_LABELS[value]) })),
    [label],
  );
  const paymentMethodFilterOptions = useMemo(
    () => [
      { value: SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE, label: t("subscriptions.advanced.paymentMethodNone") },
      ...config.paymentMethods.map((method) => ({ value: method.value, label: label(method.labels) })),
    ],
    [config.paymentMethods, label, t],
  );
  const currencyFilterOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    locale,
  });
  const { convert, loading: ratesLoading, sourceDate: ratesSourceDate } = useExchangeRates(exchangeRateProvider);
  const currencyRatesReady = Boolean(ratesSourceDate) && !ratesLoading;
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [aiRecognitionDialogOpen, setAIRecognitionDialogOpen] = useState(false);
  const isMobileTagFilter = useMediaQuery("(max-width: 767px)");
  const {
    searchQuery,
    setSearchQuery,
    selectedCategories,
    setSelectedCategories,
    statusFilter,
    setStatusFilter,
    paymentTypeFilter,
    setPaymentTypeFilter,
    sortOption,
    setSortOption,
    selectedTags,
    setSelectedTags,
    advancedFilters,
    setAdvancedFilters,
    allTags,
    sortSubscriptionsForDisplay,
    selectSubscriptionsForExport,
    subscriptionListFilters,
    hasActiveFilters,
    needsCollectionIndex,
    toggleCategory,
    clearSelectedCategories,
    toggleTag,
    clearFilters,
  } = useSubscriptionFilters({
    defaultCurrency,
    convert,
    locale,
    today,
    availableTags: facetsQuery.data?.tags ?? [],
  });
  const indexQuery = useSubscriptionIndex(subscriptionListFilters, needsCollectionIndex);
  const indexedSubscriptions = indexQuery.data?.subscriptions ?? EMPTY_SUBSCRIPTIONS;
  const displaySourceSubscriptions = needsCollectionIndex ? indexedSubscriptions : subscriptions;
  // 先选择分页或全库索引，再只排序实际展示的数据；索引模式不能附带重排未展示的分页列表。
  const filteredSubscriptions = useMemo(
    () => sortSubscriptionsForDisplay(displaySourceSubscriptions),
    [displaySourceSubscriptions, sortSubscriptionsForDisplay],
  );
  const isDisplayPending = needsCollectionIndex && indexQuery.isPending;
  useRouteReady(subscriptionsQuery.isPending || isDisplayPending);
  const displayError = needsCollectionIndex ? indexQuery.error : subscriptionsQuery.error;
  const retryDisplayQuery = needsCollectionIndex ? indexQuery.refetch : subscriptionsQuery.refetch;
  const displayedTotal = needsCollectionIndex ? (indexQuery.data?.total ?? 0) : subscriptionsQuery.total;
  const unfilteredTotal = hasActiveFilters ? facetsQuery.data?.total : undefined;
  const {
    editingSubscription,
    editingCollectionItem,
    editDialogOpen,
    cloningSubscription,
    cloningCollectionItem,
    cloneDialogOpen,
    renewingSubscription,
    renewingCollectionItem,
    renewDialogOpen,
    editDetailPending,
    cloneDetailPending,
    renewDetailPending,
    renewError,
    renewSubmitting,
    renewRestoreFocusRef,
    handlePrefetchSubscription,
    handleAddSubscription,
    handleDeleteSubscription,
    handleCloneSubscription,
    handleEditSubscription,
    handleTogglePinnedSubscription,
    handleTogglePublicHiddenSubscription,
    handleRenewSubscription,
    handleSubmitRenewSubscription,
    handleSaveSubscription,
    handleSaveClonedSubscription,
    handleEditDialogOpenChange,
    handleCloneDialogOpenChange,
    handleRenewDialogOpenChange,
  } = useSubscriptionCrud(displaySourceSubscriptions);
  const settings = settingsQuery.data?.settings ?? DEFAULT_SETTINGS;
  const priceReferenceCurrency = resolveSubscriptionPriceReferenceCurrency(settings);
  const { exportToJSON, exportToJSONWithSecrets, exportToCSV, exporting } =
    useSubscriptionExport(config, settings, locale, selectSubscriptionsForExport, today, convert);
  const {
    detailDialogOpen,
    selectedDetailSubscription,
    selectedDetailCollectionItem,
    detailPending,
    handleViewDetails,
    handleDetailDialogOpenChange,
  } = useSubscriptionDetailDialog(displaySourceSubscriptions);
  const calendarDialog = useSubscriptionCalendarDialog(displaySourceSubscriptions);
  const selectedStatus = config.statuses.find((status) => status.value === statusFilter);
  const statusFilterLabel = statusFilter === "all"
    ? t("subscriptions.allStatuses")
    : selectedStatus
      ? label(selectedStatus.labels)
      : statusFilter;
  const paymentTypeFilterLabel = t(PAYMENT_TYPE_FILTER_LABEL_KEYS[paymentTypeFilter]);
  const sortOptionLabel = t(SORT_OPTION_LABEL_KEYS[sortOption]);
  const removeSelectedTag = useCallback((tag: string) => {
    setSelectedTags((current) => current.filter((item) => item !== tag));
  }, [setSelectedTags]);
  const clearSelectedTags = useCallback(() => {
    setSelectedTags([]);
  }, [setSelectedTags]);
  const handleLoadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const handleEditFromDetail = useCallback((subscription: Subscription) => {
    handleEditSubscription(subscription.id);
  }, [handleEditSubscription]);
  const aiRecognitionAction = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={() => setAIRecognitionDialogOpen(true)}
          onFocus={preloadAIRecognizeSubscriptionDialog}
          onPointerEnter={preloadAIRecognizeSubscriptionDialog}
          onTouchStart={preloadAIRecognizeSubscriptionDialog}
          className="h-12 w-12 shrink-0 text-primary sm:h-10 sm:w-10"
          aria-label={t("subscriptions.aiRecognizeAdd")}
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="text-xs">
        {t("subscriptions.aiRecognizeAdd")}
      </TooltipContent>
    </Tooltip>
  );

  // 首次加载订阅列表时展示骨架屏（筛选条 + 卡片网格占位）。
  if (subscriptionsQuery.isPending) {
    return (
      <div className="app-page bg-background">
        <Header onAddSubscription={handleAddSubscription} availableTags={allTags} subscriptionActions={aiRecognitionAction} />
        <main className="app-main mx-auto max-w-7xl">
          <SubscriptionsPageSkeleton withPageShell={false} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-page bg-background">
      <Header onAddSubscription={handleAddSubscription} availableTags={allTags} subscriptionActions={aiRecognitionAction} />

      <main className="app-main mx-auto max-w-7xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("subscriptions.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("subscriptions.count", { count: displayedTotal })}
              {unfilteredTotal !== undefined && ` ${t("subscriptions.filteredCount", { count: unfilteredTotal })}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="border-border"
                  aria-label={t("subscriptions.exportMenu")}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={exportToJSON} disabled={exporting}>
                  {t("subscriptions.exportJson")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={exportToJSONWithSecrets} disabled={exporting}>
                  {t("subscriptions.exportJsonWithSecrets")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={exportToCSV} disabled={exporting}>
                  {t("subscriptions.exportCsv")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportDialogOpen(true)}
              onFocus={preloadImportDataDialog}
              onPointerEnter={preloadImportDataDialog}
              onTouchStart={preloadImportDataDialog}
              className="gap-2 border-border"
              aria-label={t("subscriptions.importData")}
            >
              <Upload className="h-4 w-4" />
              <span className="hidden sm:inline">{t("subscriptions.importData")}</span>
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
              className="border-border"
            >
              {viewMode === 'grid' ? <ListIcon className="h-4 w-4" /> : <Grid className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className={cn("mb-6 rounded-xl border border-border bg-card p-5", isMobileTagFilter ? "grid gap-3" : "grid gap-4")}>
          {isMobileTagFilter ? (
            <>
              <div className="relative w-full">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="subscription-search"
                  type="search"
                  enterKeyHint="search"
                  placeholder={t("subscriptions.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-11 border-border bg-secondary pl-10"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <SubscriptionCategoryFilter
                  categories={config.categories}
                  selectedCategories={selectedCategories}
                  onToggleCategory={toggleCategory}
                  onClearCategories={clearSelectedCategories}
                  onApply={setSelectedCategories}
                  mode="drawer"
                />

                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as SubscriptionStatus | 'all')}>
                  <SelectTrigger className="h-11 min-w-0 border-border bg-secondary" tooltipContent={statusFilterLabel}>
                    <SelectValue placeholder={t("subscription.field.status")} />
                  </SelectTrigger>
                  <SelectContent mobileTitle={t("subscription.field.status")}>
                    <SelectItem value="all">{t("subscriptions.allStatuses")}</SelectItem>
                    {config.statuses.map((status) => (
                      <SelectItem key={status.id} value={status.value}>
                        {label(status.labels)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3" data-testid="mobile-payment-type-sort-row">
                <Select value={paymentTypeFilter} onValueChange={(v) => setPaymentTypeFilter(v as SubscriptionPaymentTypeFilter)}>
                  <SelectTrigger className="h-11 min-w-0 border-border bg-secondary" tooltipContent={paymentTypeFilterLabel}>
                    <SelectValue placeholder={t("subscriptions.paymentTypeFilter.label")} />
                  </SelectTrigger>
                  <SelectContent mobileTitle={t("subscriptions.paymentTypeFilter.label")}>
                    <SelectItem value="all">{t("subscriptions.paymentTypeFilter.all")}</SelectItem>
                    <SelectItem value="auto">{t("subscriptions.paymentTypeFilter.auto")}</SelectItem>
                    <SelectItem value="manual">{t("subscriptions.paymentTypeFilter.manual")}</SelectItem>
                    <SelectItem value="one-time-buyout">{t("subscriptions.paymentTypeFilter.buyout")}</SelectItem>
                    <SelectItem value="one-time-fixed-term">{t("subscriptions.paymentTypeFilter.fixedTerm")}</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={sortOption} onValueChange={(v) => setSortOption(v as SubscriptionSortOption)}>
                  <SelectTrigger
                    aria-label={t("subscriptions.sort.label")}
                    className="h-11 border-border bg-secondary"
                    tooltipContent={sortOptionLabel}
                  >
                    <SelectValue placeholder={t("subscriptions.sort.label")} />
                  </SelectTrigger>
                  <SelectContent mobileTitle={t("subscriptions.sort.label")}>
                    <SelectItem value="default">{t("subscriptions.sort.default")}</SelectItem>
                    <SelectItem value="renewal_asc">{t("subscriptions.sort.renewalAsc")}</SelectItem>
                    <SelectItem value="renewal_desc">{t("subscriptions.sort.renewalDesc")}</SelectItem>
                    <SelectItem value="monthly_cost_desc">{t("subscriptions.sort.monthlyCostDesc")}</SelectItem>
                    <SelectItem value="monthly_cost_asc">{t("subscriptions.sort.monthlyCostAsc")}</SelectItem>
                    <SelectItem value="price_desc">{t("subscriptions.sort.priceDesc")}</SelectItem>
                    <SelectItem value="price_asc">{t("subscriptions.sort.priceAsc")}</SelectItem>
                    <SelectItem value="name_asc">{t("subscriptions.sort.nameAsc")}</SelectItem>
                    <SelectItem value="name_desc">{t("subscriptions.sort.nameDesc")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex min-w-0 items-center gap-3" data-testid="mobile-advanced-tag-row">
                <SubscriptionAdvancedFilter
                  filters={advancedFilters}
                  onChange={setAdvancedFilters}
                  billingCycleOptions={billingCycleOptions}
                  paymentMethodOptions={paymentMethodFilterOptions}
                  currencyOptions={currencyFilterOptions}
                  mode="mobileWorkspace"
                  className="flex-1"
                />

                {allTags.length > 0 && (
                  <SubscriptionTagFilterDrawer
                    tags={allTags}
                    selectedTags={selectedTags}
                    onApply={setSelectedTags}
                  />
                )}
              </div>

              <SubscriptionFilterFeedback
                selectedTags={selectedTags}
                onRemoveTag={removeSelectedTag}
                filters={advancedFilters}
                onChangeAdvancedFilters={setAdvancedFilters}
                billingCycleOptions={billingCycleOptions}
                paymentMethodOptions={paymentMethodFilterOptions}
                currencyOptions={currencyFilterOptions}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={clearFilters}
                tagTestId="mobile-selected-tags"
                advancedTestId="mobile-selected-advanced-filters"
                testId="mobile-filter-feedback"
              />
            </>
          ) : (
            <>
              <div className={subscriptionFilterLayout.desktopRow} data-testid="desktop-filter-toolbar">
                <div className={subscriptionFilterLayout.desktopSearch}>
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    name="subscription-search"
                    type="search"
                    enterKeyHint="search"
                    placeholder={t("subscriptions.searchPlaceholder")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="border-border bg-secondary pl-10"
                  />
                </div>

                <SubscriptionCategoryFilter
                  categories={config.categories}
                  selectedCategories={selectedCategories}
                  onToggleCategory={toggleCategory}
                  onClearCategories={clearSelectedCategories}
                  onApply={setSelectedCategories}
                  mode="popover"
                />

                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as SubscriptionStatus | 'all')}>
                  <SelectTrigger className={subscriptionFilterLayout.desktopStatusTrigger} tooltipContent={statusFilterLabel}>
                    <SelectValue placeholder={t("subscription.field.status")} />
                  </SelectTrigger>
                  <SelectContent mobileTitle={t("subscription.field.status")}>
                    <SelectItem value="all">{t("subscriptions.allStatuses")}</SelectItem>
                    {config.statuses.map((status) => (
                      <SelectItem key={status.id} value={status.value}>
                        {label(status.labels)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={paymentTypeFilter} onValueChange={(v) => setPaymentTypeFilter(v as SubscriptionPaymentTypeFilter)}>
                  <SelectTrigger className={subscriptionFilterLayout.desktopPaymentTypeTrigger} tooltipContent={paymentTypeFilterLabel}>
                    <SelectValue placeholder={t("subscriptions.paymentTypeFilter.label")} />
                  </SelectTrigger>
                  <SelectContent mobileTitle={t("subscriptions.paymentTypeFilter.label")}>
                    <SelectItem value="all">{t("subscriptions.paymentTypeFilter.all")}</SelectItem>
                    <SelectItem value="auto">{t("subscriptions.paymentTypeFilter.auto")}</SelectItem>
                    <SelectItem value="manual">{t("subscriptions.paymentTypeFilter.manual")}</SelectItem>
                    <SelectItem value="one-time-buyout">{t("subscriptions.paymentTypeFilter.buyout")}</SelectItem>
                    <SelectItem value="one-time-fixed-term">{t("subscriptions.paymentTypeFilter.fixedTerm")}</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={sortOption} onValueChange={(v) => setSortOption(v as SubscriptionSortOption)}>
                  <SelectTrigger
                    aria-label={t("subscriptions.sort.label")}
                    className={subscriptionFilterLayout.desktopSortTrigger}
                    tooltipContent={sortOptionLabel}
                  >
                    <SelectValue placeholder={t("subscriptions.sort.label")} />
                  </SelectTrigger>
                  <SelectContent mobileTitle={t("subscriptions.sort.label")}>
                    <SelectItem value="default">{t("subscriptions.sort.default")}</SelectItem>
                    <SelectItem value="renewal_asc">{t("subscriptions.sort.renewalAsc")}</SelectItem>
                    <SelectItem value="renewal_desc">{t("subscriptions.sort.renewalDesc")}</SelectItem>
                    <SelectItem value="monthly_cost_desc">{t("subscriptions.sort.monthlyCostDesc")}</SelectItem>
                    <SelectItem value="monthly_cost_asc">{t("subscriptions.sort.monthlyCostAsc")}</SelectItem>
                    <SelectItem value="price_desc">{t("subscriptions.sort.priceDesc")}</SelectItem>
                    <SelectItem value="price_asc">{t("subscriptions.sort.priceAsc")}</SelectItem>
                    <SelectItem value="name_asc">{t("subscriptions.sort.nameAsc")}</SelectItem>
                    <SelectItem value="name_desc">{t("subscriptions.sort.nameDesc")}</SelectItem>
                  </SelectContent>
                </Select>

                <SubscriptionAdvancedFilter
                  filters={advancedFilters}
                  onChange={setAdvancedFilters}
                  billingCycleOptions={billingCycleOptions}
                  paymentMethodOptions={paymentMethodFilterOptions}
                  currencyOptions={currencyFilterOptions}
                  mode="desktopSidePanel"
                />

                {allTags.length > 0 && (
                  <SubscriptionTagFilterPopover
                    tags={allTags}
                    selectedTags={selectedTags}
                    onToggleTag={toggleTag}
                    onClearTags={clearSelectedTags}
                  />
                )}
              </div>

              <SubscriptionFilterFeedback
                selectedTags={selectedTags}
                onRemoveTag={removeSelectedTag}
                filters={advancedFilters}
                onChangeAdvancedFilters={setAdvancedFilters}
                billingCycleOptions={billingCycleOptions}
                paymentMethodOptions={paymentMethodFilterOptions}
                currencyOptions={currencyFilterOptions}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={clearFilters}
                tagTestId="desktop-selected-tags"
                advancedTestId="desktop-selected-advanced-filters"
                testId="desktop-filter-feedback"
              />
            </>
          )}
        </div>

        {displayError ? (
          <QueryErrorState error={displayError} onRetry={retryDisplayQuery} />
        ) : isDisplayPending ? (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-card/50 py-16 text-sm text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : filteredSubscriptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 py-16">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <Search className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-lg font-medium text-foreground">
              {hasActiveFilters ? t("subscriptions.emptyFilteredTitle") : t("subscriptions.emptyNoDataTitle")}
            </h3>
            <p className="mb-6 text-sm text-muted-foreground">
              {hasActiveFilters ? t("subscriptions.emptyFiltered") : t("subscriptions.emptyNoData")}
            </p>
            {hasActiveFilters ? (
              <Button type="button" variant="outline" className="gap-2 border-border" onClick={clearFilters}>
                {t("subscriptions.clearFilters")}
              </Button>
            ) : (
              <AddSubscriptionDialog 
                onAdd={handleAddSubscription}
                availableTags={allTags}
                trigger={
                  <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary-glow">
                    <Plus className="h-4 w-4" />
                    {t("subscriptions.addFirst")}
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <>
            <SubscriptionGrid
              subscriptions={filteredSubscriptions}
              viewMode={viewMode}
              today={today}
              inheritedReminderDays={inheritedReminderDays}
              currencyConvert={convert}
              currencyRatesReady={currencyRatesReady}
              priceReferenceCurrency={priceReferenceCurrency}
              categoryByValue={categoryByValue}
              paymentMethodByValue={paymentMethodByValue}
              onEdit={handleEditSubscription}
              onDelete={handleDeleteSubscription}
              onClone={handleCloneSubscription}
              onTogglePinned={handleTogglePinnedSubscription}
              onTogglePublicHidden={handleTogglePublicHiddenSubscription}
              onRenew={handleRenewSubscription}
              onViewDetails={handleViewDetails}
              onAddToCalendar={calendarDialog.show}
              onPrefetchDetails={handlePrefetchSubscription}
            />
            {!needsCollectionIndex && subscriptionsQuery.hasNextPage && (
              <div className="mt-6 flex justify-center [overflow-anchor:none]" data-testid="subscriptions-load-more-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={subscriptionsQuery.isFetchingNextPage}
                  className="min-w-32 border-border"
                >
                  {subscriptionsQuery.isFetchingNextPage ? t("common.loading") : t("notification.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      <BackToTopFloatButton />

      <EditSubscriptionDialog
        subscription={editingSubscription}
        loadingPreview={editingCollectionItem}
        open={editDialogOpen}
        onOpenChange={handleEditDialogOpenChange}
        onSave={handleSaveSubscription}
        availableTags={allTags}
        loading={editDetailPending}
      />
      <SubscriptionDialog
        mode="create"
        open={cloneDialogOpen}
        onOpenChange={handleCloneDialogOpenChange}
        onSubmit={handleSaveClonedSubscription}
        initialSubscription={cloningSubscription}
        loadingPreview={cloningCollectionItem}
        availableTags={allTags}
        loading={cloneDetailPending}
      />
      <DeferredRenewSubscriptionDialog
        subscription={renewingSubscription}
        loadingPreview={renewingCollectionItem}
        open={renewDialogOpen}
        today={today}
        submitting={renewSubmitting}
        error={renewError instanceof Error ? renewError.message : null}
        restoreFocusRef={renewRestoreFocusRef}
        onOpenChange={handleRenewDialogOpenChange}
        onSubmit={handleSubmitRenewSubscription}
        loading={renewDetailPending}
      />
      <SubscriptionDetailDialog
        open={detailDialogOpen}
        onOpenChange={handleDetailDialogOpenChange}
        subscription={selectedDetailSubscription}
        loadingPreview={selectedDetailCollectionItem}
        onEditSubscription={handleEditFromDetail}
        onRenewSubscription={handleRenewSubscription}
        today={today}
        currencyConvert={convert}
        currencyRatesReady={currencyRatesReady}
        priceReferenceCurrency={priceReferenceCurrency}
        loading={detailPending}
      />
      <AddToCalendarDialog
        open={calendarDialog.open}
        onOpenChange={calendarDialog.onOpenChange}
        subscription={calendarDialog.subscription}
        loadingPreview={calendarDialog.collectionItem}
        loading={calendarDialog.pending}
      />
      <DeferredImportDataDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        settings={settings}
        config={config}
      />
      <DeferredAIRecognizeSubscriptionDialog
        open={aiRecognitionDialogOpen}
        onOpenChange={setAIRecognitionDialogOpen}
        settings={settings}
        apiKeyConfigured={settingsQuery.data?.secretStatus["aiRecognition.apiKey"].configured ?? false}
        config={config}
        availableTags={allTags}
      />
    </div>
  );
};

export default Subscriptions;
