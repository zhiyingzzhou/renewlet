/**
 * 订阅导出领域逻辑。
 *
 * 架构位置：
 * - domain 负责把订阅转换为稳定的 JSON/CSV 内容。
 * - application hook 负责浏览器下载副作用。
 *
 * 注意： CSV 面向表格软件，任何新增字段都要继续经过 `escapeCsvCell`，
 * 避免 `= + - @ tab` 开头的内容被当作公式执行。
 */
import type { Locale } from "@/i18n/locales";
import { translate } from "@/i18n/messages";
import type { DateOnly } from "@/lib/time/date-only";
import { formatBillingCycleLabel } from "@/lib/subscription-billing";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS, type Subscription } from "@/types/subscription";
import { getEffectiveSubscriptionStatus } from "./subscription-status";
import { calculateCostSharingSummary, type CostSharingCalculationOptions } from "@renewlet/shared/cost-sharing";

interface SubscriptionExportLabelMaps {
  categoryLabelByValue: ReadonlyMap<string, string>;
  statusLabelByValue: ReadonlyMap<string, string>;
  locale: Locale;
  today: DateOnly | string;
  costSharingCalculation?: CostSharingCalculationOptions | undefined;
}

/** CSV 单元格转义，并防护常见表格公式注入前缀。 */
export function escapeCsvCell(value: unknown): string {
  // 为什么加单引号：Excel/Numbers/Sheets 会把特定前缀识别成公式，导出文件可能变成注入载体。
  const text = String(value ?? "");
  const formulaSafe = /^[=+\-@\t]/.test(text) ? `'${text}` : text;
  return `"${formulaSafe.replace(/"/g, '""')}"`;
}

/** 构建 CSV 导出内容。 */
export function buildSubscriptionsCsv(
  subscriptions: readonly Subscription[],
  labelMaps: SubscriptionExportLabelMaps,
): string {
  const headers = [
    translate(labelMaps.locale, "subscriptions.csv.name"),
    translate(labelMaps.locale, "subscriptions.csv.price"),
    translate(labelMaps.locale, "subscriptions.csv.currency"),
    translate(labelMaps.locale, "subscription.field.balance"),
    translate(labelMaps.locale, "subscription.field.balanceCurrency"),
    translate(labelMaps.locale, "subscriptions.csv.billingCycle"),
    translate(labelMaps.locale, "subscriptions.csv.category"),
    translate(labelMaps.locale, "subscriptions.csv.status"),
    translate(labelMaps.locale, "subscriptions.csv.startDate"),
    translate(labelMaps.locale, "subscriptions.csv.nextBillingDate"),
    translate(labelMaps.locale, "subscriptions.csv.reminderDays"),
    translate(labelMaps.locale, "subscription.costSharing.yourShare"),
    translate(labelMaps.locale, "subscription.costSharing.memberTotal"),
    translate(labelMaps.locale, "subscriptions.csv.tags"),
  ];
  const rows = subscriptions.map((subscription) => {
    // CSV 是面向用户阅读的报表，状态列跟 UI 一样使用有效状态；JSON 导出仍保留原始 status，方便备份和未来迁移。
    const effectiveStatus = getEffectiveSubscriptionStatus(subscription, labelMaps.today);
    const reminderDays = subscription.reminderDays === DISABLED_REMINDER_DAYS
      ? translate(labelMaps.locale, "subscription.reminderDisabledCsv")
      : subscription.reminderDays === INHERIT_REMINDER_DAYS
        ? translate(labelMaps.locale, "subscription.reminderInheritCsv")
        : subscription.reminderDays;
    const costSharingSummary = calculateCostSharingSummary(subscription.costSharing, subscription.price, {
      ...labelMaps.costSharingCalculation,
      baseCurrency: subscription.currency,
    });
    return [
      subscription.name,
      subscription.price,
      subscription.currency,
      subscription.balance ?? "",
      subscription.balanceCurrency ?? "",
      formatBillingCycleLabel(subscription, labelMaps.locale),
      labelMaps.categoryLabelByValue.get(subscription.category) ?? subscription.category,
      labelMaps.statusLabelByValue.get(effectiveStatus) ?? effectiveStatus,
      subscription.startDate ?? "",
      subscription.nextBillingDate,
      reminderDays,
      costSharingSummary.enabled ? costSharingSummary.yourShare : "",
      costSharingSummary.enabled ? costSharingSummary.memberTotal : "",
      subscription.tags?.join(";") || "",
    ];
  });

  return [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ].join("\n");
}
