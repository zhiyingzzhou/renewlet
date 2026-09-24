import { z } from "zod";
import {
  COST_SHARING_SPLIT_MODES,
  costSharingCollectionAnchorsAreSatisfied,
  costSharingCustomAmountsAreValid,
  costSharingMemberJoinedDatesWithinRange,
} from "../cost-sharing";
import { moneyStringSchema } from "../money";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  MAX_REMINDER_DAYS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
  isValidReminderDays,
  type BillingCycle,
  type CustomCycleUnit,
  type DateOnly,
} from "../runtime";

/**
 * 订阅 API schema 是 Docker Go、Cloudflare Worker 和前端表单的共享边界。
 *
 * 这里表达的是 wire shape，不是 UI domain model；任何字段新增、默认值或互斥关系变化，
 * 都必须同步 PocketBase schema/hooks、D1 mapper、前端 service normalize 和契约测试。
 */
const maxLogoReferenceLength = 2048;
const privateAssetPathPattern = /^\/api\/app\/assets\/[A-Za-z0-9_-]+$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isLogoHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const dateInputSchema = z
  .string()
  .min(1)
  .refine(isValidDateOnly, "Invalid date")
  .describe("日期字符串：必须是 YYYY-MM-DD，不接受带时间或时区的 ISO datetime。");
const nullableDateInputSchema = dateInputSchema.nullable();
const dateOnlyOutputSchema = dateInputSchema.transform((value) => value as DateOnly);

const optionalUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .nullable()
  .optional()
  .refine((value) => !value || isHttpUrl(value), "Invalid URL");

export const logoReferenceSchema = z
  .string()
  .trim()
  .max(maxLogoReferenceLength)
  .refine((value) => {
    // Logo 持久化契约只允许私有资产代理路径或浏览器直连 http(s) 外链；服务端不抓取用户 URL。
    if (privateAssetPathPattern.test(value)) return true;
    return isLogoHttpUrl(value);
  }, "Invalid logo URL");
const optionalLogoReferenceSchema = logoReferenceSchema.nullable().optional();

const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(100).optional();
const extraSchema = z.record(z.string(), z.unknown()).optional();
export const SUBSCRIPTION_PAYMENT_METHOD_NONE = "__none";
export const SUBSCRIPTION_PAYMENT_TYPES = ["auto", "manual", "one-time-buyout", "one-time-fixed-term"] as const;
export const SUBSCRIPTION_REMINDER_MODES = ["disabled", "inherit", "custom"] as const;
export const SUBSCRIPTION_RENEW_MODES = ["continue", "restart"] as const;
const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());
export const reminderDaysSchema = z
  .number()
  .int()
  .min(DISABLED_REMINDER_DAYS)
  .max(MAX_REMINDER_DAYS)
  .refine(isValidReminderDays, "Invalid reminder days");
const costSharingCollectionReminderDaysSchema = z
  .number()
  .int()
  .min(INHERIT_REMINDER_DAYS)
  .max(MAX_REMINDER_DAYS)
  .refine((value) => value === INHERIT_REMINDER_DAYS || value >= 0, "Invalid cost sharing collection reminder days");
const costSharingCollectionReminderSchema = z.object({
  enabled: z.boolean(),
  reminderDays: costSharingCollectionReminderDaysSchema,
}).strict();
// costSharing 是“当前用户默认付款、成员只代表其他人”的 shared wire shape；旧身份字段必须在迁移层清理，写入层拒绝。
const costSharingMemberSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  note: z.string().trim().max(500).optional(),
  // DateOnly 只作为成员收款周期 anchor；付款状态、账本流水和联系方式不属于 v1 契约。
  joinedDate: dateOnlyOutputSchema.optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  customAmount: moneyStringSchema.optional(),
}).strict();
export const costSharingSchema = z.object({
  enabled: z.boolean(),
  splitMode: z.enum(COST_SHARING_SPLIT_MODES),
  members: z.array(costSharingMemberSchema).min(1).max(20),
  // 收款提醒的事实源仍在 costSharing JSON；D1/PocketBase 只保存内部镜像列给 cron 热路径走索引。
  collectionReminder: costSharingCollectionReminderSchema.optional(),
}).strict().refine((value) => {
  if (!value.enabled) return true;
  const ids = new Set(value.members.map((member) => member.id));
  return ids.size === value.members.length;
}, {
  path: ["members"],
  message: "Invalid cost sharing members",
}).refine((value) => !value.enabled || costSharingCustomAmountsAreValid(value), {
  path: ["members"],
  message: "Invalid custom cost sharing amounts",
}).refine((value) => value.enabled || value.collectionReminder?.enabled !== true, {
  path: ["collectionReminder"],
  message: "Invalid cost sharing collection reminder",
});

const oneTimeTermCountSchema = z.number().int().positive().max(MAX_REMINDER_DAYS);
const oneTimeTermUnitSchema = z.enum(CUSTOM_CYCLE_UNITS);

export function oneTimeTermFieldsAreConsistent(value: {
  billingCycle: BillingCycle;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
}): boolean {
  const hasCount = value.oneTimeTermCount !== undefined && value.oneTimeTermCount !== null;
  const hasUnit = value.oneTimeTermUnit !== undefined && value.oneTimeTermUnit !== null;
  // 固定服务期必须 count/unit 成对出现；非 one-time 周期带服务期字段会污染统计摊销和到期提醒。
  if (value.billingCycle !== "one-time") return !hasCount && !hasUnit;
  return hasCount === hasUnit;
}

function customCycleFieldsAreConsistent(value: {
  billingCycle?: BillingCycle | undefined;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
}): boolean {
  if (value.billingCycle !== "custom") return true;
  return typeof value.customDays === "number" && value.customDays > 0 && value.customCycleUnit !== null && value.customCycleUnit !== undefined;
}

export function startDateRequirementIsSatisfied(value: {
  billingCycle: BillingCycle;
  startDate: string | null;
  autoCalculateNextBillingDate: boolean;
}): boolean {
  // 周期订阅允许未知开始日期；one-time 和自动日期锚点仍需要真实 date-only。
  if (value.billingCycle === "one-time") return value.startDate !== null;
  return !value.autoCalculateNextBillingDate || value.startDate !== null;
}

export function costSharingCollectionReminderMatchesBillingCycle(value: {
  billingCycle: BillingCycle;
  oneTimeTermCount?: number | null | undefined;
  costSharing?: z.infer<typeof costSharingSchema> | null | undefined;
}): boolean {
  // 买断记录没有可推进的家庭收款周期；启用状态必须在写入边界拒绝，而不是让 cron 镜像生成无效候选。
  if (
    value.billingCycle !== "one-time"
    || (typeof value.oneTimeTermCount === "number" && value.oneTimeTermCount > 0)
  ) return true;
  return value.costSharing?.collectionReminder?.enabled !== true;
}

export function subscriptionDateOrderIsValid(value: {
  startDate: string | null;
  nextBillingDate: string;
}): boolean {
  return value.startDate === null || value.nextBillingDate >= value.startDate;
}

export function costSharingMemberJoinedDateRangeIsValid(value: {
  billingCycle: BillingCycle;
  startDate: string | null;
  nextBillingDate: string;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
  costSharing?: z.infer<typeof costSharingSchema> | null | undefined;
}): boolean {
  return costSharingMemberJoinedDatesWithinRange(value.costSharing ?? undefined, {
    subscriptionStartDate: value.startDate,
    nextBillingDate: value.nextBillingDate,
    billingCycle: value.billingCycle,
    oneTimeTermCount: value.oneTimeTermCount,
    oneTimeTermUnit: value.oneTimeTermUnit,
  });
}

/**
 * 订阅写入请求的跨运行面事实来源。
 *
 * Go route、Cloudflare Worker 和前端表单都应接受这组字段；新增或收窄字段时必须同步
 * PocketBase schema/hooks、D1 row 转换和前端 domain 类型，不能只改某一个运行面。
 */
const subscriptionWriteFieldShape = {
  name: z.string().trim().min(1).max(120),
  logo: optionalLogoReferenceSchema,
  price: moneyStringSchema,
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  billingCycle: z.enum(BILLING_CYCLES),
  customDays: z.number().int().positive().nullable().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable().optional(),
  oneTimeTermCount: oneTimeTermCountSchema.nullable().optional(),
  oneTimeTermUnit: oneTimeTermUnitSchema.nullable().optional(),
  category: z.string().trim().min(1).max(80),
  status: z.enum(SUBSCRIPTION_STATUSES),
  pinned: z.boolean(),
  publicHidden: z.boolean(),
  paymentMethod: z.string().trim().min(1).max(80).nullable().optional(),
  startDate: nullableDateInputSchema,
  nextBillingDate: dateInputSchema,
  autoRenew: z.boolean(),
  autoCalculateNextBillingDate: z.boolean(),
  trialEndDate: dateInputSchema.nullable().optional(),
  website: optionalUrlSchema,
  notes: z.string().max(5000).nullable().optional(),
  tags: tagsSchema,
  reminderDays: reminderDaysSchema,
  repeatReminderEnabled: z.boolean(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS),
  costSharing: costSharingSchema.nullable().optional(),
  // extra 是跨运行面的非展示元数据通道；seed/import 依赖它做幂等，不参与订阅 UI。
  extra: extraSchema,
} satisfies z.ZodRawShape;

const subscriptionCreateBodyShape = {
  ...subscriptionWriteFieldShape,
  pinned: subscriptionWriteFieldShape.pinned.default(false),
  publicHidden: subscriptionWriteFieldShape.publicHidden.default(false),
  // 创建时缺省自动续订必须按关闭处理；PATCH 字段保持可选且绝不能注入默认值。
  autoRenew: subscriptionWriteFieldShape.autoRenew.default(false),
} satisfies z.ZodRawShape;

export const subscriptionCreateBodySchema = z.object(subscriptionCreateBodyShape)
  .strict()
  .refine(customCycleFieldsAreConsistent, {
    path: ["customCycleUnit"],
    message: "Custom cycle count and unit are required",
  })
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
  .refine((value) => costSharingCollectionAnchorsAreSatisfied(value.costSharing ?? undefined, value.startDate), {
    path: ["costSharing", "members"],
    message: "Cost sharing collection reminder requires member joined dates or subscription start date",
  })
  .refine(costSharingMemberJoinedDateRangeIsValid, {
    path: ["costSharing", "members"],
    message: "Cost sharing member joined date is outside the subscription date range",
  });

export const subscriptionUpdateBodySchema = z.object(subscriptionWriteFieldShape)
  .strict()
  .partial()
  .refine(customCycleFieldsAreConsistent, {
    path: ["customCycleUnit"],
    message: "Custom cycle count and unit are required",
  })
  .refine((value) => {
    if (value.billingCycle === undefined) return true;
    return oneTimeTermFieldsAreConsistent({
      billingCycle: value.billingCycle,
      oneTimeTermCount: value.oneTimeTermCount,
      oneTimeTermUnit: value.oneTimeTermUnit,
    });
  }, {
    path: ["oneTimeTermCount"],
    message: "Invalid one-time term",
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: "Empty payload" });

export const subscriptionRenewBodySchema = z.object({
  mode: z.enum(SUBSCRIPTION_RENEW_MODES),
  price: moneyStringSchema,
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  startDate: nullableDateInputSchema.optional(),
  nextBillingDate: dateInputSchema,
  autoCalculateNextBillingDate: z.boolean(),
}).strict()
  .describe("手动续订请求：显式选择延续原锚点或从新日期重开，并允许同步调整价格/币种。")
  .refine((value) => value.mode !== "restart" || value.startDate !== undefined && value.startDate !== null, {
    path: ["startDate"],
    message: "Start date is required when restarting a subscription",
  })
  .refine((value) => value.startDate === undefined || value.startDate === null || value.nextBillingDate >= value.startDate, {
    path: ["nextBillingDate"],
    message: "Next billing date must not be before start date",
  });

const apiSubscriptionCollectionItemShape = {
  id: z.string(),
  name: z.string(),
  price: moneyStringSchema,
  currency: z.string(),
  category: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  pinned: z.boolean(),
  publicHidden: z.boolean(),
  paymentMethod: z.string().min(1).optional(),
  startDate: nullableDateInputSchema,
  // 订阅响应的 date-only 字段由 shared 统一守门；Go、Worker 和前端都不能在本地补解析 ISO datetime。
  nextBillingDate: dateInputSchema,
  autoRenew: z.boolean(),
  // 集合卡片需要该日期锚点决定“手动续订”是否可用，不能等详情请求后再改变操作菜单。
  autoCalculateNextBillingDate: z.boolean(),
  trialEndDate: dateInputSchema.optional(),
  reminderDays: reminderDaysSchema,
  costSharing: costSharingSchema.optional(),
} satisfies z.ZodRawShape;

const recurringBillingCycles = ["weekly", "monthly", "quarterly", "semi-annual", "annual"] as const;
const apiRecurringCycleShape = {
  billingCycle: z.enum(recurringBillingCycles),
  customDays: z.never().optional(),
  customCycleUnit: z.never().optional(),
  oneTimeTermCount: z.never().optional(),
  oneTimeTermUnit: z.never().optional(),
} satisfies z.ZodRawShape;
const apiCustomCycleShape = {
  billingCycle: z.literal("custom"),
  customDays: z.number().int().positive(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS),
  oneTimeTermCount: z.never().optional(),
  oneTimeTermUnit: z.never().optional(),
} satisfies z.ZodRawShape;
const apiOneTimeBuyoutCycleShape = {
  billingCycle: z.literal("one-time"),
  customDays: z.never().optional(),
  customCycleUnit: z.never().optional(),
  oneTimeTermCount: z.never().optional(),
  oneTimeTermUnit: z.never().optional(),
} satisfies z.ZodRawShape;
const apiOneTimeFixedTermCycleShape = {
  billingCycle: z.literal("one-time"),
  customDays: z.never().optional(),
  customCycleUnit: z.never().optional(),
  oneTimeTermCount: oneTimeTermCountSchema,
  oneTimeTermUnit: oneTimeTermUnitSchema,
} satisfies z.ZodRawShape;

const apiSubscriptionDetailShape = {
  website: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()),
  repeatReminderEnabled: z.boolean(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS),
  extra: z.record(z.string(), z.unknown()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
} satisfies z.ZodRawShape;

function subscriptionRenewalFieldsAreConsistent(value: {
  billingCycle: BillingCycle;
  autoRenew: boolean;
  autoCalculateNextBillingDate: boolean;
}): boolean {
  if (value.billingCycle !== "one-time") return true;
  return !value.autoRenew && !value.autoCalculateNextBillingDate;
}

type ApiSubscriptionCycleBaseShape = typeof apiSubscriptionCollectionItemShape & {
  logo: z.ZodType<string | undefined>;
};

function subscriptionCostSharingAnchorsAreSatisfied(value: {
  costSharing?: z.infer<typeof costSharingSchema> | null | undefined;
  startDate: string | null;
}): boolean {
  return costSharingCollectionAnchorsAreSatisfied(value.costSharing ?? undefined, value.startDate);
}

const startDateRequirementCheck = z.refine<Parameters<typeof startDateRequirementIsSatisfied>[0]>(startDateRequirementIsSatisfied, {
  path: ["startDate"],
  message: "Start date is required for one-time subscriptions and automatic billing date calculation",
});
const subscriptionDateOrderCheck = z.refine<Parameters<typeof subscriptionDateOrderIsValid>[0]>(subscriptionDateOrderIsValid, {
  path: ["nextBillingDate"],
  message: "Next billing date must not be before start date",
});
const subscriptionRenewalFieldsCheck = z.refine<Parameters<typeof subscriptionRenewalFieldsAreConsistent>[0]>(
  subscriptionRenewalFieldsAreConsistent,
  {
    path: ["autoRenew"],
    message: "One-time subscriptions cannot renew or calculate another billing date",
  },
);
const costSharingCollectionReminderCheck = z.refine<Parameters<typeof costSharingCollectionReminderMatchesBillingCycle>[0]>(
  costSharingCollectionReminderMatchesBillingCycle,
  {
    path: ["costSharing", "collectionReminder"],
    message: "Cost sharing collection reminder is not available for one-time buyouts",
  },
);
const costSharingCollectionAnchorsCheck = z.refine<Parameters<typeof subscriptionCostSharingAnchorsAreSatisfied>[0]>(
  subscriptionCostSharingAnchorsAreSatisfied,
  {
    path: ["costSharing", "members"],
    message: "Cost sharing collection reminder requires member joined dates or subscription start date",
  },
);
const costSharingMemberJoinedDateRangeCheck = z.refine<Parameters<typeof costSharingMemberJoinedDateRangeIsValid>[0]>(
  costSharingMemberJoinedDateRangeIsValid,
  {
    path: ["costSharing", "members"],
    message: "Cost sharing member joined date is outside the subscription date range",
  },
);

function createSubscriptionCycleBranches<TBaseShape extends ApiSubscriptionCycleBaseShape>(baseShape: TBaseShape) {
  // 周期分支是 collection、完整详情与 ZIP 导出的共同事实源；base shape 先固定读取边界，周期字段最后写入以禁止调用方覆盖不变量。
  return [
    z.object({ ...baseShape, ...apiRecurringCycleShape }).strict(),
    z.object({ ...baseShape, ...apiCustomCycleShape }).strict(),
    z.object({ ...baseShape, ...apiOneTimeBuyoutCycleShape }).strict(),
    z.object({ ...baseShape, ...apiOneTimeFixedTermCycleShape }).strict(),
  ] as const;
}

export const apiSubscriptionCollectionItemSchema = z.union(createSubscriptionCycleBranches({
  ...apiSubscriptionCollectionItemShape,
  logo: logoReferenceSchema.optional(),
})).check(
  startDateRequirementCheck,
  subscriptionDateOrderCheck,
  subscriptionRenewalFieldsCheck,
  costSharingCollectionReminderCheck,
  costSharingCollectionAnchorsCheck,
  costSharingMemberJoinedDateRangeCheck,
);

export function createApiSubscriptionSchema(logoSchema: z.ZodType<string>) {
  return z.union(createSubscriptionCycleBranches({
    ...apiSubscriptionCollectionItemShape,
    logo: logoSchema.optional(),
    ...apiSubscriptionDetailShape,
  })).check(
    startDateRequirementCheck,
    subscriptionDateOrderCheck,
    subscriptionRenewalFieldsCheck,
    costSharingCollectionReminderCheck,
    costSharingCollectionAnchorsCheck,
    costSharingMemberJoinedDateRangeCheck,
  );
}

export const apiSubscriptionSchema = createApiSubscriptionSchema(logoReferenceSchema);

export const SUBSCRIPTION_INDEX_LIMIT = 5000;

const subscriptionCollectionFilterShape = {
  q: z.string().trim().min(1).max(200).optional(),
  category: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  tag: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
  billingCycle: z.array(z.enum(BILLING_CYCLES)).max(BILLING_CYCLES.length).optional(),
  paymentMethod: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
  currency: z.array(z.string().trim().regex(/^[A-Z]{3}$/)).max(50).optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  paymentType: z.enum(SUBSCRIPTION_PAYMENT_TYPES).optional(),
  nextBillingFrom: dateInputSchema.optional(),
  nextBillingTo: dateInputSchema.optional(),
  pinned: queryBooleanSchema.optional(),
  publicHidden: queryBooleanSchema.optional(),
  reminderMode: z.enum(SUBSCRIPTION_REMINDER_MODES).optional(),
  repeatReminder: queryBooleanSchema.optional(),
} satisfies z.ZodRawShape;

function subscriptionDateRangeIsValid(value: { nextBillingFrom?: string | undefined; nextBillingTo?: string | undefined }): boolean {
  if (!value.nextBillingFrom || !value.nextBillingTo) return true;
  return value.nextBillingFrom <= value.nextBillingTo;
}

export const subscriptionsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
  ...subscriptionCollectionFilterShape,
}).strict().refine(subscriptionDateRangeIsValid, {
  path: ["nextBillingTo"],
  message: "Invalid date range",
});

export const subscriptionsIndexQuerySchema = z.object(subscriptionCollectionFilterShape).strict()
  .refine(subscriptionDateRangeIsValid, {
    path: ["nextBillingTo"],
    message: "Invalid date range",
  });

export const subscriptionsCalendarQuerySchema = z.object({
  from: dateInputSchema,
  to: dateInputSchema,
}).strict().refine((value) => value.from <= value.to, {
  path: ["to"],
  message: "Invalid date range",
});

export const subscriptionsListPayloadSchema = z.object({
  subscriptions: z.array(apiSubscriptionCollectionItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
}).strict();
export const subscriptionsListResponseSchema = apiSuccessResponseSchema(subscriptionsListPayloadSchema);

export const subscriptionsIndexPayloadSchema = z.object({
  subscriptions: z.array(apiSubscriptionCollectionItemSchema).max(SUBSCRIPTION_INDEX_LIMIT),
  total: z.number().int().nonnegative(),
}).strict();
export const subscriptionsIndexResponseSchema = apiSuccessResponseSchema(subscriptionsIndexPayloadSchema);

export const subscriptionsAnalyticsPayloadSchema = z.object({
  subscriptions: z.array(apiSubscriptionCollectionItemSchema).max(SUBSCRIPTION_INDEX_LIMIT),
}).strict();
export const subscriptionsAnalyticsResponseSchema = apiSuccessResponseSchema(subscriptionsAnalyticsPayloadSchema);

export const subscriptionsCalendarPayloadSchema = z.object({
  subscriptions: z.array(apiSubscriptionCollectionItemSchema).max(SUBSCRIPTION_INDEX_LIMIT),
}).strict();
export const subscriptionsCalendarResponseSchema = apiSuccessResponseSchema(subscriptionsCalendarPayloadSchema);

export const subscriptionFacetsPayloadSchema = z.object({
  total: z.number().int().nonnegative(),
  categoryCounts: z.record(z.string().min(1), z.number().int().nonnegative()),
  tags: z.array(z.string().min(1)),
  visibleCount: z.number().int().nonnegative(),
  hiddenCount: z.number().int().nonnegative(),
  expiredCount: z.number().int().nonnegative(),
  lifetimeCount: z.number().int().nonnegative(),
}).strict();
export const subscriptionFacetsResponseSchema = apiSuccessResponseSchema(subscriptionFacetsPayloadSchema);

const publicVisibilityCategorySchema = z.enum(["expired", "lifetime"]);
const subscriptionBulkPublicVisibilitySelectionSchema = z.union([
  z.object({ ids: z.array(z.string().trim().min(1).max(80)).min(1).max(SUBSCRIPTION_INDEX_LIMIT) }).strict(),
  z.object({ categories: z.array(publicVisibilityCategorySchema).min(1).max(2) }).strict(),
]);
export const subscriptionBulkPublicVisibilityRequestSchema = z.object({
  selection: subscriptionBulkPublicVisibilitySelectionSchema,
  publicHidden: z.boolean(),
  dryRun: z.boolean().default(false),
}).strict();
export const subscriptionBulkPublicVisibilityPayloadSchema = z.object({
  matchedCount: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedIds: z.array(z.string()),
}).strict();
export const subscriptionBulkPublicVisibilityResponseSchema = apiSuccessResponseSchema(subscriptionBulkPublicVisibilityPayloadSchema);

export const subscriptionsExportPayloadSchema = z.object({
  subscriptions: z.array(apiSubscriptionSchema),
}).strict();
export const subscriptionsExportResponseSchema = apiSuccessResponseSchema(subscriptionsExportPayloadSchema);

export const subscriptionPayloadSchema = z.object({
  subscription: apiSubscriptionSchema,
}).strict();
export const subscriptionResponseSchema = apiSuccessResponseSchema(subscriptionPayloadSchema);

export const subscriptionDeleteResponseSchema = okResponseSchema;

export type SubscriptionsListResponse = z.infer<typeof subscriptionsListPayloadSchema>;
export type SubscriptionsIndexResponse = z.infer<typeof subscriptionsIndexPayloadSchema>;
export type SubscriptionsAnalyticsResponse = z.infer<typeof subscriptionsAnalyticsPayloadSchema>;
export type SubscriptionsCalendarResponse = z.infer<typeof subscriptionsCalendarPayloadSchema>;
export type SubscriptionFacetsResponse = z.infer<typeof subscriptionFacetsPayloadSchema>;
export type SubscriptionBulkPublicVisibilityRequest = z.infer<typeof subscriptionBulkPublicVisibilityRequestSchema>;
export type SubscriptionBulkPublicVisibilityResponse = z.infer<typeof subscriptionBulkPublicVisibilityPayloadSchema>;
export type SubscriptionsExportResponse = z.infer<typeof subscriptionsExportPayloadSchema>;
export type SubscriptionResponse = z.infer<typeof subscriptionPayloadSchema>;
export type SubscriptionRenewBody = z.infer<typeof subscriptionRenewBodySchema>;

export type ApiSubscriptionCollectionItem = z.infer<typeof apiSubscriptionCollectionItemSchema>;
export type ApiSubscription = z.infer<typeof apiSubscriptionSchema>;
export type SubscriptionsListQuery = z.infer<typeof subscriptionsListQuerySchema>;
export type SubscriptionsIndexQuery = z.infer<typeof subscriptionsIndexQuerySchema>;
export type SubscriptionsCalendarQuery = z.infer<typeof subscriptionsCalendarQuerySchema>;
