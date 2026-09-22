import {
  SUBSCRIPTION_INDEX_LIMIT,
  subscriptionPayloadSchema,
  subscriptionFacetsPayloadSchema,
  subscriptionsAnalyticsPayloadSchema,
  subscriptionsCalendarPayloadSchema,
  subscriptionsCalendarQuerySchema,
  subscriptionsExportPayloadSchema,
  subscriptionsIndexPayloadSchema,
  subscriptionsIndexQuerySchema,
} from "@renewlet/shared/schemas/subscriptions";
import { requireAuth } from "./auth";
import {
  getSettings,
  getSubscription,
  listSubscriptions,
  toApiSubscription,
  toApiSubscriptionCollectionItem,
} from "./db";
import { HttpError, requestLocale, successJson } from "./http";
import { listBoundedSubscriptionsForQuery, type SubscriptionCollectionFilters } from "./subscription-list-filters";
import { readSubscriptionFacetsForUser } from "./subscription-facets";
import { subscriptionCollectionQueryInput, subscriptionSingleValueQueryInput } from "./subscription-query";
import { dateOnlyInZone } from "./subscription-renewal";
import { serverText } from "./server-i18n";
import type { Env, SubscriptionCollectionRow } from "./types";

export async function readSubscriptionIndex(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const filters = subscriptionsIndexQuerySchema.parse(subscriptionCollectionQueryInput(new URL(request.url).searchParams));
  const page = await readBoundedCollection(request, env, auth.user.id, filters);
  return successJson(subscriptionsIndexPayloadSchema.parse({
    subscriptions: page.rows.map(toApiSubscriptionCollectionItem),
    total: page.total,
  }));
}

export async function readSubscriptionAnalytics(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const page = await readBoundedCollection(request, env, auth.user.id, {});
  return successJson(subscriptionsAnalyticsPayloadSchema.parse({
    subscriptions: page.rows.map(toApiSubscriptionCollectionItem),
  }));
}

export async function readSubscriptionCalendar(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const url = new URL(request.url);
  const range = subscriptionsCalendarQuerySchema.parse(subscriptionSingleValueQueryInput(url.searchParams));
  const page = await readBoundedCollection(request, env, auth.user.id, {
    nextBillingFrom: range.from,
    nextBillingTo: range.to,
  });
  return successJson(subscriptionsCalendarPayloadSchema.parse({
    subscriptions: page.rows.map(toApiSubscriptionCollectionItem),
  }));
}

export async function readSubscriptionDetail(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  const row = await getSubscription(env, auth.user.id, id);
  if (!row) throw new HttpError(404, serverText(requestLocale(request), "subscription.notFound"));
  return successJson(subscriptionPayloadSchema.parse({ subscription: toApiSubscription(row) }));
}

export async function readSubscriptionExport(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const rows = await listSubscriptions(env, auth.user.id);
  return successJson(subscriptionsExportPayloadSchema.parse({ subscriptions: rows.map(toApiSubscription) }));
}

export async function readSubscriptionFacets(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const settings = await getSettings(env, auth.user.id);
  const today = dateOnlyInZone(new Date(), settings.timezone);
  return successJson(subscriptionFacetsPayloadSchema.parse(
    await readSubscriptionFacetsForUser(env, auth.user.id, today),
  ));
}

async function readBoundedCollection(
  request: Request,
  env: Env,
  userId: string,
  query: SubscriptionCollectionFilters,
): Promise<{ rows: SubscriptionCollectionRow[]; total: number }> {
  const today = dateOnlyInZone(new Date(), (await getSettings(env, userId)).timezone);
  const page = await listBoundedSubscriptionsForQuery(env, userId, query, today, SUBSCRIPTION_INDEX_LIMIT);
  if (page.exceeded) {
    // 5001 只用于发现超限；不能把前 5000 条作为“完整结果”返回给搜索或统计。
    throw new HttpError(
      422,
      serverText(requestLocale(request), "common.invalidRequestParameters"),
      "SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED",
      { limit: SUBSCRIPTION_INDEX_LIMIT },
    );
  }
  return page;
}
