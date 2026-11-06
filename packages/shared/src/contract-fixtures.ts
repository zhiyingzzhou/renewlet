import { z } from "zod";
import notificationScheduleFixturesJson from "./contract-fixtures/notification-schedule-fixtures.json";
import outboundUrlPolicyFixturesJson from "./contract-fixtures/outbound-url-policy-fixtures.json";
import subscriptionCollectionContractFixturesJson from "./contract-fixtures/subscription-collection-contract-fixtures.json";
import subscriptionPerformanceFixturesJson from "./contract-fixtures/subscription-performance-fixtures.json";
import subscriptionNormalizationFixturesJson from "./contract-fixtures/subscription-normalization-fixtures.json";
import aiRecognitionNormalizationFixturesJson from "./contract-fixtures/ai-recognition-normalization-fixtures.json";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
} from "./runtime";
import { moneyStringSchema } from "./money";
import {
  apiSubscriptionCollectionItemSchema,
  apiSubscriptionSchema,
} from "./schemas/subscriptions";

const dateOnlyFixtureSchema = z.string().refine(isValidDateOnly, "Invalid date");

const notificationSubscriptionFixtureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: moneyStringSchema,
  currency: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  billingCycle: z.enum(BILLING_CYCLES),
  oneTimeTermCount: z.number().int().positive().optional(),
  oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  nextBillingDate: dateOnlyFixtureSchema,
  trialEndDate: dateOnlyFixtureSchema.optional(),
  reminderDays: z.number().int(),
  repeatReminderEnabled: z.boolean(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS),
}).strict();

const notificationScheduleFixtureSchema = z.object({
  name: z.string().min(1),
  nowUtc: z.string().min(1),
  settings: z.object({
    timezone: z.string().min(1),
    notificationTimeLocal: z.string().min(1),
    notificationReminderDays: z.number().int(),
  }).strict(),
  subscriptions: z.array(notificationSubscriptionFixtureSchema),
  windowMinutes: z.number().int().nonnegative(),
  force: z.boolean(),
  expected: z.object({
    due: z.boolean(),
    reason: z.string().min(1),
    scheduledLocalDate: z.string().optional(),
    scheduledLocalTime: z.string().optional(),
    timeZone: z.string().optional(),
    scheduledInstantUtc: z.string().optional(),
    nextDailyInstantUtc: z.string().optional(),
    itemTypes: z.array(z.enum(["renewal", "trial", "expired", "expiry"])),
    repeatReminder: z.object({
      interval: z.enum(REPEAT_REMINDER_INTERVALS),
      window: z.enum(REPEAT_REMINDER_WINDOWS),
    }).optional(),
  }).strict(),
}).strict();

const subscriptionNormalizationFixtureSchema = z.object({
  name: z.string().min(1),
  input: z.object({
    billingCycle: z.enum(BILLING_CYCLES),
    customDays: z.number().int().positive().nullable(),
    customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    oneTimeTermCount: z.number().int().positive().nullable(),
    oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    autoRenew: z.boolean(),
    autoCalculateNextBillingDate: z.boolean(),
  }).strict(),
  expected: z.object({
    customDays: z.number().int().positive().nullable(),
    customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    oneTimeTermCount: z.number().int().positive().nullable(),
    oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
    autoRenew: z.boolean(),
    autoCalculateNextBillingDate: z.boolean(),
  }).strict(),
}).strict();

const aiRecognitionConfigOptionFixtureSchema = z.object({
  value: z.string().min(1),
  label: z.string(),
  zhCN: z.string(),
  enUS: z.string(),
}).strict();

const aiRecognitionNormalizationFixtureSchema = z.object({
  name: z.string().min(1),
  input: z.object({
    subscriptions: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).strict(),
  config: z.object({
    categories: z.array(aiRecognitionConfigOptionFixtureSchema),
    paymentMethods: z.array(aiRecognitionConfigOptionFixtureSchema),
    tags: z.array(z.string()),
  }).strict(),
  expected: z.object({
    providerType: z.string().min(1),
    transportProtocol: z.string().min(1),
    model: z.string().min(1),
    subscriptions: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).strict(),
}).strict();

const outboundUrlPolicyFixtureSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  resolvedIps: z.array(z.string()),
  safe: z.boolean(),
  expectedUrl: z.string().optional(),
}).strict();

const performanceRecipeSchema = z.object({
  idPrefix: z.string().regex(/^[a-z]$/),
  statuses: z.array(z.enum(SUBSCRIPTION_STATUSES)).min(1),
  categories: z.array(z.string().min(1)).min(1),
  billingCycles: z.array(z.enum(BILLING_CYCLES)).min(1),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
  paymentMethods: z.array(z.string().min(1).nullable()).min(1),
  reminderDays: z.array(z.number().int()).min(1),
  teamModulo: z.number().int().positive(),
  repeatReminderModulo: z.number().int().positive(),
  startDate: dateOnlyFixtureSchema,
  nextBillingDate: dateOnlyFixtureSchema,
  createdAt: z.iso.datetime(),
}).strict();

const performanceMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("update"),
    index: z.number().int().nonnegative(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    tags: z.array(z.string().min(1)),
  }).strict(),
  z.object({
    kind: z.literal("renew"),
    index: z.number().int().nonnegative(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    nextBillingDate: dateOnlyFixtureSchema,
  }).strict(),
  z.object({ kind: z.literal("delete"), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("create"), indexFromSize: z.literal(true) }).strict(),
]);

const performanceExpectedSchema = z.object({
  total: z.number().int().positive(),
  statusCounts: z.object({
    trial: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }).strict(),
  tagRows: z.number().int().nonnegative(),
  autoRenew: z.number().int().nonnegative(),
  repeatReminder: z.number().int().nonnegative(),
  combinedFilterIndices: z.array(z.number().int().nonnegative()),
}).strict();

const subscriptionPerformanceFixtureSchema = z.object({
  version: z.literal(1),
  recipe: performanceRecipeSchema,
  mutations: z.array(performanceMutationSchema).length(4),
  webBudget: z.object({
    authenticatedIdleRoutePreloads: z.number().int().nonnegative(),
    subscriptionCollectionCacheEntries: z.number().int().nonnegative(),
    dataRequests: z.number().int().nonnegative(),
  }).strict(),
  scenarios: z.array(z.object({
    size: z.number().int().positive(),
    expected: performanceExpectedSchema,
    operationBudget: z.object({
      derivedWriteBase: z.number().int().positive(),
      listReadQueries: z.number().int().positive(),
    }).strict(),
  }).strict()).length(4),
}).strict();

const subscriptionRouteFixtureSchema = z.object({
  path: z.string().startsWith("/api/app/subscriptions"),
  methods: z.array(z.enum(["DELETE", "GET", "PATCH", "POST"])).min(1),
}).strict();

const subscriptionCollectionContractFixtureSchema = z.object({
  version: z.literal(1),
  collectionLimit: z.number().int().positive(),
  manifestRoutes: z.array(subscriptionRouteFixtureSchema).min(1),
  collectionResponseRoutes: z.array(z.string().startsWith("/api/app/subscriptions")).min(1),
  boundedCollectionRoutes: z.array(z.string().startsWith("/api/app/subscriptions")).min(1),
  invalidQueryRoutes: z.array(z.string().startsWith("/api/app/subscriptions")).min(1),
  detailOnlyFields: z.array(z.string().min(1)).min(1),
  collectionItems: z.array(apiSubscriptionCollectionItemSchema).length(4),
  completeSubscription: apiSubscriptionSchema,
}).strict();

/**
 * 这些 fixture 是 Docker Go、Cloudflare Worker 和前端边界测试的共同样例；
 * 策略解释留在 harness 文档，产品仓库只保留可执行契约数据。
 */
export const notificationScheduleFixtures = z.array(notificationScheduleFixtureSchema).parse(notificationScheduleFixturesJson);
export const subscriptionNormalizationFixtures = z.array(subscriptionNormalizationFixtureSchema).parse(subscriptionNormalizationFixturesJson);
export const aiRecognitionNormalizationFixtures = z.array(aiRecognitionNormalizationFixtureSchema).parse(aiRecognitionNormalizationFixturesJson);
export const outboundUrlPolicyFixtures = z.array(outboundUrlPolicyFixtureSchema).parse(outboundUrlPolicyFixturesJson);
export const subscriptionPerformanceFixture = subscriptionPerformanceFixtureSchema.parse(subscriptionPerformanceFixturesJson);
export const subscriptionCollectionContractFixture = subscriptionCollectionContractFixtureSchema.parse(subscriptionCollectionContractFixturesJson);

export type NotificationScheduleFixture = (typeof notificationScheduleFixtures)[number];
export type SubscriptionNormalizationFixture = (typeof subscriptionNormalizationFixtures)[number];
export type AIRecognitionNormalizationFixture = (typeof aiRecognitionNormalizationFixtures)[number];
export type OutboundUrlPolicyFixture = (typeof outboundUrlPolicyFixtures)[number];
export type SubscriptionPerformanceScenario = (typeof subscriptionPerformanceFixture.scenarios)[number];

export interface SubscriptionPerformanceRecord {
  index: number;
  id: string;
  name: string;
  price: string;
  currency: string;
  billingCycle: (typeof BILLING_CYCLES)[number];
  customDays: number | null;
  customCycleUnit: (typeof CUSTOM_CYCLE_UNITS)[number] | null;
  category: string;
  status: (typeof SUBSCRIPTION_STATUSES)[number];
  pinned: boolean;
  publicHidden: boolean;
  paymentMethod: string | null;
  startDate: string;
  nextBillingDate: string;
  autoRenew: boolean;
  autoCalculateNextBillingDate: boolean;
  trialEndDate: string | null;
  website: string;
  notes: string;
  tags: string[];
  reminderDays: number;
  repeatReminderEnabled: boolean;
  repeatReminderInterval: (typeof REPEAT_REMINDER_INTERVALS)[number];
  repeatReminderWindow: (typeof REPEAT_REMINDER_WINDOWS)[number];
  createdAt: string;
  updatedAt: string;
}

export function buildSubscriptionPerformanceScenario(size: number): {
  initial: SubscriptionPerformanceRecord[];
  final: SubscriptionPerformanceRecord[];
} {
  const scenario = subscriptionPerformanceFixture.scenarios.find((candidate) => candidate.size === size);
  if (!scenario) throw new Error(`Unknown subscription performance fixture size: ${size}`);
  const initial = Array.from({ length: size }, (_, index) => buildPerformanceRecord(index, size));
  const final = initial.map(clonePerformanceRecord);

  for (const mutation of subscriptionPerformanceFixture.mutations) {
    if (mutation.kind === "create") {
      final.push(buildPerformanceRecord(size, size));
      continue;
    }
    const position = final.findIndex((record) => record.index === mutation.index);
    if (position < 0) throw new Error(`Missing performance fixture index: ${mutation.index}`);
    if (mutation.kind === "delete") {
      final.splice(position, 1);
      continue;
    }
    const record = final[position];
    if (!record) throw new Error(`Missing performance fixture record: ${mutation.index}`);
    record.status = mutation.status;
    if (mutation.kind === "update") record.tags = [...mutation.tags];
    if (mutation.kind === "renew") record.nextBillingDate = mutation.nextBillingDate;
  }
  return { initial, final };
}

function buildPerformanceRecord(index: number, size: number): SubscriptionPerformanceRecord {
  const { recipe } = subscriptionPerformanceFixture;
  const status = recipe.statuses[index % recipe.statuses.length];
  const billingCycle = recipe.billingCycles[index % recipe.billingCycles.length];
  if (!status || !billingCycle) throw new Error(`Invalid performance fixture recipe at index ${index}`);
  const category = recipe.categories[index % recipe.categories.length];
  const currency = recipe.currencies[index % recipe.currencies.length];
  const paymentMethod = recipe.paymentMethods[index % recipe.paymentMethods.length];
  const reminderDays = recipe.reminderDays[index % recipe.reminderDays.length];
  if (!category || !currency || paymentMethod === undefined || reminderDays === undefined) {
    throw new Error(`Incomplete performance fixture recipe at index ${index}`);
  }
  return {
    index,
    id: `${recipe.idPrefix}${String(size).padStart(4, "0")}${String(index).padStart(10, "0")}`,
    name: `Performance Subscription ${size}-${index}`,
    price: String(index + 1),
    currency,
    billingCycle,
    customDays: billingCycle === "custom" ? 30 : null,
    customCycleUnit: billingCycle === "custom" ? "day" : null,
    category,
    status,
    pinned: index % 3 === 0,
    publicHidden: index % 7 === 0,
    paymentMethod,
    startDate: recipe.startDate,
    nextBillingDate: recipe.nextBillingDate,
    autoRenew: index % 2 === 0,
    autoCalculateNextBillingDate: true,
    trialEndDate: status === "trial" ? recipe.nextBillingDate : null,
    website: `https://performance.example/${size}/${index}`,
    notes: `deterministic fixture ${size}-${index}`,
    tags: [`team-${index % recipe.teamModulo}`, `CATEGORY-${category}`],
    reminderDays,
    repeatReminderEnabled: index % recipe.repeatReminderModulo === 0,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    createdAt: recipe.createdAt,
    updatedAt: recipe.createdAt,
  };
}

function clonePerformanceRecord(record: SubscriptionPerformanceRecord): SubscriptionPerformanceRecord {
  return { ...record, tags: [...record.tags] };
}
