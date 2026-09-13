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
import type { Subscription, SubscriptionDraft, SubscriptionFormSubmission } from "@/types/subscription";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";
import {
  invalidateSubscriptionCollections,
  subscriptionQueryKeys,
} from "@/hooks/subscription-query-cache";

const SUBSCRIPTIONS_STALE_TIME_MS = 60_000;
const INITIAL_SUBSCRIPTION_CURSOR: string | null = null;

interface UseInfiniteSubscriptionsOptions {
  enabled?: boolean;
  filters?: SubscriptionListFilters | undefined;
}

export interface UpdateSubscriptionCommand {
  id: string;
  changes: SubscriptionFormSubmission;
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

export function subscriptionCalendarQueryOptions(from: DateOnly, to: DateOnly) {
  return queryOptions({
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

export function useSubscriptionIndex(filters?: SubscriptionListFilters, enabled = true) {
  return useQuery({
    queryKey: subscriptionQueryKeys.index(filters),
    queryFn: ({ signal }) => subscriptionService.index(filters, signal),
    enabled,
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function useSubscriptionAnalytics() {
  return useQuery(subscriptionAnalyticsQueryOptions());
}

export function useSubscriptionCalendar(from: DateOnly, to: DateOnly) {
  return useQuery(subscriptionCalendarQueryOptions(from, to));
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

export function useCreateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sub: SubscriptionDraft) => subscriptionService.create(sub),
    onSuccess: (subscription) => writeSubscriptionMutationResult(queryClient, subscription),
  });
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }: UpdateSubscriptionCommand) =>
      subscriptionService.update(id, changes),
    onSuccess: (subscription) => writeSubscriptionMutationResult(queryClient, subscription),
  });
}

export function usePatchSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SubscriptionFieldPatch }) =>
      subscriptionService.patch(id, patch),
    onSuccess: (subscription) => writeSubscriptionMutationResult(queryClient, subscription),
  });
}

export function useRenewSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SubscriptionRenewBody }) =>
      subscriptionService.renew(id, payload),
    onSuccess: (subscription) => writeSubscriptionMutationResult(queryClient, subscription),
  });
}

export function useDeleteSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => subscriptionService.delete(id),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: subscriptionQueryKeys.detail(id), exact: true });
      void invalidateSubscriptionCollections(queryClient);
    },
  });
}
