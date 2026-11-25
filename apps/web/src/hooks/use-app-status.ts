import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { loginOptionsSchema, type LoginOptions } from "@renewlet/shared/schemas/app";

export const appStatusQueryKey = ["app-status"] as const;

export type AppStatusState = {
  status: "loading" | "ready" | "error";
  data: LoginOptions | null;
  error: unknown;
  isLoading: boolean;
  isRefreshing: boolean;
  isReady: boolean;
  retry: () => Promise<unknown>;
};

/**
 * 认证前能力状态的唯一浏览器读取入口。
 *
 * 这个查询同时被登录、首装和 Settings 订阅；失败必须保留为 error，不能再用
 * false/空对象伪造“已初始化”，否则 Cloudflare 维护或静态资源回退会误导用户。
 */
export function useAppStatus(): AppStatusState {
  const query = useQuery({
    queryKey: appStatusQueryKey,
    queryFn: ({ signal }) => apiFetch("/api/app/auth/options", loginOptionsSchema, {
      authMode: "none",
      cache: "no-store",
      timeoutMs: 10_000,
      signal,
    }),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  });

  const status = query.isPending ? "loading" : query.isError ? "error" : "ready";
  return {
    status,
    data: query.data ?? null,
    error: query.error ?? null,
    isLoading: query.isPending,
    isRefreshing: query.isFetching && !query.isPending,
    isReady: status === "ready",
    retry: () => query.refetch(),
  };
}
