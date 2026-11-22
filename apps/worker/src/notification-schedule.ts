import { scheduleInstantUtc } from "@renewlet/shared/schedule-time";
import {
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  effectiveReminderDays,
  ordinaryRemindersAllowed,
  isDisabledReminderDays,
  isValidDateOnly,
  type RepeatReminderInterval,
  type RepeatReminderWindow,
} from "@renewlet/shared/runtime";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { addDays, dateOnlyInZone, localTimeInZone, safeTimeZone, toRfc3339Seconds } from "./time";
export { addDays, dateOnlyInZone, localTimeInZone, toRfc3339Seconds } from "./time";

/**
 * Worker 通知调度只处理“用户本地墙钟时间 -> UTC instant”的纯决策。
 * D1 job 状态机在 notification-jobs.ts，避免时间窗口和发送重试互相缠绕。
 */
export interface ScheduleOccurrence {
  scheduledLocalDate: string;
  scheduledLocalTime: string;
  timeZone: string;
  scheduledInstantUtc: string;
}

export interface ScheduleDecision extends ScheduleOccurrence {
  due: boolean;
  reason: string;
}

export interface RepeatReminderSnapshot {
  interval: RepeatReminderInterval;
  window: RepeatReminderWindow;
}

export function isSubscriptionReminderEligible(sub: Pick<ApiSubscription, "status">): boolean {
  return ordinaryRemindersAllowed(sub.status);
}

const DEFAULT_REPEAT_REMINDER_INTERVAL: RepeatReminderInterval = "1h";
const DEFAULT_REPEAT_REMINDER_WINDOW: RepeatReminderWindow = "72h";

const repeatReminderDurations: Record<RepeatReminderInterval, number> = {
  "1h": 60 * 60_000,
  "3h": 3 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

const repeatReminderWindowDurations: Record<Exclude<RepeatReminderWindow, "full">, number> = {
  "24h": 24 * 60 * 60_000,
  "48h": 48 * 60 * 60_000,
  "72h": 72 * 60 * 60_000,
};

export function getNotificationScheduleDecision(
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal" | "notificationReminderDays">,
  subscriptions: ApiSubscription[],
  windowMinutes: number,
  force: boolean,
): ScheduleDecision {
  const regular = getLocalScheduleDecision(now, settings.timezone, settings.notificationTimeLocal, windowMinutes, force);
  if (regular.due || force) return regular;
  // 日常提醒优先；本轮未命中时再检查 repeat，避免同一分钟重复生成两个 job。
  const repeat = getRepeatScheduleDecision(now, settings, subscriptions, windowMinutes);
  if (repeat.due) return repeat;
  return regular;
}

export function getLocalScheduleDecision(now: Date, timezone: string, localTime: string, windowMinutes: number, force: boolean): ScheduleDecision {
  const timeZone = safeTimeZone(timezone);
  const scheduleTime = isValidLocalTime(localTime) ? localTime : "08:00";
  const today = dateOnlyInZone(now, timeZone);
  if (force) {
    return {
      ...scheduleOccurrence(today, scheduleTime, timeZone),
      due: true,
      reason: "force",
    };
  }
  const todayDecision = buildScheduleDecision(now, today, scheduleTime, timeZone, windowMinutes);
  if (todayDecision.due) return todayDecision;
  // UTC tick 与用户本地日期可能跨日；昨天窗口仍可能落在当前 UTC 分钟内。
  const yesterdayDecision = buildScheduleDecision(now, addDays(today, -1), scheduleTime, timeZone, windowMinutes);
  if (yesterdayDecision.due) return yesterdayDecision;
  return todayDecision;
}

export function getNextLocalScheduleOccurrence(now: Date, timezone: string, localTime: string, includeCurrent = true): ScheduleOccurrence {
  const timeZone = safeTimeZone(timezone);
  const scheduleTime = isValidLocalTime(localTime) ? localTime : "08:00";
  const today = dateOnlyInZone(now, timeZone);
  const todayInstant = Date.parse(scheduleOccurrence(today, scheduleTime, timeZone).scheduledInstantUtc);
  const date = todayInstant < now.getTime() || (!includeCurrent && todayInstant === now.getTime()) ? addDays(today, 1) : today;
  return scheduleOccurrence(date, scheduleTime, timeZone);
}

export function getNextRepeatScheduleOccurrence(
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal" | "notificationReminderDays">,
  subscriptions: ApiSubscription[],
): ScheduleOccurrence | null {
  let next: ScheduleOccurrence | null = null;
  let nextInstant = Number.POSITIVE_INFINITY;
  for (const sub of subscriptions) {
    // repeat preview 与实际 due 共用静默哨兵；-2 订阅不能绕过日常提醒入口进入重复提醒。
    if (!isSubscriptionReminderEligible(sub) || !sub.repeatReminderEnabled || isDisabledReminderDays(sub.reminderDays)) continue;
    const reminderDays = effectiveReminderDays(sub.reminderDays, settings.notificationReminderDays);
    if (reminderDays === undefined) continue;
    const repeat = repeatReminderSnapshot(sub);
    const targets = sub.status === "trial" && sub.trialEndDate ? [sub.nextBillingDate, sub.trialEndDate] : [sub.nextBillingDate];
    for (const targetDate of targets) {
      const occurrence = nextRepeatOccurrenceAfter(now, settings, reminderDays, targetDate, repeat);
      if (!occurrence) continue;
      const instant = Date.parse(occurrence.scheduledInstantUtc);
      if (instant < nextInstant) {
        next = occurrence;
        nextInstant = instant;
      }
    }
  }
  return next;
}

export function getRepeatScheduleDecision(
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal" | "notificationReminderDays">,
  subscriptions: ApiSubscription[],
  windowMinutes: number,
): ScheduleDecision {
  for (const sub of subscriptions) {
    if (!isSubscriptionReminderEligible(sub) || isDisabledReminderDays(sub.reminderDays) || !sub.repeatReminderEnabled) continue;
    const reminderDays = effectiveReminderDays(sub.reminderDays, settings.notificationReminderDays);
    if (reminderDays === undefined) continue;
    const repeat = repeatReminderSnapshot(sub);
    const renewal = repeatReminderDueOccurrence(now, settings, reminderDays, sub.nextBillingDate, repeat, windowMinutes);
    if (renewal) return { ...renewal, due: true, reason: "repeat_reminder_due" };
    if (sub.status === "trial" && sub.trialEndDate) {
      const trial = repeatReminderDueOccurrence(now, settings, reminderDays, sub.trialEndDate, repeat, windowMinutes);
      if (trial) return { ...trial, due: true, reason: "repeat_reminder_due" };
    }
  }
  return {
    scheduledLocalDate: "",
    scheduledLocalTime: "",
    timeZone: safeTimeZone(settings.timezone),
    scheduledInstantUtc: "",
    due: false,
    reason: "no_repeat_reminder_due",
  };
}

function repeatReminderDueOccurrence(
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal">,
  reminderDays: number,
  targetDate: string,
  repeat: RepeatReminderSnapshot,
  windowMinutes: number,
): ScheduleOccurrence | null {
  if (!isValidDateOnly(targetDate)) return null;
  const targetInstant = Date.parse(scheduleOccurrence(targetDate, settings.notificationTimeLocal, settings.timezone).scheduledInstantUtc);
  const firstInstant = Date.parse(scheduleOccurrence(addDays(targetDate, -reminderDays), settings.notificationTimeLocal, settings.timezone).scheduledInstantUtc);
  const interval = repeatReminderDurations[repeat.interval];
  const elapsed = now.getTime() - firstInstant;
  if (elapsed <= 0) return null;
  // 用整除定位最近一个 repeat 点，避免按小时循环扫描长窗口。
  const steps = Math.floor(elapsed / interval);
  if (steps < 1) return null;
  const candidate = firstInstant + steps * interval;
  if (candidate > targetInstant) return null;
  if (candidate < repeatWindowStart(firstInstant, targetInstant, repeat)) return null;
  const deltaMinutes = Math.floor((now.getTime() - candidate) / 60_000);
  if (deltaMinutes < 0 || deltaMinutes > Math.max(windowMinutes, 0)) return null;
  return localScheduleOccurrenceFromInstant(new Date(candidate), settings.timezone);
}

export function nextRepeatOccurrenceAfter(
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal">,
  reminderDays: number,
  targetDate: string,
  repeat: RepeatReminderSnapshot,
): ScheduleOccurrence | null {
  if (!isValidDateOnly(targetDate)) return null;
  const targetInstant = Date.parse(scheduleOccurrence(targetDate, settings.notificationTimeLocal, settings.timezone).scheduledInstantUtc);
  const firstInstant = Date.parse(scheduleOccurrence(addDays(targetDate, -reminderDays), settings.notificationTimeLocal, settings.timezone).scheduledInstantUtc);
  const interval = repeatReminderDurations[repeat.interval];
  const windowStart = repeatWindowStart(firstInstant, targetInstant, repeat);
  const start = Math.max(now.getTime(), windowStart);
  // 预览从有效窗口起点算起；首提醒由日常提醒负责，repeat 从下一次 interval 开始。
  let steps = Math.floor((start - firstInstant) / interval);
  let candidate = firstInstant + steps * interval;
  if (candidate < start || candidate === firstInstant) steps += 1;
  if (steps < 1) steps = 1;
  candidate = firstInstant + steps * interval;
  if (candidate <= now.getTime()) candidate += interval;
  if (candidate > targetInstant || candidate < windowStart) return null;
  return localScheduleOccurrenceFromInstant(new Date(candidate), settings.timezone);
}

export function repeatReminderOccurrenceMatches(
  schedule: ScheduleOccurrence,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal">,
  reminderDays: number,
  targetDate: string,
  repeat: RepeatReminderSnapshot,
): boolean {
  if (!isValidDateOnly(targetDate)) return false;
  const scheduledInstant = Date.parse(schedule.scheduledInstantUtc);
  const targetInstant = Date.parse(scheduleOccurrence(targetDate, settings.notificationTimeLocal, settings.timezone).scheduledInstantUtc);
  const firstInstant = Date.parse(scheduleOccurrence(addDays(targetDate, -reminderDays), settings.notificationTimeLocal, settings.timezone).scheduledInstantUtc);
  if (scheduledInstant <= firstInstant || scheduledInstant > targetInstant) return false;
  if (scheduledInstant < repeatWindowStart(firstInstant, targetInstant, repeat)) return false;
  return (scheduledInstant - firstInstant) % repeatReminderDurations[repeat.interval] === 0;
}

export function repeatReminderSnapshot(sub: Pick<ApiSubscription, "repeatReminderInterval" | "repeatReminderWindow">): RepeatReminderSnapshot {
  return {
    interval: REPEAT_REMINDER_INTERVALS.includes(sub.repeatReminderInterval) ? sub.repeatReminderInterval : DEFAULT_REPEAT_REMINDER_INTERVAL,
    window: REPEAT_REMINDER_WINDOWS.includes(sub.repeatReminderWindow) ? sub.repeatReminderWindow : DEFAULT_REPEAT_REMINDER_WINDOW,
  };
}

function repeatWindowStart(firstInstant: number, targetInstant: number, repeat: RepeatReminderSnapshot): number {
  if (repeat.window === "full") return firstInstant;
  return Math.max(firstInstant, targetInstant - repeatReminderWindowDurations[repeat.window]);
}

function buildScheduleDecision(now: Date, localDate: string, localTime: string, timezone: string, windowMinutes: number): ScheduleDecision {
  const occurrence = scheduleOccurrence(localDate, localTime, timezone);
  const deltaMinutes = Math.floor((now.getTime() - Date.parse(occurrence.scheduledInstantUtc)) / 60_000);
  const due = deltaMinutes >= 0 && deltaMinutes <= Math.max(windowMinutes, 0);
  return {
    ...occurrence,
    due,
    reason: deltaMinutes < 0 ? "before_scheduled_time" : `not_in_time_window(delta=${deltaMinutes}m)`,
  };
}

export function scheduleOccurrence(date: string, time: string, timezone: string): ScheduleOccurrence {
  const timeZone = safeTimeZone(timezone);
  return {
    scheduledLocalDate: date,
    scheduledLocalTime: time,
    timeZone,
    scheduledInstantUtc: scheduleInstantUtc(date, time, timeZone),
  };
}

function localScheduleOccurrenceFromInstant(instant: Date, timezone: string): ScheduleOccurrence {
  const timeZone = safeTimeZone(timezone);
  return {
    scheduledLocalDate: dateOnlyInZone(instant, timeZone),
    scheduledLocalTime: localTimeInZone(instant, timeZone),
    timeZone,
    scheduledInstantUtc: toRfc3339Seconds(instant),
  };
}

export function displayTime(date: Date, settings: Pick<ApiAppSettings, "timezone">): string {
  return `${dateOnlyInZone(date, settings.timezone)} ${localTimeInZone(date, settings.timezone)} ${safeTimeZone(settings.timezone)}`;
}

function isValidLocalTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}
