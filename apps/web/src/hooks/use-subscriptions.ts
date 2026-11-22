import { ApiError } from "@/lib/api-client";
import { isSameProductSession, readProductSessionSnapshot } from "@/services/product-session";
import { useMemo } from "react";
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
} from "@tanstack/react-query";
import {
  subscriptionService,
  type SubscriptionFieldPatch,
  type SubscriptionListFilters,
} from "@/services/subscription-service";
import type { DateOnly } from "@/lib/time/date-only";
import type { Subscription, SubscriptionDraft, SubscriptionEditSubmission } from "@/types/subscription";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";
import {
  invalidateSubscriptionCollections,
  subscriptionQueryKeys,
} from "@/hooks/subscription-query-cache";
import { invalidateNotificationOverview } from "@/hooks/notification-query-cache";

import { calendarInitialSnapshot } from "./subscription-calendar-cache";

const SUBSCRIPTIONS_STALE_TIME_MS = 60_000;
const INITIAL_SUBSCRIPTION_CURSOR: string | null = null;

interface UseInfiniteSubscriptionsOptions {
  enabled?: boolean;
  filters?: SubscriptionListFilters | undefined;
}

export interface UpdateSubscriptionCommand {
  id: string;
  changes: SubscriptionEditSubmission;
}

export function subscriptionsInfiniteQueryOptions(filters?: SubscriptionListFilters) {
  const queryKey = subscriptionQueryKeys.page(filters);
  return infiniteQueryOptions({
    queryKey,
    initialPageParam: INITIAL_SUBSCRIPTION_CURSOR,
    queryFn: ({ pageParam, signal }: QueryFunctionContext<typeof queryKey, string | null>) =>
      subscriptionService.listPage(pageParam, subscriptionService.pageSize, filters, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function subscriptionDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: subscriptionQueryKeys.detail(id),
    queryFn: ({ signal }) => subscriptionService.detail(id, signal),
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function subscriptionAnalyticsQueryOptions() {
  return queryOptions({
    queryKey: subscriptionQueryKeys.analytics,
    queryFn: ({ signal }) => subscriptionService.analytics(signal),
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function subscriptionCalendarQueryOptions(from: DateOnly, to: DateOnly, queryClient: QueryClient) {
  const initial = calendarInitialSnapshot(queryClient, from, to);
  return queryOptions({
    ...(initial ? { initialData: initial.data, initialDataUpdatedAt: initial.updatedAt } : {}),
    queryKey: subscriptionQueryKeys.calendar(from, to),
    queryFn: ({ signal }) => subscriptionService.calendar(from, to, signal),
    // 月份范围属于缓存身份；换月沿用上一份成功结果，避免参数切换退回首次加载态。
    placeholderData: keepPreviousData,
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function subscriptionFacetsQueryOptions() {
  return queryOptions({
    queryKey: subscriptionQueryKeys.facets,
    queryFn: ({ signal }) => subscriptionService.facets(signal),
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

/** 列表页只显式加载下一页；统计、日历和设置不再复用这条分页数据流。 */
export function useInfiniteSubscriptions(options: UseInfiniteSubscriptionsOptions = {}) {
  const query = useInfiniteQuery({
    ...subscriptionsInfiniteQueryOptions(options.filters),
    enabled: options.enabled ?? true,
  });
  const subscriptions = useMemo(
    () => query.data?.pages.flatMap((page) => page.subscriptions) ?? [],
    [query.data?.pages],
  );
  // 只读取列表实际消费的 Query 属性；展开整个结果会订阅 isFetching 等无关变化，让相同数据的后台刷新也重渲染。
  return {
    subscriptions,
    total: query.data?.pages[0]?.total ?? 0,
    isPending: query.isPending,
    error: query.error,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
  };
}

export function subscriptionIndexQueryOptions(filters?: SubscriptionListFilters) {
  return queryOptions({
    queryKey: subscriptionQueryKeys.index(filters),
    queryFn: ({ signal }) => subscriptionService.index(filters, signal),
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function useSubscriptionIndex(filters?: SubscriptionListFilters, enabled = true) {
  return useQuery({ ...subscriptionIndexQueryOptions(filters), enabled });
}

export function useSubscriptionAnalytics() {
  return useQuery(subscriptionAnalyticsQueryOptions());
}

export function useSubscriptionCalendar(from: DateOnly, to: DateOnly) {
  const queryClient = useQueryClient();
  return useQuery(subscriptionCalendarQueryOptions(from, to, queryClient));
}

export function useSubscriptionFacets() {
  return useQuery(subscriptionFacetsQueryOptions());
}

export function useSubscriptionDetail(id: string | null, enabled = true) {
  return useQuery({
    ...subscriptionDetailQueryOptions(id ?? ""),
    enabled: enabled && Boolean(id),
  });
}

export function prefetchSubscriptionDetail(queryClient: QueryClient, id: string) {
  return queryClient.prefetchQuery(subscriptionDetailQueryOptions(id));
}

/** mutation 返回的完整 DTO 直接写 detail；集合派生数据统一由 collections 前缀失效。 */
function writeSubscriptionMutationResult(queryClient: QueryClient, subscription: Subscription): void {
  queryClient.setQueryData(subscriptionQueryKeys.detail(subscription.id), subscription);
  void invalidateSubscriptionCollections(queryClient);
}

function writeNotificationAffectingSubscriptionMutationResult(queryClient: QueryClient, subscription: Subscription): void {
  writeSubscriptionMutationResult(queryClient, subscription);
  void invalidateNotificationOverview(queryClient);
}

async function writeStatusChange(queryClient: QueryClient, subscription: Subscription) {
  queryClient.setQueryData(subscriptionQueryKeys.detail(subscription.id), subscription);
  // 状态筛选可能移除触发按钮；先等列表刷新，再由菜单或弹窗选择仍在页面上的焦点目标。
  await Promise.all([invalidateSubscriptionCollections(queryClient), invalidateNotificationOverview(queryClient)]);
}

export function useCreateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sub: SubscriptionDraft) => subscriptionService.create(sub),
    onSuccess: (subscription) => writeNotificationAffectingSubscriptionMutationResult(queryClient, subscription),
  });
}

async function writeInCurrentSession(write: () => Promise<Subscription>) {
  const session = readProductSessionSnapshot();
  const result = await write();
  // 退出/换号清缓存后，旧写请求不能把上一账号的详情重新放入共享 QueryClient。
  if (!isSameProductSession(session, readProductSessionSnapshot())) throw new ApiError("Session changed", 0, undefined, "aborted");
  return result;
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }: UpdateSubscriptionCommand) =>
      writeInCurrentSession(() => subscriptionService.update(id, changes)),
    retry: false,
    onError: (error, { id }) => {
      if (error instanceof ApiError && (error.status === 409 || error.status === 0 || error.code === "invalid_response")) {
        void queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.detail(id) });
        void invalidateSubscriptionCollections(queryClient);
        void invalidateNotificationOverview(queryClient);
      }
    },
    onSuccess: (subscription, { changes }) => changes.source.status === subscription.status
      ? writeNotificationAffectingSubscriptionMutationResult(queryClient, subscription)
      : writeStatusChange(queryClient, subscription),
  });
}

export function usePatchSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SubscriptionFieldPatch }) =>
      writeInCurrentSession(() => subscriptionService.patch(id, patch)),
    retry: false,
    onSuccess: async (subscription, { patch }) => {
      if ("status" in patch) {
        await writeStatusChange(queryClient, subscription);
      } else {
        writeSubscriptionMutationResult(queryClient, subscription);
      }
    },
  });
}

export function useRenewSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: ({ id, payload }: { id: string; payload: SubscriptionRenewBody }) =>
      writeInCurrentSession(() => subscriptionService.renew(id, payload)),
    onSuccess: (subscription) => writeNotificationAffectingSubscriptionMutationResult(queryClient, subscription),
  });
}

export function useDeleteSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => subscriptionService.delete(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: subscriptionQueryKeys.detail(id), exact: true });
      void invalidateSubscriptionCollections(queryClient);
      void invalidateNotificationOverview(queryClient);
    },
  });
}
