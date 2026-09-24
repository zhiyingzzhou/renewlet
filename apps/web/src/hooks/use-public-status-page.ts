import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publicStatusService } from "@/services/public-status-service";

const PUBLIC_STATUS_PAGE_QUERY_KEY = ["public-status-page"] as const;
const PUBLIC_STATUS_REFETCH_INTERVAL_MS = 5 * 60 * 1000;
const publicStatusQueryKey = (token: string) => ["public-status", token] as const;

/**
 * 查询当前用户公开展示页管理状态。
 *
 * pageUrl 是 bearer URL，只缓存当前登录用户可复制的完整地址；退出登录后的清理沿用全局 session cache 失效。
 */
export function usePublicStatusPageStatus() {
  return useQuery({
    queryKey: PUBLIC_STATUS_PAGE_QUERY_KEY,
    queryFn: ({ signal }) => publicStatusService.getPage(signal),
  });
}

/** 创建或复用公开展示页；成功后直接写缓存，确保复制按钮立即拿到新 URL。 */
export function useCreatePublicStatusPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => publicStatusService.createPage(),
    onSuccess: (page) => {
      queryClient.setQueryData(PUBLIC_STATUS_PAGE_QUERY_KEY, page);
    },
  });
}

/** 更新公开展示页设置；PATCH 不创建 token，未启用时由 UI 禁用该入口。 */
export function useUpdatePublicStatusPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { showPrices: boolean; hideExpired: boolean; hideLifetime: boolean }) => publicStatusService.updatePage(body),
    onSuccess: (page) => {
      queryClient.setQueryData(PUBLIC_STATUS_PAGE_QUERY_KEY, page);
    },
  });
}

/** 撤销公开展示页；服务端删除 token 后旧 URL 应统一返回 404。 */
export function useDeletePublicStatusPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => publicStatusService.deletePage(),
    onSuccess: () => {
      queryClient.setQueryData(PUBLIC_STATUS_PAGE_QUERY_KEY, { enabled: false, showPrices: false, hideExpired: false, hideLifetime: false });
    },
  });
}

/** 公开状态页读取不要求登录；低频刷新避免分享链接被当成高频探针打穿公开 API。 */
export function usePublicStatus(token: string | undefined) {
  const normalizedToken = token?.trim() ?? "";
  return useQuery({
    queryKey: publicStatusQueryKey(normalizedToken),
    queryFn: ({ signal }) => publicStatusService.readPublicStatus(normalizedToken, signal),
    enabled: normalizedToken.length > 0,
    retry: false,
    staleTime: PUBLIC_STATUS_REFETCH_INTERVAL_MS,
    refetchInterval: PUBLIC_STATUS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}
