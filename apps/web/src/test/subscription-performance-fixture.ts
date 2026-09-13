import { buildSubscriptionPerformanceScenario } from "@renewlet/shared/contract-fixtures";
import { fromApiSubscription, fromApiSubscriptionCollectionItem } from "@/services/subscription-service";

/** 保留 shared 规模夹具的字段分布，只转换为现有 API DTO；不平移日期或模拟历史升级。 */
export function subscriptionPerformanceItems(size: number) {
  return buildSubscriptionPerformanceScenario(size).initial.map((record) => {
    const {
      index: _index,
      customDays,
      customCycleUnit,
      paymentMethod,
      trialEndDate,
      ...subscription
    } = record;
    // API 周期分支拒绝不适用的字段；沿用产品 schema 校验，不用类型断言绕过 shared 夹具与 DTO 的差异。
    return fromApiSubscription({
      ...subscription,
      ...(record.billingCycle === "custom" ? { customDays, customCycleUnit } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(trialEndDate ? { trialEndDate } : {}),
      extra: {},
    });
  });
}

/** 列表诊断使用轻量 DTO，避免将只有导出才读取的详情字段算进 Query 结构共享成本。 */
export function subscriptionPerformanceCollectionItems(size: number) {
  return subscriptionPerformanceItems(size).map(({
    website: _website,
    notes: _notes,
    tags: _tags,
    repeatReminderEnabled: _repeatReminderEnabled,
    repeatReminderInterval: _repeatReminderInterval,
    repeatReminderWindow: _repeatReminderWindow,
    extra: _extra,
    ...collection
  }) => fromApiSubscriptionCollectionItem(collection));
}
