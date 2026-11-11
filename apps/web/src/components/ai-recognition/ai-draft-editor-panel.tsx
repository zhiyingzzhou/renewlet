import { useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { SubscriptionFormFields, type SubscriptionFormErrors } from "@/components/subscription-form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSubscriptionFormAutoDates } from "@/hooks/use-subscription-form-auto-dates";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useI18n } from "@/i18n/I18nProvider";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import type { AIDraftBlockingIssue } from "@/modules/ai-recognition/domain/ai-draft-preflight";
import {
  canConfirmAIDraftField,
  canConfirmAIDraftDefaultValue,
  isAIDraftConfigValueKnown,
  type AIDraftConfirmationField,
} from "@/modules/ai-recognition/domain/ai-recognition-form";
import type { CustomConfig } from "@/types/config";
import type { AppSettings } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";

interface AIDraftEditorPanelProps {
  draftId: string;
  sourceDraft: AiRecognizedSubscriptionDraft;
  formData: SubscriptionFormState;
  draftNumber: number;
  config: CustomConfig;
  settings: AppSettings;
  availableTags?: readonly string[];
  blockingIssues: readonly AIDraftBlockingIssue[];
  setFormData: Dispatch<SetStateAction<SubscriptionFormState>>;
  onFieldChange: (field: keyof SubscriptionFormState, value: unknown) => void;
  onConfirmField: (field: AIDraftConfirmationField) => void;
  onNestedDialogOpenChange?: ((open: boolean) => void) | undefined;
  onRemove: () => void;
}

const ignoreLogoUploadStatus = () => undefined;

export function AIDraftEditorPanel({
  draftId,
  sourceDraft,
  formData,
  draftNumber,
  config,
  settings,
  availableTags = [],
  blockingIssues,
  setFormData,
  onFieldChange,
  onConfirmField,
  onNestedDialogOpenChange,
  onRemove,
}: AIDraftEditorPanelProps) {
  const { t, locale } = useI18n();
  const billingReferenceDate = useMemo(
    () => todayDateOnlyInTimeZone(new Date(), settings.timezone),
    [settings.timezone],
  );
  const balanceCurrencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: formData.balanceCurrency || formData.currency,
    locale,
  });
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: formData.currency,
    locale,
  });
  const editorConfig = config;
  const blockingFormErrors = useMemo(
    () => blockingIssuesToFormErrors(blockingIssues, t),
    [blockingIssues, t],
  );
  const statusNeedsConfirmation = blockingIssues.some((issue) => issue.confirmationField === "status");
  const focusStatusField = () => {
    const element = document.getElementById(`${draftId}-status`);
    if (!(element instanceof HTMLElement)) return;
    // 部分嵌入容器和测试 DOM 没有 scrollIntoView；聚焦仍然是确认状态的核心动作。
    element.scrollIntoView?.({ block: "center", behavior: "smooth" });
    element.focus();
  };
  const confirmStatus = () => {
    onConfirmField("status");
    // The summary action is itself a button; defer the field focus until the
    // click's default focus handling has finished so keyboard users land on
    // the actual status control.
    queueMicrotask(focusStatusField);
  };
  // 自动日期与手工编辑写入同一 formData setter，因此也会让父层废弃旧 preview；它不能回写 sourceDraft 或代替核心字段确认。
  useSubscriptionFormAutoDates(formData, setFormData, billingReferenceDate);

  return (
    <div className="grid gap-4 bg-background p-3">
      <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{t("aiRecognition.selectedDraftTitle", { index: draftNumber })}</h3>
            <Badge variant={sourceDraft.confidence === "high" ? "secondary" : "outline"} className="shrink-0 bg-secondary">
              {t(sourceDraft.confidence === "high" ? "aiRecognition.confidenceHigh" : "aiRecognition.confidenceLow")}
            </Badge>
            {statusNeedsConfirmation ? (
              <Badge variant="outline" className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                {t("aiRecognition.statusPending")}
              </Badge>
            ) : null}
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label={t("aiRecognition.removeDraft")}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-5">
        {blockingIssues.length > 0 ? (
          <div className="grid gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100">
            <p className="font-medium">{t("aiRecognition.draftBlockingEditorTitle", { count: blockingIssues.length })}</p>
            <div className="grid gap-1.5">
              {blockingIssues.map((issue) => {
                const confirmationField = issue.confirmationField;
                return (
                  <div key={`${issue.field}:${issue.code}`} className="flex min-w-0 items-center justify-between gap-2">
                    <span className="flex min-w-0 items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <span>{t(issue.messageKey, issue.params)}</span>
                    </span>
                    {confirmationField === "status" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-xs text-amber-900 hover:bg-amber-500/15 dark:text-amber-100"
                        onClick={confirmStatus}
                      >
                        {t("aiRecognition.confirmStatus")}
                      </Button>
                    ) : confirmationField && (
                      (confirmationField === "billingCycle"
                        ? canConfirmAIDraftField(sourceDraft, formData, confirmationField, config)
                        : canConfirmAIDraftDefaultValue(sourceDraft, formData, confirmationField, config))
                      || isNewConfigConfirmation(confirmationField, formData, config)
                    ) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-xs text-amber-900 hover:bg-amber-500/15 dark:text-amber-100"
                        onClick={() => onConfirmField(confirmationField)}
                      >
                        {isNewConfigConfirmation(confirmationField, formData, config)
                          ? t("aiRecognition.addAsNewConfig")
                          : t("aiRecognition.useCurrentDraftValue")}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <SubscriptionFormFields
          idPrefix={`${draftId}-`}
          config={editorConfig}
          formData={formData}
          setFormData={setFormData}
          currencyOptions={currencyOptions}
          balanceCurrencyOptions={balanceCurrencyOptions}
          availableTags={availableTags}
          errors={blockingFormErrors}
          pendingStatusConfirmation={statusNeedsConfirmation}
          showLogoField={false}
          onLogoUploadStatusChange={ignoreLogoUploadStatus}
          onFieldChange={(field, value) => onFieldChange(field, value)}
          notificationReminderDays={settings.notificationReminderDays}
          onNestedDialogOpenChange={onNestedDialogOpenChange}
        />
      </div>

    </div>
  );
}

function isNewConfigConfirmation(
  field: AIDraftConfirmationField,
  formData: SubscriptionFormState,
  config: CustomConfig,
): boolean {
  if (field === "category") return Boolean(formData.category && !isAIDraftConfigValueKnown(formData.category, config.categories));
  if (field === "paymentMethod") return Boolean(formData.paymentMethod && !isAIDraftConfigValueKnown(formData.paymentMethod, config.paymentMethods));
  return false;
}

function blockingIssuesToFormErrors(
  issues: readonly AIDraftBlockingIssue[],
  t: ReturnType<typeof useI18n>["t"],
): SubscriptionFormErrors {
  return issues.reduce<SubscriptionFormErrors>((errors, issue) => {
    // status/category/paymentMethod 没有通用表单校验错误；确认状态只由上方可操作提示承载，避免把错误伪装到 name 控件。
    if (issue.confirmationField === "status" || issue.confirmationField === "category" || issue.confirmationField === "paymentMethod") return errors;
    if (!errors[issue.field]) errors[issue.field] = t(issue.messageKey, issue.params);
    return errors;
  }, {});
}
