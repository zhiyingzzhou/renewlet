import { z } from "zod";
import { moneyStringSchema } from "../money";
import { subscriptionBalanceCheck, subscriptionBalanceReadShape } from "./subscription-balance";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  MAX_REMINDER_DAYS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
} from "../runtime";
import { costSharingCollectionAnchorsAreSatisfied } from "../cost-sharing";
import {
  costSharingCollectionReminderMatchesBillingCycle,
  costSharingMemberJoinedDateRangeIsValid,
  costSharingSchema,
  dateInputSchema,
  logoReferenceSchema,
  oneTimeTermFieldsAreConsistent,
  reminderDaysSchema,
  startDateRequirementIsSatisfied,
  subscriptionDateOrderIsValid,
} from "./subscriptions";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";

export const publicApiTokenPlainSchema = z.string().trim().regex(/^rlt_[A-Za-z0-9_-]{43}$/);
export const publicApiScopeSchema = z.literal("read");
export const publicApiScopesSchema = z.array(publicApiScopeSchema).length(1);

/**
 * Public API token 管理响应只返回 prefix 和元信息。
 *
 * plainToken 只允许出现在创建响应；列表、删除和 Public API 响应都不能再次泄漏明文 token。
 */
export const apiTokenSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80),
  tokenPrefix: z.string().trim().min(6).max(16),
  scopes: publicApiScopesSchema,
  createdAt: z.string().trim().min(1),
  lastUsedAt: z.string().trim().min(1).nullable().optional(),
}).strict();

export const apiTokensListPayloadSchema = z.object({
  tokens: z.array(apiTokenSchema),
}).strict();
export const apiTokensListResponseSchema = apiSuccessResponseSchema(apiTokensListPayloadSchema);

export const apiTokenCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
}).strict();

export const apiTokenCreatePayloadSchema = z.object({
  token: apiTokenSchema,
  plainToken: publicApiTokenPlainSchema,
}).strict();
export const apiTokenCreateResponseSchema = apiSuccessResponseSchema(apiTokenCreatePayloadSchema);

export const apiTokenDeleteResponseSchema = okResponseSchema;

export const publicApiMePayloadSchema = z.object({
  scopes: publicApiScopesSchema,
}).strict();
export const publicApiMeResponseSchema = apiSuccessResponseSchema(publicApiMePayloadSchema);

const publicApiSubscriptionBaseShape = {
  ...subscriptionBalanceReadShape,
  id: z.string(),
  name: z.string(),
  logo: logoReferenceSchema.optional(),
  price: moneyStringSchema,
  currency: z.string(),
  billingCycle: z.enum(BILLING_CYCLES),
  customDays: z.number().int().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  oneTimeTermCount: z.number().int().positive().max(MAX_REMINDER_DAYS).optional(),
  oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  category: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  pinned: z.boolean(),
  publicHidden: z.boolean(),
  paymentMethod: z.string().min(1).optional(),
  startDate: dateInputSchema.nullable(),
  nextBillingDate: dateInputSchema,
  autoRenew: z.boolean(),
  autoCalculateNextBillingDate: z.boolean(),
  trialEndDate: dateInputSchema.optional(),
  website: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  reminderDays: reminderDaysSchema,
  repeatReminderEnabled: z.boolean(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS),
  costSharing: costSharingSchema.optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
} satisfies z.ZodRawShape;

export const publicApiSubscriptionSchema = z.object(publicApiSubscriptionBaseShape)
  .strict()
  .check(subscriptionBalanceCheck)
  .refine(oneTimeTermFieldsAreConsistent, {
    path: ["oneTimeTermCount"],
    message: "Invalid one-time term",
  })
  .refine(startDateRequirementIsSatisfied, {
    path: ["startDate"],
    message: "Start date is required for one-time subscriptions and automatic billing date calculation",
  })
  .refine(subscriptionDateOrderIsValid, {
    path: ["nextBillingDate"],
    message: "Next billing date must not be before start date",
  })
  .refine(costSharingCollectionReminderMatchesBillingCycle, {
    path: ["costSharing", "collectionReminder"],
    message: "Cost sharing collection reminder is not available for one-time buyouts",
  })
  .refine((value) => costSharingCollectionAnchorsAreSatisfied(value.costSharing, value.startDate), {
    path: ["costSharing", "members"],
    message: "Cost sharing collection reminder requires member joined dates or subscription start date",
  })
  .refine(costSharingMemberJoinedDateRangeIsValid, {
    path: ["costSharing", "members"],
    message: "Cost sharing member joined date is outside the subscription date range",
  });

export const publicApiSubscriptionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();
export const publicApiSubscriptionsListPayloadSchema = z.object({
  subscriptions: z.array(publicApiSubscriptionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
}).strict();
export const publicApiSubscriptionsListResponseSchema = apiSuccessResponseSchema(publicApiSubscriptionsListPayloadSchema);
export const publicApiSubscriptionPayloadSchema = z.object({
  subscription: publicApiSubscriptionSchema,
}).strict();
export const publicApiSubscriptionResponseSchema = apiSuccessResponseSchema(publicApiSubscriptionPayloadSchema);

export const publicApiStatusPayloadSchema = z.object({
  generatedAt: z.string().trim().min(1),
  total: z.number().int().nonnegative(),
  byStatus: z.object(
    Object.fromEntries(SUBSCRIPTION_STATUSES.map((status) => [status, z.number().int().nonnegative()])) as Record<
      (typeof SUBSCRIPTION_STATUSES)[number],
      z.ZodNumber
    >,
  ).strict(),
}).strict();
export const publicApiStatusResponseSchema = apiSuccessResponseSchema(publicApiStatusPayloadSchema);

export const publicApiDueQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(366).default(30),
}).strict();

export const publicApiDueItemSchema = z.object({
  dueDate: z.string().trim().min(1),
  dueType: z.enum(["renewal", "trial", "expiry"]),
  subscription: publicApiSubscriptionSchema,
}).strict();

export const publicApiDuePayloadSchema = z.object({
  days: z.number().int().min(1).max(366),
  generatedAt: z.string().trim().min(1),
  items: z.array(publicApiDueItemSchema),
}).strict();
export const publicApiDueResponseSchema = apiSuccessResponseSchema(publicApiDuePayloadSchema);

export type ApiToken = z.infer<typeof apiTokenSchema>;
export type ApiTokensListResponse = z.infer<typeof apiTokensListPayloadSchema>;
export type ApiTokenCreateRequest = z.infer<typeof apiTokenCreateRequestSchema>;
export type ApiTokenCreateResponse = z.infer<typeof apiTokenCreatePayloadSchema>;
export type PublicApiMeResponse = z.infer<typeof publicApiMePayloadSchema>;
export type PublicApiSubscriptionsListResponse = z.infer<typeof publicApiSubscriptionsListPayloadSchema>;
export type PublicApiSubscriptionResponse = z.infer<typeof publicApiSubscriptionPayloadSchema>;
export type PublicApiStatusResponse = z.infer<typeof publicApiStatusPayloadSchema>;
export type PublicApiDueItem = z.infer<typeof publicApiDueItemSchema>;
export type PublicApiDueResponse = z.infer<typeof publicApiDuePayloadSchema>;
