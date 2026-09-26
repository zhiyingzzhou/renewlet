/**
 * 订阅、设置与通知的前端领域模型。
 *
 * 架构位置：API/PocketBase 响应必须先经过 Zod schema 与 hook 边界，页面、统计、日历和通知设置
 * 只消费这里的品牌类型与联合类型。
 *
 * 注意： date-only、本地时间和 custom 周期是核心不变量；新增字段时要同步 Go schema/hooks 与前端 schema。
 */
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { labelsFromCatalog } from "@/i18n/label-messages";
import { labels, withDerivedLabels, type LocalizedLabels } from '@/i18n/locales';
import { SUPPORTED_EXCHANGE_RATE_CURRENCIES, getIntlCurrencyOptionLabel } from '@/lib/currency-data';
import type { DateOnly } from '@/lib/time/date-only';
import type { CostSharing } from '@renewlet/shared/cost-sharing';
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import {
  BILLING_CYCLES as SHARED_BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS as SHARED_CUSTOM_CYCLE_UNITS,
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  MAX_REMINDER_DAYS,
  NOTIFICATION_CHANNELS as SHARED_NOTIFICATION_CHANNELS,
  REPEAT_REMINDER_INTERVALS as SHARED_REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS as SHARED_REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES as SHARED_SUBSCRIPTION_STATUSES,
  type BillingCycle as SharedBillingCycle,
  type CustomCycleUnit as SharedCustomCycleUnit,
  type NotificationChannel as SharedNotificationChannel,
  type RepeatReminderInterval as SharedRepeatReminderInterval,
  type RepeatReminderWindow as SharedRepeatReminderWindow,
  type SubscriptionStatus as SharedSubscriptionStatus,
} from "@renewlet/shared/runtime";
import type { ApiSubscription, ApiSubscriptionCollectionItem } from "@renewlet/shared/schemas/subscriptions";

export { DEFAULT_NOTIFICATION_REMINDER_DAYS, DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS, MAX_REMINDER_DAYS };
export type { ApiSubscription, ApiSubscriptionCollectionItem };

export const SUBSCRIPTION_STATUSES = SHARED_SUBSCRIPTION_STATUSES;
/** 订阅状态（影响展示、统计与提醒逻辑）。 */
export type SubscriptionStatus = SharedSubscriptionStatus;

export const BILLING_CYCLES = SHARED_BILLING_CYCLES;
/** 扣费周期；one-time 由服务期字段进一步区分长期有效与固定服务期。 */
export type BillingCycle = SharedBillingCycle;

export const CUSTOM_CYCLE_UNITS = SHARED_CUSTOM_CYCLE_UNITS;
export type CustomCycleUnit = SharedCustomCycleUnit;

export const CATEGORIES = [
  'productivity',
  'entertainment',
  'lifestyle',
  'finance',
  'streaming',
  'music',
  'gaming',
  'utilities',
  'cloud_storage',
  'education',
  'health_fitness',
  'food_dining',
  'shopping',
  'travel',
  'business',
  'communication',
  'developer_tools',
  'design',
  'ai_tools',
  'security_vpn',
  'hosting_domains',
  'news_media',
  'other',
] as const;
/** 内置订阅分类（用于默认选项 + 视觉 token）。 */
export type BuiltInCategory = (typeof CATEGORIES)[number];
/**
 * 订阅分类值。
 *
 * 说明：
 * - `BuiltInCategory`：内置分类（有默认颜色 token）
 * - `(string & {})`：用户自定义分类（来自「设置 → 分类管理」）
 */
export type Category = BuiltInCategory | (string & {});

export const PAYMENT_METHODS = [
  'alipay',
  'wechat',
  'credit_card',
  'debit_card',
  'paypal',
  'apple_pay',
  'google_pay',
  'bank_transfer',
  'crypto',
  'direct_debit',
  'money',
  'samsung_pay',
  'klarna',
  'amazon_pay',
  'sepa',
  'skrill',
  'sofort',
  'stripe',
  'affirm',
  'elo',
  'facebook_pay',
  'giropay',
  'ideal',
  'union_pay',
  'interac',
  'paysafe',
  'poli',
  'qiwi',
  'shop_pay',
  'venmo',
  'verifone',
  'webmoney',
  'other',
] as const;
/** 内置支付方式（图标固定，覆盖 Renewlet 与 Wallos 的默认支付方式并集）。 */
export type BuiltInPaymentMethod = (typeof PAYMENT_METHODS)[number];
/**
 * 支付方式值。
 *
 * 说明：
 * - `BuiltInPaymentMethod`：内置支付方式（图标固定）
 * - `(string & {})`：用户自定义支付方式（来自「设置 → 支付方式管理」）
 */
export type PaymentMethod = BuiltInPaymentMethod | (string & {});

export const NOTIFICATION_CHANNELS = SHARED_NOTIFICATION_CHANNELS;
/** 通知渠道（用于配置页选择 + 后续通知任务）。 */
export type NotificationChannel = SharedNotificationChannel;

export const REPEAT_REMINDER_INTERVALS = SHARED_REPEAT_REMINDER_INTERVALS;
/** 重复提醒间隔（按小时计，用于重要订阅的后续提醒）。 */
export type RepeatReminderInterval = SharedRepeatReminderInterval;

export const REPEAT_REMINDER_WINDOWS = SHARED_REPEAT_REMINDER_WINDOWS;
/** 重复提醒窗口；full 表示从首次提醒后一直重复到目标日期通知时间。 */
export type RepeatReminderWindow = SharedRepeatReminderWindow;

/** 单个订阅允许的标签数量保护上限；正常使用体验上不主动强调。 */
export const MAX_SUBSCRIPTION_TAGS = 100;
/** 单个标签的后端契约长度上限。 */
export const MAX_SUBSCRIPTION_TAG_LENGTH = 40;

export const WEBHOOK_HEADERS_PLACEHOLDER = '{"Authorization": "Bearer your-token", "Content-Type": "application/json"}';
export const WEBHOOK_PAYLOAD_PLACEHOLDER = '{"title": "{title}", "content": "{content}", "timestamp": "{timestamp}"}';

export type { CostSharing, CostSharingMember, CostSharingSplitMode } from '@renewlet/shared/cost-sharing';

type SubscriptionCollectionDomainFields = {
  logo: string | undefined;
  category: Category;
  paymentMethod: PaymentMethod | undefined;
  startDate: DateOnly | null;
  nextBillingDate: DateOnly;
  trialEndDate: DateOnly | undefined;
};

type SubscriptionCollectionItemFromApi<T> =
  T extends ApiSubscriptionCollectionItem
    ? Omit<T, keyof SubscriptionCollectionDomainFields> & SubscriptionCollectionDomainFields
    : never;

export type SubscriptionCollectionItem = SubscriptionCollectionItemFromApi<ApiSubscriptionCollectionItem>;
export type RecurringCycleSubscriptionCollectionItem = Extract<
  SubscriptionCollectionItem,
  { billingCycle: Exclude<BillingCycle, "custom" | "one-time"> }
>;
export type CustomCycleSubscriptionCollectionItem = Extract<SubscriptionCollectionItem, { billingCycle: "custom" }>;
export type OneTimeSubscriptionCollectionItem = Extract<SubscriptionCollectionItem, { billingCycle: "one-time" }>;
export type OneTimeFixedTermSubscriptionCollectionItem = Extract<
  OneTimeSubscriptionCollectionItem,
  { oneTimeTermCount: number; oneTimeTermUnit: CustomCycleUnit }
>;
export type OneTimeBuyoutSubscriptionCollectionItem = Exclude<
  OneTimeSubscriptionCollectionItem,
  OneTimeFixedTermSubscriptionCollectionItem
>;

type SubscriptionDetailDomainFields = {
  website: string | undefined;
  notes: string | undefined;
  tags: string[];
  extra: Record<string, unknown>;
};

type SubscriptionFromApi<T extends ApiSubscription> = T extends ApiSubscription
  ? Omit<
      SubscriptionCollectionItemFromApi<T>,
      keyof SubscriptionDetailDomainFields | "createdAt" | "updatedAt"
    > & SubscriptionDetailDomainFields
  : never;

export type Subscription = SubscriptionFromApi<ApiSubscription>;
export type RecurringCycleSubscription = Extract<
  Subscription,
  { billingCycle: Exclude<BillingCycle, "custom" | "one-time"> }
>;
export type CustomCycleSubscription = Extract<Subscription, { billingCycle: "custom" }>;
export type OneTimeSubscription = Extract<Subscription, { billingCycle: "one-time" }>;
export type OneTimeFixedTermSubscription = Extract<
  OneTimeSubscription,
  { oneTimeTermCount: number; oneTimeTermUnit: CustomCycleUnit }
>;
export type OneTimeBuyoutSubscription = Exclude<OneTimeSubscription, OneTimeFixedTermSubscription>;
export type FixedCycleSubscription = RecurringCycleSubscription | OneTimeSubscription;

type SubscriptionFormSubmissionFrom<T extends Subscription> = T extends Subscription
  ? Omit<T, "id" | "pinned" | "extra" | "trialEndDate">
  : never;
export type SubscriptionFormSubmission = SubscriptionFormSubmissionFrom<Subscription>;
type SubscriptionDraftFrom<T extends SubscriptionFormSubmission> = T extends SubscriptionFormSubmission
  ? T & { pinned: boolean; extra?: Record<string, unknown> }
  : never;
export type SubscriptionDraft = SubscriptionDraftFrom<SubscriptionFormSubmission>;

export interface SubscriptionStats {
  /** 按月折算的总支出（基于订阅周期换算）。 */
  totalMonthly: number;
  /** 按年折算的总支出（基于订阅周期换算）。 */
  totalAnnual: number;
  /** 当前处于活跃状态的订阅数量。 */
  activeCount: number;
  /** 即将续费的订阅数量（时间窗口由 UI 逻辑决定）。 */
  upcomingRenewals: number;
  /** 试用即将结束的订阅数量（时间窗口由 UI 逻辑决定）。 */
  trialEndingSoon: number;
}

export type PublicStatusCurrency = "inherit" | (string & {});
export type SubscriptionPriceReferenceCurrency = "default" | (string & {});

export type AppSettings = ApiAppSettings;

export const CATEGORY_LABELS: Record<BuiltInCategory, LocalizedLabels> = {
  productivity: labelsFromCatalog("category.productivity"),
  entertainment: labelsFromCatalog("category.entertainment"),
  lifestyle: labelsFromCatalog("category.lifestyle"),
  finance: labelsFromCatalog("category.finance"),
  streaming: labelsFromCatalog("category.streaming"),
  music: labelsFromCatalog("category.music"),
  gaming: labelsFromCatalog("category.gaming"),
  utilities: labelsFromCatalog("category.utilities"),
  cloud_storage: labelsFromCatalog("category.cloudStorage"),
  education: labelsFromCatalog("category.education"),
  health_fitness: labelsFromCatalog("category.healthFitness"),
  food_dining: labelsFromCatalog("category.foodDining"),
  shopping: labelsFromCatalog("category.shopping"),
  travel: labelsFromCatalog("category.travel"),
  business: labelsFromCatalog("category.business"),
  communication: labelsFromCatalog("category.communication"),
  developer_tools: labelsFromCatalog("category.developerTools"),
  design: labelsFromCatalog("category.design"),
  ai_tools: labelsFromCatalog("category.aiTools"),
  security_vpn: labelsFromCatalog("category.securityVpn"),
  hosting_domains: labelsFromCatalog("category.hostingDomains"),
  news_media: labelsFromCatalog("category.newsMedia"),
  other: labelsFromCatalog("category.other"),
};

export const STATUS_LABELS: Record<SubscriptionStatus, LocalizedLabels> = {
  trial: labelsFromCatalog("status.trial"),
  active: labelsFromCatalog("status.active"),
  expired: labelsFromCatalog("status.expired"),
  paused: labelsFromCatalog("status.paused"),
  cancelled: labelsFromCatalog("status.cancelled"),
};

export const CYCLE_LABELS: Record<BillingCycle, LocalizedLabels> = {
  weekly: labelsFromCatalog("cycle.weekly"),
  monthly: labelsFromCatalog("cycle.monthly"),
  quarterly: labelsFromCatalog("cycle.quarterly"),
  'semi-annual': labelsFromCatalog("cycle.semiAnnual"),
  annual: labelsFromCatalog("cycle.annual"),
  custom: labelsFromCatalog("cycle.custom"),
  'one-time': labelsFromCatalog("cycle.oneTime"),
};

export const CHANNEL_LABELS: Record<NotificationChannel, LocalizedLabels> = {
  telegram: labelsFromCatalog("channel.telegram"),
  notifyx: labelsFromCatalog("channel.notifyx"),
  webhook: labelsFromCatalog("channel.webhook"),
  dingtalk: labelsFromCatalog("channel.dingtalk"),
  wechat: labelsFromCatalog("channel.wechat"),
  email: labelsFromCatalog("channel.email"),
  bark: labelsFromCatalog("channel.bark"),
  serverchan: labelsFromCatalog("channel.serverchan"),
  discord: labelsFromCatalog("channel.discord"),
  pushplus: labelsFromCatalog("channel.pushplus"),
};

export const PAYMENT_METHOD_LABELS: Record<BuiltInPaymentMethod, LocalizedLabels> = {
  alipay: labelsFromCatalog("payment.alipay"),
  wechat: labelsFromCatalog("payment.wechat"),
  credit_card: labelsFromCatalog("payment.creditCard"),
  debit_card: labelsFromCatalog("payment.debitCard"),
  paypal: labelsFromCatalog("payment.paypal"),
  apple_pay: labelsFromCatalog("payment.applePay"),
  google_pay: labelsFromCatalog("payment.googlePay"),
  bank_transfer: labelsFromCatalog("payment.bankTransfer"),
  crypto: labelsFromCatalog("payment.crypto"),
  direct_debit: labelsFromCatalog("payment.directDebit"),
  money: labelsFromCatalog("payment.money"),
  samsung_pay: labelsFromCatalog("payment.samsungPay"),
  klarna: labelsFromCatalog("payment.klarna"),
  amazon_pay: labelsFromCatalog("payment.amazonPay"),
  sepa: labelsFromCatalog("payment.sepa"),
  skrill: labelsFromCatalog("payment.skrill"),
  sofort: labelsFromCatalog("payment.sofort"),
  stripe: labelsFromCatalog("payment.stripe"),
  affirm: labelsFromCatalog("payment.affirm"),
  elo: labelsFromCatalog("payment.elo"),
  facebook_pay: labelsFromCatalog("payment.facebookPay"),
  giropay: labelsFromCatalog("payment.giropay"),
  ideal: labelsFromCatalog("payment.ideal"),
  union_pay: labelsFromCatalog("payment.unionPay"),
  interac: labelsFromCatalog("payment.interac"),
  paysafe: labelsFromCatalog("payment.paysafe"),
  poli: labelsFromCatalog("payment.poli"),
  qiwi: labelsFromCatalog("payment.qiwi"),
  shop_pay: labelsFromCatalog("payment.shopPay"),
  venmo: labelsFromCatalog("payment.venmo"),
  verifone: labelsFromCatalog("payment.verifone"),
  webmoney: labelsFromCatalog("payment.webmoney"),
  other: labelsFromCatalog("payment.other"),
};

/** 货币选项所属地区（仅用于 UI 搜索关键词）。 */
export type CurrencyRegion = 'asia' | 'europe' | 'americas' | 'oceania' | 'africa' | 'global';

/** 货币下拉选项（用于新增/编辑订阅，以及自定义货币配置）。 */
export interface CurrencyOption {
  /** 货币代码（ISO 4217），例如：CNY、USD。 */
  value: string;
  /** 货币身份展示文案，由 currency-data 统一生成。 */
  labels: LocalizedLabels;
  /** 地区分组（用于 UI 分组/排序展示）。 */
  region: CurrencyRegion;
}

/** 时区下拉选项（用于设置页选择）。 */
export interface TimezoneOption {
  /** IANA 时区名，例如：Asia/Shanghai。 */
  value: string;
  /** UI 展示文案（通常包含 UTC 偏移）。 */
  label: string;
}

/** 提醒天数下拉选项（用于新增/编辑订阅）。 */
export interface ReminderDaysOption {
  /** 提前多少天提醒；-1 表示继承设置页全局值。 */
  value: number;
  /** UI 展示文案。 */
  labels: LocalizedLabels;
}

export interface RepeatReminderIntervalOption {
  value: RepeatReminderInterval;
  labels: LocalizedLabels;
}

export interface RepeatReminderWindowOption {
  value: RepeatReminderWindow;
  labels: LocalizedLabels;
}

/** 两个远端汇率来源共同支持的 146 种货币（用于默认列表与下拉选项）。 */
export const CURRENCY_OPTIONS = SUPPORTED_EXCHANGE_RATE_CURRENCIES.map((value) => ({
  value,
  labels: withDerivedLabels(
    labels(
      getIntlCurrencyOptionLabel(value, 'zh-CN'),
      getIntlCurrencyOptionLabel(value, 'en-US'),
    ),
    (locale) => getIntlCurrencyOptionLabel(value, locale),
  ),
  region: 'global',
})) satisfies readonly CurrencyOption[];

export const TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Denver', label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'Pacific/Honolulu', label: 'Pacific/Honolulu' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland' },
  { value: 'Pacific/Kiritimati', label: 'Pacific/Kiritimati' },
] as const satisfies readonly TimezoneOption[];

export const REMINDER_DAYS_OPTIONS = [
  { value: 1, labels: labelsFromCatalog("reminder.days1") },
  { value: 3, labels: labelsFromCatalog("reminder.days3") },
  { value: 7, labels: labelsFromCatalog("reminder.days7") },
  { value: 14, labels: labelsFromCatalog("reminder.days14") },
  { value: 30, labels: labelsFromCatalog("reminder.days30") },
] as const satisfies readonly ReminderDaysOption[];

export const REPEAT_REMINDER_INTERVAL_OPTIONS = [
  { value: '1h', labels: labelsFromCatalog("repeat.interval1h") },
  { value: '3h', labels: labelsFromCatalog("repeat.interval3h") },
  { value: '6h', labels: labelsFromCatalog("repeat.interval6h") },
  { value: '12h', labels: labelsFromCatalog("repeat.interval12h") },
  { value: '24h', labels: labelsFromCatalog("repeat.interval24h") },
] as const satisfies readonly RepeatReminderIntervalOption[];

export const REPEAT_REMINDER_SENTENCE_INTERVAL_LABELS: Record<RepeatReminderInterval, LocalizedLabels> = {
  '1h': labelsFromCatalog("repeat.sentenceInterval1h"),
  '3h': labelsFromCatalog("repeat.sentenceInterval3h"),
  '6h': labelsFromCatalog("repeat.sentenceInterval6h"),
  '12h': labelsFromCatalog("repeat.sentenceInterval12h"),
  '24h': labelsFromCatalog("repeat.sentenceInterval24h"),
};

export const REPEAT_REMINDER_WINDOW_OPTIONS = [
  { value: '24h', labels: labelsFromCatalog("repeat.window24h") },
  { value: '48h', labels: labelsFromCatalog("repeat.window48h") },
  { value: '72h', labels: labelsFromCatalog("repeat.window72h") },
  { value: 'full', labels: labelsFromCatalog("repeat.windowFull") },
] as const satisfies readonly RepeatReminderWindowOption[];

export const DEFAULT_SETTINGS: AppSettings = createDefaultAppSettings();
