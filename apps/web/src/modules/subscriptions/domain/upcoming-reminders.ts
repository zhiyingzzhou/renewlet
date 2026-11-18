import { createBillingDateProjector, prepareBillingDateWindow, type BillingDateWindow } from "@renewlet/shared/subscription-renewal";
import { effectiveReminderDays } from "@renewlet/shared/runtime";
import { daysBetweenDateOnly, toPlainDate, type DateOnly } from "@/lib/time/date-only";
import { isOneTimeBuyout } from "@/lib/subscription-billing";
import { DISABLED_REMINDER_DAYS, type SubscriptionCollectionItem } from "@/types/subscription";
import { isEffectivelyActiveSubscription } from "./subscription-status";

export type UpcomingReminderKind = "renewal" | "expiry";

export interface UpcomingReminderItem {
  subscription: SubscriptionCollectionItem;
  kind: UpcomingReminderKind;
  daysUntil: number;
  reminderDays: number;
}

export type UpcomingSubscriptionEventKind = "renewal" | "trial" | "expiry";

export interface UpcomingSubscriptionEvent {
  id: string;
  projected: boolean;
  /** null 表示事件不扣费；零价订阅仍保留 "0"，不能和纯到期事件混为一类。 */
  amount: SubscriptionCollectionItem["price"] | null;
  subscriptionId: string;
  subscription: SubscriptionCollectionItem;
  kind: UpcomingSubscriptionEventKind;
  dueDate: DateOnly;
  daysUntil: number;
  reminderEnabled: boolean;
}

export function subscriptionEventLabelKey(event: UpcomingSubscriptionEvent) {
  if (event.kind === "expiry") return "upcoming.expiry";
  if (event.kind === "trial") return event.amount === null ? "upcoming.trial" : "upcoming.trialCharge";
  return event.projected ? "upcoming.projectedRenewal" : "upcoming.renewal";
}

interface BuildUpcomingReminderItemsInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  notificationReminderDays: number;
  today: DateOnly | string;
}

/** 构建首页“即将续费/到期”提醒窗口条目。 */
export function buildUpcomingReminderItems({
  subscriptions,
  notificationReminderDays,
  today,
}: BuildUpcomingReminderItemsInput): UpcomingReminderItem[] {
  const items: UpcomingReminderItem[] = [];

  for (const subscription of subscriptions) {
    if (!isEffectivelyActiveSubscription(subscription, today)) continue;
    if (isOneTimeBuyout(subscription)) continue;

    // 首页可视窗口复用 reminderDays 的哨兵契约，但这里只决定是否展示，不代表 Cron 发送时刻。
    const reminderDays = effectiveReminderDays(subscription.reminderDays, notificationReminderDays);
    if (reminderDays === undefined) continue;

    const daysUntil = daysBetweenDateOnly(today, subscription.nextBillingDate);
    if (daysUntil < 0 || daysUntil > reminderDays) continue;

    items.push({
      subscription,
      kind: subscription.billingCycle === "one-time" ? "expiry" : "renewal",
      daysUntil,
      reminderDays,
    });
  }

  return items.sort((a, b) => {
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
    return a.subscription.name.localeCompare(b.subscription.name);
  });
}

interface BuildUpcomingSubscriptionEventsInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  today: DateOnly | string;
  from?: DateOnly | string;
  to?: DateOnly | string;
  limit?: number;
}

type EventCandidate = Omit<UpcomingSubscriptionEvent, "daysUntil">;

function* subscriptionEvents(subscription: SubscriptionCollectionItem, window: BillingDateWindow): Generator<EventCandidate> {
  // 到期是展示状态，不代表第三方停止收费；预测只尊重明确保存的停用状态。
  if ((subscription.status !== "active" && subscription.status !== "trial") || isOneTimeBuyout(subscription)) return;
  const event = (dueDate: DateOnly, kind: UpcomingSubscriptionEventKind, amount: UpcomingSubscriptionEvent["amount"]): EventCandidate => ({
    id: `${subscription.id}:${dueDate}:${kind}`, subscriptionId: subscription.id, subscription, kind, dueDate,
    projected: kind === "renewal" && dueDate !== subscription.nextBillingDate,
    amount, reminderEnabled: subscription.reminderDays !== DISABLED_REMINDER_DAYS,
  });
  const trialDate = subscription.status === "trial" && subscription.trialEndDate
    && subscription.trialEndDate <= subscription.nextBillingDate ? subscription.trialEndDate : undefined;
  if (trialDate && trialDate < subscription.nextBillingDate && trialDate >= window.from && trialDate <= window.to) {
    yield event(trialDate, "trial", null);
  }
  if (subscription.billingCycle === "one-time") {
    if (subscription.nextBillingDate >= window.from && subscription.nextBillingDate <= window.to) {
      yield event(subscription.nextBillingDate, "expiry", null);
    }
    return;
  }
  for (const date of createBillingDateProjector(subscription).dates(window)) {
    // 同日试用结束与首次扣费合并，固定锚点生成的日期已经过 shared 校验。
    yield event(date, date === trialDate ? "trial" : "renewal", subscription.price);
  }
}

function compareEvents(left: EventCandidate, right: EventCandidate): number {
  if (left.dueDate !== right.dueDate) return left.dueDate < right.dueDate ? -1 : 1;
  return left.subscription.name.localeCompare(right.subscription.name) || left.id.localeCompare(right.id);
}

function eventFinisher(today: string) {
  const start = toPlainDate(today);
  const daysByDate = new Map<string, number>();
  return (event: EventCandidate): UpcomingSubscriptionEvent => {
    let daysUntil = daysByDate.get(event.dueDate);
    if (daysUntil === undefined) {
      daysUntil = start.until(toPlainDate(event.dueDate), { largestUnit: "day" }).days;
      daysByDate.set(event.dueDate, daysUntil);
    }
    return Object.assign(event, { daysUntil });
  };
}

/** 每个订阅是一个可让出主线程的工作单元；只保留全局 limit 个流，避免生成 N×limit 个事件。 */
export function* upcomingSubscriptionEventsTask({
  subscriptions, today, from = today, to, limit = to === undefined ? 5 : undefined,
}: BuildUpcomingSubscriptionEventsInput): Generator<void, UpcomingSubscriptionEvent[]> {
  if (limit !== undefined && limit <= 0) return [];
  if (limit === undefined) {
    const grouped = yield* calendarSubscriptionEventsTask({ subscriptions, today, from, ...(to === undefined ? {} : { to }) });
    return [...grouped.keys()].sort().flatMap((date) => grouped.get(date)!);
  }
  const window = prepareBillingDateWindow(from > today ? from : today, to);
  if (window.from > window.to) return [];
  const candidates: { event: EventCandidate; iterator: Generator<EventCandidate> }[] = [];
  const sortCandidates = () => candidates.sort((left, right) => compareEvents(left.event, right.event));
  for (const subscription of subscriptions) {
    const iterator = subscriptionEvents(subscription, window);
    const first = iterator.next();
    if (!first.done) {
      candidates.push({ event: first.value, iterator });
      sortCandidates();
      // 各流日期单调，首事件未进入全局前 limit 的流不可能贡献最终前 limit；直接释放其迭代状态。
      if (candidates.length > limit) candidates.pop();
    }
    yield;
  }
  const finish = eventFinisher(today);
  const events: UpcomingSubscriptionEvent[] = [];
  while (events.length < limit && candidates.length) {
    const first = candidates.shift()!;
    events.push(finish(first.event));
    if (events.length < limit) {
      const next = first.iterator.next();
      if (!next.done) {
        candidates.push({ event: next.value, iterator: first.iterator });
        sortCandidates();
      }
    }
  }
  return events;
}

/** 日历直接按日期归组，同名排序只做一次；日差按不同日期复用，不建立额外全局事件排序数组。 */
export function* calendarSubscriptionEventsTask({
  subscriptions, today, from = today, to,
}: Omit<BuildUpcomingSubscriptionEventsInput, "limit">): Generator<void, Map<string, UpcomingSubscriptionEvent[]>> {
  const window = prepareBillingDateWindow(from > today ? from : today, to);
  const grouped = new Map<string, UpcomingSubscriptionEvent[]>();
  if (window.from > window.to) return grouped;
  const finish = eventFinisher(today);
  const ordered = [...subscriptions].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const subscription of ordered) {
    for (const candidate of subscriptionEvents(subscription, window)) {
      const event = finish(candidate);
      const events = grouped.get(event.dueDate);
      if (events) events.push(event);
      else grouped.set(event.dueDate, [event]);
    }
    yield;
  }
  return grouped;
}

/** 同步入口用于小范围派生与纯模型测试，页面通过同一任务按需让出主线程。 */
export function buildUpcomingSubscriptionEvents(input: BuildUpcomingSubscriptionEventsInput): UpcomingSubscriptionEvent[] {
  const task = upcomingSubscriptionEventsTask(input);
  let result = task.next();
  while (!result.done) result = task.next();
  return result.value;
}

/** 列表筛选仍表示当前有效记录的下一日期，不把逾期后的预测账期带入原有日期筛选。 */
export function resolveUpcomingSubscriptionEvent(
  subscription: SubscriptionCollectionItem,
  today: DateOnly | string,
): UpcomingSubscriptionEvent | null {
  if (!isEffectivelyActiveSubscription(subscription, today)) return null;
  return buildUpcomingSubscriptionEvents({ subscriptions: [subscription], today, limit: 1 })[0] ?? null;
}
