import { Temporal } from "@js-temporal/polyfill";
import { divideMoney, moneyToNumber, type MoneyString } from "./money";
import {
  INHERIT_REMINDER_DAYS,
  MAX_REMINDER_DAYS,
  isValidDateOnly,
  type BillingCycle,
  type CustomCycleUnit,
  type DateOnly,
} from "./runtime";
import { addBillingCycles, requireCustomBillingCycle } from "./subscription-renewal";

export const COST_SHARING_SPLIT_MODES = ["equal", "custom"] as const;
const MAX_COST_SHARING_COLLECTION_ADVANCE_CYCLES = 20_000;

export type CostSharingSplitMode = (typeof COST_SHARING_SPLIT_MODES)[number];

export interface CostSharingMember {
  id: string;
  name: string;
  note?: string | undefined;
  /** 成员上车日期只作为收款周期 anchor，不代表付款状态或账本流水。 */
  joinedDate?: DateOnly | undefined;
  currency?: string | undefined;
  customAmount?: MoneyString | undefined;
}

export interface CostSharingCollectionReminder {
  enabled: boolean;
  /** -1 继承全局提醒天数；关闭必须用 enabled=false，避免和普通订阅的 -2 静默语义混用。 */
  reminderDays: number;
}

export interface CostSharing {
  enabled: boolean;
  splitMode: CostSharingSplitMode;
  members: CostSharingMember[];
  /** v1 只提醒账号主人向成员收款；不保存成员联系方式或付款状态。 */
  collectionReminder?: CostSharingCollectionReminder | undefined;
}

/** 重开时只合并显式确认的日期；缺少调整的越界成员仍报错，不能在后端静默重置收款锚点。 */
export function restartCostSharingMemberDates(
  costSharing: CostSharing | undefined,
  updates: readonly { id: string; joinedDate: string }[],
  startDate: string,
  nextBillingDate: string,
): CostSharing | undefined {
  const invalid = () => new Error("SUBSCRIPTION_RENEW_COST_SHARING_INVALID");
  const members = costSharing?.enabled ? costSharing.members : [];
  const memberIds = new Set(members.map((member) => member.id));
  const dates = new Map<string, DateOnly>();
  for (const update of updates) {
    if (!memberIds.has(update.id) || dates.has(update.id) || !isValidDateOnly(update.joinedDate)) throw invalid();
    dates.set(update.id, update.joinedDate as DateOnly);
  }
  if (!costSharing?.enabled) return costSharing;
  const merged = { ...costSharing, members: members.map((member) => dates.has(member.id) ? { ...member, joinedDate: dates.get(member.id)! } : member) };
  const range = { minDate: startDate as DateOnly, maxDate: nextBillingDate as DateOnly };
  if (!merged.members.every((member) => costSharingMemberJoinedDateIsWithinRange(member, range))) throw invalid();
  return merged;
}

export interface CostSharingSummary {
  enabled: boolean;
  total: number;
  yourShare: number;
  /** 成员合计是共享成员金额总和；custom 模式允许它和订阅总价不一致。 */
  memberTotal: number;
  /** 当前用户固定是付款人，成员金额就是向其他成员应收/可回收的金额。 */
  recoverableAmount: number;
  memberCount: number;
}

export type CostSharingCurrencyConverter = (amount: MoneyString | number, fromCurrency: string, toCurrency: string) => number;

export interface CostSharingCalculationOptions {
  baseCurrency?: string | undefined;
  convert?: CostSharingCurrencyConverter | undefined;
}

export interface CostSharingCollectionReminderCalculationInput {
  costSharing: CostSharing | undefined;
  subscriptionStartDate: string | null | undefined;
  nextBillingDate: string | null | undefined;
  billingCycle: BillingCycle;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
  notificationReminderDays: number;
  referenceDate: string;
}

export interface CostSharingCollectionReminderOccurrence {
  member: CostSharingMember;
  targetDate: DateOnly;
  reminderDate: DateOnly;
  reminderDays: number;
}

export interface CostSharingMemberJoinedDateRangeInput {
  subscriptionStartDate: string | null | undefined;
  nextBillingDate: string | null | undefined;
  billingCycle: BillingCycle;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
}

export interface CostSharingMemberJoinedDateRange {
  minDate: DateOnly | null;
  maxDate: DateOnly | null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isCostSharingEnabled(costSharing: CostSharing | undefined): costSharing is CostSharing {
  return Boolean(costSharing?.enabled && costSharing.members.length > 0);
}

function convertMemberAmountToBase(
  amount: MoneyString | number,
  member: CostSharingMember,
  options: CostSharingCalculationOptions | undefined,
): number {
  const baseCurrency = options?.baseCurrency;
  const memberCurrency = member.currency ?? baseCurrency;
  // 跨币种分摊只在调用方提供基础币种和转换器时换算；否则保留原金额，避免 shared 层猜测汇率。
  const numericAmount = moneyToNumber(amount);
  if (!baseCurrency || !memberCurrency || memberCurrency === baseCurrency || !options?.convert) return numericAmount;
  return options.convert(amount, memberCurrency, baseCurrency);
}

export function calculateCostSharingMemberAmount(
  costSharing: CostSharing,
  member: CostSharingMember,
  total: MoneyString | number,
  options?: CostSharingCalculationOptions,
): number {
  if (costSharing.splitMode === "custom") {
    return roundMoney(convertMemberAmountToBase(member.customAmount ?? 0, member, options));
  }
  const participantCount = costSharing.members.length + 1;
  if (participantCount <= 1) return 0;
  return roundMoney(moneyToNumber(divideMoney(total, participantCount)));
}

export function calculateCostSharingSummary(
  costSharing: CostSharing | undefined,
  total: MoneyString | number,
  options?: CostSharingCalculationOptions,
): CostSharingSummary {
  const numericTotal = moneyToNumber(total);
  if (!isCostSharingEnabled(costSharing)) {
    return {
      enabled: false,
      total: numericTotal,
      yourShare: numericTotal,
      memberTotal: 0,
      recoverableAmount: 0,
      memberCount: 0,
    };
  }

  // 当前用户不在 members 里：equal 按“我 + 成员”平分，custom 则把成员金额直接视作应收款，允许超过订阅总价。
  const firstMember = costSharing.members.at(0);
  const memberTotal = costSharing.splitMode === "equal"
    ? roundMoney(Math.max(numericTotal - (firstMember ? calculateCostSharingMemberAmount(costSharing, firstMember, total, options) : 0), 0))
    : roundMoney(costSharing.members.reduce(
        (sum, member) => sum + calculateCostSharingMemberAmount(costSharing, member, total, options),
        0,
      ));
  const yourShare = roundMoney(Math.max(numericTotal - memberTotal, 0));
  const recoverableAmount = memberTotal;

  return {
    enabled: true,
    total: numericTotal,
    yourShare,
    memberTotal,
    recoverableAmount,
    memberCount: costSharing.members.length,
  };
}

export function costSharingCustomAmountsAreValid(costSharing: CostSharing): boolean {
  if (costSharing.splitMode !== "custom") return true;
  return costSharing.members.every((member) => {
    return member.customAmount !== undefined && moneyToNumber(member.customAmount) >= 0;
  });
}

export function isValidCostSharingCollectionReminderDays(value: number): boolean {
  return Number.isInteger(value) && (value === INHERIT_REMINDER_DAYS || (value >= 0 && value <= MAX_REMINDER_DAYS));
}

export function resolveCostSharingCollectionReminderDays(reminderDays: number, notificationReminderDays: number): number | null {
  if (!isValidCostSharingCollectionReminderDays(reminderDays)) return null;
  if (reminderDays === INHERIT_REMINDER_DAYS) {
    return Number.isInteger(notificationReminderDays) && notificationReminderDays >= 0 && notificationReminderDays <= MAX_REMINDER_DAYS
      ? notificationReminderDays
      : null;
  }
  return reminderDays;
}

export function resolveCostSharingMemberCollectionAnchor(
  member: Pick<CostSharingMember, "joinedDate">,
  subscriptionStartDate: string | null | undefined,
): DateOnly | null {
  const joinedDate = member.joinedDate?.trim();
  if (joinedDate && isValidDateOnly(joinedDate)) return joinedDate as DateOnly;
  if (subscriptionStartDate && isValidDateOnly(subscriptionStartDate)) return subscriptionStartDate as DateOnly;
  return null;
}

export function costSharingCollectionAnchorsAreSatisfied(
  costSharing: CostSharing | undefined,
  subscriptionStartDate: string | null | undefined,
): boolean {
  const reminder = costSharing?.collectionReminder;
  if (!costSharing?.enabled || !reminder?.enabled) return true;
  return costSharing.members.every((member) => resolveCostSharingMemberCollectionAnchor(member, subscriptionStartDate) !== null);
}

export function resolveCostSharingMemberJoinedDateRange(input: CostSharingMemberJoinedDateRangeInput): CostSharingMemberJoinedDateRange {
  const minDate = input.subscriptionStartDate && isValidDateOnly(input.subscriptionStartDate)
    ? input.subscriptionStartDate as DateOnly
    : null;
  const maxDate = !isCostSharingCollectionOneTimeBuyout(input) && input.nextBillingDate && isValidDateOnly(input.nextBillingDate)
    ? input.nextBillingDate as DateOnly
    : null;
  return { minDate, maxDate };
}

export function costSharingMemberJoinedDateIsWithinRange(
  member: Pick<CostSharingMember, "joinedDate">,
  range: CostSharingMemberJoinedDateRange,
): boolean {
  const joinedDate = member.joinedDate?.trim();
  if (!joinedDate || !isValidDateOnly(joinedDate)) return true;
  if (range.minDate && compareDateOnly(joinedDate, range.minDate) < 0) return false;
  if (range.maxDate && compareDateOnly(joinedDate, range.maxDate) > 0) return false;
  return true;
}

export function costSharingMemberJoinedDatesWithinRange(
  costSharing: CostSharing | undefined,
  input: CostSharingMemberJoinedDateRangeInput,
): boolean {
  if (!costSharing?.enabled) return true;
  const range = resolveCostSharingMemberJoinedDateRange(input);
  return costSharing.members.every((member) => costSharingMemberJoinedDateIsWithinRange(member, range));
}

export function nextCostSharingCollectionTargetDate(
  input: Omit<CostSharingCollectionReminderCalculationInput, "costSharing" | "notificationReminderDays"> & { anchorDate: string },
): DateOnly | null {
  if (!isValidDateOnly(input.anchorDate) || !isValidDateOnly(input.referenceDate)) return null;
  if (isCostSharingCollectionOneTimeBuyout(input)) return null;
  if (input.billingCycle === "one-time") {
    if (!input.oneTimeTermCount || !input.oneTimeTermUnit || !input.nextBillingDate || !isValidDateOnly(input.nextBillingDate)) return null;
    if (compareDateOnly(input.anchorDate, input.nextBillingDate) > 0) return null;
    return compareDateOnly(input.nextBillingDate, input.referenceDate) >= 0 ? input.nextBillingDate as DateOnly : null;
  }

  const anchor = Temporal.PlainDate.from(input.anchorDate);
  const threshold = Temporal.PlainDate.from(input.referenceDate);
  let cycleCount = Math.max(1, initialCostSharingCollectionCycleCount(anchor, input, threshold));
  for (let attempts = 0; attempts < MAX_COST_SHARING_COLLECTION_ADVANCE_CYCLES; attempts += 1) {
    const candidate = addBillingCycles(
      anchor.toString(),
      input.billingCycle,
      cycleCount,
      input.customDays,
      input.customCycleUnit,
    );
    if (compareDateOnly(candidate, input.referenceDate) >= 0) return candidate;
    cycleCount += 1;
  }
  return null;
}

export function costSharingCollectionReminderOccurrencesForDate(input: CostSharingCollectionReminderCalculationInput): CostSharingCollectionReminderOccurrence[] {
  const reminder = input.costSharing?.collectionReminder;
  if (!input.costSharing?.enabled || !reminder?.enabled || !isValidDateOnly(input.referenceDate)) return [];
  const reminderDays = resolveCostSharingCollectionReminderDays(reminder.reminderDays, input.notificationReminderDays);
  if (reminderDays === null) return [];

  const targetThresholdDate = addDateOnly(input.referenceDate, reminderDays);
  return input.costSharing.members.flatMap((member) => {
    const anchor = resolveCostSharingMemberCollectionAnchor(member, input.subscriptionStartDate);
    if (!anchor) return [];
    const targetDate = nextCostSharingCollectionTargetDate({ ...input, anchorDate: anchor, referenceDate: targetThresholdDate });
    if (!targetDate) return [];
    const reminderDate = addDateOnly(targetDate, -reminderDays);
    return reminderDate === input.referenceDate ? [{ member, targetDate, reminderDate, reminderDays }] : [];
  });
}

export function nextCostSharingCollectionReminderDate(input: CostSharingCollectionReminderCalculationInput): DateOnly | null {
  const reminder = input.costSharing?.collectionReminder;
  if (!input.costSharing?.enabled || !reminder?.enabled || !isValidDateOnly(input.referenceDate)) return null;
  const reminderDays = resolveCostSharingCollectionReminderDays(reminder.reminderDays, input.notificationReminderDays);
  if (reminderDays === null) return null;

  const targetThresholdDate = addDateOnly(input.referenceDate, reminderDays);
  let earliest: DateOnly | null = null;
  for (const member of input.costSharing.members) {
    const anchor = resolveCostSharingMemberCollectionAnchor(member, input.subscriptionStartDate);
    if (!anchor) continue;
    const targetDate = nextCostSharingCollectionTargetDate({ ...input, anchorDate: anchor, referenceDate: targetThresholdDate });
    if (!targetDate) continue;
    const reminderDate = addDateOnly(targetDate, -reminderDays);
    if (!earliest || reminderDate < earliest) earliest = reminderDate;
  }
  return earliest;
}

function isCostSharingCollectionOneTimeBuyout(input: Pick<CostSharingCollectionReminderCalculationInput, "billingCycle" | "oneTimeTermCount" | "oneTimeTermUnit">): boolean {
  return input.billingCycle === "one-time"
    && (typeof input.oneTimeTermCount !== "number" || input.oneTimeTermCount <= 0);
}

function initialCostSharingCollectionCycleCount(
  anchor: Temporal.PlainDate,
  input: Pick<CostSharingCollectionReminderCalculationInput, "billingCycle" | "customDays" | "customCycleUnit">,
  threshold: Temporal.PlainDate,
): number {
  const dayStep = costSharingCollectionExactDayStep(input);
  if (dayStep) {
    const diff = anchor.until(threshold, { largestUnit: "day" }).days;
    return Math.ceil(diff / dayStep);
  }
  const monthStep = costSharingCollectionMonthStep(input);
  if (monthStep) {
    const monthDelta = (threshold.year - anchor.year) * 12 + (threshold.month - anchor.month);
    return Math.floor(monthDelta / monthStep);
  }
  return 1;
}

function costSharingCollectionExactDayStep(input: Pick<CostSharingCollectionReminderCalculationInput, "billingCycle" | "customDays" | "customCycleUnit">): number | null {
  if (input.billingCycle === "weekly") return 7;
  if (input.billingCycle !== "custom") return null;
  const custom = requireCustomBillingCycle(input.customDays, input.customCycleUnit);
  if (custom.unit === "day") return custom.count;
  if (custom.unit === "week") return custom.count * 7;
  return null;
}

function costSharingCollectionMonthStep(input: Pick<CostSharingCollectionReminderCalculationInput, "billingCycle" | "customDays" | "customCycleUnit">): number | null {
  switch (input.billingCycle) {
    case "monthly":
      return 1;
    case "quarterly":
      return 3;
    case "semi-annual":
      return 6;
    case "annual":
      return 12;
    case "custom": {
      const custom = requireCustomBillingCycle(input.customDays, input.customCycleUnit);
      if (custom.unit === "month") return custom.count;
      if (custom.unit === "year") return custom.count * 12;
      return null;
    }
    default:
      return null;
  }
}

function addDateOnly(date: string, days: number): DateOnly {
  return Temporal.PlainDate.from(date).add({ days }).toString() as DateOnly;
}

function compareDateOnly(left: string, right: string): number {
  return Temporal.PlainDate.compare(Temporal.PlainDate.from(left), Temporal.PlainDate.from(right));
}
