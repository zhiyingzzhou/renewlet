import { ordinaryRemindersAllowed, SUBSCRIPTION_STATUSES } from "./runtime";
import { buildSubscriptionPerformanceScenario, subscriptionPerformanceFixture } from "./contract-fixtures";
import { describe, expect, it } from "vitest";

describe.each(subscriptionPerformanceFixture.scenarios)("subscription performance oracle: $size", ({ size, expected }) => {
  it("keeps the deterministic mutation result aligned across runtimes", () => {
    // 这组结果是 Go、Worker 和 Web 性能测试的共同 oracle；运行面只能转换字段名，不能另造样例语义。
    const { initial, final } = buildSubscriptionPerformanceScenario(size);
    const statusCounts = Object.fromEntries(SUBSCRIPTION_STATUSES.map((status) => [
      status,
      final.filter((record) => record.status === status).length,
    ]));
    const tagRows = final.reduce((total, record) => total + new Set(record.tags.map((tag) => tag.trim().toLowerCase())).size, 0);
    const combinedFilterIndices = final
      .filter((record) => record.category === "developer_tools"
        && record.status === "cancelled"
        && record.tags.some((tag) => tag.trim().toLowerCase() === "priority"))
      .map((record) => record.index);

    expect(initial).toHaveLength(size);
    expect(final).toHaveLength(expected.total);
    expect(statusCounts).toEqual(expected.statusCounts);
    expect(tagRows).toBe(expected.tagRows);
    expect(final.filter((record) => record.autoRenew)).toHaveLength(expected.autoRenew);
    // repeatReminder 是调度候选资格；暂停和已取消订阅即使保留开关也不能进入 repeat schedule。
    expect(final.filter((record) => record.repeatReminderEnabled && ordinaryRemindersAllowed(record.status)))
      .toHaveLength(expected.repeatReminder);
    expect(combinedFilterIndices).toEqual(expected.combinedFilterIndices);
  });
});

describe("subscription performance fixture coverage", () => {
  it("covers the required scales, mutations, filters, and field cycles", () => {
    expect(subscriptionPerformanceFixture.scenarios.map(({ size }) => size)).toEqual([10, 100, 1000, 5000]);
    expect(subscriptionPerformanceFixture.mutations.map(({ kind }) => kind)).toEqual(["update", "renew", "delete", "create"]);

    const { initial } = buildSubscriptionPerformanceScenario(1000);
    expect(new Set(initial.map((record) => record.status))).toEqual(new Set(SUBSCRIPTION_STATUSES));
    expect(new Set(initial.map((record) => record.billingCycle))).toEqual(new Set(subscriptionPerformanceFixture.recipe.billingCycles));
    expect(new Set(initial.map((record) => record.currency))).toEqual(new Set(subscriptionPerformanceFixture.recipe.currencies));
    expect(new Set(initial.map((record) => record.reminderDays))).toEqual(new Set(subscriptionPerformanceFixture.recipe.reminderDays));
  });
});
