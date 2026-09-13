import type { ComponentType, ReactElement } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  AdminUsersPageSkeleton,
  CalendarPageSkeleton,
  DashboardPageSkeleton,
  DocumentRouteSkeleton,
  LightweightRouteSkeleton,
  SettingsPageSkeleton,
  StatisticsPageSkeleton,
  SubscriptionsPageSkeleton,
} from "@/components/loading-skeleton";
import { readProductSession } from "@/services/product-session";

// 路由资源只响应 render 或链接 hover/focus/touch 意图预加载；登录后禁止空闲遍历全部私有 chunk。
// 私有数据预取还要经过产品 session 门禁，并统一写入 subscriptions infinite cache，避免保留第二份全量列表。

type RouteModule = { default: ComponentType };
type RouteLoader = () => Promise<RouteModule>;
type RouteFallbackComponent = () => ReactElement;
type RouteDataPreloadModule = { preload: (queryClient: QueryClient) => Promise<void> };
type RouteDataLoader = () => Promise<RouteDataPreloadModule>;

export type RoutePreloadMode = "none" | "intent" | "render" | "viewport";

interface RouteResource {
  path: string;
  load: RouteLoader;
  fallback: RouteFallbackComponent;
  loadData?: RouteDataLoader;
  usesPrivateShell?: true;
}

const loadPrivateAppShell = () => import("@/components/private-app-shell");
const loadDashboard = () => import("@/pages/dashboard");
const loadSubscriptions = () => import("@/pages/subscriptions");
const loadCalendar = () => import("@/pages/calendar");
const loadStatistics = () => import("@/pages/statistics");
const loadSettings = () => import("@/pages/settings");
const loadSetup = () => import("@/pages/setup");
const loadLogin = () => import("@/pages/login");
const loadPrivacy = () => import("@/pages/privacy");
const loadTerms = () => import("@/pages/terms");
const loadPublicStatus = () => import("@/pages/public-status");
const loadAdminUsers = () => import("@/pages/admin/users");
const loadForgotPassword = () => import("@/pages/forgot-password");
const loadResetPassword = () => import("@/pages/reset-password");
const loadNotFound = () => import("@/pages/not-found");
const loadPrivateShellData = () => import("@/lib/route-preloads/private-shell");
const loadOverviewData = () => import("@/lib/route-preloads/overview");
const loadSubscriptionsData = () => import("@/lib/route-preloads/subscriptions");
const loadCalendarData = () => import("@/lib/route-preloads/calendar");
const loadSettingsData = () => import("@/lib/route-preloads/settings");

function DashboardRouteFallback() {
  return <DashboardPageSkeleton />;
}

function SubscriptionsRouteFallback() {
  return <SubscriptionsPageSkeleton />;
}

function CalendarRouteFallback() {
  return <CalendarPageSkeleton />;
}

function StatisticsRouteFallback() {
  return <StatisticsPageSkeleton />;
}

function SettingsRouteFallback() {
  return <SettingsPageSkeleton />;
}

function AdminUsersRouteFallback() {
  return <AdminUsersPageSkeleton />;
}

function DocumentRouteFallback() {
  return <DocumentRouteSkeleton />;
}

function LightweightRouteFallback() {
  return <LightweightRouteSkeleton />;
}

export const routeResources = {
  dashboard: {
    path: "/",
    load: loadDashboard,
    fallback: DashboardRouteFallback,
    loadData: loadOverviewData,
    usesPrivateShell: true,
  },
  subscriptions: {
    path: "/subscriptions",
    load: loadSubscriptions,
    fallback: SubscriptionsRouteFallback,
    loadData: loadSubscriptionsData,
    usesPrivateShell: true,
  },
  calendar: {
    path: "/calendar",
    load: loadCalendar,
    fallback: CalendarRouteFallback,
    loadData: loadCalendarData,
    usesPrivateShell: true,
  },
  statistics: {
    path: "/statistics",
    load: loadStatistics,
    fallback: StatisticsRouteFallback,
    loadData: loadOverviewData,
    usesPrivateShell: true,
  },
  settings: {
    path: "/settings",
    load: loadSettings,
    fallback: SettingsRouteFallback,
    loadData: loadSettingsData,
    usesPrivateShell: true,
  },
  adminUsers: {
    path: "/admin/users",
    load: loadAdminUsers,
    fallback: AdminUsersRouteFallback,
    usesPrivateShell: true,
  },
  setup: {
    path: "/setup",
    load: loadSetup,
    fallback: LightweightRouteFallback,
  },
  login: {
    path: "/login",
    load: loadLogin,
    fallback: LightweightRouteFallback,
  },
  forgotPassword: {
    path: "/forgot-password",
    load: loadForgotPassword,
    fallback: LightweightRouteFallback,
  },
  resetPassword: {
    path: "/reset-password",
    load: loadResetPassword,
    fallback: LightweightRouteFallback,
  },
  privacy: {
    path: "/privacy",
    load: loadPrivacy,
    fallback: DocumentRouteFallback,
  },
  terms: {
    path: "/terms",
    load: loadTerms,
    fallback: DocumentRouteFallback,
  },
  publicStatus: {
    path: "/status",
    load: loadPublicStatus,
    fallback: LightweightRouteFallback,
  },
  notFound: {
    path: "*",
    load: loadNotFound,
    fallback: LightweightRouteFallback,
  },
} as const satisfies Record<string, RouteResource>;

const resourcesByExactPath = new Map<string, RouteResource>(
  Object.values(routeResources)
    .filter((resource) => resource.path !== "*" && resource.path !== "/status")
    .map((resource) => [resource.path, resource]),
);

const inFlightPreloads = new Map<string, Promise<void>>();

function routeResourceForPathname(pathname: string): RouteResource | null {
  if (pathname.startsWith("/status/")) return routeResources.publicStatus;
  return resourcesByExactPath.get(pathname) ?? null;
}

function canPrefetchPrivateData() {
  return Boolean(readProductSession());
}

function loadRouteModules(resource: RouteResource): Promise<void> {
  const shellPreload = resource.usesPrivateShell ? loadPrivateAppShell() : Promise.resolve();
  return Promise.all([shellPreload, resource.load()]).then(() => undefined);
}

export function lazyRouteLoader(key: keyof typeof routeResources): RouteLoader {
  return routeResources[key].load;
}

export function lazyPrivateAppShellLoader(): Promise<RouteModule> {
  return loadPrivateAppShell();
}

export function routeFallbackForPathname(pathname: string): ReactElement {
  const Fallback = routeResourceForPathname(pathname)?.fallback ?? LightweightRouteFallback;
  return <Fallback />;
}

/** 冷启动并行预取当前模块与数据；无会话时不能下载私有路由或发起私有请求。 */
export function preloadInitialRoute(pathname: string, queryClient: QueryClient): Promise<void> {
  const resource = routeResourceForPathname(pathname);
  if (!resource || resource.usesPrivateShell && !canPrefetchPrivateData()) return Promise.resolve();
  return preloadRoute(pathname, queryClient);
}

export function preloadRoute(pathname: string, queryClient?: QueryClient | null): Promise<void> {
  const resource = routeResourceForPathname(pathname);
  if (!resource) return Promise.resolve();

  const existing = inFlightPreloads.get(resource.path);
  if (existing) return existing;

  // 同一路由的 chunk 与数据预取共享 in-flight promise，快速 hover/focus 切换不会制造重复网络请求。
  const canPreloadData = Boolean(queryClient && canPrefetchPrivateData());
  const privateShellDataPreload = queryClient && resource.usesPrivateShell && canPreloadData
    ? loadPrivateShellData().then(({ preload: preloadData }) => preloadData(queryClient))
    : Promise.resolve();
  const routeDataPreload = queryClient && resource.loadData && canPreloadData
    ? resource.loadData().then(({ preload: preloadData }) => preloadData(queryClient))
    : Promise.resolve();
  // 私有壳、页面模块与 query options 必须并行预热；壳层只负责 Provider 生命周期，不能成为导航 waterfall。
  const preload = Promise.all([loadRouteModules(resource), privateShellDataPreload, routeDataPreload])
    .then(() => undefined);

  inFlightPreloads.set(resource.path, preload);
  // intent 只静默预热资源；鼠标悬停或缓存刷新不能伪装成页面导航。
  const clearInFlight = () => {
    if (inFlightPreloads.get(resource.path) === preload) {
      inFlightPreloads.delete(resource.path);
    }
  };
  preload.then(clearInFlight, clearInFlight);
  return preload;
}
