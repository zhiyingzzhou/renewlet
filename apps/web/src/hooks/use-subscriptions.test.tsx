// subscriptions hook 测试保护产品 API 分页契约、CRUD 写入 payload 和 query invalidation 范围。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  apiSubscriptionCollectionItemSchema,
  apiSubscriptionSchema,
  subscriptionCreateBodySchema,
  subscriptionUpdateBodySchema,
  type ApiSubscription,
  type ApiSubscriptionCollectionItem,
} from "@/lib/api/schemas/subscriptions";
import type {
  BillingCycle,
  Subscription,
  SubscriptionDraft,
  SubscriptionFormSubmission,
} from "@/types/subscription";
import { fromApiSubscription, toSubscriptionCreatePayload } from "@/services/subscription-service";
import {
  useCreateSubscription,
  useDeleteSubscription,
  usePatchSubscription,
  useRenewSubscription,
  useSubscriptionCalendar,
  useSubscriptionIndex,
  useUpdateSubscription,
} from "./use-subscriptions";
import { subscriptionQueryKeys } from "./subscription-query-cache";
import { notificationQueryKeys } from "./notification-query-cache";

type RecurringSubscriptionDraft = Extract<
  SubscriptionDraft,
  { billingCycle: Exclude<BillingCycle, "custom" | "one-time"> }
>;

type ApiFetchMock = (url: string, schema: unknown, init?: RequestInit) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<ApiFetchMock>(),
  getProductCurrentUserId: vi.fn<() => string | null>(),
  readProductSessionSnapshot: vi.fn<() => { userId: string; expiresAt: string; verifiedAt: number } | null>(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api-client")>(),
  apiFetch: mocks.apiFetch,
}));

vi.mock("@/services/product-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/product-session")>(),
  getProductCurrentUserId: mocks.getProductCurrentUserId,
  readProductSessionSnapshot: mocks.readProductSessionSnapshot,
}));

function createWrapper(
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  }),
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function apiSubscriptionFromPayload(id: string, payload: unknown): ApiSubscription {
  const body = subscriptionCreateBodySchema.parse(payload);
  return apiSubscriptionSchema.parse({
    id,
    name: body.name,
    ...(body.logo ? { logo: body.logo } : {}),
    price: body.price,
    currency: body.currency,
    billingCycle: body.billingCycle,
    ...(body.billingCycle === "custom" && body.customDays !== null && body.customDays !== undefined
      ? { customDays: body.customDays, customCycleUnit: body.customCycleUnit }
      : {}),
    ...(body.billingCycle === "one-time" && body.oneTimeTermCount !== null && body.oneTimeTermCount !== undefined
      ? { oneTimeTermCount: body.oneTimeTermCount, oneTimeTermUnit: body.oneTimeTermUnit }
      : {}),
    category: body.category,
    status: body.status,
    pinned: body.pinned,
    publicHidden: body.publicHidden,
    ...(body.paymentMethod ? { paymentMethod: body.paymentMethod } : {}),
    startDate: body.startDate,
    nextBillingDate: body.nextBillingDate,
    autoRenew: body.autoRenew,
    autoCalculateNextBillingDate: body.autoCalculateNextBillingDate,
    ...(body.trialEndDate ? { trialEndDate: body.trialEndDate } : {}),
    ...(body.website ? { website: body.website } : {}),
    ...(body.notes ? { notes: body.notes } : {}),
    tags: body.tags ?? [],
    reminderDays: body.reminderDays,
    repeatReminderEnabled: body.repeatReminderEnabled,
    repeatReminderInterval: body.repeatReminderInterval,
    repeatReminderWindow: body.repeatReminderWindow,
    extra: body.extra ?? {},
  });
}

function apiSubscriptionFromDraft(id: string, draft: RecurringSubscriptionDraft): ApiSubscription {
  return apiSubscriptionFromPayload(id, toSubscriptionCreatePayload(draft));
}

function subscriptionFromDraft(id: string, draft: RecurringSubscriptionDraft): Subscription {
  return fromApiSubscription(apiSubscriptionFromDraft(id, draft));
}

function apiCollectionItemFromDraft(
  id: string,
  draft: RecurringSubscriptionDraft,
): ApiSubscriptionCollectionItem {
  const subscription = apiSubscriptionFromDraft(id, draft);
  const {
    website: _website,
    notes: _notes,
    tags: _tags,
    repeatReminderEnabled: _repeatReminderEnabled,
    repeatReminderInterval: _repeatReminderInterval,
    repeatReminderWindow: _repeatReminderWindow,
    extra: _extra,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...collectionItem
  } = subscription;
  return apiSubscriptionCollectionItemSchema.parse(collectionItem);
}

function subscriptionDraft(overrides: Partial<RecurringSubscriptionDraft> = {}): RecurringSubscriptionDraft {
  return {
    name: "Aws",
    logo: "https://aws.amazon.com/favicon.ico",
    price: "15",
    currency: "USD",
    billingCycle: "monthly",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-05-14"),
    nextBillingDate: assertDateOnly("2026-06-14"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    ...overrides,
  };
}

function formSubmission(draft: RecurringSubscriptionDraft): SubscriptionFormSubmission {
  const {
    pinned: _pinned,
    extra: _extra,
    ...submission
  } = draft;
  return submission;
}

function requestBody(callIndex: number): unknown {
  return JSON.parse(String(mocks.apiFetch.mock.calls[callIndex]?.[2]?.body));
}

describe("use-subscriptions mutations", () => {
  beforeEach(() => {
    mocks.readProductSessionSnapshot.mockReturnValue({ userId: "user-1", expiresAt: "2027-01-01T00:00:00Z", verifiedAt: 1 });
    mocks.apiFetch.mockReset();
    mocks.getProductCurrentUserId.mockReset();
    mocks.getProductCurrentUserId.mockReturnValue("user-1");
    mocks.apiFetch.mockImplementation(async (url: string, _schema: unknown, init?: RequestInit) => {
      const id = url.includes("/sub-1") ? "sub-1" : "sub-1";
      if (!init?.body) {
        return { subscription: apiSubscriptionFromDraft(id, subscriptionDraft()) };
      }
      const payload: unknown = JSON.parse(String(init.body));
      return { subscription: apiSubscriptionFromPayload(id, payload) };
    });
  });

  it("keeps tags as an empty array when creating a subscription through the product API", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateSubscription(), { wrapper: createWrapper(queryClient) });
    const draft = subscriptionDraft({ tags: [] });

    await act(async () => {
      await result.current.mutateAsync(draft);
    });

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "POST" });
    const payload = subscriptionCreateBodySchema.parse(requestBody(0));
    expect(payload).toMatchObject({
      name: "Aws",
      tags: [],
      repeatReminderEnabled: false,
      repeatReminderInterval: "1h",
      repeatReminderWindow: "72h",
      autoRenew: false,
    });
    expect(payload).not.toHaveProperty("user");
    expect(payload).not.toHaveProperty("trialEndDate");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: notificationQueryKeys.overview });
  });

  it("sends nullable start dates for manual recurring creates", async () => {
    const { result } = renderHook(() => useCreateSubscription(), { wrapper: createWrapper() });
    const draft = subscriptionDraft({
      startDate: null,
      nextBillingDate: assertDateOnly("2026-08-01"),
      autoCalculateNextBillingDate: false,
    });

    await act(async () => {
      await result.current.mutateAsync(draft);
    });

    expect(subscriptionCreateBodySchema.parse(requestBody(0))).toMatchObject({
      startDate: null,
      nextBillingDate: "2026-08-01",
      autoCalculateNextBillingDate: false,
    });
  });

  it("keeps tags as an empty array when updating a subscription through the product API", async () => {
    const { result } = renderHook(() => useUpdateSubscription(), { wrapper: createWrapper() });
    const draft = subscriptionDraft({ tags: [] });
    const subscription = subscriptionFromDraft("sub-1", draft);

    await act(async () => {
      await result.current.mutateAsync({ id: subscription.id, changes: formSubmission(draft) });
    });

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub-1");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "PATCH" });
    const payload = subscriptionUpdateBodySchema.parse(requestBody(0));
    expect(payload).toMatchObject({
      name: "Aws",
      tags: [],
      repeatReminderEnabled: false,
      repeatReminderInterval: "1h",
      repeatReminderWindow: "72h",
    });
    expect(payload).not.toHaveProperty("pinned");
    expect(payload).not.toHaveProperty("extra");
    expect(payload).not.toHaveProperty("trialEndDate");
  });

  it("invalidates notification overview after renewal", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      subscription: apiSubscriptionFromDraft("sub-1", subscriptionDraft({ nextBillingDate: assertDateOnly("2026-07-14") })),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRenewSubscription(), { wrapper: createWrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync({
        id: "sub-1",
        payload: {
          mode: "continue",
          expectedNextBillingDate: "2026-06-14",
          expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
          price: "15",
          currency: "USD",
          startDate: null,
          nextBillingDate: assertDateOnly("2026-07-14"),
          autoCalculateNextBillingDate: true,
        },
      });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: notificationQueryKeys.overview });
  });

  it.each(["logout", "switch", "verify"])("isolates late renewal results across %s", async (change) => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let release!: (value: unknown) => void;
    mocks.apiFetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { result } = renderHook(() => useRenewSubscription(), { wrapper: createWrapper(queryClient) });
    let outcome: unknown;
    await act(async () => {
      const pending = result.current.mutateAsync({ id: "sub-1", payload: {
        mode: "continue", expectedNextBillingDate: "2026-06-14", expectedUpdatedAt: "2026-01-01T00:00:00Z",
        price: "15", currency: "USD", startDate: null, nextBillingDate: "2026-07-14", autoCalculateNextBillingDate: false,
      } }).then(() => "saved", (error: unknown) => error);
      await Promise.resolve();
      mocks.readProductSessionSnapshot.mockReturnValue(change === "logout" ? null : {
        userId: change === "switch" ? "user-2" : "user-1", expiresAt: "2027-01-01T00:00:00Z", verifiedAt: 2,
      });
      release({ subscription: apiSubscriptionFromDraft("sub-1", subscriptionDraft()) });
      outcome = await pending;
    });
    if (change === "verify") {
      expect(outcome).toBe("saved");
      expect(queryClient.getQueryData(subscriptionQueryKeys.detail("sub-1"))).toBeDefined();
    } else {
      expect(outcome).toMatchObject({ code: "aborted" });
      expect(queryClient.getQueryData(subscriptionQueryKeys.detail("sub-1"))).toBeUndefined();
    }
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("sends only quick-action fields through the patch mutation", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      subscription: apiSubscriptionFromDraft("sub-1", subscriptionDraft({ pinned: true })),
    });
    const { result } = renderHook(() => usePatchSubscription(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.mutateAsync({ id: "sub-1", patch: { pinned: true } });
    });

    const init = mocks.apiFetch.mock.calls[0]?.[2];
    const payload = subscriptionUpdateBodySchema.parse(requestBody(0));
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub-1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(payload).toEqual({ pinned: true });
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("nextBillingDate");
  });

  it("writes mutation results and invalidates notification overview for full edits", async () => {
    const updated = apiSubscriptionFromDraft("sub-1", subscriptionDraft({ name: "Updated", status: "cancelled" }));
    mocks.apiFetch.mockResolvedValueOnce({ subscription: updated });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateSubscription(), { wrapper });
    const updatedDraft = subscriptionDraft({ name: "Updated", status: "cancelled" });
    const updatedSubscription = subscriptionFromDraft("sub-1", updatedDraft);

    await act(async () => {
      await result.current.mutateAsync({
        id: updatedSubscription.id,
        changes: formSubmission(updatedDraft),
      });
    });

    expect(queryClient.getQueryData<Subscription>(subscriptionQueryKeys.detail("sub-1"))?.name).toBe("Updated");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: subscriptionQueryKeys.collections });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: notificationQueryKeys.overview });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: subscriptionQueryKeys.details });
  });

  it("does not invalidate notification overview for display-only patches", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      subscription: apiSubscriptionFromDraft("sub-1", subscriptionDraft({ pinned: true })),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePatchSubscription(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: "sub-1", patch: { pinned: true } });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: subscriptionQueryKeys.collections });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: notificationQueryKeys.overview });
  });

  it("removes a deleted detail cache entry before invalidating collections", async () => {
    mocks.apiFetch.mockResolvedValueOnce({});
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(
      subscriptionQueryKeys.detail("sub-1"),
      subscriptionFromDraft("sub-1", subscriptionDraft()),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteSubscription(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("sub-1");
    });

    expect(queryClient.getQueryData(subscriptionQueryKeys.detail("sub-1"))).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: subscriptionQueryKeys.collections });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: notificationQueryKeys.overview });
  });
});

describe("use-subscriptions collection queries", () => {
  beforeEach(() => {
    mocks.readProductSessionSnapshot.mockReturnValue({ userId: "user-1", expiresAt: "2027-01-01T00:00:00Z", verifiedAt: 1 });
    mocks.apiFetch.mockReset();
    mocks.getProductCurrentUserId.mockReset();
    mocks.getProductCurrentUserId.mockReturnValue("user-1");
  });

  it("loads a 1000-row search index with one request and no pagination waterfall", async () => {
    const subscriptions = Array.from({ length: 1000 }, (_, index) =>
      apiCollectionItemFromDraft(`sub-${index}`, subscriptionDraft({ name: `Layout ${index}` })));
    mocks.apiFetch.mockResolvedValue({ subscriptions, total: subscriptions.length });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSubscriptionIndex({ q: "layout" }), { wrapper });

    await waitFor(() => expect(result.current.data?.subscriptions).toHaveLength(1000));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/index?q=layout");
    expect(queryClient.getQueryCache().findAll({
      queryKey: ["subscriptions", "collections", "index"],
    })).toHaveLength(1);
  });

  it("keeps the last calendar result while newer ranges load and cancels superseded requests", async () => {
    type CalendarResponse = { subscriptions: ApiSubscriptionCollectionItem[] };
    let resolveJune: ((value: CalendarResponse) => void) | undefined;
    let resolveJuly: ((value: CalendarResponse) => void) | undefined;
    let juneSignal: AbortSignal | undefined;
    const mayItem = apiCollectionItemFromDraft(
      "may",
      subscriptionDraft({ nextBillingDate: assertDateOnly("2026-05-14") }),
    );
    const juneItem = apiCollectionItemFromDraft(
      "june",
      subscriptionDraft({ nextBillingDate: assertDateOnly("2026-06-14") }),
    );
    const julyItem = apiCollectionItemFromDraft(
      "july",
      subscriptionDraft({ nextBillingDate: assertDateOnly("2026-07-14") }),
    );

    mocks.apiFetch.mockImplementation((url: string, _schema: unknown, init?: RequestInit) => {
      if (url.includes("from=2026-05-01")) return Promise.resolve({ subscriptions: [mayItem] });
      if (url.includes("from=2026-06-01")) {
        juneSignal = init?.signal ?? undefined;
        return new Promise((resolve) => {
          resolveJune = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveJuly = resolve;
      });
    });

    const { result, rerender } = renderHook(
      ({ from, to }: { from: string; to: string }) =>
        useSubscriptionCalendar(assertDateOnly(from), assertDateOnly(to)),
      {
        initialProps: { from: "2026-05-01", to: "2026-05-31" },
        wrapper: createWrapper(),
      },
    );

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(result.current.data?.[0]?.id).toBe("may"));

    rerender({ from: "2026-06-01", to: "2026-06-30" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.isPending).toBe(false);
    expect(result.current.isFetching).toBe(true);
    expect(result.current.data?.[0]?.id).toBe("may");

    rerender({ from: "2026-07-01", to: "2026-07-31" });
    await waitFor(() => expect(juneSignal?.aborted).toBe(true));
    await waitFor(() => expect(resolveJuly).toBeTypeOf("function"));
    expect(result.current.data?.[0]?.id).toBe("may");

    await act(async () => {
      resolveJune?.({ subscriptions: [juneItem] });
      resolveJuly?.({ subscriptions: [julyItem] });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.data?.[0]?.id).toBe("july"));
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.isFetching).toBe(false);
  });

  it("aborts an in-flight index request when its last observer unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    mocks.apiFetch.mockImplementation((_url: string, _schema: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    });

    const { unmount } = renderHook(() => useSubscriptionIndex({ q: "stale" }), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));
    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});
