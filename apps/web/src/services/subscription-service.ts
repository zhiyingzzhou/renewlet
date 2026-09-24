import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { apiFetch } from "@/lib/api-client";
import { assertDateOnly, type DateOnly } from "@/lib/time/date-only";
import { getCurrentUserId } from "@/lib/pocketbase";
import type {
  Subscription,
  SubscriptionCollectionItem,
  SubscriptionDraft,
  SubscriptionFormSubmission,
} from "@/types/subscription";
import {
  apiSubscriptionCollectionItemSchema,
  apiSubscriptionSchema,
  subscriptionDeleteResponseSchema,
  subscriptionFacetsResponseSchema,
  subscriptionResponseSchema,
  subscriptionsAnalyticsResponseSchema,
  subscriptionsCalendarResponseSchema,
  subscriptionsExportResponseSchema,
  subscriptionsIndexResponseSchema,
  subscriptionsListResponseSchema,
  type ApiSubscription,
  type ApiSubscriptionCollectionItem,
  type SubscriptionFacetsResponse,
  type SubscriptionRenewBody,
  type SubscriptionsListQuery,
} from "@renewlet/shared/schemas/subscriptions";

const SUBSCRIPTION_PAGE_SIZE = 50;
export type SubscriptionListFilters = Omit<SubscriptionsListQuery, "limit" | "cursor">;

type SubscriptionCollectionBaseForService = Pick<
  SubscriptionCollectionItem,
  | "id"
  | "name"
  | "logo"
  | "price"
  | "currency"
  | "category"
  | "status"
  | "paymentMethod"
  | "startDate"
  | "nextBillingDate"
  | "autoRenew"
  | "autoCalculateNextBillingDate"
  | "pinned"
  | "publicHidden"
  | "trialEndDate"
  | "reminderDays"
  | "costSharing"
>;

type SubscriptionDetailFieldsForService = Pick<
  Subscription,
  | "website"
  | "notes"
  | "tags"
  | "repeatReminderEnabled"
  | "repeatReminderInterval"
  | "repeatReminderWindow"
  | "extra"
>;

export interface SubscriptionPage {
  subscriptions: SubscriptionCollectionItem[];
  nextCursor: string | null;
  total: number;
}

export interface SubscriptionIndex {
  subscriptions: SubscriptionCollectionItem[];
  total: number;
}

export type SubscriptionFacets = SubscriptionFacetsResponse;
export type SubscriptionFieldPatch = Partial<Pick<SubscriptionCollectionItem, "pinned" | "publicHidden">>;

function normalizeSubscriptionPageLimit(value: number): number {
  if (!Number.isFinite(value)) return SUBSCRIPTION_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(value), 100));
}

function appendSubscriptionListFilters(params: URLSearchParams, filters?: SubscriptionListFilters): void {
  if (!filters) return;
  if (filters.q) params.set("q", filters.q);
  for (const value of filters.category ?? []) params.append("category", value);
  for (const value of filters.tag ?? []) params.append("tag", value);
  for (const value of filters.billingCycle ?? []) params.append("billingCycle", value);
  for (const value of filters.paymentMethod ?? []) params.append("paymentMethod", value);
  for (const value of filters.currency ?? []) params.append("currency", value);
  if (filters.status) params.set("status", filters.status);
  if (filters.paymentType) params.set("paymentType", filters.paymentType);
  if (filters.nextBillingFrom) params.set("nextBillingFrom", filters.nextBillingFrom);
  if (filters.nextBillingTo) params.set("nextBillingTo", filters.nextBillingTo);
  if (filters.pinned !== undefined) params.set("pinned", String(filters.pinned));
  if (filters.publicHidden !== undefined) params.set("publicHidden", String(filters.publicHidden));
  if (filters.reminderMode) params.set("reminderMode", filters.reminderMode);
  if (filters.repeatReminder !== undefined) params.set("repeatReminder", String(filters.repeatReminder));
}

function fromApiSubscriptionCollectionBase(
  parsedRow: ApiSubscriptionCollectionItem,
): SubscriptionCollectionBaseForService {
  return {
    id: parsedRow.id,
    name: parsedRow.name,
    logo: parsedRow.logo,
    price: parsedRow.price,
    currency: parsedRow.currency,
    category: parsedRow.category,
    status: parsedRow.status,
    paymentMethod: parsedRow.paymentMethod,
    startDate: parsedRow.startDate === null ? null : assertDateOnly(parsedRow.startDate),
    nextBillingDate: assertDateOnly(parsedRow.nextBillingDate),
    autoRenew: parsedRow.billingCycle === "one-time" ? false : parsedRow.autoRenew,
    autoCalculateNextBillingDate: parsedRow.billingCycle === "one-time"
      ? false
      : parsedRow.autoCalculateNextBillingDate,
    pinned: parsedRow.pinned,
    publicHidden: parsedRow.publicHidden,
    trialEndDate: parsedRow.trialEndDate ? assertDateOnly(parsedRow.trialEndDate) : undefined,
    reminderDays: parsedRow.reminderDays,
    costSharing: parsedRow.costSharing,
  };
}

function fromApiSubscriptionDetailFields(parsedRow: ApiSubscription): SubscriptionDetailFieldsForService {
  return {
    website: parsedRow.website,
    notes: parsedRow.notes,
    tags: parsedRow.tags,
    repeatReminderEnabled: parsedRow.repeatReminderEnabled,
    repeatReminderInterval: parsedRow.repeatReminderInterval,
    repeatReminderWindow: parsedRow.repeatReminderWindow,
    extra: parsedRow.extra,
  };
}

function withCollectionBillingCycle(
  parsedRow: ApiSubscriptionCollectionItem,
  base: SubscriptionCollectionBaseForService,
): SubscriptionCollectionItem {
  if (parsedRow.billingCycle === "custom") {
    return {
      ...base,
      billingCycle: "custom",
      customDays: parsedRow.customDays,
      customCycleUnit: parsedRow.customCycleUnit,
    };
  }
  if (parsedRow.billingCycle === "one-time") {
    if (parsedRow.oneTimeTermCount !== undefined) {
      return {
        ...base,
        billingCycle: "one-time",
        oneTimeTermCount: parsedRow.oneTimeTermCount,
        oneTimeTermUnit: parsedRow.oneTimeTermUnit,
      };
    }
    return {
      ...base,
      billingCycle: "one-time",
    };
  }
  return {
    ...base,
    billingCycle: parsedRow.billingCycle,
  };
}

function fromParsedApiSubscriptionCollectionItem(
  parsedRow: ApiSubscriptionCollectionItem,
): SubscriptionCollectionItem {
  return withCollectionBillingCycle(parsedRow, fromApiSubscriptionCollectionBase(parsedRow));
}

export function fromApiSubscriptionCollectionItem(row: unknown): SubscriptionCollectionItem {
  return fromParsedApiSubscriptionCollectionItem(apiSubscriptionCollectionItemSchema.parse(row));
}

function fromParsedApiSubscription(parsedRow: ApiSubscription): Subscription {
  const collection = withCollectionBillingCycle(parsedRow, fromApiSubscriptionCollectionBase(parsedRow));
  const detail = fromApiSubscriptionDetailFields(parsedRow);
  if (collection.billingCycle === "custom") return { ...collection, ...detail };
  if (collection.billingCycle === "one-time") return { ...collection, ...detail };
  return { ...collection, ...detail };
}

export function fromApiSubscription(row: unknown): Subscription {
  return fromParsedApiSubscription(apiSubscriptionSchema.parse(row));
}

/**
 * `null` 表示清空可选字段，`undefined` 表示字段缺席；这里主动使用 null，
 * 防止 PocketBase patch 和 Worker JSON merge 对可选字段产生不同语义。
 */
function toSubscriptionFormPayload(submission: SubscriptionFormSubmission) {
  return {
    name: submission.name,
    logo: submission.logo ?? null,
    price: submission.price,
    currency: submission.currency,
    billingCycle: submission.billingCycle,
    customDays: submission.customDays ?? null,
    customCycleUnit: submission.customCycleUnit ?? null,
    oneTimeTermCount: submission.oneTimeTermCount ?? null,
    oneTimeTermUnit: submission.oneTimeTermUnit ?? null,
    category: submission.category,
    status: submission.status,
    paymentMethod: submission.paymentMethod ?? null,
    startDate: submission.startDate,
    nextBillingDate: submission.nextBillingDate,
    autoRenew: submission.billingCycle === "one-time" ? false : submission.autoRenew,
    autoCalculateNextBillingDate: submission.autoCalculateNextBillingDate,
    publicHidden: submission.publicHidden,
    website: submission.website ?? null,
    notes: submission.notes ?? null,
    tags: submission.tags,
    reminderDays: submission.reminderDays,
    repeatReminderEnabled: submission.repeatReminderEnabled,
    repeatReminderInterval: submission.repeatReminderInterval,
    repeatReminderWindow: submission.repeatReminderWindow,
    costSharing: submission.costSharing ?? null,
  };
}

export function toSubscriptionCreatePayload(draft: SubscriptionDraft) {
  const payload = {
    ...toSubscriptionFormPayload(draft),
    pinned: draft.pinned,
  };
  return draft.extra === undefined ? payload : { ...payload, extra: draft.extra };
}

export function toSubscriptionUpdatePayload(changes: SubscriptionFormSubmission) {
  // 表单更新刻意省略 pinned、extra 与 trialEndDate；它们不归普通表单所有，PATCH 必须保留服务端当前值。
  return toSubscriptionFormPayload(changes);
}

function toSubscriptionFieldPatchPayload(patch: SubscriptionFieldPatch) {
  const payload: Record<string, boolean> = {};
  if (patch.pinned !== undefined) payload["pinned"] = patch.pinned;
  if (patch.publicHidden !== undefined) payload["publicHidden"] = patch.publicHidden;
  if (Object.keys(payload).length === 0) throw new Error("SUBSCRIPTION_PATCH_EMPTY");
  return payload;
}

function signalInit(signal?: AbortSignal): RequestInit | undefined {
  return signal ? { signal } : undefined;
}

export const subscriptionService = {
  pageSize: SUBSCRIPTION_PAGE_SIZE,

  async listPage(
    cursor?: string | null,
    limit = SUBSCRIPTION_PAGE_SIZE,
    filters?: SubscriptionListFilters,
    signal?: AbortSignal,
  ): Promise<SubscriptionPage> {
    if (!getCurrentUserId()) return { subscriptions: [], nextCursor: null, total: 0 };
    const params = new URLSearchParams({ limit: String(normalizeSubscriptionPageLimit(limit)) });
    if (cursor) params.set("cursor", cursor);
    appendSubscriptionListFilters(params, filters);
    const data = await apiFetch(
      `/api/app/subscriptions?${params.toString()}`,
      subscriptionsListResponseSchema,
      signalInit(signal),
    );
    return {
      subscriptions: data.subscriptions.map(fromParsedApiSubscriptionCollectionItem),
      nextCursor: data.nextCursor,
      total: data.total,
    };
  },

  async index(filters?: SubscriptionListFilters, signal?: AbortSignal): Promise<SubscriptionIndex> {
    if (!getCurrentUserId()) return { subscriptions: [], total: 0 };
    const params = new URLSearchParams();
    appendSubscriptionListFilters(params, filters);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const data = await apiFetch(`/api/app/subscriptions/index${suffix}`, subscriptionsIndexResponseSchema, signalInit(signal));
    return {
      subscriptions: data.subscriptions.map(fromParsedApiSubscriptionCollectionItem),
      total: data.total,
    };
  },

  async analytics(signal?: AbortSignal): Promise<SubscriptionCollectionItem[]> {
    if (!getCurrentUserId()) return [];
    const data = await apiFetch("/api/app/subscriptions/analytics", subscriptionsAnalyticsResponseSchema, signalInit(signal));
    return data.subscriptions.map(fromParsedApiSubscriptionCollectionItem);
  },

  async calendar(from: DateOnly, to: DateOnly, signal?: AbortSignal): Promise<SubscriptionCollectionItem[]> {
    if (!getCurrentUserId()) return [];
    const params = new URLSearchParams({ from, to });
    const data = await apiFetch(`/api/app/subscriptions/calendar?${params.toString()}`, subscriptionsCalendarResponseSchema, signalInit(signal));
    return data.subscriptions.map(fromParsedApiSubscriptionCollectionItem);
  },

  async facets(signal?: AbortSignal): Promise<SubscriptionFacets> {
    if (!getCurrentUserId()) {
      return { total: 0, categoryCounts: {}, tags: [], visibleCount: 0, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 };
    }
    return await apiFetch("/api/app/subscriptions/facets", subscriptionFacetsResponseSchema, signalInit(signal));
  },

  async detail(id: string, signal?: AbortSignal): Promise<Subscription> {
    const data = await apiFetch(`/api/app/subscriptions/${id}`, subscriptionResponseSchema, signalInit(signal));
    return fromParsedApiSubscription(data.subscription);
  },

  async exportAll(signal?: AbortSignal): Promise<Subscription[]> {
    if (!getCurrentUserId()) return [];
    const data = await apiFetch("/api/app/subscriptions/export", subscriptionsExportResponseSchema, signalInit(signal));
    return data.subscriptions.map(fromParsedApiSubscription);
  },

  async create(sub: SubscriptionDraft): Promise<Subscription> {
    if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
    const data = await apiFetch("/api/app/subscriptions", subscriptionResponseSchema, {
      method: "POST",
      body: JSON.stringify(toSubscriptionCreatePayload(sub)),
    });
    return fromParsedApiSubscription(data.subscription);
  },

  async update(id: string, changes: SubscriptionFormSubmission): Promise<Subscription> {
    const data = await apiFetch(`/api/app/subscriptions/${id}`, subscriptionResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(toSubscriptionUpdatePayload(changes)),
    });
    return fromParsedApiSubscription(data.subscription);
  },

  async patch(id: string, patch: SubscriptionFieldPatch): Promise<Subscription> {
    const data = await apiFetch(`/api/app/subscriptions/${id}`, subscriptionResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(toSubscriptionFieldPatchPayload(patch)),
    });
    return fromParsedApiSubscription(data.subscription);
  },

  async renew(id: string, payload: SubscriptionRenewBody): Promise<Subscription> {
    const data = await apiFetch(`/api/app/subscriptions/${id}/renew`, subscriptionResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return fromParsedApiSubscription(data.subscription);
  },

  async delete(id: string): Promise<void> {
    await apiFetch(`/api/app/subscriptions/${id}`, subscriptionDeleteResponseSchema, { method: "DELETE" });
  },
};
