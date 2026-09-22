import { z } from "zod";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
} from "../runtime";
import { moneyStringSchema } from "../money";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";
import { exchangeRateSnapshotPublicBasisSchema } from "./exchange-rates";

const publicStatusTokenSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * 登录态公开页管理响应。
 *
 * pageUrl 可展示给用户复制，但 token 不写入 settings/export；撤销后旧 URL 应立即失效。
 */
export const publicStatusPageSchema = z.object({
  enabled: z.boolean(),
  createdAt: z.string().optional(),
  pageUrl: z.string().trim().url().max(4096).optional(),
  showPrices: z.boolean(),
  hideExpired: z.boolean(),
  hideLifetime: z.boolean(),
  updatedAt: z.string().optional(),
}).strict();

export const publicStatusPagePayloadSchema = z.object({
  publicStatusPage: publicStatusPageSchema,
}).strict();
export const publicStatusPageResponseSchema = apiSuccessResponseSchema(publicStatusPagePayloadSchema);

export const publicStatusPageCreateRequestSchema = z.object({}).strict();

export const publicStatusPageCreatePayloadSchema = z.object({
  publicStatusPage: z.object({
    enabled: z.literal(true),
    createdAt: z.string().trim().min(1),
    pageUrl: z.string().trim().url().max(4096),
    showPrices: z.boolean(),
    hideExpired: z.boolean(),
    hideLifetime: z.boolean(),
    updatedAt: z.string().trim().min(1),
  }).strict(),
}).strict();
export const publicStatusPageCreateResponseSchema = apiSuccessResponseSchema(publicStatusPageCreatePayloadSchema);

export const publicStatusPageUpdateRequestSchema = z.object({
  showPrices: z.boolean(),
  hideExpired: z.boolean(),
  hideLifetime: z.boolean(),
}).strict();

export const publicStatusPageDeleteResponseSchema = okResponseSchema;

const publicStatusLogoSchema = z.string().trim().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return value.startsWith("/api/public/status/");
  }
}, "Invalid public logo URL");

/**
 * 公开订阅投影的 allowlist。
 *
 * 这里故意不包含 notes、website、tags、paymentMethod、extra 和私有 owner 字段；价格字段也必须受 showPrices 控制。
 */
const publicStatusSubscriptionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  logo: publicStatusLogoSchema.optional(),
  category: z.object({
    value: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    color: z.string().trim().max(80).optional(),
  }).strict(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  startDate: z.string().refine(isValidDateOnly).nullable(),
  nextBillingDate: z.string().refine(isValidDateOnly).nullable(),
  updatedAt: z.string().trim().min(1),
  price: moneyStringSchema.optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  customDays: z.number().int().positive().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  oneTimeTermCount: z.number().int().positive().max(3650).optional(),
  oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
}).strict().refine((value) => (value.price === undefined) === (value.currency === undefined), {
  path: ["price"],
  message: "Price and currency must be included together",
}).refine((value) => value.price === undefined || value.billingCycle !== undefined, {
  path: ["billingCycle"],
  message: "Billing cycle is required when price is exposed",
}).refine((value) => {
  if (value.billingCycle === undefined) {
    return value.customDays === undefined
      && value.customCycleUnit === undefined
      && value.oneTimeTermCount === undefined
      && value.oneTimeTermUnit === undefined;
  }
  if (value.billingCycle === "custom") {
    return value.customDays !== undefined
      && value.customCycleUnit !== undefined
      && value.oneTimeTermCount === undefined
      && value.oneTimeTermUnit === undefined;
  }
  if (value.billingCycle === "one-time") {
    return value.customDays === undefined
      && value.customCycleUnit === undefined
      && (value.oneTimeTermCount === undefined) === (value.oneTimeTermUnit === undefined);
  }
  return value.customDays === undefined
    && value.customCycleUnit === undefined
    && value.oneTimeTermCount === undefined
    && value.oneTimeTermUnit === undefined;
}, {
  path: ["billingCycle"],
  message: "Billing cycle fields are inconsistent",
});

export const publicStatusPayloadSchema = z.object({
  page: z.object({
    title: z.literal("Renewlet"),
    showPrices: z.boolean(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    exchangeRateBasis: exchangeRateSnapshotPublicBasisSchema.optional(),
    asOf: z.string().refine(isValidDateOnly),
    generatedAt: z.string().trim().min(1),
    truncated: z.boolean(),
  }).strict(),
  subscriptions: z.array(publicStatusSubscriptionSchema).max(500),
}).strict().superRefine((value, context) => {
  // showPrices 是公开页隐私开关，金额相关字段必须整组出现或整组隐藏，避免半公开响应被前端误展示。
  if (value.page.showPrices && !value.page.currency) {
    context.addIssue({
      code: "custom",
      path: ["page", "currency"],
      message: "Currency is required when prices are exposed",
    });
  }
  if (!value.page.showPrices && value.page.currency !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["page", "currency"],
      message: "Currency must be hidden when prices are not exposed",
    });
  }
  if (!value.page.showPrices && value.page.exchangeRateBasis !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["page", "exchangeRateBasis"],
      message: "Exchange-rate basis must be hidden when prices are not exposed",
    });
  }
  value.subscriptions.forEach((subscription, index) => {
    const amountFields = [
      subscription.price,
      subscription.currency,
      subscription.billingCycle,
      subscription.customDays,
      subscription.customCycleUnit,
      subscription.oneTimeTermCount,
      subscription.oneTimeTermUnit,
    ];
    const hasAnyAmountProjection = amountFields.some((field) => field !== undefined);
    const hasRequiredAmountProjection = subscription.price !== undefined
      && subscription.currency !== undefined
      && subscription.billingCycle !== undefined;
    if (value.page.showPrices && !hasRequiredAmountProjection) {
      context.addIssue({
        code: "custom",
        path: ["subscriptions", index, "price"],
        message: "Price projection is required when prices are exposed",
      });
    }
    if (!value.page.showPrices && hasAnyAmountProjection) {
      context.addIssue({
        code: "custom",
        path: ["subscriptions", index, "price"],
        message: "Price projection must be hidden when prices are not exposed",
      });
    }
    if (subscription.billingCycle !== undefined) {
      const buyout = subscription.billingCycle === "one-time" && subscription.oneTimeTermCount === undefined;
      if (buyout !== (subscription.nextBillingDate === null)) {
        context.addIssue({
          code: "custom",
          path: ["subscriptions", index, "nextBillingDate"],
          message: "Only one-time buyouts omit the next billing date",
        });
      }
    }
  });
});
export const publicStatusResponseSchema = apiSuccessResponseSchema(publicStatusPayloadSchema);

export type PublicStatusPage = z.infer<typeof publicStatusPageSchema>;
export type PublicStatusPageResponse = z.infer<typeof publicStatusPagePayloadSchema>;
export type PublicStatusPageCreateResponse = z.infer<typeof publicStatusPageCreatePayloadSchema>;
export type PublicStatusPageUpdateRequest = z.infer<typeof publicStatusPageUpdateRequestSchema>;
export type PublicStatusResponse = z.infer<typeof publicStatusPayloadSchema>;
export type PublicStatusToken = z.infer<typeof publicStatusTokenSchema>;
