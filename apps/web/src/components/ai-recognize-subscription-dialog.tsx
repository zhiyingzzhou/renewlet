import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { AlertTriangle, FileSearch } from "lucide-react";
// AI 识别弹窗负责把流式事件收敛为导入草稿；只有 final 事件能进入 preview/apply 链路。
import { AIDraftReviewPanel } from "@/components/ai-recognition/ai-draft-review-panel";
import { AIErrorDetailsDialog } from "@/components/ai-recognition/ai-error-details-dialog";
import {
  AIRecognitionCompactStepper,
  AIRecognitionFooterActions,
  AIRecognitionRunSettingsPanel,
  AIRecognitionStepper,
  NO_THINKING_CONTROL_ID,
  type AIRecognitionStep,
} from "@/components/ai-recognition/ai-recognition-dialog-layout";
import { AIRecognitionInputTabs } from "@/components/ai-recognition/ai-recognition-input-tabs";
import { AIRecognitionStreamPanel } from "@/components/ai-recognition/ai-recognition-stream-panel";
import { useAIRecognitionImages } from "@/components/ai-recognition/use-ai-recognition-images";
import {
  appendLimitedText,
  isAbortedApiError,
  nextDraftId,
  recognitionElapsedSeconds,
  thinkingOptionIdOrNull,
} from "@/components/ai-recognition/ai-recognition-dialog-utils";
import type { AIDraftListItem } from "@/components/ai-recognition/ai-recognition-dialog-types";
import Link from "@/components/router-link";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ImportPreviewPanel } from "@/components/import-preview-panel";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";
import { useI18n } from "@/i18n/I18nProvider";
import { createAIErrorDetails, type AIErrorDetails } from "@/lib/ai-error-details";
import { getDisplayErrorMessage } from "@/lib/display-error";
import {
  type AiRecognizedSubscriptionDraft,
  type AiRecognitionStreamEvent,
  type AiRecognitionStreamStage,
  type AiThinkingControl,
} from "@/lib/api/schemas/ai-recognition";
import { cn } from "@/lib/utils";
import type { CustomConfig } from "@/types/config";
import type { AppSettings } from "@/types/subscription";
import {
  getAIThinkingOptions,
  normalizeAIThinkingControl,
  thinkingControlFromOptionId,
  thinkingOptionId,
} from "@/modules/ai-recognition/domain/model-capabilities";
import { getAIRecognitionSettingsBlocker } from "@/modules/ai-recognition/domain/settings-readiness";
import { buildPreparedImportFromAIDrafts } from "@/modules/ai-recognition/domain/ai-recognition-import";
import { getAIDraftBlockingIssues } from "@/modules/ai-recognition/domain/ai-draft-preflight";
import {
  AI_DRAFT_CONFIRMATION_FIELDS,
  aiDraftToSubscriptionFormState,
  canConfirmAIDraftField,
  canConfirmAIDraftDefaultValue,
  getInitialAIDraftConfirmationFields,
  isAIDraftConfigValueKnown,
  type AIDraftConfirmationField,
} from "@/modules/ai-recognition/domain/ai-recognition-form";
import { useImportPreviewApply } from "@/modules/import-export/application/use-import-preview-apply";
import { aiRecognitionService } from "@/services/ai-recognition-service";
import type { SubscriptionFormState } from "@/types/subscription-form";

export interface AIRecognizeSubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AppSettings;
  apiKeyConfigured?: boolean;
  config: CustomConfig;
  availableTags?: readonly string[];
}

export interface AIRecognizeSubscriptionDialogContentProps extends Omit<
  AIRecognizeSubscriptionDialogProps,
  "apiKeyConfigured" | "availableTags" | "onOpenChange"
> {
  apiKeyConfigured: boolean | undefined;
  availableTags: readonly string[] | undefined;
  onNestedDialogOpenChange: (open: boolean) => void;
  onRequestClose: () => void;
  onWorkflowExpandedChange: (expanded: boolean) => void;
}

type AIRecognitionStage = "input" | "draft" | "preview";
type AIRecognitionStreamStatus = "running" | "complete" | "error" | "stopped";
const AI_RECOGNITION_TEXT_PREVIEW_MAX_CHARS = 360;
export function AIRecognizeSubscriptionDialogContent({
  open,
  settings,
  apiKeyConfigured = false,
  config,
  availableTags = [],
  onNestedDialogOpenChange,
  onRequestClose,
  onWorkflowExpandedChange,
}: AIRecognizeSubscriptionDialogContentProps) {
  const { t } = useI18n();
  const isMobile = useMediaQuery("(max-width: 639px)");
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const draftIdRef = useRef(0);
  const recognitionRunRef = useRef(0);
  const recognitionAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const recognitionStartedAtRef = useRef<number | null>(null);
  const recognitionElapsedSecondsRef = useRef<number | null>(null);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<AIDraftListItem[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [thinkingControl, setThinkingControl] = useState<AiThinkingControl | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [previewingDrafts, setPreviewingDrafts] = useState(false);
  const [stage, setStage] = useState<AIRecognitionStage>("input");
  const [draftsStale, setDraftsStale] = useState(false);
  const [streamStage, setStreamStage] = useState<AiRecognitionStreamStage | null>(null);
  const [streamStatus, setStreamStatus] = useState<AIRecognitionStreamStatus | null>(null);
  const [streamSubscriptionsSeen, setStreamSubscriptionsSeen] = useState(0);
  const [streamWarningsSeen, setStreamWarningsSeen] = useState(0);
  const [streamTextPreview, setStreamTextPreview] = useState("");
  const [streamElapsedSeconds, setStreamElapsedSeconds] = useState<number | null>(null);
  const [draftGenerationElapsedSeconds, setDraftGenerationElapsedSeconds] = useState<number | null>(null);
  const [aiErrorDetails, setAIErrorDetails] = useState<AIErrorDetails | null>(null);
  const [aiErrorDetailsOpen, setAIErrorDetailsOpen] = useState(false);
  const aiSettings = settings.aiRecognition;
  const settingsBlocker = getAIRecognitionSettingsBlocker(aiSettings, apiKeyConfigured);
  const thinkingOptions = useMemo(
    () => getAIThinkingOptions(aiSettings.providerType, aiSettings.transportProtocol, aiSettings.model),
    [aiSettings.model, aiSettings.providerType, aiSettings.transportProtocol],
  );
  const selectedThinkingId = thinkingControl ? thinkingOptionId(thinkingControl) : NO_THINKING_CONTROL_ID;
  const {
    prepared,
    preview,
    conflictMode,
    previewFilter,
    skippedIndexes,
    error,
    applying,
    assetProgress,
    applyProgress,
    setError,
    setPreviewFilter,
    resetImportPreview,
    previewPrepared,
    handleConflictModeChange,
    handleLogoChange,
    handleSkipChange,
    handleApply,
  } = useImportPreviewApply({ onApplied: onRequestClose });
  const {
    images,
    imageProcessing,
    imageProcessingCount,
    addImages,
    removeImage,
    abortProcessing: abortImageProcessing,
  } = useAIRecognitionImages({
    setError,
    onInputChanged: markDraftsStaleFromInputChange,
  });
  const draftBlockingIssuesById = useMemo(
    () => new Map(drafts.map((item) => [item.id, getAIDraftBlockingIssues(item)])),
    [drafts],
  );
  const firstBlockingDraftId = useMemo(
    () => drafts.find((item) => (draftBlockingIssuesById.get(item.id)?.length ?? 0) > 0)?.id ?? null,
    [draftBlockingIssuesById, drafts],
  );
  const hasDraftBlockingIssues = firstBlockingDraftId !== null;
  const activeText = text.trim();
  const activeImages = images;
  const canGenerate = !settingsBlocker && (activeText.length > 0 || activeImages.length > 0) && !recognizing && !imageProcessing;
  const workflowExpanded = stage !== "input";
  const inputStageVisible = stage === "input";
  const draftStageVisible = stage === "draft";
  const previewStageVisible = stage === "preview";
  const steps: AIRecognitionStep[] = [
    { label: t("aiRecognition.stepInput"), active: stage === "input", done: drafts.length > 0 && !draftsStale },
    { label: t("aiRecognition.stepDraft"), active: stage === "draft", done: stage === "preview" },
    { label: t("import.stepPreview"), active: stage === "preview", done: Boolean(preview && preview.summary.errors === 0) },
    { label: t("import.stepApply"), active: Boolean(preview && preview.summary.errors === 0), done: false },
  ];
  const mobileActiveStepIndex = previewStageVisible && preview?.summary.errors === 0
    ? 3
    : draftStageVisible ? 1 : previewStageVisible ? 2 : 0;
  const resolveInitialFocus = useCallback(() => {
    if (!isMobile) return textInputRef.current;
    return textInputRef.current
      ?.closest<HTMLElement>('[role="dialog"]')
      ?.querySelector<HTMLElement>("[data-dialog-close]") ?? null;
  }, [isMobile]);
  useDeferredDialogInitialFocus(
    open,
    true,
    isMobile ? "ai-recognition-mobile" : "ai-recognition-desktop",
    resolveInitialFocus,
  );

  useEffect(() => () => {
    recognitionAbortRef.current?.abort();
    previewAbortRef.current?.abort();
  }, []);

  useLayoutEffect(() => {
    if (open) return;
    // 关闭即废弃当前异步会话，但保留退出动画中的最后一帧；新会话会以新的 content key 重新初始化。
    recognitionRunRef.current += 1;
    recognitionAbortRef.current?.abort();
    recognitionAbortRef.current = null;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    abortImageProcessing();
  }, [abortImageProcessing, open]);

  useEffect(() => {
    if (!open) return;
    setThinkingControl(normalizeAIThinkingControl(aiSettings.providerType, aiSettings.transportProtocol, aiSettings.model, aiSettings.defaultThinkingControl));
  }, [aiSettings.defaultThinkingControl, aiSettings.model, aiSettings.providerType, aiSettings.transportProtocol, open]);

  useLayoutEffect(() => {
    onWorkflowExpandedChange(workflowExpanded);
  }, [onWorkflowExpandedChange, workflowExpanded]);

  useEffect(() => {
    if (!open || !recognizing || recognitionStartedAtRef.current === null) return;
    // runId 保护事件顺序，elapsed refs 保护计时器：旧运行结束后不能把耗时写进新草稿。
    const timer = window.setInterval(() => {
      const startedAt = recognitionStartedAtRef.current;
      if (startedAt === null) return;
      const elapsed = recognitionElapsedSeconds(startedAt);
      recognitionElapsedSecondsRef.current = elapsed;
      setStreamElapsedSeconds(elapsed);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, recognizing]);

  function cancelActiveRecognitionRun() {
    recognitionAbortRef.current?.abort();
    recognitionAbortRef.current = null;
  }

  function handleTextChange(nextText: string) {
    if (nextText === text) return;
    setText(nextText);
    markDraftsStaleFromInputChange();
  }

  function handleThinkingChange(value: string) {
    const nextThinkingControl = value === NO_THINKING_CONTROL_ID ? null : thinkingControlFromOptionId(thinkingOptions, value);
    if (thinkingOptionIdOrNull(nextThinkingControl) === thinkingOptionIdOrNull(thinkingControl)) return;
    setThinkingControl(nextThinkingControl);
    markDraftsStaleFromInputChange();
  }

  function markDraftsStaleFromInputChange() {
    if (recognitionAbortRef.current) {
      cancelActiveRecognitionRun();
      recognitionRunRef.current += 1;
      setRecognizing(false);
      resetStreamState();
    }
    if (drafts.length === 0) return;
    // 输入、图片和思考控制是草稿生成的事实源；返回输入后改动任一项，都必须让旧 preview 失效。
    setDraftsStale(true);
    setDraftGenerationElapsedSeconds(null);
    resetImportPreview();
  }

  function handleBackToInput() {
    resetStreamState();
    setStage("input");
    setError(null);
  }

  function handleBackToDraft() {
    if (drafts.length === 0 || draftsStale) return;
    resetStreamState();
    setStage("draft");
    setError(null);
  }

  const handleRecognize = async () => {
    if (!canGenerate) return;
    // runId 与 AbortController 共同保护 SSE 竞态：旧流即使晚到，也不能覆盖新一轮输入状态。
    const runId = recognitionRunRef.current + 1;
    recognitionRunRef.current = runId;
    cancelActiveRecognitionRun();
    const controller = new AbortController();
    recognitionAbortRef.current = controller;
    setRecognizing(true);
    setError(null);
    setAIErrorDetails(null);
    setAIErrorDetailsOpen(false);
    resetStreamState();
    startRecognitionElapsed();
    setStreamStatus("running");
    setDraftGenerationElapsedSeconds(null);
    resetImportPreview();
    try {
      const response = await aiRecognitionService.recognizeSubscriptionsStream(
        {
          text,
          images: images.map((image) => image.file),
          thinkingControl,
        },
        {
          onEvent: (event) => handleRecognitionStreamEvent(runId, event),
        },
        { signal: controller.signal },
      );
      if (recognitionRunRef.current !== runId) return;
      // final 事件是唯一可信草稿来源；partial/text/reasoning 只驱动上方状态面板，不能进入导入预览。
      const elapsedSeconds = freezeRecognitionElapsed();
      resetStreamState();
      const nextDrafts = response.subscriptions.map((draft) => ({
        id: nextDraftId(draftIdRef),
        // sourceDraft 只保存模型证据；所有用户可见编辑都进入唯一 formData，切换草稿不会再做双向镜像。
        sourceDraft: draft,
        formData: aiDraftToSubscriptionFormState(draft, { settings }),
        pendingConfirmationFields: getInitialAIDraftConfirmationFields(draft, config, settings.timezone),
      }));
      setDrafts(nextDrafts);
      setDraftGenerationElapsedSeconds(elapsedSeconds);
      setSelectedDraftId(nextDrafts[0]?.id ?? null);
      setDraftsStale(false);
      setStage("draft");
    } catch (err) {
      if (recognitionRunRef.current !== runId) return;
      freezeRecognitionElapsed();
      const aborted = isAbortedApiError(err);
      setStreamStatus(aborted ? "stopped" : "error");
      if (aborted) return;
      const details = createAIErrorDetails(err, t("aiRecognition.recognizeFailedDescription"));
      setAIErrorDetails(details);
      setAIErrorDetailsOpen(true);
      setError(null);
      setStreamStatus("error");
    } finally {
      if (recognitionRunRef.current === runId) {
        setRecognizing(false);
        recognitionAbortRef.current = null;
      }
    }
  };

  function dismissStreamOverlay() {
    if (recognizing) return;
    // 关闭错误/停止态遮罩只恢复输入工作区；partial 仍然只是进度信号，不能被当成草稿成功。
    resetStreamState();
  }

  function resetStreamState() {
    recognitionStartedAtRef.current = null;
    recognitionElapsedSecondsRef.current = null;
    setStreamStage(null);
    setStreamStatus(null);
    setStreamSubscriptionsSeen(0);
    setStreamWarningsSeen(0);
    setStreamTextPreview("");
    setStreamElapsedSeconds(null);
  }

  function startRecognitionElapsed() {
    recognitionStartedAtRef.current = performance.now();
    recognitionElapsedSecondsRef.current = 1;
    setStreamElapsedSeconds(1);
  }

  function freezeRecognitionElapsed(): number | null {
    const startedAt = recognitionStartedAtRef.current;
    if (startedAt === null) return recognitionElapsedSecondsRef.current;
    const elapsed = recognitionElapsedSeconds(startedAt);
    recognitionStartedAtRef.current = null;
    recognitionElapsedSecondsRef.current = elapsed;
    setStreamElapsedSeconds(elapsed);
    return elapsed;
  }

  function handleRecognitionStreamEvent(runId: number, event: AiRecognitionStreamEvent) {
    if (recognitionRunRef.current !== runId) return;
    switch (event.type) {
      case "recognition/progress":
        setStreamStage(event.stage);
        break;
      case "recognition/partial":
        setStreamSubscriptionsSeen(event.subscriptionsSeen);
        setStreamWarningsSeen(event.warningsSeen);
        break;
      case "recognition/text-delta":
        setStreamTextPreview((current) => appendLimitedText(current, event.delta, AI_RECOGNITION_TEXT_PREVIEW_MAX_CHARS));
        break;
      case "recognition/reasoning-delta":
        // 兼容旧 Worker 事件但永不展示内部 reasoning，避免把 chain-of-thought 变成用户界面契约。
        break;
      case "recognition/final":
        freezeRecognitionElapsed();
        setStreamStatus("complete");
        setStreamStage("finalizing");
        break;
      case "recognition/error":
        freezeRecognitionElapsed();
        setStreamStatus("error");
        break;
    }
  }

  const handleBuildPreview = async () => {
    if (drafts.length === 0 || draftsStale) return;
    if (firstBlockingDraftId) {
      // preflight 必须把用户带回首个问题草稿；不能用 UI 中的 fallback 值生成看似有效、实际未经确认的 preview。
      setSelectedDraftId(firstBlockingDraftId);
      setStage("draft");
      setError(null);
      return;
    }
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewingDrafts(true);
    setError(null);
    try {
      const preparedImport = buildPreparedImportFromAIDrafts(drafts, { config });
      await previewPrepared(preparedImport, conflictMode, controller.signal);
      if (controller.signal.aborted) return;
      setStage("preview");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getDisplayErrorMessage(err, t("import.previewFailed")));
    } finally {
      if (previewAbortRef.current === controller) {
        previewAbortRef.current = null;
        setPreviewingDrafts(false);
      }
    }
  };

  function invalidateDraftPreview() {
    // 草稿是导入预览的前端事实源；任何编辑/删除都必须废弃旧 preview，避免确认时写入过期数据。
    resetImportPreview();
  }

  function updateDraftForm(id: string, action: SetStateAction<SubscriptionFormState>) {
    invalidateDraftPreview();
    setDrafts((current) => current.map((item) => {
      if (item.id !== id) return item;
      const formData = typeof action === "function" ? action(item.formData) : action;
      const pendingConfirmationFields = syncAIDraftConfirmationFields(item, formData, config);
      return { ...item, formData, pendingConfirmationFields };
    }));
  }

  function confirmDraftField(id: string, field: AIDraftConfirmationField, value?: unknown) {
    // 直接编辑或点击“使用当前值”都消费一次显式确认；确认只改变审阅状态，绝不回写不可变的 sourceDraft。
    invalidateDraftPreview();
    setDrafts((current) => current.map((item) => {
      if (item.id !== id) return item;
      // 字段可能本来就显示表单默认值（例如缺失周期显示“每月”），因此不能只比较新旧值。
      // 编辑回调传入的值代表用户刚刚明确选择的值，直接用它参与确认判断，避免读到旧快照。
      const confirmationFormData = value === undefined
        ? item.formData
        : { ...item.formData, [field]: value } as SubscriptionFormState;
      if (!canConfirmAIDraftField(item.sourceDraft, confirmationFormData, field, config)) return item;
      return { ...item, pendingConfirmationFields: item.pendingConfirmationFields.filter((candidate) => candidate !== field) };
    }));
  }

  function confirmAllDraftDefaults() {
    invalidateDraftPreview();
    setDrafts((current) => current.map((item) => ({
      ...item,
      pendingConfirmationFields: item.pendingConfirmationFields.filter((field) => !canConfirmAIDraftDefaultValue(item.sourceDraft, item.formData, field, config)),
    })));
  }

  function removeDraft(id: string) {
    invalidateDraftPreview();
    const removedIndex = drafts.findIndex((item) => item.id === id);
    const nextDrafts = drafts.filter((item) => item.id !== id);
    const fallback = removedIndex >= 0 ? nextDrafts[Math.min(removedIndex, nextDrafts.length - 1)]?.id ?? null : null;
    setDrafts(nextDrafts);
    setSelectedDraftId((currentSelected) => (currentSelected === id ? fallback : currentSelected));
  }

  const inputTabs = (
    <AIRecognitionInputTabs
      text={text}
      onTextChange={handleTextChange}
      textInputRef={textInputRef}
      images={images}
      disabled={recognizing || imageProcessing}
      imageProcessing={imageProcessing}
      imageProcessingCount={imageProcessingCount}
      onAddImages={addImages}
      onRemoveImage={removeImage}
      layout={isMobile ? "mobile-compact" : "default"}
    />
  );
  const runSettingsPanel = (
    <AIRecognitionRunSettingsPanel
      providerType={aiSettings.providerType}
      model={aiSettings.model}
      textLength={Array.from(text).length}
      imageCount={images.length}
      thinkingOptions={thinkingOptions}
      selectedThinkingId={selectedThinkingId}
      disabled={recognizing || imageProcessing}
      layout={isMobile ? "mobile-bar" : "default"}
      onThinkingChange={handleThinkingChange}
    />
  );
  const streamPanel = streamStatus ? (
    <AIRecognitionStreamPanel
      stage={streamStage}
      status={streamStatus}
      subscriptionsSeen={streamSubscriptionsSeen}
      warningsSeen={streamWarningsSeen}
      textPreview={streamTextPreview}
      elapsedSeconds={streamElapsedSeconds}
      hasErrorDetails={streamStatus === "error" && Boolean(aiErrorDetails)}
      actionsDisabled={recognizing}
      mobile={isMobile}
      onDismiss={dismissStreamOverlay}
      onOpenErrorDetails={() => setAIErrorDetailsOpen(true)}
    />
  ) : null;

  const body = (
    <div
      data-testid="ai-recognition-dialog-body"
      className={cn(
        "h-full min-h-0",
        isMobile ? "px-3 py-2" : "px-4 py-4 sm:px-6",
        inputStageVisible || draftStageVisible
          ? cn("flex flex-col overflow-hidden", isMobile ? "gap-2" : "gap-4")
          : cn("overflow-y-auto", isMobile ? "space-y-3" : "space-y-4"),
      )}
    >
      {aiErrorDetails && !streamStatus ? (
        <div className={cn("flex", isMobile ? "justify-stretch" : "justify-end")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("border-border", isMobile && "w-full")}
            onClick={() => setAIErrorDetailsOpen(true)}
          >
            <AlertTriangle className="h-4 w-4" />
            {t("aiRecognition.errorDetailsOpenLast")}
          </Button>
        </div>
      ) : null}

      {settingsBlocker ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>{t(settingsBlocker)}</span>
          </div>
          <Button asChild type="button" variant="outline" className="shrink-0 border-border">
            <Link href="/settings#settings-ai-recognition" onClick={onRequestClose}>
              {t("aiRecognition.openSettings")}
            </Link>
          </Button>
        </div>
      ) : null}

      {inputStageVisible ? (
        <section
          className={cn(
            "grid min-h-0 flex-1",
            isMobile
              ? "grid-rows-[auto_minmax(0,1fr)] gap-2 overflow-hidden"
              : "gap-4 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-stretch lg:overflow-hidden",
          )}
          aria-label={t("aiRecognition.stepInput")}
        >
          {isMobile ? (
            <>
              {runSettingsPanel}
              {inputTabs}
            </>
          ) : (
            <>
              {inputTabs}
              <div className="min-h-0 space-y-3 overflow-y-auto">
                {runSettingsPanel}
              </div>
            </>
          )}
        </section>
      ) : null}

      {inputStageVisible && drafts.length > 0 && draftsStale ? (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("aiRecognition.draftsStale")}</span>
        </div>
      ) : null}

      {error ? (
        <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {draftStageVisible && drafts.length > 0 ? (
        <AIDraftReviewPanel
          drafts={drafts}
          config={config}
          settings={settings}
          availableTags={availableTags}
          draftBlockingIssuesById={draftBlockingIssuesById}
          generationElapsedSeconds={draftGenerationElapsedSeconds}
          selectedDraftId={selectedDraftId}
          onSelectedDraftIdChange={setSelectedDraftId}
          onChangeDraftForm={updateDraftForm}
          onConfirmAllDefaults={confirmAllDraftDefaults}
          onConfirmDraftField={confirmDraftField}
          onNestedDialogOpenChange={onNestedDialogOpenChange}
          onRemoveDraft={removeDraft}
        />
      ) : null}

      {previewStageVisible && prepared && preview ? (
        <ImportPreviewPanel
          prepared={prepared}
          preview={preview}
          conflictMode={conflictMode}
          previewFilter={previewFilter}
          skippedIndexes={skippedIndexes}
          assetProgress={assetProgress}
          applyProgress={applyProgress}
          showImportOptions={false}
          onConflictModeChange={handleConflictModeChange}
          onPreviewFilterChange={setPreviewFilter}
          onLogoChange={handleLogoChange}
          onSkipChange={handleSkipChange}
        />
      ) : null}
    </div>
  );

  const desktopFooter = (
    <DialogFooter className="shrink-0 border-t border-border bg-card px-4 py-4 sm:px-6">
      <Button type="button" variant="outline" onClick={onRequestClose}>{t("common.cancel")}</Button>
      <AIRecognitionFooterActions
        inputStageVisible={inputStageVisible}
        draftStageVisible={draftStageVisible}
        previewStageVisible={previewStageVisible}
        draftsCount={drafts.length}
        draftsStale={draftsStale}
        recognizing={recognizing}
        canGenerate={canGenerate}
        previewingDrafts={previewingDrafts}
        hasDraftBlockingIssues={hasDraftBlockingIssues}
        preview={preview}
        applying={applying}
        onBackToDraft={handleBackToDraft}
        onRecognize={() => void handleRecognize()}
        onBackToInput={handleBackToInput}
        onBuildPreview={() => void handleBuildPreview()}
        onApply={() => void handleApply()}
      />
    </DialogFooter>
  );

  const mobileFooter = (
    <div
      data-testid="ai-recognition-mobile-footer"
      className="flex shrink-0 gap-2 border-t border-border bg-card px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
    >
      <AIRecognitionFooterActions
        inputStageVisible={inputStageVisible}
        draftStageVisible={draftStageVisible}
        previewStageVisible={previewStageVisible}
        draftsCount={drafts.length}
        draftsStale={draftsStale}
        recognizing={recognizing}
        canGenerate={canGenerate}
        previewingDrafts={previewingDrafts}
        hasDraftBlockingIssues={hasDraftBlockingIssues}
        preview={preview}
        applying={applying}
        mobile
        onBackToDraft={handleBackToDraft}
        onRecognize={() => void handleRecognize()}
        onBackToInput={handleBackToInput}
        onBuildPreview={() => void handleBuildPreview()}
        onApply={() => void handleApply()}
      />
    </div>
  );

  return (
    <>
      <DialogHeader
        className={cn(
          "shrink-0 border-b border-border bg-card pr-12",
          isMobile ? "px-4 py-3 text-left" : "px-4 py-4 sm:px-6 sm:pr-14",
        )}
      >
        {isMobile ? (
          <>
            <DialogTitle className="text-base leading-6">{t("aiRecognition.dialogTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t("aiRecognition.dialogDescription")}</DialogDescription>
          </>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground">
                <FileSearch className="h-4 w-4" />
              </div>
              <div className="min-w-0 text-left">
                <DialogTitle className="text-lg">{t("aiRecognition.dialogTitle")}</DialogTitle>
                <DialogDescription className="sr-only">{t("aiRecognition.dialogDescription")}</DialogDescription>
              </div>
            </div>
            <AIRecognitionStepper
              steps={steps}
              ariaLabel={t("aiRecognition.dialogTitle")}
            />
          </div>
        )}
      </DialogHeader>

      {isMobile ? (
        <AIRecognitionCompactStepper
          steps={steps}
          activeIndex={mobileActiveStepIndex}
          ariaLabel={t("aiRecognition.dialogTitle")}
        />
      ) : null}

      <div data-testid="ai-recognition-dialog-workspace" className="relative min-h-0 flex-1 overflow-hidden">
        {body}
        {streamPanel ? (
          <div
            data-testid="ai-recognition-stream-overlay"
            className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-card/75 px-3 py-4 backdrop-blur-[2px] sm:px-6"
          >
            {streamPanel}
          </div>
        ) : null}
      </div>
      {isMobile ? mobileFooter : desktopFooter}
      <AIErrorDetailsDialog
        open={aiErrorDetailsOpen}
        details={aiErrorDetails}
        onOpenChange={setAIErrorDetailsOpen}
      />
    </>
  );
}

function syncAIDraftConfirmationFields(
  item: AIDraftListItem,
  formData: SubscriptionFormState,
  config: CustomConfig,
): AIDraftConfirmationField[] {
  const next = new Set(item.pendingConfirmationFields);
  const previousFormData = item.formData;
  // 用户编辑已经是对模型缺失的核心值作出的明确确认。这里在同一个
  // setState 事务里消费确认，避免先更新表单、再回调确认时读到旧快照。
  for (const field of ["price", "currency", "billingCycle", "status"] as const) {
    if (previousFormData[field] === formData[field]) continue;
    if (canConfirmAIDraftField(item.sourceDraft, formData, field, config)) next.delete(field);
  }
  const configFields: Array<{
    field: "category" | "paymentMethod";
    value: string;
    options: CustomConfig["categories"] | CustomConfig["paymentMethods"];
  }> = [
    { field: "category", value: formData.category, options: config.categories },
    { field: "paymentMethod", value: formData.paymentMethod, options: config.paymentMethods },
  ];
  for (const { field, value, options } of configFields) {
    if (previousFormData[field] === value) continue;
    // 清空未知配置仍然是未确认状态；否则导入层会把空值静默回退为 other/null，绕过安全确认。
    if (!value.trim()) {
      next.add(field);
    } else if (isAIDraftConfigValueKnown(value, options)) {
      next.delete(field);
    } else {
      next.add(field);
    }
  }
  return AI_DRAFT_CONFIRMATION_FIELDS.filter((field) => next.has(field));
}
