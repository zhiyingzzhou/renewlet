/**
 * 统计分析页（/statistics）。
 *
 * 功能：
 * - 月度/年度支出汇总（使用当前月报表汇率口径换算到默认币种）
 * - 预算使用情况（与 Settings 中 monthlyBudget 对齐）
 * - 分类分布 / 支付方式分布图表
 *
 * 架构位置：
 * - 统计聚合由 `useStatisticsModel` 完成。
 * - 页面只负责图表/卡片渲染和汇率刷新入口。
 *
 * 注意： 统计口径依赖订阅 domain 类型、Settings.defaultCurrency 和 USD base 月度快照；
 * 修改其中任一处都要同步首页统计、SpendingChart 和导出逻辑。
 */

import { useCallback, useMemo, useState } from 'react';
import type { Subscription, SubscriptionCollectionItem } from '@/types/subscription';
import { EditSubscriptionDialog } from '@/components/edit-subscription-dialog';
import { DeferredRenewSubscriptionDialog } from '@/components/renew-subscription-dialog-loader';
import { Header } from '@/components/header';
import { StatisticsPageSkeleton } from '@/components/loading-skeleton';
import { useRouteReady } from '@/components/route-progress';
import { QueryErrorState } from '@/components/query-error-state';
import { ExchangeRateErrorFeedback } from '@/components/exchange-rate-error-feedback';
import { ExchangeRateRefreshButton } from '@/components/exchange-rate-refresh-button';
import { SubscriptionDetailDialog } from '@/components/subscription-detail-dialog';
import { DeferredStatisticsCharts } from '@/components/statistics-charts-loader';
import { CircleHelp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCompactCurrencyAmount } from '@/lib/currency';
import { useReportExchangeRates } from '@/hooks/use-report-exchange-rates';
import { moneyToNumber } from "@renewlet/shared/money";
import { toast } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSubscriptionAnalytics, useSubscriptionFacets } from '@/hooks/use-subscriptions';
import { useSettings } from '@/hooks/use-settings';
import { useCustomConfigState } from '@/contexts/CustomConfigContext';
import { useStatisticsModel } from '@/modules/subscriptions/application/use-statistics-model';
import { useSubscriptionCrud } from '@/modules/subscriptions/application/use-subscription-crud';
import { resolveSubscriptionPriceReferenceCurrency } from '@/modules/subscriptions/domain/subscription-price-reference';
import { useI18n } from '@/i18n/I18nProvider';
import { useSubscriptionDetailDialog } from '@/hooks/use-subscription-detail-dialog';
import { todayDateOnlyInTimeZone } from '@/lib/time/date-only';

/** 空订阅数组：用于在数据未加载完成时提供稳定引用，避免 useMemo 依赖抖动。 */
const EMPTY_SUBSCRIPTIONS: SubscriptionCollectionItem[] = [];
interface StatBoxProps {
  /** 统计值（数值或已格式化字符串）。 */
  value: string | number;
  /** 统计标题。 */
  label: string;
  /** 可选：右下角图标。 */
  icon?: React.ReactNode;
  /** 展示风格（影响 value 的颜色）。 */
  variant?: 'default' | 'primary' | 'success' | 'warning';
  /** 可选：统计口径说明，会在标题旁显示可聚焦提示图标。 */
  description?: string;
}

/** 统计卡片（用于顶部概要数据）。 */
const StatBox = ({ value, label, icon, variant = 'default', description }: StatBoxProps) => {
  const { t } = useI18n();
  const valueColor = {
    default: 'text-foreground',
    primary: 'text-foreground',
    success: 'text-emerald-500',
    warning: 'text-amber-500',
  }[variant];

  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-5 flex flex-col items-center justify-center text-center transition-all hover:bg-card-hover hover:shadow-lg">
      <p className={cn("max-w-full wrap-break-word text-2xl sm:text-3xl font-bold", valueColor)}>{value}</p>
      <div className="mt-1 flex max-w-full items-center justify-center gap-1 text-sm text-muted-foreground">
        <span className="min-w-0 wrap-break-word">{label}</span>
        {description ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label={t("statistics.explain", { label })}
              >
                <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-left text-xs leading-relaxed">
              {description}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {icon && <div className="mt-2 text-muted-foreground/50">{icon}</div>}
    </div>
  );
};

/** 统计分析页组件。 */
const Statistics = () => {
  const subscriptionsQuery = useSubscriptionAnalytics();
  const subscriptions = subscriptionsQuery.data ?? EMPTY_SUBSCRIPTIONS;
  const facetsQuery = useSubscriptionFacets();
  const settingsQuery = useSettings();
  const settings = settingsQuery.data;
  const { config } = useCustomConfigState();
  const monthlyBudget = settings?.monthlyBudget ?? "0";
  const monthlyBudgetAmount = moneyToNumber(monthlyBudget);
  const defaultCurrency = settings?.defaultCurrency ?? "CNY";
  const priceReferenceCurrency = settings ? resolveSubscriptionPriceReferenceCurrency(settings) : null;
  const timeZone = settings?.timezone ?? "UTC";
  const { locale, t, formatCurrency, formatDateTime } = useI18n();
  const [personalCostBasis, setPersonalCostBasis] = useState(false);

  const {
    convert,
    loading: ratesLoading,
    isRefreshing: ratesRefreshing,
    refresh: refreshRates,
    lastUpdated,
    error: ratesError,
    errorDetails: ratesErrorDetails,
    sourceDate: ratesSourceDate,
  } = useReportExchangeRates(settings?.exchangeRateProvider);
  const ratesRefreshPending = ratesLoading || ratesRefreshing;
  const currencyRatesReady = Boolean(ratesSourceDate) && !ratesLoading;
  const stats = useStatisticsModel(subscriptions, config, monthlyBudget, defaultCurrency, convert, timeZone, locale, personalCostBasis ? "personal" : "total");
  const {
    editingSubscription,
    editingCollectionItem,
    editDialogOpen,
    renewingSubscription,
    renewingCollectionItem,
    renewDialogOpen,
    editDetailPending,
    renewDetailPending,
    renewError,
    renewSubmitting,
    renewRestoreFocusRef,
    handleAddSubscription,
    handleEditSubscription,
    handleRenewSubscription,
    handleSubmitRenewSubscription,
    handleSaveSubscription,
    handleEditDialogOpenChange,
    handleRenewDialogOpenChange,
  } = useSubscriptionCrud(subscriptions);
  const availableTags = facetsQuery.data?.tags ?? [];
  const today = useMemo(() => todayDateOnlyInTimeZone(new Date(), timeZone), [timeZone]);
  const {
    detailDialogOpen,
    selectedDetailSubscription,
    selectedDetailCollectionItem,
    detailPending,
    handleViewDetails: handleViewTrendSubscriptionDetails,
    handleDetailDialogOpenChange,
  } = useSubscriptionDetailDialog(subscriptions);
  const handleEditFromDetail = useCallback((subscription: Subscription) => {
    handleEditSubscription(subscription.id);
  }, [handleEditSubscription]);
  const handleRefreshRates = useCallback(async () => {
    const result = await refreshRates();
    if (result.status === "succeeded") {
      toast.success(t("exchangeRates.updated"));
    }
  }, [refreshRates, t]);

  useRouteReady(subscriptionsQuery.isPending || settingsQuery.isPending);
  // 汇率 hook 有内置 fallback；远端刷新中继续渲染统计内容，避免切页后因为第三方汇率慢而整页回退骨架。
  if (subscriptionsQuery.isPending || settingsQuery.isPending) {
    return (
      <div className="app-page bg-background">
        <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />
        <main className="app-main mx-auto max-w-7xl">
          <StatisticsPageSkeleton withPageShell={false} />
        </main>
      </div>
    );
  }

  if (subscriptionsQuery.error) {
    return (
      <div className="app-page bg-background">
        <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />
        <main className="app-main mx-auto max-w-7xl">
          <QueryErrorState error={subscriptionsQuery.error} onRetry={subscriptionsQuery.refetch} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-page bg-background">
      <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />

      <main className="app-main mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{t("statistics.title")}</h1>
            {lastUpdated && !ratesLoading ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("statistics.ratesUpdatedAt", { date: formatDateTime(lastUpdated, { year: "numeric", month: "2-digit", day: "2-digit" }) })}
              </p>
            ) : null}
          </div>
          <ExchangeRateRefreshButton
            label={t("statistics.refreshRates")}
            pending={ratesRefreshPending}
            onRefresh={handleRefreshRates}
            className="w-full sm:w-auto"
          />
        </div>

        {ratesError ? (
          <ExchangeRateErrorFeedback error={ratesError} details={ratesErrorDetails} />
        ) : null}

        {/* 总体统计 */}
        <section className="mb-8">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-foreground">{t("statistics.overview")}</h2>
            <label className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={personalCostBasis} onCheckedChange={setPersonalCostBasis} aria-label={t("statistics.personalCostBasis")} />
              {t("statistics.personalCostBasis")}
            </label>
          </div>
          <div className="grid grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <StatBox
              value={stats.activeCount}
              label={t("statistics.activeSubscriptions")}
              variant="primary"
            />
            <StatBox
              value={formatCurrency(stats.totalMonthly, defaultCurrency)}
              label={t("statistics.monthlyCost", { currency: defaultCurrency })}
              variant="primary"
            />
            <StatBox
              value={formatCompactCurrencyAmount(stats.totalDaily, defaultCurrency, locale)}
              label={t("statistics.dailyCost", { currency: defaultCurrency })}
              variant="primary"
            />
            <StatBox
              value={formatCurrency(stats.totalAnnual, defaultCurrency)}
              label={t("statistics.annualCost", { currency: defaultCurrency })}
              variant="primary"
            />
            <StatBox
              value={formatCurrency(stats.avgMonthlyPerSub, defaultCurrency)}
              label={t("statistics.avgMonthly")}
            />
            <StatBox
              value={stats.mostExpensive ? formatCurrency(convert(stats.mostExpensive.price, stats.mostExpensive.currency, defaultCurrency), defaultCurrency) : '-'}
              label={stats.mostExpensive ? t("statistics.mostExpensiveNamed", { name: stats.mostExpensive.name }) : t("statistics.mostExpensive")}
            />
            <StatBox
              value={formatCurrency(stats.thisMonthDue, defaultCurrency)}
              label={t("statistics.thisMonthDue")}
              variant="warning"
            />
            <StatBox
              value={`${stats.budgetUsedPercent.toFixed(1)}%`}
              label={t("statistics.budgetPercent")}
              variant={stats.budgetUsedPercent > 80 ? 'warning' : 'primary'}
            />
            <StatBox
              value={formatCurrency(stats.budgetRemaining, defaultCurrency)}
              label={t("statistics.budgetRemaining")}
              variant={stats.budgetRemaining < 0 ? 'warning' : 'success'}
            />
            <StatBox
              value={stats.inactiveCount}
              label={t("statistics.inactiveSubscriptions")}
            />
            <StatBox
              value={formatCurrency(stats.monthlySavings, defaultCurrency)}
              label={t("statistics.monthlySavings")}
              variant="success"
              description={t("statistics.monthlySavingsDescription")}
            />
            <StatBox
              value={formatCurrency(stats.annualSavings, defaultCurrency)}
              label={t("statistics.annualSavings")}
              variant="success"
              description={t("statistics.annualSavingsDescription")}
            />
          </div>
        </section>

        <DeferredStatisticsCharts
          trendData={stats.trendData}
          categoryData={stats.categoryData}
          paymentData={stats.paymentData}
          budgetChartData={stats.budgetChartData}
          defaultCurrency={defaultCurrency}
          monthlyBudget={monthlyBudget}
          monthlyBudgetAmount={monthlyBudgetAmount}
          totalMonthly={stats.totalMonthly}
          budgetRemaining={stats.budgetRemaining}
          onViewSubscriptionDetails={handleViewTrendSubscriptionDetails}
        />
      </main>

      <EditSubscriptionDialog
        subscription={editingSubscription}
        loadingPreview={editingCollectionItem}
        open={editDialogOpen}
        onOpenChange={handleEditDialogOpenChange}
        onSave={handleSaveSubscription}
        availableTags={availableTags}
        loading={editDetailPending}
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
    </div>
  );
};

export default Statistics;
