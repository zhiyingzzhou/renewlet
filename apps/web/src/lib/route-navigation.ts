export interface RouteCommit {
  key: string;
  target: string;
}

type NavigationState =
  | { phase: "idle"; id: number }
  | { phase: "loading" | "complete"; id: number; target: string; key: string | null };

/** 每个应用实例只拥有一条导航状态；不保存业务数据，也不取消共享 Query。 */
export function createRouteNavigation() {
  let state: NavigationState = { phase: "idle", id: 0 };
  let committed: RouteCommit | null = null;
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (next: NavigationState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin(target: string) {
      if (target === committed?.target) {
        if (state.phase === "loading" && state.target !== target) {
          publish({ phase: "idle", id: ++sequence });
        }
        return;
      }
      if (state.phase === "loading" && state.target === target) return;
      // 意图阶段还没有目标 location.key；清空 key，旧页面即使提交也不能结束新导航。
      publish({ phase: "loading", id: ++sequence, target, key: null });
    },
    commit(location: RouteCommit) {
      const changed = committed?.target !== location.target;
      committed = location;
      if (state.phase === "loading" && state.target === location.target) {
        if (state.key !== location.key) publish({ ...state, key: location.key });
      } else if (changed) {
        publish({ phase: "loading", id: ++sequence, ...location });
      }
    },
    complete(id: number, location: RouteCommit) {
      // 只接受当前路由 commit 的就绪报告；预取 Promise 完成不代表页面已经可用。
      if (state.phase === "loading" && state.id === id
        && state.key === location.key && state.target === location.target) {
        publish({ ...state, phase: "complete" });
      }
    },
  };
}
