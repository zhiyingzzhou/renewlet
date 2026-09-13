// Header 测试守住全局导航、会话菜单和新增订阅入口，避免路由重排时破坏主要工作流入口。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SystemVersionResponse } from "@/lib/api/schemas/app";
import { Header } from "./header";

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  signOut: vi.fn(),
  useSystemVersion: vi.fn(),
  useSystemUpdate: vi.fn(),
  useSystemUpdateStatus: vi.fn(),
  useSystemRestart: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  setTheme: vi.fn(),
  theme: "dark",
  writeAppearancePendingToStorage: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: mocks.useSession,
    signOut: mocks.signOut,
  },
}));

vi.mock("@/hooks/use-system-version", () => ({
  useSystemVersion: mocks.useSystemVersion,
  useSystemUpdate: mocks.useSystemUpdate,
  useSystemUpdateStatus: mocks.useSystemUpdateStatus,
  useSystemRestart: mocks.useSystemRestart,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/lib/theme-provider", () => ({
  useTheme: () => ({
    theme: mocks.theme,
    setTheme: mocks.setTheme,
  }),
}));

vi.mock("@/lib/theme-storage", () => ({
  writeAppearancePendingToStorage: mocks.writeAppearancePendingToStorage,
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "app.tagline": "订阅管理助手",
        "header.logout": "退出登录",
        "header.toggleTheme": "切换主题",
        "nav.calendar": "日历",
        "nav.dashboard": "仪表盘",
        "nav.settings": "设置",
        "nav.statistics": "统计",
        "nav.subscriptions": "订阅",
        "system.badgeUpdate": "可更新到 v{version}",
        "system.badgeVersion": "v{version}",
        "system.buildType": "构建类型",
        "system.checkDeferredDescription": "当前显示的是本机版本；请稍后重新检查。",
        "system.checkDeferredTitle": "暂时无法检查更新",
        "system.currentVersion": "当前版本",
        "system.latestVersion": "最新版本",
        "system.noUpdateTitle": "已是最新版本",
        "system.openUpdateDialog": "打开系统更新",
        "system.cloudflareDeployGuide": "Cloudflare 部署说明",
        "system.recheck": "重新检查",
        "system.releaseLink": "发布页",
        "system.restartNow": "立即重启",
        "system.restartRequired": "请重启服务以应用更新",
        "system.restarting": "正在重启...",
        "system.retry": "重试",
        "system.runtime": "运行面",
        "system.runtime.cloudflare": "Cloudflare",
        "system.runtime.docker": "Docker",
        "system.runtime.source": "源码/手动部署",
        "system.unsupportedDescription": "请使用原部署方式升级。",
        "system.unsupportedTitle": "当前部署不支持一键更新",
        "system.updateAvailableDescription": "可以更新到 v{version}。",
        "system.updateAvailableTitle": "发现新版本",
        "system.updateComplete": "更新完成",
        "system.updateFailedDescription": "更新失败，请稍后重试。",
        "system.updateFailedTitle": "更新失败",
        "system.updateNow": "立即更新",
        "system.updateTitle": "系统更新",
        "system.updateUnavailableTitle": "页面内更新不可用",
        "system.updating": "更新中...",
        "system.viewChangelog": "查看更新日志",
      };
      let value = messages[key] ?? key;
      for (const [name, param] of Object.entries(params ?? {})) {
        value = value.split(`{${name}}`).join(String(param));
      }
      return value;
    },
    formatDateTime: (value: string) => value,
  }),
}));

function versionFixture(overrides: Partial<SystemVersionResponse> = {}): SystemVersionResponse {
  return {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    hasUpdate: true,
    checkSucceeded: true,
    deployment: "docker",
    updateMode: "in-app-binary",
    updateSupported: true,
    unsupportedReason: undefined,
    releaseInfo: null,
    cached: false,
    warning: undefined,
    build: {
      version: "1.0.0",
      commit: "abc",
      buildTime: "2026-05-26T00:00:00Z",
      buildType: "release",
    },
    ...overrides,
  };
}

function adminSession(role: "admin" | "user") {
  return {
    data: {
      session: { expiresAt: "2026-07-01T00:00:00.000Z" },
      user: { id: "user-1", email: "alice@example.com", name: "Alice", role, banned: false },
    },
    isPending: false,
  };
}

function renderHeader(ui: ReactElement = <Header />) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Header system version entry", () => {
  beforeEach(() => {
    mocks.useSession.mockReset();
    mocks.signOut.mockReset();
    mocks.useSystemVersion.mockReset();
    mocks.useSystemUpdate.mockReset();
    mocks.useSystemUpdateStatus.mockReset();
    mocks.useSystemRestart.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.setTheme.mockReset();
    mocks.theme = "dark";
    mocks.writeAppearancePendingToStorage.mockReset();
    mocks.useSystemVersion.mockReturnValue({
      data: versionFixture(),
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    mocks.useSystemUpdate.mockReturnValue({
      isPending: false,
      isSuccess: false,
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      data: undefined,
    });
    mocks.useSystemUpdateStatus.mockReturnValue({ data: { operation: null } });
    mocks.useSystemRestart.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
      reset: vi.fn(),
    });
  });

  it("shows the version badge for administrators and opens the update dialog", async () => {
    mocks.useSession.mockReturnValue(adminSession("admin"));
    const user = userEvent.setup();

    renderHeader();

    const updateButton = screen.getByRole("button", { name: "打开系统更新" });
    expect(screen.getAllByRole("button", { name: "打开系统更新" })).toHaveLength(1);
    expect(updateButton.closest("a")).toBeNull();
    expect(screen.queryByText("订阅管理助手")).not.toBeInTheDocument();

    await user.click(updateButton);

    expect(screen.getByText("可更新到 v1.1.0")).toBeInTheDocument();
    expect(screen.getByText("当前版本")).toBeInTheDocument();
    expect(mocks.useSystemUpdateStatus).toHaveBeenLastCalledWith(true, false);
  });

  it("shows the version badge for non-admin users without update actions", async () => {
    mocks.useSession.mockReturnValue(adminSession("user"));
    mocks.useSystemVersion.mockReturnValue({
      data: versionFixture({ updateSupported: false, unsupportedReason: "需要管理员权限" }),
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    const user = userEvent.setup();

    renderHeader();

    const updateButton = screen.getByRole("button", { name: "打开系统更新" });
    expect(updateButton).toBeInTheDocument();

    await user.click(updateButton);

    expect(screen.getByText("当前版本")).toBeInTheDocument();
    expect(screen.getByText("需要管理员权限")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
    expect(mocks.useSystemUpdateStatus).toHaveBeenLastCalledWith(false, false);
  });

  it("waits for a signed-in session before showing the version badge", () => {
    mocks.useSession.mockReturnValue({ data: undefined, isPending: true });

    renderHeader();

    expect(screen.queryByRole("button", { name: "打开系统更新" })).not.toBeInTheDocument();
    expect(mocks.useSystemVersion).not.toHaveBeenCalled();
  });

  it("keeps the header stable after sign-in without scheduling private route preloads", () => {
    mocks.useSession.mockReturnValue(adminSession("user"));

    renderHeader();

    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
  });

  it("keeps the shared progress indicator inside the existing header chrome", () => {
    mocks.useSession.mockReturnValue(adminSession("user"));

    renderHeader();

    expect(screen.getByTestId("route-progress")).toHaveClass(
      "absolute",
      "bottom-0",
      "h-0.5",
      "pointer-events-none",
      "opacity-0",
    );
    expect(screen.getByTestId("route-progress").firstElementChild).toHaveClass("bg-primary");
  });

  it("keeps the header theme toggle as a local-only preference", async () => {
    mocks.useSession.mockReturnValue(adminSession("user"));
    const user = userEvent.setup();

    renderHeader();

    await user.click(screen.getByRole("button", { name: "切换主题" }));

    expect(mocks.setTheme).toHaveBeenCalledWith("light");
    expect(mocks.writeAppearancePendingToStorage).not.toHaveBeenCalled();
  });

  it("uses the shared responsive header layout contract", () => {
    mocks.useSession.mockReturnValue(adminSession("user"));

    renderHeader();

    expect(screen.getByTestId("app-header")).toHaveClass("sticky", "top-0", "z-50", "bg-card/80");
    expect(screen.getByTestId("app-header-inner")).toHaveClass("max-w-7xl", "justify-between", "gap-3");
    expect(screen.getByTestId("app-header-actions")).toHaveClass("min-w-0", "shrink-0", "justify-end");

    const desktopNav = screen.getByTestId("app-header-desktop-nav");
    const mobileNav = screen.getByTestId("app-header-mobile-nav");
    expect(desktopNav).toHaveClass("hidden", "min-w-0", "lg:flex");
    expect(mobileNav).toHaveClass("flex", "border-t", "lg:hidden");

    const subscriptionLink = within(desktopNav).getByRole("link", { name: "订阅" });
    expect(subscriptionLink).toHaveAttribute("title", "订阅");
    expect(subscriptionLink).toHaveClass("h-10", "w-auto", "justify-start", "gap-2", "px-3", "xl:px-4");
    expect(subscriptionLink).not.toHaveClass("lg:w-10", "lg:px-0");
    const subscriptionLabel = within(subscriptionLink).getByText("订阅");
    expect(subscriptionLabel).toHaveClass("whitespace-nowrap");
    expect(subscriptionLabel).not.toHaveClass("sr-only", "xl:not-sr-only");
  });

  it("uses the shared brand mark contract in the header", () => {
    mocks.useSession.mockReturnValue(adminSession("user"));

    renderHeader();

    const mark = screen.getByTestId("app-header-brand-mark");
    expect(mark).toHaveClass(
      "h-10",
      "w-10",
      "bg-brand-mark",
      "text-brand-mark-foreground",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
    );
    expect(mark.className).not.toContain("bg-[");
    expect(mark.className).not.toContain("text-[");
  });
});
