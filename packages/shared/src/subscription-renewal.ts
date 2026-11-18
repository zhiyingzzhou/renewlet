import { Temporal } from "@js-temporal/polyfill";
import {
  type BillingCycle,
  type CustomCycleUnit,
  type DateOnly,
  type SubscriptionStatus,
  isValidDateOnly,
} from "./runtime";

/** 续订模式决定推进阈值：自动维护追到 today，手动续订至少推进一期并严格晚于当前边界。 */
export type RenewalMode = "auto" | "manual";

/** 续订算法输入是跨 D1、PocketBase 和前端 fixture 的最小字段集，不包含价格、通知或展示字段。 */
export interface SubscriptionRenewalInput {
  billingCycle: BillingCycle;
  status: SubscriptionStatus;
  startDate: string | null;
  nextBillingDate: string;
  autoRenew: boolean;
  autoCalculateNextBillingDate: boolean;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
}

/** 账单日纯计算入口使用同一字段集，避免表单自动日期与后端续订算法分叉。 */
export interface AdvanceBillingDateInput {
  billingCycle: BillingCycle;
  startDate: string | null;
  nextBillingDate: string;
  autoCalculateNextBillingDate: boolean;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
}

/** 续订结果只返回 date-only 与状态；不会生成付款记录或通知历史。 */
export interface SubscriptionRenewalResult {
  nextBillingDate: DateOnly;
  status: SubscriptionStatus;
}

const MAX_CALENDAR_ADVANCE_CYCLES = 20_000;

type BillingPeriod = { unit: "day" | "month"; count: number };

function hasRenewalAnchor(input: Pick<AdvanceBillingDateInput, "autoCalculateNextBillingDate" | "nextBillingDate" | "startDate">): boolean {
  return input.autoCalculateNextBillingDate
    ? typeof input.startDate === "string" && isValidDateOnly(input.startDate)
    : isValidDateOnly(input.nextBillingDate);
}

/**
 * 判断订阅是否可由后台维护任务自动推进。
 *
 * 自动续订只处理已经落后于用户本地 today 的 active/trial 周期订阅；缺省 autoRenew 不能被解释成授权。
 */
export function isAutoRenewEligible(subscription: SubscriptionRenewalInput, today: string): boolean {
  return (
    subscription.autoRenew &&
    subscription.billingCycle !== "one-time" &&
    (subscription.status === "active" || subscription.status === "trial") &&
    isValidDateOnly(subscription.nextBillingDate) &&
    hasRenewalAnchor(subscription) &&
    isValidDateOnly(today) &&
    subscription.nextBillingDate < today
  );
}

/**
 * 判断订阅是否可由用户手动续订。
 *
 * 手动续订覆盖 expired 记录，但明确排除 autoRenew=true 的订阅，避免用户和维护 cron 同时推进同一账单日。
 */
export function isManualRenewEligible(subscription: SubscriptionRenewalInput): boolean {
  return (
    !subscription.autoRenew &&
    subscription.billingCycle !== "one-time" &&
    (subscription.status === "active" || subscription.status === "trial" || subscription.status === "expired") &&
    isValidDateOnly(subscription.nextBillingDate) &&
    hasRenewalAnchor(subscription)
  );
}

/**
 * 推进订阅续订状态，是 Docker Go、Cloudflare Worker 和前端测试共用的事实算法。
 *
 * `mode=auto` 推进到第一个 `>= today` 的周期日；`mode=manual` 至少推进一期并要求结果严格晚于阈值。
 */
export function advanceSubscriptionRenewal(
  subscription: SubscriptionRenewalInput,
  today: string,
  mode: RenewalMode,
): SubscriptionRenewalResult | null {
  if (mode === "auto" && !isAutoRenewEligible(subscription, today)) return null;
  if (mode === "manual" && !isManualRenewEligible(subscription)) return null;
  const nextBillingDate = advanceBillingDate(subscription, today, mode);
  return {
    nextBillingDate,
    status: mode === "manual" && subscription.status === "expired" ? "active" : subscription.status,
  };
}

/**
 * 计算下一账单日，不改变状态。
 *
 * `autoCalculateNextBillingDate=true` 以 startDate 作周期锚点；否则保留用户手动修正过的 nextBillingDate 锚点。
 * 周期订阅允许未知 startDate，因此只有自动锚点模式才需要 startDate。
 */
export function advanceBillingDate(
  input: AdvanceBillingDateInput,
  today: string,
  mode: RenewalMode,
): DateOnly {
  assertRenewableBillingCycle(input.billingCycle);
  const original = assertDateOnly(input.nextBillingDate);
  const anchor = assertDateOnly(input.autoCalculateNextBillingDate ? input.startDate ?? "" : input.nextBillingDate);
  const reference = assertDateOnly(today);
  const threshold = mode === "manual" && original > reference ? original : reference;
  const strict = mode === "manual";

  return firstCycleDateAfter(anchor, input, threshold, strict);
}

export interface BillingDateWindow {
  from: DateOnly;
  to: DateOnly;
  start: Temporal.PlainDate;
  end: Temporal.PlainDate;
}

export interface BillingDateSummary {
  count: number;
  firstDate: DateOnly | null;
  lastDate: DateOnly | null;
}

/** 同一预测窗口由所有订阅复用；窗口与锚点各解析一次，不在排序或每个事件上重复验证日期。 */
export function prepareBillingDateWindow(from: string, to = "9999-12-31"): BillingDateWindow {
  return { from: from as DateOnly, to: to as DateOnly, start: parseProjectionDate(from), end: parseProjectionDate(to) };
}

function parseProjectionDate(value: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date-only value: ${value}`);
  return Temporal.PlainDate.from(value);
}

/** 固定当前快照的锚点，既可展开事件，也可直接求窗口内次数；保存的首期独立于自动锚点。 */
export function createBillingDateProjector(input: AdvanceBillingDateInput) {
  const original = input.nextBillingDate as DateOnly;
  const originalDate = parseProjectionDate(original);
  const period = input.billingCycle === "one-time" ? null
    : billingPeriod(input.billingCycle, input.customDays, input.customCycleUnit);
  let anchor: Temporal.PlainDate | undefined;
  const getAnchor = () => anchor ??= input.autoCalculateNextBillingDate
    ? parseProjectionDate(input.startDate ?? "") : originalDate;
  const datesByCycle = new Map<number, DateOnly>();
  const dateAt = (cycle: number) => {
    let date = datesByCycle.get(cycle);
    if (date === undefined) {
      date = addPeriod(getAnchor(), period!, cycle).toString() as DateOnly;
      datesByCycle.set(cycle, date);
    }
    return date;
  };
  const distance = (date: Temporal.PlainDate) => period!.unit === "day"
    ? getAnchor().until(date, { largestUnit: "day" }).days
    : (date.year - getAnchor().year) * 12 + date.month - getAnchor().month;

  function bounds(window: BillingDateWindow) {
    if (!period || window.from > window.to || original > window.to) return null;
    const includeOriginal = original >= window.from;
    if (original === window.to) return { includeOriginal, first: 1, last: 0 };
    // 先限制期数再做日历加法，超长周期不会对窗口外日期求值；月末始终从原锚点夹取。
    let last = Math.floor(distance(window.end) / period.count);
    let first = Math.max(1, Math.floor(distance(original > window.from ? originalDate : window.start) / period.count));
    if (first <= last) {
      const candidate = dateAt(first);
      if (candidate < window.from || candidate <= original) first += 1;
    }
    if (first <= last && dateAt(last) > window.to) last -= 1;
    return { includeOriginal, first, last };
  }

  return {
    *dates(window: BillingDateWindow): Generator<DateOnly> {
      const range = bounds(window);
      if (!range) return;
      if (range.includeOriginal) yield original;
      for (let cycle = range.first; cycle <= range.last; cycle += 1) yield dateAt(cycle);
    },
    summarize(window: BillingDateWindow): BillingDateSummary {
      const range = bounds(window);
      if (!range) return { count: 0, firstDate: null, lastDate: null };
      const projectedCount = Math.max(0, range.last - range.first + 1);
      return {
        count: Number(range.includeOriginal) + projectedCount,
        firstDate: range.includeOriginal ? original : projectedCount ? dateAt(range.first) : null,
        lastDate: projectedCount ? dateAt(range.last) : range.includeOriginal ? original : null,
      };
    },
  };
}

/** 按快照展开有效 date-only 范围内的账期；无结束日期时调用方按数量停止，不产生续订副作用。 */
export function* iterateBillingDates(input: AdvanceBillingDateInput, from: string, to?: string): Generator<DateOnly> {
  if (input.billingCycle === "one-time") return;
  yield* createBillingDateProjector(input).dates(prepareBillingDateWindow(from, to));
}

/** 表单自动推算下一账单日的纯函数入口，保持 date-only 输出，不引入浏览器时区。 */
export function calculateNextBillingDate(
  startDate: string,
  cycle: BillingCycle,
  customDays?: number | null | undefined,
  referenceDate?: string | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
): DateOnly {
  const anchor = assertDateOnly(startDate);
  if (cycle === "one-time") return anchor;
  const threshold = referenceDate ? assertDateOnly(referenceDate) : anchor;
  return firstCycleDateAfter(anchor, {
    billingCycle: cycle,
    startDate: anchor,
    nextBillingDate: anchor,
    autoCalculateNextBillingDate: true,
    customDays,
    customCycleUnit,
  }, threshold, false);
}

/**
 * 将一个 date-only 按账单周期前进 N 期。
 *
 * 使用 Temporal 是为了让月末夹取语义稳定，例如 1 月 31 日按月推进到 2 月最后一天。
 */
export function addBillingCycles(
  date: string,
  cycle: BillingCycle,
  cycleCount: number,
  customDays?: number | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
): DateOnly {
  const start = toPlainDate(date);
  if (cycle === "one-time") return fromPlainDate(start);
  const count = Math.max(1, Math.trunc(cycleCount));
  return fromPlainDate(addPeriod(start, billingPeriod(cycle, customDays, customCycleUnit), count));
}

function firstCycleDateAfter(
  anchor: string,
  input: AdvanceBillingDateInput,
  threshold: string,
  strict: boolean,
): DateOnly {
  assertRenewableBillingCycle(input.billingCycle);
  const start = toPlainDate(anchor);
  const target = toPlainDate(threshold);
  const period = billingPeriod(input.billingCycle, input.customDays, input.customCycleUnit);
  const distance = period.unit === "day"
    ? start.until(target, { largestUnit: "day" }).days + Number(strict)
    : (target.year - start.year) * 12 + target.month - start.month;
  let cycles = Math.max(1, Math.ceil(distance / period.count));
  assertCalendarAdvanceLimit(period, cycles);
  let candidate = addPeriod(start, period, cycles);
  // 月份差只定位期数；每次从原锚点用 Temporal 夹取月底，不能从已夹取的二月日期滚动累计。
  // 候选已在目标月份或之后，最多再推进一期即可满足日与严格边界，历史逾期不会线性放大 CPU。
  const comparison = Temporal.PlainDate.compare(candidate, target);
  if (strict ? comparison <= 0 : comparison < 0) {
    cycles += 1;
    assertCalendarAdvanceLimit(period, cycles);
    candidate = addPeriod(start, period, cycles);
  }
  return fromPlainDate(candidate);
}

function billingPeriod(
  cycle: Exclude<BillingCycle, "one-time">,
  customDays?: number | null,
  customCycleUnit?: CustomCycleUnit | null,
): BillingPeriod {
  switch (cycle) {
    case "weekly": return { unit: "day", count: 7 };
    case "monthly": return { unit: "month", count: 1 };
    case "quarterly": return { unit: "month", count: 3 };
    case "semi-annual": return { unit: "month", count: 6 };
    case "annual": return { unit: "month", count: 12 };
    case "custom": {
      const { count, unit } = requireCustomBillingCycle(customDays, customCycleUnit);
      return unit === "day" || unit === "week"
        ? { unit: "day", count: count * (unit === "week" ? 7 : 1) }
        : { unit: "month", count: count * (unit === "year" ? 12 : 1) };
    }
  }
}

function addPeriod(start: Temporal.PlainDate, period: BillingPeriod, cycles: number): Temporal.PlainDate {
  return start.add(period.unit === "day" ? { days: period.count * cycles } : { months: period.count * cycles });
}

function assertCalendarAdvanceLimit(period: BillingPeriod, cycles: number): void {
  // 保留 Go 与既有 TS 对超长日历周期追溯的拒绝边界；固定天数原本就允许直接跳过任意期数。
  if (period.unit === "month" && cycles > MAX_CALENDAR_ADVANCE_CYCLES) {
    throw new Error("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED");
  }
}

/** custom 周期在迁移后的所有运行面都必须显式携带正整数数量与单位。 */
export function requireCustomBillingCycle(
  customDays: number | null | undefined,
  customCycleUnit: CustomCycleUnit | null | undefined,
): { count: number; unit: CustomCycleUnit } {
  if (typeof customDays !== "number" || !Number.isInteger(customDays) || customDays <= 0 || !customCycleUnit) {
    throw new Error("SUBSCRIPTION_CUSTOM_CYCLE_INVALID");
  }
  return { count: customDays, unit: customCycleUnit };
}

function assertRenewableBillingCycle(cycle: BillingCycle): asserts cycle is Exclude<BillingCycle, "one-time"> {
  if (cycle === "one-time") {
    throw new Error("SUBSCRIPTION_RENEWAL_ONE_TIME_NOT_RENEWABLE");
  }
}

function assertDateOnly(value: string): DateOnly {
  if (!isValidDateOnly(value)) {
    throw new Error(`Invalid date-only value: ${value}`);
  }
  return value as DateOnly;
}

function toPlainDate(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(assertDateOnly(value));
}

function fromPlainDate(value: Temporal.PlainDate): DateOnly {
  return assertDateOnly(value.toString());
}
