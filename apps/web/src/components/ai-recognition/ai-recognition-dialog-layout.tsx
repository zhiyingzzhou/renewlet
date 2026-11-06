import { Check, CheckCircle2, Circle, FileSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import type { ImportPreviewResponse } from "@/lib/api/schemas/import-export";
import {
  AI_RECOGNITION_MAX_IMAGES,
  AI_RECOGNITION_MAX_TEXT_CHARS,
  type AiRecognitionProviderType,
} from "@/lib/api/schemas/ai-recognition";
import { cn } from "@/lib/utils";
import { aiThinkingDefaultLabelKey, type AIThinkingOption } from "@/modules/ai-recognition/domain/model-capabilities";

export const NO_THINKING_CONTROL_ID = "no-explicit-thinking";

export type AIRecognitionStep = { label: string; active: boolean; done: boolean };

// provider 类型展示必须跟设置页模型能力保持同步，避免生成入口暗示浏览器会直连第三方。
const AI_PROVIDER_TYPE_LABEL_KEYS: Record<AiRecognitionProviderType, MessageKey> = {
  openai: "aiRecognition.providerType.openai",
  anthropic: "aiRecognition.providerType.anthropic",
  gemini: "aiRecognition.providerType.gemini",
  "openai-compatible": "aiRecognition.providerType.openaiCompatible",
};

export function AIRecognitionFooterActions({
  inputStageVisible,
  draftStageVisible,
  previewStageVisible,
  draftsCount,
  draftsStale,
  recognizing,
  canGenerate,
  previewingDrafts,
  hasDraftBlockingIssues,
  preview,
  applying,
  mobile = false,
  onBackToDraft,
  onRecognize,
  onBackToInput,
  onBuildPreview,
  onApply,
}: {
  inputStageVisible: boolean;
  draftStageVisible: boolean;
  previewStageVisible: boolean;
  draftsCount: number;
  draftsStale: boolean;
  recognizing: boolean;
  canGenerate: boolean;
  previewingDrafts: boolean;
  hasDraftBlockingIssues: boolean;
  preview: ImportPreviewResponse | null;
  applying: boolean;
  mobile?: boolean;
  onBackToDraft: () => void;
  onRecognize: () => void;
  onBackToInput: () => void;
  onBuildPreview: () => void;
  onApply: () => void;
}) {
  const { t } = useI18n();
  const secondaryButtonClassName = cn("border-border", mobile && "h-11 flex-1");
  const primaryButtonClassName = cn("gap-2", mobile && "h-11 flex-1");

  return (
    <>
      {inputStageVisible && draftsCount > 0 && !draftsStale ? (
        <Button
          type="button"
          variant="outline"
          className={cn("gap-2", secondaryButtonClassName)}
          disabled={recognizing}
          onClick={onBackToDraft}
        >
          {t("aiRecognition.backToDraft")}
        </Button>
      ) : null}
      {inputStageVisible ? (
        <Button
          type="button"
          className={cn(primaryButtonClassName, "bg-primary text-primary-foreground hover:bg-primary-glow")}
          disabled={!canGenerate}
          onClick={onRecognize}
        >
          {recognizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
          {recognizing ? t("aiRecognition.recognizing") : t(draftsCount > 0 ? "aiRecognition.regenerateDrafts" : "aiRecognition.generateDrafts")}
        </Button>
      ) : draftStageVisible ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={secondaryButtonClassName}
            disabled={previewingDrafts || recognizing}
            onClick={onBackToInput}
          >
            {t("aiRecognition.backToInput")}
          </Button>
          {/* 草稿失效或存在阻塞字段时禁止进入导入预览，确保 AI 入口仍复用 import preview/apply 的契约。 */}
          <Button
            type="button"
            className={primaryButtonClassName}
            onClick={onBuildPreview}
            disabled={previewingDrafts || recognizing || draftsCount === 0 || draftsStale || hasDraftBlockingIssues}
          >
            {previewingDrafts ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {t("aiRecognition.previewDrafts")}
          </Button>
        </>
      ) : preview && previewStageVisible ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={secondaryButtonClassName}
            disabled={applying}
            onClick={onBackToDraft}
          >
            {t("aiRecognition.backToDraft")}
          </Button>
          {/* 草稿问题已在 preflight 消化；进入标准预览后只由当前 payload 的 error 决定能否写入。 */}
          <Button
            type="button"
            className={primaryButtonClassName}
            onClick={onApply}
            disabled={preview.summary.errors > 0 || applying}
          >
            {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {t("aiRecognition.confirmImport")}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          className={primaryButtonClassName}
          onClick={onBuildPreview}
          disabled={previewingDrafts || recognizing || draftsCount === 0 || hasDraftBlockingIssues}
        >
          {previewingDrafts ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {t("aiRecognition.previewDrafts")}
        </Button>
      )}
    </>
  );
}

export function AIRecognitionStepper({
  steps,
  ariaLabel,
}: {
  steps: AIRecognitionStep[];
  ariaLabel: string;
}) {
  return (
    <ol className="flex min-w-0 items-center gap-0 overflow-x-auto text-xs text-muted-foreground lg:justify-end" aria-label={ariaLabel}>
      {steps.map((step, index) => (
        <li key={step.label} className="flex min-w-0 items-center">
          <span className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1",
            step.active && "text-foreground",
          )}>
            <span className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
              step.done
                ? "border-primary/40 bg-primary/10 text-primary"
                : step.active
                  ? "border-foreground/40 bg-background text-foreground"
                  : "border-border bg-secondary/40 text-muted-foreground",
            )}>
              {step.done ? <Check className="h-3 w-3" /> : step.active ? <Circle className="h-2 w-2 fill-current" /> : index + 1}
            </span>
            <span className="truncate">{step.label}</span>
          </span>
          {index < steps.length - 1 ? <span className="mx-1 h-px w-6 shrink-0 bg-border" /> : null}
        </li>
      ))}
    </ol>
  );
}

export function AIRecognitionCompactStepper({
  steps,
  activeIndex,
  ariaLabel,
}: {
  steps: AIRecognitionStep[];
  activeIndex: number;
  ariaLabel: string;
}) {
  const activeStep = steps[activeIndex] ?? steps[0];

  return (
    <div
      data-testid="ai-recognition-mobile-stepper"
      className="shrink-0 border-b border-border bg-secondary/20 px-4 py-1.5"
      aria-label={ariaLabel}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
          <span className="tabular-nums">{activeIndex + 1}/{steps.length}</span>
          <span className="text-muted-foreground" aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{activeStep?.label}</span>
        </div>
        <ol className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
          {steps.map((step, index) => (
            <li
              key={step.label}
              className={cn(
                "h-1.5 rounded-full transition-all",
                index === activeIndex ? "w-5 bg-primary" : "w-1.5",
                index < activeIndex ? "bg-primary/70" : "bg-border",
              )}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

export function AIRecognitionRunSettingsPanel({
  providerType,
  model,
  textLength,
  imageCount,
  thinkingOptions,
  selectedThinkingId,
  disabled,
  layout = "default",
  onThinkingChange,
}: {
  providerType: AiRecognitionProviderType;
  model: string;
  textLength: number;
  imageCount: number;
  thinkingOptions: AIThinkingOption[];
  selectedThinkingId: string;
  disabled: boolean;
  layout?: "default" | "mobile-bar";
  onThinkingChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const mobileBar = layout === "mobile-bar";
  const inputSummary = `${textLength}/${AI_RECOGNITION_MAX_TEXT_CHARS} · ${t("aiRecognition.imageCount", { count: imageCount, max: AI_RECOGNITION_MAX_IMAGES })}`;
  // thinking 能力由 provider/model 决定；不支持时只展示原因，不把占位值写入 AI 请求。
  const thinkingHelp = thinkingOptions.length > 0
    ? t("aiRecognition.thinkingHelp")
    : t(providerType === "openai-compatible" ? "aiRecognition.thinkingUnsupportedCompatible" : "aiRecognition.thinkingUnsupportedModel");
  const thinkingControlField = (
    <div className={cn("grid gap-2", mobileBar ? "min-w-0" : "pt-3")}>
      <Label htmlFor="ai-recognition-thinking" className={cn("text-xs font-medium text-muted-foreground", mobileBar && "sr-only")}>
        {t("aiRecognition.thinking")}
      </Label>
      <Select value={selectedThinkingId} disabled={disabled} onValueChange={onThinkingChange}>
        <SelectTrigger id="ai-recognition-thinking" className={cn("border-border bg-secondary/40", mobileBar ? "h-8 text-xs" : "h-9")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_THINKING_CONTROL_ID}>{t(aiThinkingDefaultLabelKey(model))}</SelectItem>
          {thinkingOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>{t(option.labelKey)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className={cn("text-xs leading-5 text-muted-foreground", mobileBar && "sr-only")}>{thinkingHelp}</p>
    </div>
  );

  if (mobileBar) {
    return (
      <aside
        data-testid="ai-recognition-run-settings-panel"
        data-layout="mobile-bar"
        className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(7.25rem,9.5rem)] items-center gap-2 rounded-md border border-border bg-secondary/20 px-2.5 py-2"
        aria-label={t("aiRecognition.settingsTitle")}
      >
        <dl className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11px] leading-4">
          <CompactSummaryLine label={t("aiRecognition.providerType")} value={t(AI_PROVIDER_TYPE_LABEL_KEYS[providerType])} />
          <CompactSummaryLine label={t("aiRecognition.model")} value={model || t("aiRecognition.draftUnknownValue")} />
          <CompactSummaryLine label={t("aiRecognition.stepInput")} value={inputSummary} />
        </dl>
        {thinkingControlField}
      </aside>
    );
  }

  return (
    <aside
      data-testid="ai-recognition-run-settings-panel"
      data-layout="default"
      className="rounded-lg border border-border bg-background p-3"
      aria-label={t("aiRecognition.settingsTitle")}
    >
      <div className="border-b border-border pb-3">
        <h3 className="text-sm font-semibold text-foreground">{t("aiRecognition.settingsTitle")}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("aiRecognition.thinkingRunHelp")}</p>
      </div>

      <dl className="grid gap-2 border-b border-border py-3 text-xs">
        <SummaryLine label={t("aiRecognition.providerType")} value={t(AI_PROVIDER_TYPE_LABEL_KEYS[providerType])} />
        <SummaryLine label={t("aiRecognition.model")} value={model || t("aiRecognition.draftUnknownValue")} />
        <SummaryLine label={t("aiRecognition.stepInput")} value={inputSummary} />
      </dl>

      {thinkingControlField}
    </aside>
  );
}

function CompactSummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 max-w-36 truncate font-medium text-foreground" title={value}>{value}</dd>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground" title={value}>{value}</dd>
    </div>
  );
}
