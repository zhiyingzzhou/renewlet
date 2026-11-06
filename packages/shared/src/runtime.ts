/** shared runtime 常量是 Go DTO、Cloudflare Worker 和前端 schema 的共同枚举边界。 */
export {
  DEFAULT_LOCALE_PREFERENCE,
  FALLBACK_LOCALE,
  LOCALE_PREFERENCES,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  type Locale,
  type LocalePreference,
} from "./i18n-config";

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_VARIANTS = ["emerald", "ocean", "sunset", "lavender", "rose", "custom"] as const;
export type ThemeVariant = (typeof THEME_VARIANTS)[number];

/** `expired` 是当前正式状态，状态变更必须同步 D1、PocketBase hook、前端筛选和导入导出。 */
export const SUBSCRIPTION_STATUSES = ["trial", "active", "expired", "paused", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** `one-time` 默认是买断；携带 oneTimeTermCount/unit 时才按固定权益期摊销并提醒到期。 */
export const BILLING_CYCLES = ["weekly", "monthly", "quarterly", "semi-annual", "annual", "custom", "one-time"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** 自定义扣费周期单位是跨 Go/PocketBase、D1 和前端日期算法的共同契约；产品 API 不允许缺省。 */
export const CUSTOM_CYCLE_UNITS = ["day", "week", "month", "year"] as const;
export type CustomCycleUnit = (typeof CUSTOM_CYCLE_UNITS)[number];

/**
 * 模型可能返回本地化单位或把数量连在单位前面；这里统一收敛到持久化枚举。
 * 只处理单位本身，不从文本猜测周期数量，数量仍由调用方单独解析。
 */
export function normalizeCustomCycleUnit(value: string | null | undefined): CustomCycleUnit | null {
  const text = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "") : "";
  if (!text) return null;
  if (text === "day" || text === "days" || text === "天" || text === "日") return "day";
  if (text === "week" || text === "weeks" || text === "周" || text === "星期") return "week";
  if (text === "month" || text === "months" || text === "月" || text === "个月") return "month";
  if (text === "year" || text === "years" || text === "年" || text === "年度") return "year";
  const suffix = text.match(/(days?|天|日|weeks?|周|星期|months?|个月|月|years?|年|年度)$/)?.[1];
  if (suffix === "day" || suffix === "days" || suffix === "天" || suffix === "日") return "day";
  if (suffix === "week" || suffix === "weeks" || suffix === "周" || suffix === "星期") return "week";
  if (suffix === "month" || suffix === "months" || suffix === "月" || suffix === "个月") return "month";
  if (suffix === "year" || suffix === "years" || suffix === "年" || suffix === "年度") return "year";
  return null;
}

/** 通知渠道枚举同时约束设置 payload、cron result 和历史面板筛选。 */
export const NOTIFICATION_CHANNELS = ["telegram", "notifyx", "webhook", "dingtalk", "wechat", "email", "bark", "serverchan", "discord", "pushplus"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const REPEAT_REMINDER_INTERVALS = ["1h", "3h", "6h", "12h", "24h"] as const;
export type RepeatReminderInterval = (typeof REPEAT_REMINDER_INTERVALS)[number];

export const REPEAT_REMINDER_WINDOWS = ["24h", "48h", "72h", "full"] as const;
export type RepeatReminderWindow = (typeof REPEAT_REMINDER_WINDOWS)[number];

export const EXCHANGE_RATE_PROVIDERS = ["frankfurter", "floatrates", "exchange-api"] as const;
export type ExchangeRateProvider = (typeof EXCHANGE_RATE_PROVIDERS)[number];

/** 跨 Go/PocketBase、D1 和前端的 date-only 品牌类型，避免续费日期被误当成带时区 instant。 */
export type DateOnly = string & { readonly __brand: "DateOnly" };
/** 通知调度保存用户本地墙钟时间；真实 UTC instant 由后端按 IANA timezone 推导。 */
export type LocalTime = string & { readonly __brand: "LocalTime" };

// reminderDays 的负值是跨 Go/PocketBase、D1、前端和导入链路共享的哨兵：-2 静默，-1 继承，0 当天提醒。
export const DISABLED_REMINDER_DAYS = -2;
export const INHERIT_REMINDER_DAYS = -1;
export const DEFAULT_NOTIFICATION_REMINDER_DAYS = 3;
export const MAX_REMINDER_DAYS = 3650;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDateOnly(value: string): boolean {
  // date-only 是跨 Go/PocketBase、D1 和前端的契约；禁止带时区的 ISO datetime 混入。
  if (!DATE_ONLY_RE.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp)) return false;
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function isValidLocalTime(value: string): boolean {
  return LOCAL_TIME_RE.test(value);
}

export function isValidTimeZone(value: string): boolean {
  try {
    // Intl 是浏览器、Node 和 Workers 都可用的 IANA timezone 共同裁判，避免维护本地时区表。
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeExchangeRateProvider(value: unknown): ExchangeRateProvider {
  if (value === "frankfurter") return "frankfurter";
  if (value === "floatrates") return "floatrates";
  if (value === "exchange-api") return "exchange-api";
  return "frankfurter";
}

export function isValidReminderDays(value: number): boolean {
  return Number.isInteger(value) && value >= DISABLED_REMINDER_DAYS && value <= MAX_REMINDER_DAYS;
}

export function isDisabledReminderDays(value: number): boolean {
  return value === DISABLED_REMINDER_DAYS;
}

export function isInheritReminderDays(value: number): boolean {
  return value === INHERIT_REMINDER_DAYS;
}

export function effectiveReminderDays(reminderDays: number, notificationReminderDays: number): number | undefined {
  // -2 在通知链路中表示“单订阅静默”；undefined 让调用方自然跳过该订阅，不写通知 payload。
  if (isDisabledReminderDays(reminderDays)) return undefined;
  return isInheritReminderDays(reminderDays) ? notificationReminderDays : reminderDays;
}
