/**
 * 客户端应用挂载入口。
 *
 * 架构位置：这里只组合浏览器文档生命周期唯一的 QueryClient、产品会话 observer、
 * React Router 与全局 Providers；页面业务初始化继续下沉到 application hook。
 *
 * 启动链路：
 *   产品会话 Query -> DOM 根节点 -> StrictMode -> BrowserRouter -> Providers/QueryClient -> App 路由
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "@/App";
import Providers from "@/providers";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { RouteNavigationProvider } from "@/components/route-progress";
import { initializeProductSessionQuery } from "@/lib/auth-client";
import { getInitialLocale } from "@/i18n/locales";
import { loadAndActivateLocale } from "@/i18n/messages";
import { installAnimationFrameResizeObserver } from "@/lib/browser/animation-frame-resize-observer";
import { appQueryClient } from "@/lib/app-query-client";
import { preloadInitialRoute } from "@/lib/route-resources";
import { reportClientError } from "@/lib/report-client-error";
import "@/index.css";

const disposeProductSessionQuery = initializeProductSessionQuery(appQueryClient);
if (import.meta.hot) import.meta.hot.dispose(disposeProductSessionQuery);

async function bootstrap() {
  installAnimationFrameResizeObserver();
  // 当前路由模块与 locale catalog 并行下载；私有路由预热仍受本地产品 session 门禁。
  void preloadInitialRoute(window.location.pathname, appQueryClient).catch((error: unknown) => {
    reportClientError(error, { source: "route.initial-module-preload" });
  });
  // 首屏渲染前激活当前 catalog，避免已保存英文偏好时先闪另一种语言再切换。
  await loadAndActivateLocale(getInitialLocale());

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <BrowserRouter>
        <RouteNavigationProvider>
          <Providers queryClient={appQueryClient}>
            <AppErrorBoundary>
              <App />
            </AppErrorBoundary>
          </Providers>
        </RouteNavigationProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

void bootstrap();
