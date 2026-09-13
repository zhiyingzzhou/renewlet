import {
  createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef,
  useState, useSyncExternalStore, type CSSProperties, type PropsWithChildren,
} from "react";
import { useLocation } from "react-router";
import { createRouteNavigation, type RouteCommit } from "@/lib/route-navigation";
import { cn } from "@/lib/utils";

const NavigationContext = createContext<{
  navigation: ReturnType<typeof createRouteNavigation>;
  location: RouteCommit;
  id: number;
} | null>(null);
const HIDDEN_PROGRESS = { visible: false, value: 0 };
const ProgressContext = createContext(HIDDEN_PROGRESS);
const ignoreNavigation = (_target: string) => {};

export function useRouteNavigationIntent() {
  return useContext(NavigationContext)?.navigation.begin ?? ignoreNavigation;
}

/** pending 只描述首次必要数据；页面已有可用内容时，后台刷新不能重启导航反馈。 */
export function useRouteReady(pending = false) {
  const context = useContext(NavigationContext);
  useEffect(() => {
    if (context && !pending) context.navigation.complete(context.id, context.location);
  }, [context, pending]);
}

export function RouteNavigationProvider({ children }: PropsWithChildren) {
  const { key, pathname, search } = useLocation();
  const [navigation] = useState(createRouteNavigation);
  const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const location = useMemo(() => ({ key, target: `${pathname}${search}` }), [key, pathname, search]);
  const context = useMemo(() => ({ navigation, location, id: state.id }), [navigation, location, state.id]);
  const [progress, setProgress] = useState(HIDDEN_PROGRESS);
  const visibleAt = useRef<number | null>(null);

  useLayoutEffect(() => { navigation.commit(location); }, [navigation, location]);
  useEffect(() => {
    const onPopState = () => navigation.begin(`${window.location.pathname}${window.location.search}`);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigation]);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let interval: ReturnType<typeof setInterval> | undefined;
    const schedule = (callback: () => void, delay: number) => {
      timers.push(setTimeout(callback, delay));
    };
    if (state.phase === "loading") {
      visibleAt.current = null;
      setProgress(HIDDEN_PROGRESS);
      // 延迟和最短展示时间只管理横条，绝不能延迟业务内容或延长请求生命周期。
      schedule(() => {
        visibleAt.current = Date.now();
        let value = 0.08;
        setProgress({ visible: true, value });
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        interval = setInterval(() => {
          value = Math.min(0.9, value + Math.max(0.02, (0.9 - value) * 0.15));
          setProgress({ visible: true, value });
          if (value === 0.9) clearInterval(interval);
        }, 800);
      }, 150);
    } else if (state.phase === "complete" && visibleAt.current !== null) {
      schedule(() => {
        setProgress({ visible: true, value: 1 });
        schedule(() => {
          setProgress({ visible: false, value: 1 });
          schedule(() => {
            visibleAt.current = null;
            setProgress(HIDDEN_PROGRESS);
          }, 200);
        }, 200);
      }, Math.max(0, 250 - (Date.now() - visibleAt.current)));
    } else {
      visibleAt.current = null;
      setProgress(HIDDEN_PROGRESS);
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
      clearInterval(interval);
    };
  }, [state.id, state.phase]);

  return (
    <NavigationContext.Provider value={context}>
      <ProgressContext.Provider value={progress}>{children}</ProgressContext.Provider>
    </NavigationContext.Provider>
  );
}

export function RouteProgress() {
  const { visible, value } = useContext(ProgressContext);
  const style: CSSProperties & { "--route-progress": number } = { "--route-progress": value };
  return (
    <div
      aria-hidden="true"
      data-testid="route-progress"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden transition-opacity duration-200 motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className="h-full origin-left scale-x-(--route-progress) bg-primary transition-transform duration-200 motion-reduce:scale-x-100 motion-reduce:transition-none"
        style={style}
      />
    </div>
  );
}
