import { z, type ZodType } from "zod";
import { apiErrorResponseSchema } from "./schemas/errors";
import {
  publicApiDueQuerySchema,
  publicApiDueResponseSchema,
  publicApiMeResponseSchema,
  publicApiStatusResponseSchema,
  publicApiSubscriptionResponseSchema,
  publicApiSubscriptionsListResponseSchema,
  publicApiSubscriptionsQuerySchema,
} from "./schemas/public-api";

export type PublicApiParameterLocation = "path" | "query";
export type PublicApiMethod = "get";

export interface PublicApiParameterDoc {
  name: string;
  in: PublicApiParameterLocation;
  required: boolean;
  description: string;
  schemaName: keyof typeof publicApiDocumentationSchemas;
  schemaProperty?: string;
  example?: unknown;
}

export interface PublicApiEndpointDoc {
  method: PublicApiMethod;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  responseSchemaName: keyof typeof publicApiDocumentationSchemas;
  parameters?: readonly PublicApiParameterDoc[];
  exampleUrl: string;
  successExample: unknown;
  errorStatuses: readonly number[];
}

export const publicApiSubscriptionIdParamSchema = z.string().trim().min(1).max(120)
  .describe("Renewlet subscription id returned by the subscriptions list endpoint.");

// schema 名称会进入 OpenAPI component `$ref`，新增或重命名时必须同步生成物和外部客户端契约。
export const publicApiDocumentationSchemas = {
  PublicApiErrorResponse: apiErrorResponseSchema,
  PublicApiSubscriptionIdParam: publicApiSubscriptionIdParamSchema,
  PublicApiSubscriptionsQuery: publicApiSubscriptionsQuerySchema,
  PublicApiDueQuery: publicApiDueQuerySchema,
  PublicApiMeResponse: publicApiMeResponseSchema,
  PublicApiSubscriptionsListResponse: publicApiSubscriptionsListResponseSchema,
  PublicApiSubscriptionResponse: publicApiSubscriptionResponseSchema,
  PublicApiStatusResponse: publicApiStatusResponseSchema,
  PublicApiDueResponse: publicApiDueResponseSchema,
} as const satisfies Record<string, ZodType>;

const sampleSubscription = {
  id: "sub_01HZY7YQ7EXAMPLE",
  name: "GitHub",
  price: "12",
  currency: "USD",
  balance: "50.123456",
  balanceCurrency: "EUR",
  billingCycle: "monthly",
  category: "developer_tools",
  status: "active",
  pinned: false,
  publicHidden: false,
  startDate: "2026-01-01",
  nextBillingDate: "2026-09-01",
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  tags: ["dev"],
  reminderDays: 3,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

// 这里是 Public API 文档的路由级事实源；字段结构仍由 shared Zod schema 生成，动态用户配置只保留 string 形状。
export const publicApiEndpointDocs = [
  {
    method: "get",
    path: "/api/public/v1/me",
    operationId: "getPublicApiMe",
    summary: "Inspect the current Public API token",
    description: "Returns the read scope attached to the bearer token. It does not expose the token owner or token hash.",
    responseSchemaName: "PublicApiMeResponse",
    exampleUrl: "/api/public/v1/me",
    successExample: { ok: true, data: { scopes: ["read"] } },
    errorStatuses: [401],
  },
  {
    method: "get",
    path: "/api/public/v1/subscriptions",
    operationId: "listPublicApiSubscriptions",
    summary: "List subscriptions",
    description: "Returns an owner-scoped page of subscriptions ordered by Renewlet's Public API cursor contract.",
    responseSchemaName: "PublicApiSubscriptionsListResponse",
    parameters: [
      {
        name: "limit",
        in: "query",
        required: false,
        description: "Page size. The maximum is 100.",
        schemaName: "PublicApiSubscriptionsQuery",
        schemaProperty: "limit",
        example: 50,
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        description: "Opaque cursor returned as `data.nextCursor` from the previous page.",
        schemaName: "PublicApiSubscriptionsQuery",
        schemaProperty: "cursor",
        example: "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InN1YiJ9",
      },
    ],
    exampleUrl: "/api/public/v1/subscriptions?limit=50",
    successExample: {
      ok: true,
      data: {
        subscriptions: [sampleSubscription],
        nextCursor: null,
        total: 1,
      },
    },
    errorStatuses: [400, 401],
  },
  {
    method: "get",
    path: "/api/public/v1/subscriptions/{id}",
    operationId: "getPublicApiSubscription",
    summary: "Read one subscription",
    description: "Returns one owner-scoped subscription by id. Foreign or missing ids return the same not found shape.",
    responseSchemaName: "PublicApiSubscriptionResponse",
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        description: "Subscription id from the list endpoint.",
        schemaName: "PublicApiSubscriptionIdParam",
        example: "sub_01HZY7YQ7EXAMPLE",
      },
    ],
    exampleUrl: "/api/public/v1/subscriptions/sub_01HZY7YQ7EXAMPLE",
    successExample: { ok: true, data: { subscription: sampleSubscription } },
    errorStatuses: [401, 404],
  },
  {
    method: "get",
    path: "/api/public/v1/status",
    operationId: "getPublicApiStatus",
    summary: "Read subscription status summary",
    description: "Returns total subscription count and counts by Renewlet status for the token owner.",
    responseSchemaName: "PublicApiStatusResponse",
    exampleUrl: "/api/public/v1/status",
    successExample: {
      ok: true,
      data: {
        generatedAt: "2026-08-05T00:00:00.000Z",
        total: 1,
        byStatus: { active: 1, trial: 0, expired: 0, paused: 0, cancelled: 0 },
      },
    },
    errorStatuses: [401],
  },
  {
    method: "get",
    path: "/api/public/v1/due",
    operationId: "listPublicApiDueItems",
    summary: "List upcoming due items",
    description: "Returns upcoming renewal, trial, or one-time expiry items within the requested day window.",
    responseSchemaName: "PublicApiDueResponse",
    parameters: [
      {
        name: "days",
        in: "query",
        required: false,
        description: "Look-ahead window in days. The default is 30 and the maximum is 366.",
        schemaName: "PublicApiDueQuery",
        schemaProperty: "days",
        example: 30,
      },
    ],
    exampleUrl: "/api/public/v1/due?days=30",
    successExample: {
      ok: true,
      data: {
        days: 30,
        generatedAt: "2026-08-05T00:00:00.000Z",
        items: [{ dueDate: "2026-09-01", dueType: "renewal", subscription: sampleSubscription }],
      },
    },
    errorStatuses: [400, 401],
  },
] as const satisfies readonly PublicApiEndpointDoc[];
