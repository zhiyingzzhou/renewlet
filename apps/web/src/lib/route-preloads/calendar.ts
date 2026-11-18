import type { QueryClient } from "@tanstack/react-query";
import {
  subscriptionCalendarQueryOptions,
  subscriptionFacetsQueryOptions,
} from "@/hooks/use-subscriptions";
import { getSubscriptionCalendarRange } from "@/modules/subscriptions/domain/subscription-calendar-range";

export async function preload(queryClient: QueryClient): Promise<void> {
  const { from, to } = getSubscriptionCalendarRange(new Date());
  await Promise.all([
    queryClient.prefetchQuery(subscriptionCalendarQueryOptions(from, to, queryClient)),
    queryClient.prefetchQuery(subscriptionFacetsQueryOptions()),
  ]);
}
