/**
 * 顶部导航栏（桌面）+ 底部导航栏（移动端）。
 *
 * 作用：
 * - 提供全局导航（仪表盘/订阅/日历/统计/设置）
 * - 主题切换（dark/light）
 * - 可选：在支持的页面提供“新增订阅”入口
 *
 * 注意： Header 的主题切换只代表本设备即时偏好；跨设备外观同步必须在 Settings 页保存完成。
 */

import Link, { NavLink } from '@/components/router-link';
import { useRouter } from '@/lib/router';
import { LayoutDashboard, List, CalendarDays, BarChart3, Settings, Sun, Moon, LogOut } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SubscriptionFormSubmission } from '@/types/subscription';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme-provider';
import { toast } from '@/components/ui/sonner';
import { RenewletBrandMark } from '@/components/brand/renewlet-brand-mark';
import { getHeaderDesktopNavLinkClass, getHeaderMobileNavLinkClass, headerLayout } from '@/components/header-layout';
import { authClient } from '@/lib/auth-client';
import { AddSubscriptionDialog } from '@/components/add-subscription-dialog';
import { SystemUpdateDialog } from '@/components/system-update-dialog';
import { useI18n } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages';
import { RouteProgress } from '@/components/route-progress';
import { cn } from '@/lib/utils';

interface HeaderProps {
  /** 新增订阅回调（传入订阅主体数据，不包含 id）。不传则隐藏“新增订阅”按钮。 */
  onAddSubscription?: (submission: SubscriptionFormSubmission) => void;
  /** 当前用户已有标签建议，用于新增订阅弹窗复用。 */
  availableTags?: readonly string[] | undefined;
  /** 订阅页专属快捷动作，渲染在“新增订阅”旁边。 */
  subscriptionActions?: ReactNode;
}

type NavIconKey = "dashboard" | "subscriptions" | "calendar" | "statistics" | "settings";

/** 导航项配置：路径 / 文案 / 图标 key。 */
const navItems: Array<{ path: string; labelKey: MessageKey; icon: NavIconKey }> = [
  { path: '/', labelKey: 'nav.dashboard', icon: "dashboard" },
  { path: '/subscriptions', labelKey: 'nav.subscriptions', icon: "subscriptions" },
  { path: '/calendar', labelKey: 'nav.calendar', icon: "calendar" },
  { path: '/statistics', labelKey: 'nav.statistics', icon: "statistics" },
  { path: '/settings', labelKey: 'nav.settings', icon: "settings" },
];

function renderNavIcon(icon: NavIconKey, className: string) {
  switch (icon) {
    case "dashboard":
      return <LayoutDashboard className={className} />;
    case "subscriptions":
      return <List className={className} />;
    case "calendar":
      return <CalendarDays className={className} />;
    case "statistics":
      return <BarChart3 className={className} />;
    case "settings":
      return <Settings className={className} />;
  }
}

/** Header 组件：全局导航 + 主题切换 + 新增订阅入口。 */
export function Header({ onAddSubscription, availableTags, subscriptionActions }: HeaderProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const { data: sessionData } = authClient.useSession();
  const [systemDialogOpen, setSystemDialogOpen] = useState(false);
  const isAuthenticated = Boolean(sessionData?.user);

  /**
   * Header 是全局快捷开关，只写本机偏好；账户级外观草稿必须从 Settings 页外观控件产生。
   */
  const handleToggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
  };

  /** 退出登录：清理本地认证会话并回到 /login。 */
  const handleLogout = async () => {
    try {
      await authClient.signOut();
      toast.success(t("header.logoutSuccessTitle"));
      router.replace('/login');
    } catch {
      toast.error(t("header.logoutFailedTitle"), { description: t("error.generic") });
    }
  };

  return (
    <header className={headerLayout.shell} data-testid="app-header">
      <RouteProgress />
      <div className={headerLayout.inner} data-testid="app-header-inner">
        <div className={headerLayout.primaryCluster}>
          <div className={headerLayout.brandCluster}>
            <RenewletBrandMark size="sm" href="/" data-testid="app-header-brand-mark" />
            <div className={headerLayout.brandTextGroup}>
              <Link
                href="/"
                className={headerLayout.brandTitleLink}
              >
                <h1 className={headerLayout.brandTitle}>Renewlet</h1>
              </Link>
              {isAuthenticated ? (
                <SystemUpdateDialog
                  open={systemDialogOpen}
                  onOpenChange={setSystemDialogOpen}
                  canManageUpdates={sessionData?.user.role === "admin"}
                  contentAlign="start"
                  triggerClassName="w-fit"
                  badgeClassName="h-6 max-w-23 px-2 min-[380px]:max-w-32 sm:h-7 sm:max-w-none sm:px-2.5"
                />
              ) : null}
            </div>
          </div>

          <nav className={headerLayout.desktopNav} data-testid="app-header-desktop-nav">
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                href={item.path}
                end={item.path === "/"}
                title={t(item.labelKey)}
                className={({ isActive }) => getHeaderDesktopNavLinkClass(isActive)}
              >
                {renderNavIcon(item.icon, headerLayout.desktopNavIcon)}
                <span className={headerLayout.desktopNavLabel}>{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </nav>
        </div>

        <div className={headerLayout.actions} data-testid="app-header-actions">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleToggleTheme}
            className="h-9 w-9"
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">{t("header.toggleTheme")}</span>
          </Button>
          
          {onAddSubscription && (
            <>
              <AddSubscriptionDialog onAdd={onAddSubscription} availableTags={availableTags} />
              {subscriptionActions}
            </>
          )}

          <Button
            variant="ghost"
            size="icon"
            onClick={handleLogout}
            className="h-9 w-9 text-muted-foreground hover:text-destructive"
            title={t("header.logout")}
          >
            <LogOut className="h-4 w-4" />
            <span className="sr-only">{t("header.logout")}</span>
          </Button>
        </div>
      </div>

      {/* 移动端导航 */}
      <nav className={headerLayout.mobileNav} data-testid="app-header-mobile-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            href={item.path}
            end={item.path === "/"}
            className={({ isActive }) => getHeaderMobileNavLinkClass(isActive)}
          >
            {renderNavIcon(item.icon, headerLayout.mobileNavIcon)}
            {t(item.labelKey)}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
