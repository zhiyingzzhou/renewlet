/**
 * 通知内容构建器。
 *
 * 架构位置：
 * - Cron/手动通知负责读取 settings 和订阅。
 * - 本模块只把领域数据转换成纯文本消息，不访问网络、不写数据库。
 *
 * 流程：
 * ```
 * 当前时间 + settings + subscriptions -> date-only 比较 -> 文本分组 -> NotificationContent
 * ```
 */
import type {
  AppSettings,
  CostSharing,
  RepeatReminderInterval,
  RepeatReminderWindow,
  BillingCycle,
  CustomCycleUnit,
  SubscriptionStatus,
} from "@/types/subscription";
import { effectiveReminderDays, isDisabledReminderDays, ordinaryRemindersAllowed } from "@renewlet/shared/runtime";
import { daysBetweenDateOnly, isValidDateOnly, todayDateOnlyInTimeZone, type DateOnly } from "@/lib/time/date-only";
import { isValidTimeZone } from "@/lib/time/time-zone";
import { DEFAULT_LOCALE, localeForPreference, type Locale } from "@/i18n/locales";
import { translate, type MessageKey, type MessageParams } from "@/i18n/messages";
import { divideMoney, moneyToNumber, type MoneyString } from "@renewlet/shared/money";
import { costSharingCollectionReminderOccurrencesForDate } from "@renewlet/shared/cost-sharing";
import { isOneTimeBuyout } from "@/lib/subscription-billing";

/**
 * 生成通知内容（不负责发送）。
 *
 * 说明：
 * - 该文件只做“输入 → 文本消息”的纯逻辑，便于后续写单测/复用到不同触发器（手动/定时）
 * - 金额不做汇率换算：通知更接近“原始扣费信息”（统计口径在页面里处理）
 *
 * 注意： 这里使用 date-only 天数比较，不使用 Date 本地时区差值，避免服务器时区影响提醒日期。
 */

export interface SubscriptionForNotification {
  id: string;
  name: string;
  price: string;
  currency: string;
  status: SubscriptionStatus;
  billingCycle?: BillingCycle;
  customDays?: number | undefined;
  customCycleUnit?: CustomCycleUnit | undefined;
  oneTimeTermCount?: number | undefined;
  oneTimeTermUnit?: CustomCycleUnit | undefined;
  startDate?: string | null;
  nextBillingDate: string; // YYYY-MM-DD
  trialEndDate?: string | null; // YYYY-MM-DD | null
  reminderDays: number;
  repeatReminderEnabled?: boolean;
  repeatReminderInterval?: RepeatReminderInterval;
  repeatReminderWindow?: RepeatReminderWindow;
  costSharing?: CostSharing | undefined;
}

export type NotificationItemType = "renewal" | "trial" | "expired" | "expiry" | "costSharing";

/** 单个会进入通知内容的结构化条目，用于发送历史快照和即将提醒预览。 */
export interface NotificationContentItem {
  type: NotificationItemType;
  subscriptionId: string;
  name: string;
  price: string;
  currency: string;
  status: SubscriptionStatus;
  targetDate: string;
  reminderDays: number;
  daysUntil: number;
  repeatReminder?: {
    interval: RepeatReminderInterval;
    window: RepeatReminderWindow;
  };
  costSharing?: {
    memberName: string;
    amount: MoneyString;
    currency: string;
  };
}

/** 通知内容输出；发送层只关心 title/content/timestamp，调度层使用 hasPayload 决定是否发送。 */
export interface NotificationContent {
  title: string;
  content: string;
  /** 用户可见的生成时间，已按用户选择的 IANA 时区格式化。 */
  timestamp: string;
  items: NotificationContentItem[];
  /** 用于判断“是否真的需要发送”的标志（例如没到期时不发）。 */
  hasPayload: boolean;
}

/** 取某个时区的“今天”（YYYY-MM-DD）。 */
export function getTodayDateOnlyInTimeZone(now: Date, timeZone: string): string {
  try {
    return todayDateOnlyInTimeZone(now, timeZone);
  } catch {
    return todayDateOnlyInTimeZone(now, "UTC");
  }
}

function resolveDisplayTimeZone(timeZone: string): string {
  const trimmed = timeZone.trim();
  return trimmed && isValidTimeZone(trimmed) ? trimmed : "UTC";
}

function getDateTimePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "00";
}

/** 按用户选择的 IANA 时区格式化通知中展示给人的时间。 */
export function formatNotificationDisplayTime(now: Date, timeZone: string, locale: Locale = DEFAULT_LOCALE): string {
  const displayTimeZone = resolveDisplayTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: displayTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(now);

  // 用 formatToParts 手工拼 `YYYY-MM-DD HH:mm:ss`，避免不同 locale 的标点/顺序影响通知文案和测试断言。
  const year = getDateTimePart(parts, "year");
  const month = getDateTimePart(parts, "month");
  const day = getDateTimePart(parts, "day");
  const hour = getDateTimePart(parts, "hour");
  const minute = getDateTimePart(parts, "minute");
  const second = getDateTimePart(parts, "second");

  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${displayTimeZone}`;
}

function formatAmount(amount: string | number): string {
  const numericAmount = moneyToNumber(amount);
  if (!Number.isFinite(numericAmount)) return String(amount);
  const fixed = numericAmount.toFixed(2);
  return fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function repeatIntervalHours(interval: string): number {
  const hours = Number.parseInt(interval, 10);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

function translateNotification(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  return translate(locale, key, params);
}

function formatItemLine(item: NotificationContentItem, locale: Locale): string {
  let extra: string;
  if (item.type === "trial") {
    extra = translateNotification(locale, "notification.content.trialBeforeDays", { days: item.reminderDays });
  } else if (item.type === "expiry") {
    extra = translateNotification(locale, "notification.content.expiryBeforeDays", { days: item.reminderDays });
  } else if (item.type === "expired") {
    extra = translateNotification(locale, "notification.content.expiredStatus");
  } else if (item.type === "costSharing" && item.costSharing) {
    extra = translateNotification(locale, "notification.content.costSharingBeforeDays", {
      member: item.costSharing.memberName,
      days: item.reminderDays,
    });
  } else {
    extra = translateNotification(locale, "notification.content.beforeDays", { days: item.reminderDays });
  }
  if (item.repeatReminder) {
    const repeat = translateNotification(locale, "notification.content.repeatEvery", {
      hours: repeatIntervalHours(item.repeatReminder.interval),
    });
    extra = translateNotification(locale, "notification.content.extraWithRepeat", { extra, repeat });
  }
  const amount = item.type === "costSharing" && item.costSharing ? item.costSharing.amount : item.price;
  const currency = item.type === "costSharing" && item.costSharing ? item.costSharing.currency : item.currency;
  return translateNotification(locale, "notification.content.itemLine", {
    name: item.name,
    date: item.targetDate,
    amount: formatAmount(amount),
    currency,
    extra,
  });
}

function buildNotificationContentFromItems(
  now: Date,
  timeZone: string,
  items: NotificationContentItem[],
  locale: Locale,
): NotificationContent {
  // 分组顺序固定为续费、到期、试用、过期，让同一批 items 在邮件、Webhook 和历史快照中都稳定可读。
  const renewals = items.filter((item) => item.type === "renewal").map((item) => formatItemLine(item, locale));
  const expiries = items.filter((item) => item.type === "expiry").map((item) => formatItemLine(item, locale));
  const trials = items.filter((item) => item.type === "trial").map((item) => formatItemLine(item, locale));
  const expired = items.filter((item) => item.type === "expired").map((item) => formatItemLine(item, locale));
  const collections = items.filter((item) => item.type === "costSharing").map((item) => formatItemLine(item, locale));

  const blocks: string[] = [];
  if (renewals.length > 0) blocks.push([translateNotification(locale, "notification.content.renewalBlock"), ...renewals].join("\n"));
  if (expiries.length > 0) blocks.push([translateNotification(locale, "notification.content.expiryBlock"), ...expiries].join("\n"));
  if (trials.length > 0) blocks.push([translateNotification(locale, "notification.content.trialBlock"), ...trials].join("\n"));
  if (expired.length > 0) blocks.push([translateNotification(locale, "notification.content.expiredBlock"), ...expired].join("\n"));
  if (collections.length > 0) blocks.push([translateNotification(locale, "notification.content.costSharingBlock"), ...collections].join("\n"));

  const hasPayload = blocks.length > 0;
  const content = hasPayload
    ? blocks.join("\n\n")
    : translateNotification(locale, "notification.content.empty");

  return {
    title: translateNotification(locale, "notification.content.title"),
    content,
    timestamp: formatNotificationDisplayTime(now, timeZone, locale),
    items,
    hasPayload,
  };
}

/** 构造固定测试通知，用于验证单个渠道配置。 */
export function buildTestNotification(now: Date, timeZone: string, locale: Locale = DEFAULT_LOCALE): NotificationContent {
  return {
    title: translateNotification(locale, "notification.content.testTitle"),
    content: translateNotification(locale, "notification.content.testBody"),
    timestamp: formatNotificationDisplayTime(now, timeZone, locale),
    items: [],
    hasPayload: true,
  };
}

/**
 * 计算某个用户本地日期会被纳入通知的条目。
 *
 * `includeExpired=false` 主要用于未来预览，避免把同一批已过期订阅重复塞进未来 30 天的每一天。
 */
export function collectNotificationItemsForLocalDate(
  localDate: DateOnly | string,
  settings: AppSettings,
  subscriptions: SubscriptionForNotification[],
  options: { includeExpired?: boolean } = {},
): NotificationContentItem[] {
  const includeExpired = options.includeExpired ?? true;
  const items: NotificationContentItem[] = [];

  for (const sub of subscriptions) {
    if (!isValidDateOnly(sub.nextBillingDate)) continue;
    // -1 只在订阅存储和表单里表示继承；通知预览/历史 payload 必须保存用户可解释的有效天数。
    const reminderDays = effectiveReminderDays(sub.reminderDays, settings.notificationReminderDays);
    const daysUntilNext = daysBetweenDateOnly(localDate, sub.nextBillingDate);
    const isOneTime = sub.billingCycle === "one-time";
    const buyout = isOneTime && isOneTimeBuyout({
      billingCycle: "one-time",
      oneTimeTermCount: sub.oneTimeTermCount,
      oneTimeTermUnit: sub.oneTimeTermUnit,
    });

    if (ordinaryRemindersAllowed(sub.status) && !isDisabledReminderDays(sub.reminderDays) && reminderDays !== undefined) {
      if (buyout) {
        // one-time 买断没有权益到期边界；购买日不能被本地预览解释成续费或过期。
      } else if (daysUntilNext < 0) {
        if (settings.showExpired && includeExpired) {
          // 过期项只在“当前检查/手动运行”里提示；未来预览会关闭 includeExpired，避免每天重复展示同一笔旧账单。
          items.push({
            type: "expired",
            subscriptionId: sub.id,
            name: sub.name,
            price: sub.price,
            currency: sub.currency,
            status: sub.status,
            targetDate: sub.nextBillingDate,
            reminderDays,
            daysUntil: daysUntilNext,
          });
        }
      } else if (daysUntilNext === reminderDays) {
        items.push({
          type: isOneTime ? "expiry" : "renewal",
          subscriptionId: sub.id,
          name: sub.name,
          price: sub.price,
          currency: sub.currency,
          status: sub.status,
          targetDate: sub.nextBillingDate,
          reminderDays,
          daysUntil: daysUntilNext,
        });
      }

      if (sub.status === "trial" && sub.trialEndDate) {
        if (!isValidDateOnly(sub.trialEndDate)) continue;
        const daysUntilTrialEnd = daysBetweenDateOnly(localDate, sub.trialEndDate);
        if (daysUntilTrialEnd === reminderDays) {
          items.push({
            type: "trial",
            subscriptionId: sub.id,
            name: sub.name,
            price: sub.price,
            currency: sub.currency,
            status: sub.status,
            targetDate: sub.trialEndDate,
            reminderDays,
            daysUntil: daysUntilTrialEnd,
          });
        }
      }
    }
    items.push(...collectCostSharingCollectionItems(sub, settings, localDate, buyout));
  }

  return items;
}

function collectCostSharingCollectionItems(
  sub: SubscriptionForNotification,
  settings: AppSettings,
  localDate: DateOnly | string,
  isOneTimeBuyout: boolean,
): NotificationContentItem[] {
  if (isOneTimeBuyout) return [];
  const occurrences = costSharingCollectionReminderOccurrencesForDate({
    costSharing: sub.costSharing,
    subscriptionStartDate: sub.startDate,
    nextBillingDate: sub.nextBillingDate,
    billingCycle: sub.billingCycle ?? "monthly",
    customDays: sub.customDays,
    customCycleUnit: sub.customCycleUnit,
    oneTimeTermCount: sub.oneTimeTermCount,
    oneTimeTermUnit: sub.oneTimeTermUnit,
    notificationReminderDays: settings.notificationReminderDays,
    referenceDate: localDate,
  });
  return occurrences.flatMap((occurrence) => {
    const payload = costSharingCollectionPayload(sub, occurrence.member);
    if (!payload) return [];
    return [{
      type: "costSharing",
      subscriptionId: sub.id,
      name: sub.name,
      price: sub.price,
      currency: sub.currency,
      status: sub.status,
      targetDate: occurrence.targetDate,
      reminderDays: occurrence.reminderDays,
      daysUntil: daysBetweenDateOnly(localDate, occurrence.targetDate),
      costSharing: payload,
    }];
  });
}

function costSharingCollectionPayload(
  sub: SubscriptionForNotification,
  member: CostSharing["members"][number],
): NotificationContentItem["costSharing"] | null {
  if (!sub.costSharing) return null;
  if (sub.costSharing.splitMode === "custom") {
    if (!member.customAmount) return null;
    // custom 模式只展示成员配置金额和币种；前端预览不猜汇率，也不强制换算为订阅币种。
    return { memberName: member.name, amount: member.customAmount, currency: member.currency ?? sub.currency };
  }
  return {
    memberName: member.name,
    amount: divideMoney(sub.price, sub.costSharing.members.length + 1),
    currency: sub.currency,
  };
}

/**
 * 生成“到期/试用结束”通知内容；没有需要提醒的订阅时返回 hasPayload=false。
 *
 * 规则（尽量贴合现有数据结构）：
 * - 续费提醒：`daysUntil(nextBillingDate) === reminderDays`
 * - 试用结束提醒：`status=trial` 且 `daysUntil(trialEndDate) === reminderDays`
 * - 已过期订阅（可选）：`nextBillingDate < today` 且 settings.showExpired=true
 */
export function buildDueNotification(
  now: Date,
  settings: AppSettings,
  subscriptions: SubscriptionForNotification[],
): NotificationContent {
  const today = getTodayDateOnlyInTimeZone(now, settings.timezone || "UTC");
  return buildDueNotificationForLocalDate(today, now, settings, subscriptions);
}

/**
 * 按指定用户本地调度日构建通知内容。
 *
 * Cron 可能在跨午夜的容错窗口内补跑上一天的计划任务，因此不能总是用 `now`
 * 推导本地日期；否则 23:59 的计划在 00:01 补跑时会错过上一天应命中的订阅。
 */
export function buildDueNotificationForLocalDate(
  localDate: DateOnly | string,
  now: Date,
  settings: AppSettings,
  subscriptions: SubscriptionForNotification[],
): NotificationContent {
  const items = collectNotificationItemsForLocalDate(localDate, settings, subscriptions);
  return buildNotificationContentFromItems(now, settings.timezone || "UTC", items, localeForPreference(settings.localePreference));
}
