/**
 * 统计页领域模型。
 *
 * 架构位置：
 * - 将金额换算、预算占比、分类/支付方式图表数据集中在纯函数中。
 * - 页面只负责渲染 Recharts 和统计卡片，避免图表 UI 反向承载业务规则。
 *
 * 数据流：
 * ```
 * 输入：subscriptions + settings.defaultCurrency + exchangeRates + customConfig
 *   -> buildStatisticsModel
 *   -> StatBox / PieChart view model
 * ```
 */
import { isOneTimeBuyout, toDailyAmountFromMonthly, toMonthlyAmount } from "@/lib/subscription-billing";
import { compareDateOnly, fromPlainDate, todayDateOnlyInTimeZone, toPlainDate, type DateOnly } from "@/lib/time/date-only";
import { DEFAULT_LOCALE, localizedLabel, type Locale } from "@/i18n/locales";
import { translate } from "@/i18n/messages";
import type { CustomConfig } from "@/types/config";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import { createBillingDateProjector, prepareBillingDateWindow, type BillingDateWindow } from "@renewlet/shared/subscription-renewal";
import { calculateCostSharingSummary } from "@renewlet/shared/cost-sharing";
import { moneyToNumber } from "@renewlet/shared/money";
import { isEffectivelyActiveSubscription } from "./subscription-status";

/** 统计图表固定色板；保持跨图表颜色稳定，避免同一分类在不同渲染中频繁换色。 */
export const STATISTICS_CHART_COLORS = [
  "hsl(200 80% 50%)",
  "hsl(350 75% 55%)",
  "hsl(160 84% 45%)",
  "hsl(35 90% 55%)",
  "hsl(280 70% 55%)",
  "hsl(180 60% 45%)",
  "hsl(45 90% 50%)",
  "hsl(320 70% 55%)",
];

function chartColorAt(index: number): string {
  return STATISTICS_CHART_COLORS[index % STATISTICS_CHART_COLORS.length] ?? "hsl(200 80% 50%)";
}

const STATISTICS_TREND_MONTHS = 12;

export interface StatisticsTrendDatum {
  monthKey: string;
  label: string;
  cashflow: number;
  amortized: number;
  cashflowItems: StatisticsTrendItem[];
  amortizedItems: StatisticsTrendItem[];
}

export interface StatisticsTrendItem {
  subscriptionId: string;
  name: string;
  amount: number;
  firstDate: DateOnly | null;
  lastDate: DateOnly | null;
  occurrenceCount: number;
}

interface StatisticsTrendBucket extends Omit<StatisticsTrendDatum, "cashflowItems" | "amortizedItems"> {
  cashflowItems: Map<string, StatisticsTrendItem>;
  amortizedItems: Map<string, StatisticsTrendItem>;
  window: BillingDateWindow;
  startDate: DateOnly;
  endDate: DateOnly;
}

interface BuildStatisticsModelInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  config: CustomConfig;
  monthlyBudget: string;
  defaultCurrency: string;
  convert: (amount: number | string, from: string, to: string) => number;
  now?: Date;
  today?: DateOnly;
  timeZone?: string;
  locale?: Locale;
  costBasis?: "total" | "personal";
}

function roundTrendAmount(amount: number): number {
  return Math.round(amount * 1000) / 1000;
}

function buildTrendBuckets(today: DateOnly, locale: Locale): StatisticsTrendBucket[] {
  const startMonth = toPlainDate(today).with({ day: 1 });
  return Array.from({ length: STATISTICS_TREND_MONTHS }, (_, index) => {
    const monthStart = startMonth.add({ months: index });
    const monthEnd = monthStart.add({ months: 1 });
    return {
      monthKey: `${monthStart.year}-${String(monthStart.month).padStart(2, "0")}`,
      label: translate(locale, "statistics.trendMonthLabel", { year: monthStart.year, month: monthStart.month }),
      cashflow: 0,
      amortized: 0,
      cashflowItems: new Map(),
      amortizedItems: new Map(),
      window: prepareBillingDateWindow(index === 0 ? today : monthStart.toString(), monthEnd.subtract({ days: 1 }).toString()),
      startDate: fromPlainDate(monthStart),
      endDate: fromPlainDate(monthEnd),
    };
  });
}

function sortTrendItems(items: StatisticsTrendItem[]): StatisticsTrendItem[] {
  return items
    .map((item) => ({ ...item, amount: roundTrendAmount(item.amount) }))
    .sort((left, right) => {
      const amountDelta = right.amount - left.amount;
      return amountDelta !== 0 ? amountDelta : left.name.localeCompare(right.name);
    });
}

function addTrendItem(
  items: Map<string, StatisticsTrendItem>,
  subscription: SubscriptionCollectionItem,
  amount: number,
  occurrenceDate: DateOnly | null,
  count = 1,
  lastDate = occurrenceDate,
) {
  const existing = items.get(subscription.id);
  if (!existing) {
    items.set(subscription.id, {
      subscriptionId: subscription.id,
      name: subscription.name,
      amount,
      firstDate: occurrenceDate,
      lastDate,
      occurrenceCount: count,
    });
    return;
  }

  existing.amount += amount;
  existing.occurrenceCount += count;
  if (occurrenceDate) {
    if (!existing.firstDate || occurrenceDate < existing.firstDate) {
      existing.firstDate = occurrenceDate;
    }
    if (lastDate && (!existing.lastDate || lastDate > existing.lastDate)) {
      existing.lastDate = lastDate;
    }
  }
}

function addCashflowTrend(
  bucketsByMonth: Map<string, StatisticsTrendBucket>,
  window: BillingDateWindow,
  buckets: readonly StatisticsTrendBucket[],
  subscription: SubscriptionCollectionItem,
  amountInDefault: number,
) {
  if (subscription.billingCycle === "one-time") return;
  const projector = createBillingDateProjector(subscription);
  const fixedDays = subscription.billingCycle === "weekly" || (subscription.billingCycle === "custom"
    && (subscription.customCycleUnit === "day" || subscription.customCycleUnit === "week"));
  // 月/年周期一年最多少量事件，直接沿同一锚点迭代；短周期才按月求次数，避免 365 次展开。
  if (!fixedDays) {
    for (const date of projector.dates(window)) {
      const bucket = bucketsByMonth.get(date.slice(0, 7));
      if (!bucket) continue;
      bucket.cashflow += amountInDefault;
      addTrendItem(bucket.cashflowItems, subscription, amountInDefault, date);
    }
    return;
  }
  for (const bucket of buckets) {
    const summary = projector.summarize(bucket.window);
    if (summary.count === 0) continue;
    const amount = amountInDefault * summary.count;
    bucket.cashflow += amount;
    addTrendItem(bucket.cashflowItems, subscription, amount, summary.firstDate, summary.count, summary.lastDate);
  }
}

function addAmortizedTrend(
  buckets: readonly StatisticsTrendBucket[],
  subscription: SubscriptionCollectionItem,
  monthlyAmount: number,
) {
  if (monthlyAmount <= 0) return;

  if (subscription.billingCycle !== "one-time") {
    for (const bucket of buckets) {
      bucket.amortized += monthlyAmount;
      addTrendItem(bucket.amortizedItems, subscription, monthlyAmount, null);
    }
    return;
  }

  // 固定服务期 one-time 的到期日是权益结束边界，不是下一次扣费；只把服务覆盖月份计入摊销。
  if (!subscription.oneTimeTermCount) return;
  if (!subscription.startDate) return;
  for (const bucket of buckets) {
    const overlapsServiceWindow =
      compareDateOnly(subscription.startDate, bucket.endDate) < 0 &&
      compareDateOnly(subscription.nextBillingDate, bucket.startDate) >= 0;
    if (overlapsServiceWindow) {
      bucket.amortized += monthlyAmount;
      addTrendItem(bucket.amortizedItems, subscription, monthlyAmount, null);
    }
  }
}

function* buildTrendData(
  subscriptions: readonly SubscriptionCollectionItem[],
  today: DateOnly,
  locale: Locale,
  convertToDefault: (amount: number | string, currency: string) => number,
  amountForStats: (subscription: SubscriptionCollectionItem) => number | string,
  calculateMonthlyAmount: (subscription: SubscriptionCollectionItem) => number,
  activeItems: ReadonlySet<SubscriptionCollectionItem>,
): Generator<void, StatisticsTrendDatum[]> {
  const buckets = buildTrendBuckets(today, locale);
  const bucketsByMonth = new Map(buckets.map((bucket) => [bucket.monthKey, bucket]));
  const window = prepareBillingDateWindow(today, buckets.at(-1)!.window.to);

  for (const subscription of subscriptions) {
    if (subscription.status !== "active" && subscription.status !== "trial") continue;
    const amountInDefault = convertToDefault(amountForStats(subscription), subscription.currency);
    addCashflowTrend(bucketsByMonth, window, buckets, subscription, amountInDefault);
    if (activeItems.has(subscription)) {
      addAmortizedTrend(buckets, subscription, calculateMonthlyAmount(subscription));
    }
    yield;
  }

  const result: StatisticsTrendDatum[] = [];
  for (const { monthKey, label, cashflow, amortized, cashflowItems, amortizedItems } of buckets) {
    result.push({
      monthKey,
      label,
      cashflow: roundTrendAmount(cashflow),
      amortized: roundTrendAmount(amortized),
      // 短周期订阅可能在同一自然月触发多次扣费；明细按订阅聚合，避免 tooltip 和读屏文本被逐次事件淹没。
      cashflowItems: sortTrendItems([...cashflowItems.values()]),
      amortizedItems: sortTrendItems([...amortizedItems.values()]),
    });
    yield;
  }
  return result;
}

/** 构建统计页视图模型。 */
export function* statisticsModelTask({
  subscriptions,
  config,
  monthlyBudget,
  defaultCurrency,
  convert,
  now = new Date(),
  today: suppliedToday,
  timeZone = "UTC",
  locale = DEFAULT_LOCALE,
  costBasis = "total",
}: BuildStatisticsModelInput) {
  const today = suppliedToday ?? todayDateOnlyInTimeZone(now, timeZone);
  const categoryByValue = new Map(config.categories.map((category) => [category.value, category]));
  const paymentMethodByValue = new Map(config.paymentMethods.map((method) => [method.value, method]));
  // 当前成本按有效状态与列表对齐；现金流预测另按原始启用状态展开，逾期本身不代表停止扣费。
  const activeSubscriptions: SubscriptionCollectionItem[] = [];
  const inactiveSubscriptions: SubscriptionCollectionItem[] = [];
  const activeItems = new Set<SubscriptionCollectionItem>();
  for (const subscription of subscriptions) {
    if (isEffectivelyActiveSubscription(subscription, today)) {
      activeSubscriptions.push(subscription);
      activeItems.add(subscription);
    } else {
      inactiveSubscriptions.push(subscription);
    }
    yield;
  }
  const activeCostSubscriptions = activeSubscriptions.filter((subscription) => !isOneTimeBuyout(subscription));
  const inactiveCostSubscriptions = inactiveSubscriptions.filter((subscription) => !isOneTimeBuyout(subscription));
  const monthlyBudgetAmount = moneyToNumber(monthlyBudget);

  // costBasis 是统计页的金额口径开关；一旦选 personal，月均、日均、当月现金流、分类和趋势都必须使用个人份额。
  const amounts = new WeakMap<SubscriptionCollectionItem, number | string>();
  const amountForStats = (subscription: SubscriptionCollectionItem): number | string => {
    const cached = amounts.get(subscription);
    if (cached !== undefined) return cached;
    const amount = costBasis === "personal"
      ? calculateCostSharingSummary(subscription.costSharing, subscription.price, {
          baseCurrency: subscription.currency,
          convert,
        }).yourShare
      : subscription.price;
    amounts.set(subscription, amount);
    return amount;
  };
  const monthlyAmounts = new WeakMap<SubscriptionCollectionItem, number>();
  const convertToDefault = (amount: number | string, currency: string) => convert(amount, currency, defaultCurrency);
  const calculateMonthlyAmount = (subscription: SubscriptionCollectionItem): number => {
    const cached = monthlyAmounts.get(subscription);
    if (cached !== undefined) return cached;
    // 先换算币种再折算周期，同一次模型计算内的卡片与趋势复用结果，个人分摊也只求一次。
    const amountInDefault = convertToDefault(amountForStats(subscription), subscription.currency);
    const monthlyAmount = toMonthlyAmount(
      amountInDefault,
      subscription.billingCycle,
      subscription.customDays,
      subscription.customCycleUnit,
      subscription.oneTimeTermCount,
      subscription.oneTimeTermUnit,
    );
    monthlyAmounts.set(subscription, monthlyAmount);
    return monthlyAmount;
  };

  let totalMonthly = 0;
  for (const subscription of activeCostSubscriptions) {
    totalMonthly += calculateMonthlyAmount(subscription);
    yield;
  }
  const totalDaily = toDailyAmountFromMonthly(totalMonthly);
  const totalAnnual = totalMonthly * 12;
  const avgMonthlyPerSub = activeCostSubscriptions.length > 0 ? totalMonthly / activeCostSubscriptions.length : 0;
  const mostExpensive = activeCostSubscriptions.reduce<SubscriptionCollectionItem | null>((max, subscription) => {
    // 使用月折算金额比较，而不是原始价格，避免年付订阅被低估。
    const currentMonthly = calculateMonthlyAmount(subscription);
    const maxMonthly = max ? calculateMonthlyAmount(max) : 0;
    return currentMonthly > maxMonthly ? subscription : max;
  }, null);
  const budgetUsedPercent = monthlyBudgetAmount > 0 ? (totalMonthly / monthlyBudgetAmount) * 100 : 0;
  const budgetRemaining = monthlyBudgetAmount - totalMonthly;
  let inactiveSavings = 0;
  for (const subscription of inactiveCostSubscriptions) {
    inactiveSavings += calculateMonthlyAmount(subscription);
    yield;
  }

  yield;
  const categoryData = Object.entries(
    activeCostSubscriptions.reduce((acc, subscription) => {
      const amount = calculateMonthlyAmount(subscription);
      acc[subscription.category] = (acc[subscription.category] || 0) + amount;
      return acc;
    }, {} as Record<string, number>),
  ).map(([name, value], index) => {
    const category = categoryByValue.get(name);
    return {
      name: category ? localizedLabel(category.labels, locale) : name,
      value: Math.round(value * 1000) / 1000,
      color: category?.color ?? chartColorAt(index),
    };
  });

  yield;
  const paymentData = Object.entries(
    activeSubscriptions.reduce((acc, subscription) => {
      const method = subscription.paymentMethod || "other";
      acc[method] = (acc[method] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  ).map(([name, value], index) => {
    const paymentMethod = paymentMethodByValue.get(name);
    return {
      name: paymentMethod ? localizedLabel(paymentMethod.labels, locale) : name,
      value,
      color: chartColorAt(index),
    };
  });

  const budgetChartData = [
    { name: translate(locale, "statistics.budgetUsed"), value: Math.min(totalMonthly, monthlyBudgetAmount), color: "hsl(350 75% 55%)" },
    { name: translate(locale, "statistics.budgetRemaining"), value: Math.max(budgetRemaining, 0), color: "hsl(200 80% 50%)" },
  ];
  const trendData = yield* buildTrendData(subscriptions, today, locale, convertToDefault, amountForStats, calculateMonthlyAmount, activeItems);

  // TODO：若未来支持多预算周期，可把 monthlyBudget 和 budgetChartData 抽成独立预算 domain。
  return {
    activeCount: activeSubscriptions.length,
    inactiveCount: inactiveSubscriptions.length,
    totalMonthly,
    totalDaily,
    totalAnnual,
    avgMonthlyPerSub,
    mostExpensive,
    thisMonthDue: trendData[0]?.cashflow ?? 0,
    budgetUsedPercent,
    budgetRemaining,
    monthlySavings: inactiveSavings,
    annualSavings: inactiveSavings * 12,
    categoryData,
    paymentData,
    budgetChartData,
    trendData,
  };
}

/** 同步测试与页面分片消费同一模型任务，金额和日期规则只有一个实现。 */
export function buildStatisticsModel(input: BuildStatisticsModelInput) {
  const task = statisticsModelTask(input);
  let result = task.next();
  while (!result.done) result = task.next();
  return result.value;
}
