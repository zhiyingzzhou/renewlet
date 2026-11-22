import { useEffect, type Dispatch, type SetStateAction } from "react";
import { calculateNextBillingDate, calculateOneTimeTermEndDate } from "@/lib/subscription-billing";
import { parsePositiveIntegerInput } from "@/lib/subscription-form";
import type { DateOnly } from "@/lib/time/date-only";
import type { SubscriptionFormState } from "@/types/subscription-form";

type SubscriptionFormAutoDatePatch = Pick<Partial<SubscriptionFormState>, "autoCalculate" | "nextBillingDate">;
type SubscriptionFormAutoDateFields = Pick<
  SubscriptionFormState,
  | "autoCalculate"
  | "billingCycle"
  | "customCycleUnit"
  | "customDays"
  | "nextBillingDate"
  | "oneTimeMode"
  | "oneTimeTermCount"
  | "oneTimeTermUnit"
  | "startDate"
>;

export function useSubscriptionFormAutoDates(
  formData: SubscriptionFormState,
  setFormData: Dispatch<SetStateAction<SubscriptionFormState>>,
  billingReferenceDate: DateOnly,
  onAutoDatePatch?: (patch: SubscriptionFormAutoDatePatch) => void,
  enabled = true,
): void {
  const {
    autoCalculate,
    billingCycle,
    customCycleUnit,
    customDays,
    nextBillingDate,
    oneTimeMode,
    oneTimeTermCount,
    oneTimeTermUnit,
    startDate,
  } = formData;

  useEffect(() => {
    // 这个 effect 只根据账单字段生成最小 patch；避免 setFormData 回写同值导致表单状态链反复触发。
    if (!enabled) return;
    const patch = getSubscriptionFormAutoDatePatch({
      autoCalculate,
      billingCycle,
      customCycleUnit,
      customDays,
      nextBillingDate,
      oneTimeMode,
      oneTimeTermCount,
      oneTimeTermUnit,
      startDate,
    }, billingReferenceDate);
    if (!patch) return;
    setFormData((prev) => ({ ...prev, ...patch }));
    onAutoDatePatch?.(patch);
  }, [
    autoCalculate,
    billingReferenceDate,
    billingCycle,
    customCycleUnit,
    customDays,
    nextBillingDate,
    enabled,
    onAutoDatePatch,
    oneTimeMode,
    oneTimeTermCount,
    oneTimeTermUnit,
    setFormData,
    startDate,
  ]);
}

export function getSubscriptionFormAutoDatePatch(
  formData: SubscriptionFormAutoDateFields,
  billingReferenceDate: DateOnly,
): SubscriptionFormAutoDatePatch | null {
  if (formData.billingCycle === "one-time") {
    // 一次性固定服务期的到期日来自 startDate + term；买断/长期有效则保留 startDate 并关闭自动日期语义。
    const oneTimeTermCount = formData.oneTimeMode === "term" ? parsePositiveIntegerInput(formData.oneTimeTermCount) : null;
    const nextBillingDate = formData.startDate && oneTimeTermCount
      ? calculateOneTimeTermEndDate(formData.startDate, oneTimeTermCount, formData.oneTimeTermUnit)
      : formData.startDate;
    return compactAutoDatePatch(formData, {
      autoCalculate: false,
      nextBillingDate,
    });
  }
  if (formData.autoCalculate && formData.startDate) {
    // 自定义周期缺天数时沿用历史表单默认 30 天，保持手动输入为空时仍能给用户一个可预览日期。
    const customDays = formData.billingCycle === "custom" ? parsePositiveIntegerInput(formData.customDays) ?? 30 : undefined;
    const customCycleUnit = formData.billingCycle === "custom" ? formData.customCycleUnit : "day";
    return compactAutoDatePatch(formData, {
      nextBillingDate: calculateNextBillingDate(formData.startDate, formData.billingCycle, customDays, billingReferenceDate, customCycleUnit),
    });
  }
  return null;
}

function compactAutoDatePatch(
  formData: SubscriptionFormAutoDateFields,
  patch: SubscriptionFormAutoDatePatch,
): SubscriptionFormAutoDatePatch | null {
  const compacted: SubscriptionFormAutoDatePatch = {};
  if (patch.autoCalculate !== undefined && patch.autoCalculate !== formData.autoCalculate) {
    compacted.autoCalculate = patch.autoCalculate;
  }
  if (patch.nextBillingDate !== formData.nextBillingDate) {
    compacted.nextBillingDate = patch.nextBillingDate;
  }
  return Object.keys(compacted).length > 0 ? compacted : null;
}
