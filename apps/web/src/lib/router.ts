/**
 * 路由兼容适配层（React Router）。
 *
 * 架构位置：部分组件保留了 Next.js 风格的 `useRouter/usePathname` 心智模型；
 * 这里把它收敛为薄 shim，避免页面层直接依赖多个路由 API。
 *
 * 注意： `back()` 使用浏览器 history，不会自动套用登录 next 路径清洗。
 */
import {
  useLocation,
  useNavigate,
  useSearchParams as useReactRouterSearchParams,
  resolvePath,
} from "react-router";
import { useCallback, useMemo } from "react";
import { useRouteNavigationIntent } from "@/components/route-progress";

export function usePathname(): string {
  return useLocation().pathname;
}

/** 返回 React Router 当前 search params 的快照；调用方不要缓存后再跨导航复用，避免 next 参数清洗读到旧值。 */
export function useSearchParams(): URLSearchParams {
  const [params] = useReactRouterSearchParams();
  return params;
}

/** 提供项目内统一使用的命令式导航接口；保留 Next 风格方法名是为了让共享组件迁移到 React Router 后不分叉。 */
export function useRouter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const begin = useRouteNavigationIntent();
  const push = useCallback((href: string) => {
    const target = resolvePath(href, pathname);
    begin(`${target.pathname}${target.search}`);
    return navigate(href);
  }, [navigate, pathname, begin]);
  const replace = useCallback((href: string) => {
    const target = resolvePath(href, pathname);
    begin(`${target.pathname}${target.search}`);
    return navigate(href, { replace: true });
  }, [navigate, pathname, begin]);
  const back = useCallback(() => window.history.back(), []);

  // 登录页的条件式 Passkey effect 依赖 router 回调；这里保持对象身份稳定，避免普通输入重渲染反复重启浏览器凭据流程。
  return useMemo(() => ({ push, replace, back }), [back, push, replace]);
}
