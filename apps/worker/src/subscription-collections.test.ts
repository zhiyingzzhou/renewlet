import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionCollectionContractFixture } from "@renewlet/shared/contract-fixtures";
import {
  subscriptionFacetsPayloadSchema,
  subscriptionPayloadSchema,
  subscriptionsExportPayloadSchema,
  subscriptionsIndexPayloadSchema,
} from "@renewlet/shared/schemas/subscriptions";
import { readSuccessData } from "./api-test-helpers";
import {
  readSubscriptionAnalytics,
  readSubscriptionCalendar,
  readSubscriptionDetail,
  readSubscriptionExport,
  readSubscriptionFacets,
  readSubscriptionIndex,
} from "./subscription-collections";
import type { SubscriptionFacetsResult } from "./subscription-facets";
import type { Env } from "./types";
import { dateOnlyInZone } from "./subscription-renewal";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  listBoundedSubscriptionsForQuery: vi.fn(),
  readSubscriptionFacetsForUser: vi.fn<(env: Env, userId: string) => Promise<SubscriptionFacetsResult>>(),
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("./subscription-list-filters", () => ({
  listBoundedSubscriptionsForQuery: mocks.listBoundedSubscriptionsForQuery,
}));
vi.mock("./subscription-facets", () => ({
  readSubscriptionFacetsForUser: mocks.readSubscriptionFacetsForUser,
}));
vi.mock("./db", () => ({
  getSettings: mocks.getSettings,
  getSubscription: mocks.getSubscription,
  listSubscriptions: mocks.listSubscriptions,
  toApiSubscription: (row: unknown) => row,
  toApiSubscriptionCollectionItem: (row: unknown) => row,
}));

const USER_ID = "usr_collection_owner";

const { collectionItems, completeSubscription } = subscriptionCollectionContractFixture;
const recurringCollectionItem = collectionItems.find((item) => item.billingCycle === "monthly");
if (!recurringCollectionItem) throw new Error("Missing recurring collection contract fixture");

function request(path: string): Request {
  return new Request(`https://renewlet.test${path}`, {
    headers: { authorization: "Bearer test" },
  });
}

function envFixture(): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  } satisfies Env;
}

describe("Cloudflare subscription collection routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // facets 按账号时区的业务日期计数；固定时钟避免测试随执行日跨午夜漂移。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T23:30:00Z"));
    mocks.requireAuth.mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "ses" },
    });
    mocks.getSettings.mockResolvedValue({ timezone: "UTC" });
    mocks.getSubscription.mockResolvedValue(completeSubscription);
    mocks.listSubscriptions.mockResolvedValue([completeSubscription]);
    mocks.listBoundedSubscriptionsForQuery.mockResolvedValue({
      rows: collectionItems,
      total: collectionItems.length,
      exceeded: false,
    });
    mocks.readSubscriptionFacetsForUser.mockResolvedValue({
      total: 2,
      categoryCounts: { productivity: 2 },
      tags: ["AI", "Team"],
      visibleCount: 1,
      hiddenCount: 1, expiredCount: 0, lifetimeCount: 0,
    });
  });

  afterEach(() => vi.useRealTimers());

  it("reads one filtered index request as lightweight items without pagination parameters", async () => {
    const env = envFixture();
    const response = await readSubscriptionIndex(
      request("/api/app/subscriptions/index?q=collection&category=productivity"),
      env,
    );
    const data = subscriptionsIndexPayloadSchema.parse(await readSuccessData<unknown>(response));

    expect(data.total).toBe(collectionItems.length);
    expect(data.subscriptions).toEqual(collectionItems);
    expect(data.subscriptions[0]).not.toHaveProperty("website");
    expect(mocks.listBoundedSubscriptionsForQuery).toHaveBeenCalledWith(env, USER_ID, {
      q: "collection",
      category: ["productivity"],
    }, dateOnlyInZone(new Date(), "UTC"), subscriptionCollectionContractFixture.collectionLimit);
  });

  it("accepts total 5000 and rejects 5001 for every complete collection route", async () => {
    const env = envFixture();
    mocks.listBoundedSubscriptionsForQuery.mockResolvedValueOnce({
      rows: [recurringCollectionItem],
      total: subscriptionCollectionContractFixture.collectionLimit,
      exceeded: false,
    });
    const accepted = await readSubscriptionIndex(request("/api/app/subscriptions/index"), env);
    expect(subscriptionsIndexPayloadSchema.parse(await readSuccessData<unknown>(accepted)).total)
      .toBe(subscriptionCollectionContractFixture.collectionLimit);

    const routes = [
      () => readSubscriptionIndex(request("/api/app/subscriptions/index"), env),
      () => readSubscriptionAnalytics(request("/api/app/subscriptions/analytics"), env),
      () => readSubscriptionCalendar(request("/api/app/subscriptions/calendar?from=2026-01-01&to=2026-12-31"), env),
    ];
    for (const read of routes) {
      mocks.listBoundedSubscriptionsForQuery.mockResolvedValueOnce({
        rows: [],
        total: subscriptionCollectionContractFixture.collectionLimit + 1,
        exceeded: true,
      });
      await expect(read()).rejects.toMatchObject({
        status: 422,
        code: "SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED",
        details: { limit: subscriptionCollectionContractFixture.collectionLimit },
      });
    }
  });

  it("rejects index pagination and calendar query parameters outside the shared contract", async () => {
    const env = envFixture();
    for (const path of subscriptionCollectionContractFixture.invalidQueryRoutes) {
      const read = path.includes("/calendar?") ? readSubscriptionCalendar : readSubscriptionIndex;
      await expect(read(request(path), env)).rejects.toThrow();
    }
    expect(mocks.listBoundedSubscriptionsForQuery).not.toHaveBeenCalled();
  });

  it("keeps detail and export on the complete owner-scoped DTO", async () => {
    const env = envFixture();
    const detailResponse = await readSubscriptionDetail(
      request("/api/app/subscriptions/sub_collection"),
      env,
      "sub_collection",
    );
    const detail = subscriptionPayloadSchema.parse(await readSuccessData<unknown>(detailResponse));
    expect(detail.subscription).toMatchObject({
      id: "sub_collection",
      website: "https://collection.example.com",
      notes: "private detail",
      tags: ["AI"],
    });
    expect(mocks.getSubscription).toHaveBeenCalledWith(env, USER_ID, "sub_collection");

    const exportResponse = await readSubscriptionExport(request("/api/app/subscriptions/export"), env);
    const exported = subscriptionsExportPayloadSchema.parse(await readSuccessData<unknown>(exportResponse));
    expect(exported.subscriptions).toEqual([completeSubscription]);
    expect(mocks.listSubscriptions).toHaveBeenCalledWith(env, USER_ID);
  });

  it("reads facets from three owner-scoped aggregates", async () => {
    const env = envFixture();
    const response = await readSubscriptionFacets(request("/api/app/subscriptions/facets"), env);
    const facets = subscriptionFacetsPayloadSchema.parse(await readSuccessData<unknown>(response));

    expect(facets).toEqual({
      total: 2,
      categoryCounts: { productivity: 2 },
      tags: ["AI", "Team"],
      visibleCount: 1,
      hiddenCount: 1, expiredCount: 0, lifetimeCount: 0,
    });
    expect(mocks.readSubscriptionFacetsForUser).toHaveBeenCalledWith(env, USER_ID, "2026-09-14");
  });
});
