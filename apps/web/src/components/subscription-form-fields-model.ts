import type { Dispatch, SetStateAction } from "react";
import type { UploadStatus as LogoUploadStatus } from "@/components/logo-picker";
import type { SearchableSelectOption } from "@/lib/searchable-options";
import type { CustomConfig } from "@/types/config";
import type { SubscriptionFormState } from "@/types/subscription-form";
import type { SubscriptionFormErrorField, SubscriptionFormErrors } from "@/lib/subscription-form";

export interface SubscriptionFormFieldsProps {
  /** 同一页面可能同时渲染新增/编辑弹窗，id 前缀用于保持 label 与错误提示的 a11y 关联唯一。 */
  idPrefix: string;
  config: CustomConfig;
  formData: SubscriptionFormState;
  setFormData: Dispatch<SetStateAction<SubscriptionFormState>>;
  /** 由表单宿主统一生成，字段组件不能重建货币列表，否则会绕开设置页货币管理顺序。 */
  currencyOptions: SearchableSelectOption[];
  balanceCurrencyOptions: SearchableSelectOption[];
  hasStoredBalance?: boolean | undefined;
  availableTags?: readonly string[] | undefined;
  showLogoField?: boolean | undefined;
  onLogoUploadStatusChange: (status: LogoUploadStatus) => void;
  onFieldChange?: <K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) => void;
  /** AI 草稿在模型未给出状态时保留可编辑占位值，但必须把状态控件标成待确认。 */
  pendingStatusConfirmation?: boolean | undefined;
  errors?: SubscriptionFormErrors | undefined;
  onClearFieldError?: ((field: keyof SubscriptionFormErrors) => void) | undefined;
  notificationReminderDays: number;
  costSharingCurrencyConvert?: ((amount: number | string, fromCurrency: string, toCurrency: string) => number) | undefined;
  onNestedDialogOpenChange?: ((open: boolean) => void) | undefined;
}

export type { SubscriptionFormErrors };

export type SubscriptionFormFieldUpdater = <K extends keyof SubscriptionFormState>(
  key: K,
  value: SubscriptionFormState[K],
) => void;

// 输入态字段到错误区块的唯一映射；onChange 清错和 submit 校验共用它，避免某些字段改动后旧错误残留。
export const errorFieldByFormKey: Partial<Record<keyof SubscriptionFormState, SubscriptionFormErrorField>> = {
  name: "name",
  price: "price",
  currency: "currency",
  balance: "balance",
  balanceCurrency: "balanceCurrency",
  billingCycle: "billingCycle",
  customDays: "customDays",
  oneTimeMode: "oneTimeTerm",
  oneTimeTermCount: "oneTimeTerm",
  oneTimeTermUnit: "oneTimeTerm",
  startDate: "dates",
  nextBillingDate: "dates",
  reminderType: "reminderDays",
  reminderDays: "reminderDays",
  customReminderDays: "reminderDays",
  costSharing: "costSharing",
  website: "website",
  tags: "tags",
} satisfies Partial<Record<keyof SubscriptionFormState, SubscriptionFormErrorField>>;

const structuralErrorFieldsByFormKey: Partial<Record<keyof SubscriptionFormState, readonly SubscriptionFormErrorField[]>> = {
  // 这些字段会重塑日期、普通提醒和家庭收款提醒含义；旧提交错误必须失效，下一次提交再按当前形态重新生成。
  billingCycle: ["billingCycle", "dates", "customDays", "oneTimeTerm", "reminderDays", "costSharing"],
  oneTimeMode: ["dates", "oneTimeTerm", "reminderDays", "costSharing"],
  autoCalculate: ["dates"],
  balanceEnabled: ["balance", "balanceCurrency"],
};

export function getErrorFieldsToClearForFormChange(
  key: keyof SubscriptionFormState,
): readonly (keyof SubscriptionFormErrors)[] {
  const fields = new Set<SubscriptionFormErrorField>();
  const directField = errorFieldByFormKey[key];
  if (directField) fields.add(directField);
  for (const structuralField of structuralErrorFieldsByFormKey[key] ?? []) {
    fields.add(structuralField);
  }
  return Array.from(fields);
}
