import { Skeleton } from "@/components/ui/skeleton";
import { RouteProgress } from "@/components/route-progress";
import { dashboardStatLayout } from "@/components/dashboard-stat-layout";
import { getHeaderDesktopNavSkeletonItemClass, headerLayout } from "@/components/header-layout";
import { subscriptionFilterLayout } from "@/components/subscription-filter-layout";
import { cn } from "@/lib/utils";
import { SETTINGS_SECTION_FRAME_CLASS, settingsLayout } from "@/modules/settings/presentation/settings-layout";

type PageSkeletonProps = {
  withPageShell?: boolean;
};

function range(length: number): number[] {
  return Array.from({ length }, (_: unknown, index: number) => index);
}

function SkeletonBox({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

function HeaderSkeleton({ showAddAction = false }: { showAddAction?: boolean }) {
  return (
    <header className={headerLayout.shell} data-testid="app-header-skeleton">
      <RouteProgress />
      <div className={headerLayout.inner} data-testid="app-header-skeleton-inner">
        <div className={headerLayout.primaryCluster}>
          <div className={headerLayout.brandCluster}>
            <SkeletonBox className="h-10 w-10 shrink-0 rounded-xl" />
            <div className={headerLayout.brandTextGroup}>
              <SkeletonBox className="h-6 w-28" />
              <SkeletonBox className="h-6 w-23 rounded-lg min-[380px]:w-32 sm:h-7" />
            </div>
          </div>
          <nav className={headerLayout.desktopNav} data-testid="app-header-desktop-nav-skeleton">
            {range(5).map((index) => (
              <div key={index} className={getHeaderDesktopNavSkeletonItemClass()}>
                <SkeletonBox className="h-4 w-4 rounded" />
                <SkeletonBox className={headerLayout.desktopNavSkeletonLabel} />
              </div>
            ))}
          </nav>
        </div>
        <div className={headerLayout.actions} data-testid="app-header-actions-skeleton">
          <SkeletonBox className="h-9 w-9 rounded-md" />
          {showAddAction ? <SkeletonBox className="h-9 w-9 rounded-md sm:w-28" /> : null}
          <SkeletonBox className="h-9 w-9 rounded-md" />
        </div>
      </div>
      <nav className={headerLayout.mobileNav} data-testid="app-header-mobile-nav-skeleton">
        {range(5).map((index) => (
          <div key={index} className="flex flex-1 flex-col items-center gap-1 py-3">
            <SkeletonBox className="h-5 w-5 rounded" />
            <SkeletonBox className="h-3 w-10" />
          </div>
        ))}
      </nav>
    </header>
  );
}

function PageShellSkeleton({
  children,
  maxWidthClassName = "max-w-7xl",
  showAddAction = false,
  testId,
}: {
  children: React.ReactNode;
  maxWidthClassName?: string;
  showAddAction?: boolean;
  testId: string;
}) {
  return (
    // 路由级 lazy fallback 复刻真实页面壳，避免 chunk 加载期间 header/nav 高度跳变。
    <div className="app-page bg-background" aria-busy="true" data-testid={testId}>
      <HeaderSkeleton showAddAction={showAddAction} />
      <main className={cn("app-main mx-auto", maxWidthClassName)}>
        <div aria-hidden="true">{children}</div>
      </main>
    </div>
  );
}

function PageTitleSkeleton({ withActions = false, subtitleWidth = "w-48" }: { withActions?: boolean; subtitleWidth?: string }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <SkeletonBox className="h-8 w-32 rounded" />
        <SkeletonBox className={cn("mt-2 h-4 rounded", subtitleWidth)} />
      </div>
      {withActions ? (
        <div className="flex items-center gap-2">
          <SkeletonBox className="h-9 w-9 rounded-md" />
          <SkeletonBox className="h-9 w-24 rounded-md" />
          <SkeletonBox className="h-9 w-9 rounded-md" />
        </div>
      ) : null}
    </div>
  );
}

function StatCardSkeleton({
  compact = false,
  className,
  testId,
}: {
  compact?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("rounded-xl border border-border bg-card", compact ? "p-4 lg:p-6" : "p-6", className)}
    >
      <div className={cn("flex items-start justify-between", compact && "gap-3 lg:gap-4")}>
        <div className={cn("grid min-w-0", compact ? "gap-1.5 lg:gap-2" : "gap-2")}>
          <SkeletonBox className={cn("w-20", compact ? "h-3.5 lg:h-4" : "h-4")} />
          <SkeletonBox className={cn("w-24", compact ? "h-7 lg:h-8" : "h-8")} />
          <SkeletonBox className={cn("h-3", compact ? "w-24 lg:w-28" : "w-28")} />
        </div>
        <SkeletonBox className={cn("shrink-0 rounded-lg", compact ? "h-10 w-10 lg:h-12 lg:w-12" : "h-12 w-12")} />
      </div>
    </div>
  );
}

function SubscriptionCardSkeleton({ list = false }: { list?: boolean }) {
  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", list && "min-h-31.5")}>
      <div className="flex items-start gap-4">
        <SkeletonBox className="h-12 w-12 shrink-0 rounded-lg" />
        <div className="grid flex-1 gap-2">
          <SkeletonBox className="h-5 w-32" />
          <SkeletonBox className="h-4 w-24" />
          <SkeletonBox className="h-3 w-28" />
        </div>
        {list ? <SkeletonBox className="hidden h-9 w-24 rounded-md sm:block" /> : null}
      </div>
    </div>
  );
}

function DashboardContentSkeleton() {
  return (
    <div className="grid gap-8">
      <div className={dashboardStatLayout.grid} data-testid="dashboard-skeleton-stat-grid">
        <StatCardSkeleton
          compact
          className={dashboardStatLayout.primaryCard}
          testId="dashboard-skeleton-stat-monthly-spend"
        />
        <StatCardSkeleton compact testId="dashboard-skeleton-stat-active-subscriptions" />
        <StatCardSkeleton compact testId="dashboard-skeleton-stat-upcoming-renewals" />
        <StatCardSkeleton
          compact
          className={dashboardStatLayout.trialCard}
          testId="dashboard-skeleton-stat-trials"
        />
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-5 flex items-center justify-between">
            <SkeletonBox className="h-6 w-28" />
            <SkeletonBox className="h-9 w-20 rounded-md" />
          </div>
          <div className="grid items-stretch gap-4 sm:grid-cols-2">
            {range(6).map((index) => <SubscriptionCardSkeleton key={index} />)}
          </div>
        </div>

        <div className="grid gap-6">
          <div className="rounded-xl border border-border bg-card p-6 shadow-card">
            <SkeletonBox className="mb-3 h-6 w-32" />
            <SkeletonBox className="h-55 w-full rounded-lg" />
          </div>
          <div className="rounded-xl border border-border bg-card p-6 shadow-card">
            <SkeletonBox className="mb-4 h-6 w-28" />
            <div className="grid gap-3">
              {range(4).map((index) => (
                <div key={index} className="flex items-center gap-3">
                  <SkeletonBox className="h-10 w-10 rounded-lg" />
                  <div className="grid flex-1 gap-1">
                    <SkeletonBox className="h-4 w-28" />
                    <SkeletonBox className="h-3 w-20" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SubscriptionsContentSkeleton() {
  return (
    <>
      <PageTitleSkeleton withActions subtitleWidth="w-56" />

      {/* 订阅页骨架同时覆盖移动筛选抽屉入口和桌面筛选条，防止断点切换时首屏布局漂移。 */}
      <div className="mb-6 grid gap-3 rounded-xl border border-border bg-card p-5 md:gap-4">
        <div className="grid gap-3 md:hidden">
          <SkeletonBox className="h-11 w-full rounded-md" />
          <div className="grid grid-cols-2 gap-3">
            <SkeletonBox className="h-11 w-full rounded-md" />
            <SkeletonBox className="h-11 w-full rounded-md" />
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <SkeletonBox className="h-11 flex-1 rounded-md" />
            <SkeletonBox className="h-11 w-11 rounded-md" />
          </div>
        </div>
        <div className={cn("hidden md:flex", subscriptionFilterLayout.desktopRow)}>
          <SkeletonBox className={subscriptionFilterLayout.skeletonSearch} />
          <SkeletonBox className={subscriptionFilterLayout.skeletonCategory} />
          <SkeletonBox className={subscriptionFilterLayout.skeletonStatus} />
          <SkeletonBox className={subscriptionFilterLayout.skeletonPaymentType} />
          <SkeletonBox className={subscriptionFilterLayout.skeletonSort} />
          <SkeletonBox className="h-10 w-24 rounded-md" />
        </div>
      </div>

      <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="subscriptions-skeleton-list">
        {range(9).map((index) => <SubscriptionCardSkeleton key={index} />)}
      </div>
    </>
  );
}

function StatisticsContentSkeleton() {
  return (
    <>
      <PageTitleSkeleton withActions subtitleWidth="w-64" />

      <section className="mb-8">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SkeletonBox className="h-6 w-24" />
          <SkeletonBox className="h-6 w-40 rounded-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 min-[380px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {range(12).map((index) => (
            <div key={index} className="flex min-h-29 flex-col items-center justify-center rounded-xl border border-border bg-card p-5 text-center">
              <SkeletonBox className="mb-2 h-8 w-20" />
              <SkeletonBox className="h-4 w-24" />
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <div className="min-w-0 rounded-xl border border-border bg-card p-6 shadow-card">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="grid gap-2">
              <SkeletonBox className="h-6 w-24" />
              <SkeletonBox className="h-4 w-64 max-w-full" />
            </div>
            <SkeletonBox className="h-9 w-full rounded-md sm:w-48" />
          </div>
          <SkeletonBox className="h-70 w-full rounded-lg" />
        </div>
      </section>

      <section>
        <SkeletonBox className="mb-4 h-6 w-24" />
        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          {range(2).map((index) => (
            <div key={index} className="min-w-0 rounded-xl border border-border bg-card p-6">
              <SkeletonBox className="mx-auto mb-2 h-5 w-24" />
              <SkeletonBox className="mx-auto mb-3 h-3 w-32" />
              <SkeletonBox className="h-55 w-full rounded-lg" />
            </div>
          ))}
          <div className="min-w-0 rounded-xl border border-border bg-card p-6 md:col-span-2">
            <SkeletonBox className="mx-auto mb-2 h-5 w-32" />
            <SkeletonBox className="mx-auto mb-3 h-3 w-40" />
            <SkeletonBox className="h-55 w-full rounded-lg" />
            <div className="mt-4 flex flex-col justify-center gap-4 min-[380px]:flex-row min-[380px]:gap-8">
              <SkeletonBox className="mx-auto h-14 w-28" />
              <SkeletonBox className="mx-auto h-14 w-28" />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function CalendarContentSkeleton() {
  return (
    <>
      <PageTitleSkeleton subtitleWidth="w-48" />

      <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-card sm:p-6">
        <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <SkeletonBox className="h-5 w-5 rounded" />
            <SkeletonBox className="h-6 w-24" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
            <SkeletonBox className="h-8 w-14 rounded-md" />
            <div className="flex items-center gap-1">
              <SkeletonBox className="h-8 w-8 rounded-md" />
              <SkeletonBox className="h-8 w-16 rounded-md" />
              <SkeletonBox className="h-8 w-20 rounded-md" />
              <SkeletonBox className="h-8 w-8 rounded-md" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {range(7).map((index) => <SkeletonBox key={index} className="h-8 w-full rounded-md" />)}
          {range(42).map((index) => <SkeletonBox key={`day-${index}`} className="h-24 w-full rounded-lg sm:h-28" />)}
        </div>
        <div className="mt-6 grid gap-3 rounded-lg border border-border bg-secondary/30 p-4 sm:grid-cols-2">
          <SkeletonBox className="h-12 w-full rounded-md" />
          <SkeletonBox className="h-12 w-full rounded-md" />
        </div>
      </div>
    </>
  );
}

function SettingsContentSkeleton() {
  return (
    <div className={settingsLayout.pageGrid} data-testid="settings-page-skeleton-grid">
      <aside className="hidden lg:block">
        <div className={settingsLayout.desktopNav} data-testid="settings-page-skeleton-desktop-nav">
          <div className="grid gap-1">
            {range(10).map((index) => <SkeletonBox key={index} className="h-9 w-full rounded-lg" />)}
          </div>
        </div>
      </aside>

      <div className={settingsLayout.content}>
        <div className={settingsLayout.mobileHeader} data-testid="settings-page-skeleton-mobile-header">
          <div className={settingsLayout.mobileHeaderRow}>
            <div className={settingsLayout.mobileHeaderText}>
              <SkeletonBox className="h-6 w-28" />
              <SkeletonBox className="h-4 w-40" />
            </div>
            <SkeletonBox className="h-10 w-10 shrink-0 rounded-lg" />
          </div>
        </div>

        <div className={settingsLayout.desktopHeader}>
          <SkeletonBox className="h-8 w-32" />
          <SkeletonBox className="mt-2 h-4 w-56" />
        </div>

        {range(8).map((index) => (
          <section key={index} className={SETTINGS_SECTION_FRAME_CLASS}>
            <SkeletonBox className="mb-6 h-6 w-32" />
            <div className="grid gap-4">
              <SkeletonBox className="h-10 w-full max-w-md rounded-md" />
              <SkeletonBox className="h-4 w-3/4" />
              {index % 3 === 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SkeletonBox className="h-24 w-full rounded-lg" />
                  <SkeletonBox className="h-24 w-full rounded-lg" />
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function AdminUsersTableSkeleton() {
  return (
    <div className="divide-y divide-border" data-testid="admin-users-skeleton-table">
      {range(5).map((index) => (
        <div key={index} className="grid gap-3 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_140px_120px_260px] lg:items-center lg:gap-4">
          <div className="grid min-w-0 gap-1">
            <SkeletonBox className="h-5 w-36" />
            <SkeletonBox className="h-4 w-48 max-w-full" />
          </div>
          <SkeletonBox className="h-9 w-24 rounded-md" />
          <SkeletonBox className="h-6 w-20 rounded-full" />
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <SkeletonBox className="h-9 w-24 rounded-md" />
            <SkeletonBox className="h-9 w-20 rounded-md" />
            <SkeletonBox className="h-9 w-16 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AdminUsersContentSkeleton() {
  return (
    <>
      <PageTitleSkeleton withActions subtitleWidth="w-64" />
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_140px_120px_260px] gap-4 border-b border-border px-5 py-3 lg:grid">
          <SkeletonBox className="h-4 w-20" />
          <SkeletonBox className="h-4 w-16" />
          <SkeletonBox className="h-4 w-16" />
          <SkeletonBox className="h-4 w-20" />
        </div>
        <AdminUsersTableSkeleton />
      </section>
    </>
  );
}

export function AdminUsersRowsSkeleton() {
  return (
    <div aria-hidden="true">
      <AdminUsersTableSkeleton />
    </div>
  );
}

function LightweightRouteContentSkeleton() {
  return (
    <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-card sm:p-8">
        <div className="mb-8 flex items-center gap-3">
          <SkeletonBox className="h-12 w-12 rounded-xl" />
          <div className="grid gap-2">
            <SkeletonBox className="h-6 w-32" />
            <SkeletonBox className="h-3 w-40" />
          </div>
        </div>
        <div className="grid gap-4">
          <SkeletonBox className="h-10 w-full rounded-md" />
          <SkeletonBox className="h-10 w-full rounded-md" />
          <SkeletonBox className="h-10 w-full rounded-md" />
          <SkeletonBox className="h-11 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}

function DocumentRouteContentSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <SkeletonBox className="mb-4 h-9 w-48" />
      <SkeletonBox className="mb-8 h-4 w-64" />
      <div className="grid gap-4">
        {range(8).map((index) => <SkeletonBox key={index} className="h-4 w-full" />)}
      </div>
    </div>
  );
}

export function DashboardPageSkeleton({ withPageShell = true }: PageSkeletonProps) {
  const content = <DashboardContentSkeleton />;
  return withPageShell ? (
    <PageShellSkeleton showAddAction testId="dashboard-page-skeleton">{content}</PageShellSkeleton>
  ) : (
    <div aria-hidden="true" data-testid="dashboard-skeleton">{content}</div>
  );
}

export function SubscriptionsPageSkeleton({ withPageShell = true }: PageSkeletonProps) {
  const content = <SubscriptionsContentSkeleton />;
  return withPageShell ? (
    <PageShellSkeleton showAddAction testId="subscriptions-page-skeleton">{content}</PageShellSkeleton>
  ) : (
    <div aria-hidden="true" data-testid="subscriptions-skeleton">{content}</div>
  );
}

export function StatisticsPageSkeleton({ withPageShell = true }: PageSkeletonProps) {
  const content = <StatisticsContentSkeleton />;
  return withPageShell ? (
    <PageShellSkeleton showAddAction testId="statistics-page-skeleton">{content}</PageShellSkeleton>
  ) : (
    <div aria-hidden="true" data-testid="statistics-skeleton">{content}</div>
  );
}

export function CalendarPageSkeleton({ withPageShell = true }: PageSkeletonProps) {
  const content = <CalendarContentSkeleton />;
  return withPageShell ? (
    <PageShellSkeleton showAddAction testId="calendar-page-skeleton">{content}</PageShellSkeleton>
  ) : (
    <div aria-hidden="true" data-testid="calendar-skeleton">{content}</div>
  );
}

export function SettingsPageSkeleton({ withPageShell = true }: PageSkeletonProps) {
  const content = <SettingsContentSkeleton />;
  return withPageShell ? (
    <PageShellSkeleton testId="settings-page-skeleton">{content}</PageShellSkeleton>
  ) : (
    <div aria-hidden="true" data-testid="settings-skeleton">{content}</div>
  );
}

export function AdminUsersPageSkeleton({ withPageShell = true }: PageSkeletonProps) {
  const content = <AdminUsersContentSkeleton />;
  return withPageShell ? (
    <PageShellSkeleton testId="admin-users-page-skeleton">{content}</PageShellSkeleton>
  ) : (
    <div aria-hidden="true" data-testid="admin-users-skeleton">{content}</div>
  );
}

export function LightweightRouteSkeleton() {
  return (
    <div className="app-page bg-background" aria-busy="true" data-testid="lightweight-route-skeleton">
      <div aria-hidden="true">
        <LightweightRouteContentSkeleton />
      </div>
    </div>
  );
}

export function DocumentRouteSkeleton() {
  return (
    <div className="app-page bg-background" aria-busy="true" data-testid="document-route-skeleton">
      <div aria-hidden="true">
        <DocumentRouteContentSkeleton />
      </div>
    </div>
  );
}

export const DashboardSkeleton = DashboardPageSkeleton;
export const SubscriptionListSkeleton = SubscriptionsPageSkeleton;
export const StatisticsSkeleton = StatisticsPageSkeleton;
export const CalendarSkeleton = CalendarPageSkeleton;
