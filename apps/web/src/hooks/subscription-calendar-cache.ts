import type { QueryClient } from "@tanstack/react-query";
import type { DateOnly } from "@/lib/time/date-only";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import { subscriptionQueryKeys } from "./subscription-query-cache";

function inCalendarRange(item: SubscriptionCollectionItem, from: DateOnly, to: DateOnly): boolean {
  if (item.status !== "active" && item.status !== "trial") return false;
  if (item.billingCycle === "one-time" && !item.oneTimeTermCount) return false;
  return (item.billingCycle !== "one-time" && item.nextBillingDate <= to)
    || (item.nextBillingDate >= from && item.nextBillingDate <= to)
    || (item.status === "trial" && !!item.trialEndDate && item.trialEndDate >= from && item.trialEndDate <= to);
}

/** 页面与路由预加载共用同一会话的完整、未失效集合并保留年龄；AuthSync 换号时删除整棵订阅缓存。 */
export function calendarInitialSnapshot(queryClient: QueryClient, from: DateOnly, to: DateOnly) {
  if (queryClient.getQueryData(subscriptionQueryKeys.calendar(from, to)) !== undefined) return undefined;
  const analytics = queryClient.getQueryState<SubscriptionCollectionItem[]>(subscriptionQueryKeys.analytics);
  if (analytics?.data && !analytics.isInvalidated) {
    return { data: analytics.data.filter((item) => inCalendarRange(item, from, to)), updatedAt: analytics.dataUpdatedAt };
  }
  const candidates = queryClient.getQueryCache().findAll({ queryKey: [...subscriptionQueryKeys.collections, "calendar"] });
  const source = candidates
    .filter(({ queryKey, state }) => typeof queryKey[3] === "string" && typeof queryKey[4] === "string"
      && queryKey[3] <= from && queryKey[4] >= to && state.data !== undefined && !state.isInvalidated)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0];
  if (!source) return undefined;
  const data = queryClient.getQueryData<SubscriptionCollectionItem[]>(source.queryKey);
  return data ? { data: data.filter((item) => inCalendarRange(item, from, to)), updatedAt: source.state.dataUpdatedAt } : undefined;
}
