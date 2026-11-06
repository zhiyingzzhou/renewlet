import type { MessageKey, MessageParams } from "@/i18n/messages";
import {
  getSubscriptionFormValidationIssues,
  type SubscriptionFormErrorField,
  type SubscriptionFormValidationIssue,
} from "@/lib/subscription-form";
import type { AIDraftConfirmationField } from "@/modules/ai-recognition/domain/ai-recognition-form";
import type { SubscriptionFormState } from "@/types/subscription-form";

export const AI_DRAFT_BLOCKING_ISSUE_CODES = [
  "aiPriceUnconfirmed",
  "aiCurrencyUnconfirmed",
  "aiBillingCycleUnconfirmed",
  "aiStatusUnconfirmed",
  "aiCategoryUnconfirmed",
  "aiPaymentMethodUnconfirmed",
] as const;

export type AIDraftBlockingIssueCode =
  | typeof AI_DRAFT_BLOCKING_ISSUE_CODES[number]
  | SubscriptionFormValidationIssue["code"];

export interface AIDraftBlockingIssue {
  code: AIDraftBlockingIssueCode;
  field: SubscriptionFormErrorField;
  messageKey: MessageKey;
  params?: MessageParams | undefined;
  confirmationField?: AIDraftConfirmationField | undefined;
}

interface AIDraftPreflightInput {
  formData: SubscriptionFormState;
  pendingConfirmationFields: readonly AIDraftConfirmationField[];
}

// 模型默认值需要显式确认，但确认问题与通用表单错误按字段去重，避免同一控件出现两条阻塞原因。
export function getAIDraftBlockingIssues(input: AIDraftPreflightInput): AIDraftBlockingIssue[] {
  const confirmationIssues = input.pendingConfirmationFields.map(confirmationIssue);
  const confirmedFields = new Set(confirmationIssues.map((issue) => issue.field));
  return [
    ...confirmationIssues,
    ...getSubscriptionFormValidationIssues(input.formData)
      .filter((issue) => !confirmedFields.has(issue.field)),
  ];
}

function confirmationIssue(field: AIDraftConfirmationField): AIDraftBlockingIssue {
  switch (field) {
    case "price":
      return {
        code: "aiPriceUnconfirmed",
        field: "price",
        messageKey: "aiRecognition.draftIssuePriceRequired",
        confirmationField: field,
      };
    case "currency":
      return {
        code: "aiCurrencyUnconfirmed",
        field: "currency",
        messageKey: "aiRecognition.draftIssueCurrencyRequired",
        confirmationField: field,
      };
    case "billingCycle":
      return {
        code: "aiBillingCycleUnconfirmed",
        field: "billingCycle",
        messageKey: "aiRecognition.draftIssueBillingCycleRequired",
        confirmationField: field,
      };
    case "status":
      return {
        code: "aiStatusUnconfirmed",
        field: "name",
        messageKey: "aiRecognition.draftIssueStatusRequired",
        confirmationField: field,
      };
    case "category":
      return {
        code: "aiCategoryUnconfirmed",
        field: "name",
        messageKey: "aiRecognition.draftIssueCategoryRequired",
        confirmationField: field,
      };
    case "paymentMethod":
      return {
        code: "aiPaymentMethodUnconfirmed",
        field: "name",
        messageKey: "aiRecognition.draftIssuePaymentMethodRequired",
        confirmationField: field,
      };
  }
}

export function hasAIDraftBlockingIssues(input: AIDraftPreflightInput): boolean {
  return getAIDraftBlockingIssues(input).length > 0;
}
