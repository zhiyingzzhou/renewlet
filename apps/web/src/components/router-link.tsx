/**
 * 路由 Link 适配组件。
 *
 * 架构位置：把 React Router 的 `to` 兼容为项目内习惯使用的 `href`，方便页面从
 * 让 Next 风格组件迁移时不把路由库细节扩散到每个调用点。
 *
 * 注意： 外链仍应使用原生 `<a>`；这里默认参与 SPA 路由解析。
 */
import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type TouchEvent,
} from "react";
import {
  Link as RouterLink,
  NavLink as RouterNavLink,
  type LinkProps as RouterLinkProps,
  type NavLinkProps as RouterNavLinkProps,
  type To,
  useResolvedPath,
} from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import { preloadRoute, type RoutePreloadMode } from "@/lib/route-resources";
import { useRouteNavigationIntent } from "@/components/route-progress";

type LinkProps = Omit<RouterLinkProps, "to"> & {
  href?: RouterLinkProps["to"];
  to?: RouterLinkProps["to"];
  routePreload?: RoutePreloadMode | undefined;
};

type NavLinkProps = Omit<RouterNavLinkProps, "to"> & {
  href?: RouterNavLinkProps["to"];
  to?: RouterNavLinkProps["to"];
  routePreload?: RoutePreloadMode | undefined;
};

type AnchorEventHandler<Event> = (event: Event) => void;

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as { current: T | null }).current = value;
}

function composeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (value: T | null) => {
    for (const ref of refs) setRef(ref, value);
  };
}

function composeEventHandlers<Event>(
  userHandler: AnchorEventHandler<Event> | undefined,
  routeHandler: AnchorEventHandler<Event>,
) {
  return (event: Event) => {
    userHandler?.(event);
    const maybeDefaultPrevented = event as Event & { defaultPrevented?: boolean };
    if (!maybeDefaultPrevented.defaultPrevented) routeHandler(event);
  };
}

function isExternalTo(to: To): boolean {
  return typeof to === "string" && (/^[a-z][a-z0-9+.-]*:/i.test(to) || to.startsWith("//"));
}

function beginLinkNavigation(event: MouseEvent<HTMLAnchorElement>, begin: (target: string) => void) {
  const anchor = event.currentTarget;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    || anchor.target && anchor.target !== "_self" || anchor.hasAttribute("download")
    || anchor.origin !== window.location.origin) return;
  begin(`${anchor.pathname}${anchor.search}`);
}

function useRoutePreload(to: To, mode: RoutePreloadMode, disabled: boolean) {
  const queryClient = useContext(QueryClientContext) ?? null;
  const resolved = useResolvedPath(to);
  const elementRef = useRef<HTMLAnchorElement | null>(null);
  const shouldPreload = !disabled && mode !== "none" && !isExternalTo(to);
  const preload = useCallback(() => {
    if (!shouldPreload) return;
    void preloadRoute(resolved.pathname, queryClient).catch(() => undefined);
  }, [queryClient, resolved.pathname, shouldPreload]);

  useEffect(() => {
    if (!shouldPreload || mode !== "render") return;
    preload();
  }, [mode, preload, shouldPreload]);

  useEffect(() => {
    if (!shouldPreload || mode !== "viewport") return undefined;
    const element = elementRef.current;
    if (!element) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      preload();
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        preload();
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, preload, shouldPreload]);

  return { elementRef, preload };
}

/** 使用 `href` 或 `to` 的 React Router Link。 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({
  href,
  to,
  routePreload = "intent",
  reloadDocument,
  onClick,
  onPointerEnter,
  onFocus,
  onTouchStart,
  ...props
}, ref) {
  const begin = useRouteNavigationIntent();
  const target = useMemo(() => to ?? href ?? "/", [href, to]);
  const { elementRef, preload } = useRoutePreload(target, routePreload, Boolean(reloadDocument));
  const mergedRef = useMemo(() => composeRefs(ref, elementRef), [elementRef, ref]);
  const reloadDocumentProps = reloadDocument === undefined ? {} : { reloadDocument };

  return (
    <RouterLink
      ref={mergedRef}
      to={target}
      {...reloadDocumentProps}
      onClick={composeEventHandlers<MouseEvent<HTMLAnchorElement>>(onClick, (event) => {
        if (!reloadDocument) beginLinkNavigation(event, begin);
      })}
      onPointerEnter={composeEventHandlers<PointerEvent<HTMLAnchorElement>>(onPointerEnter, preload)}
      onFocus={composeEventHandlers<FocusEvent<HTMLAnchorElement>>(onFocus, preload)}
      onTouchStart={composeEventHandlers<TouchEvent<HTMLAnchorElement>>(onTouchStart, preload)}
      {...props}
    />
  );
});

/** 使用 `href` 或 `to` 的 React Router NavLink。 */
export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink({
  href,
  to,
  routePreload = "intent",
  reloadDocument,
  onClick,
  onPointerEnter,
  onFocus,
  onTouchStart,
  ...props
}, ref) {
  const begin = useRouteNavigationIntent();
  const target = useMemo(() => to ?? href ?? "/", [href, to]);
  const { elementRef, preload } = useRoutePreload(target, routePreload, Boolean(reloadDocument));
  const mergedRef = useMemo(() => composeRefs(ref, elementRef), [elementRef, ref]);
  const reloadDocumentProps = reloadDocument === undefined ? {} : { reloadDocument };

  return (
    <RouterNavLink
      ref={mergedRef}
      to={target}
      {...reloadDocumentProps}
      onClick={composeEventHandlers<MouseEvent<HTMLAnchorElement>>(onClick, (event) => {
        if (!reloadDocument) beginLinkNavigation(event, begin);
      })}
      onPointerEnter={composeEventHandlers<PointerEvent<HTMLAnchorElement>>(onPointerEnter, preload)}
      onFocus={composeEventHandlers<FocusEvent<HTMLAnchorElement>>(onFocus, preload)}
      onTouchStart={composeEventHandlers<TouchEvent<HTMLAnchorElement>>(onTouchStart, preload)}
      {...props}
    />
  );
});

export default Link;
