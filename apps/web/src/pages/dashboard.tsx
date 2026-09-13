/**
 * 仪表盘首页（/）。
 *
 * 展示内容：
 * - 汇总统计：月度支出/活跃订阅/即将续费/试用中
 * - 近期订阅卡片
 * - 支出分布图（按分类/币种换算）
 * - 即将续费列表
 *
 * 架构位置：
 * - 页面只做数据 hook 装配和布局。
 * - 首页统计由 `useDashboardStats` 生成，CRUD 弹窗状态由 `useSubscriptionCrud` 管理。
 */

import { useCallback, useMemo } from "react";
import Link from '@/components/router-link';
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { Header } from "@/components/header";
import { dashboardStatLayout } from "@/components/dashboard-stat-layout";
import { StatCard } from "@/components/ui/stat-card";
import { SubscriptionCard } from "@/components/subscription-card";
import { SubscriptionDetailDialog } from "@/components/subscription-detail-dialog";
import { AddToCalendarDialog } from "@/components/add-to-calendar-dialog";
import { DeferredSpendingChart } from "@/components/spending-chart-loader";
import { UpcomingRenewals } from "@/components/upcoming-renewals";
import { DashboardPageSkeleton } from "@/components/loading-skeleton";
import { QueryErrorState } from "@/components/query-error-state";
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog";
import { AddSubscriptionDialog } from "@/components/add-subscription-dialog";
import { CreditCard, TrendingUp, Clock, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReportExchangeRates } from "@/hooks/use-report-exchange-rates";
import { useSubscriptionAnalytics, useSubscriptionFacets } from "@/hooks/use-subscriptions";
import { useSettings } from "@/hooks/use-settings";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useDashboardStats } from "@/modules/subscriptions/application/use-dashboard-stats";
import { useSubscriptionCrud } from "@/modules/subscriptions/application/use-subscription-crud";
import { resolveSubscriptionPriceReferenceCurrency } from "@/modules/subscriptions/domain/subscription-price-reference";
import { useI18n } from "@/i18n/I18nProvider";
import { DEFAULT_NOTIFICATION_REMINDER_DAYS } from "@/types/subscription";
import { useSubscriptionDetailDialog } from "@/hooks/use-subscription-detail-dialog";
import { useSubscriptionCalendarDialog } from "@/hooks/use-subscription-calendar-dialog";
import { useZonedToday } from "@/hooks/use-zoned-today";
import { formatCompactCurrencyAmount } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { useRouteReady } from "@/components/route-progress";

const EMPTY_SUBSCRIPTIONS: SubscriptionCollectionItem[] = [];

/** 仪表盘页面组件。 */
export default function Index() {
  const subscriptionsQuery = useSubscriptionAnalytics();
  const subscriptions = subscriptionsQuery.data ?? EMPTY_SUBSCRIPTIONS;
  const facetsQuery = useSubscriptionFacets();
  const settingsQuery = useSettings();
  useRouteReady(subscriptionsQuery.isPending || settingsQuery.isPending);
  const settings = settingsQuery.data;
  const { config } = useCustomConfigState();
  const { t, locale, formatCurrency } = useI18n();
  const exchangeRateProvider = settings?.exchangeRateProvider;
  const { convert, loading: ratesLoading, sourceDate: ratesSourceDate } = useReportExchangeRates(exchangeRateProvider);
  const currencyRatesReady = Boolean(ratesSourceDate) && !ratesLoading;
  const defaultCurrency = settings?.defaultCurrency ?? "CNY";
  const priceReferenceCurrency = settings ? resolveSubscriptionPriceReferenceCurrency(settings) : null;
  const timeZone = settings?.timezone ?? "UTC";
  const inheritedReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const categoryByValue = useMemo(() => new Map(config.categories.map((category) => [category.value, category])), [config.categories]);
  const paymentMethodByValue = useMemo(() => new Map(config.paymentMethods.map((method) => [method.value, method])), [config.paymentMethods]);
  const availableTags = facetsQuery.data?.tags ?? [];
  // 页面级 today 是 Dashboard 全部日期派生的单一时钟，账号午夜到达时卡片、统计和提醒一起刷新。
  const today = useZonedToday(timeZone);
  const {
    detailDialogOpen,
    selectedDetailSubscription,
    selectedDetailCollectionItem,
    detailPending,
    handleViewDetails,
    handleDetailDialogOpenChange,
  } = useSubscriptionDetailDialog(subscriptions);
  const calendarDialog = useSubscriptionCalendarDialog(subscriptions);
  const { activeSubscriptions, totalMonthly, totalDaily, upcomingCount, trialCount } = useDashboardStats(
    subscriptions,
    defaultCurrency,
    convert,
    today,
    inheritedReminderDays,
  );
  const {
    editingSubscription,
    editingCollectionItem,
    editDialogOpen,
    editDetailPending,
    handleAddSubscription,
    handleDeleteSubscription,
    handleEditSubscription,
    handleTogglePublicHiddenSubscription,
    handleSaveSubscription,
    handleEditDialogOpenChange,
    handlePrefetchSubscription,
  } = useSubscriptionCrud(subscriptions);
  const handleEditFromDetail = useCallback((subscription: Subscription) => {
    handleEditSubscription(subscription.id);
  }, [handleEditSubscription]);

  // 只有页面主数据还没有首屏结果时才展示骨架屏。
  // 汇率刷新期间保留已有内容，并在统计卡片副标题里提示加载状态，避免整页闪回 loading。
  if (subscriptionsQuery.isPending || settingsQuery.isPending) {
    return (
      <div className="app-page bg-background">
        <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />
        <main className="app-main mx-auto max-w-7xl">
          <DashboardPageSkeleton withPageShell={false} />
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

  // 仪表盘只展示最近 6 个订阅（完整列表在 /subscriptions），保持首页扫描成本低。
  const displayedSubscriptions = subscriptions.slice(0, 6);

  return (
    <div className="app-page bg-background">
      <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />

      <main className="app-main mx-auto max-w-7xl">
        {/* 统计网格 */}
        <div className={cn("mb-8", dashboardStatLayout.grid)} data-testid="dashboard-stat-grid">
          <StatCard
            data-testid="dashboard-stat-monthly-spend"
            title={t("dashboard.monthlySpend")}
            value={formatCurrency(totalMonthly, defaultCurrency)}
            subtitle={t("dashboard.monthlySpendSubtitle", {
              amount: formatCompactCurrencyAmount(totalDaily, defaultCurrency, locale),
              rates: ratesLoading ? t("dashboard.ratesLoading") : t("dashboard.realTimeRates", { currency: defaultCurrency }),
            })}
            icon={<CreditCard className="h-6 w-6" />}
            variant="primary"
            density="compact"
            className={cn("animate-fade-in", dashboardStatLayout.primaryCard)}
          />
          <StatCard
            data-testid="dashboard-stat-active-subscriptions"
            title={t("dashboard.activeSubscriptions")}
            value={activeSubscriptions.length}
            subtitle={t("dashboard.totalSubscriptions", { count: facetsQuery.data?.total ?? subscriptions.length })}
            icon={<TrendingUp className="h-6 w-6" />}
            density="compact"
            className="animate-fade-in [animation-delay:100ms]"
          />
          <StatCard
            data-testid="dashboard-stat-upcoming-renewals"
            title={t("dashboard.upcomingRenewals")}
            value={upcomingCount}
            subtitle={t("dashboard.next7Days")}
            icon={<Clock className="h-6 w-6" />}
            variant={upcomingCount > 0 ? "warning" : "default"}
            density="compact"
            className="animate-fade-in [animation-delay:200ms]"
          />
          <StatCard
            data-testid="dashboard-stat-trials"
            title={t("dashboard.trials")}
            value={trialCount}
            subtitle={t("dashboard.trialsNeedAttention")}
            icon={<Sparkles className="h-6 w-6" />}
            variant={trialCount > 0 ? "warning" : "default"}
            density="compact"
            className={cn("animate-fade-in [animation-delay:300ms]", dashboardStatLayout.trialCard)}
          />
        </div>

        {/* 主内容网格 */}
        <div className="grid gap-8 lg:grid-cols-3">
          {/* 订阅列表 */}
          <div className="lg:col-span-2">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">{t("dashboard.recentSubscriptions")}</h2>
              <Link href="/subscriptions">
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                  {t("dashboard.viewAll", { count: subscriptions.length })}
                </Button>
              </Link>
            </div>
            {subscriptions.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-4 py-10 text-center">
                <h3 className="text-base font-semibold text-foreground">{t("dashboard.emptyTitle")}</h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t("dashboard.emptyDescription")}</p>
                <AddSubscriptionDialog
                  onAdd={handleAddSubscription}
                  availableTags={availableTags}
                  trigger={(
                    <Button className="mt-5 gap-2">
                      <Plus className="h-4 w-4" />
                      {t("subscriptions.addFirst")}
                    </Button>
                  )}
                />
              </div>
            ) : (
              <div className="grid items-stretch gap-4 sm:grid-cols-2">
                {displayedSubscriptions.map((sub, index) => (
                  <div key={sub.id} className="h-full animate-fade-in" style={{ animationDelay: `${index * 50}ms` }}>
                    <SubscriptionCard
                      subscription={sub}
                      today={today}
                      inheritedReminderDays={inheritedReminderDays}
                      currencyConvert={convert}
                      currencyRatesReady={currencyRatesReady}
                      priceReferenceCurrency={priceReferenceCurrency}
                      categoryByValue={categoryByValue}
                      paymentMethodByValue={paymentMethodByValue}
                      onEdit={handleEditSubscription}
                      onDelete={handleDeleteSubscription}
                      onTogglePublicHidden={handleTogglePublicHiddenSubscription}
                      onViewDetails={handleViewDetails}
                      onAddToCalendar={calendarDialog.show}
                      onPrefetchDetails={handlePrefetchSubscription}
                    />
                  </div>
                ))}
              </div>
            )}
            {subscriptions.length > 6 && (
              <div className="mt-4 text-center">
                <Link href="/subscriptions">
                  <Button variant="outline" className="border-border">
                    {t("dashboard.viewAllSubscriptions", { count: subscriptions.length })}
                  </Button>
                </Link>
              </div>
            )}
          </div>

          {/* 侧边栏 */}
          <div className="grid gap-6">
            {/* 支出图表 */}
            <div className="rounded-xl border border-border bg-card p-6 shadow-card">
              <h3 className="mb-3 text-lg font-semibold text-foreground">{t("dashboard.spendingDistribution")}</h3>
              <DeferredSpendingChart
                subscriptions={subscriptions}
                categories={config.categories}
                defaultCurrency={defaultCurrency}
                today={today}
                convert={convert}
              />
            </div>

            {/* 即将续费 */}
            <div className="rounded-xl border border-border bg-card p-6 shadow-card">
              <h3 className="mb-4 text-lg font-semibold text-foreground">{t("dashboard.upcomingRenewals")}</h3>
              <UpcomingRenewals
                subscriptions={subscriptions}
                today={today}
                notificationReminderDays={inheritedReminderDays}
              />
            </div>
          </div>
        </div>
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
    </div>
  );
}
