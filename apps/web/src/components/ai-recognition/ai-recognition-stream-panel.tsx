import { Activity, AlertTriangle, CheckCircle2, Loader2, MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import type { AiRecognitionStreamStage } from "@/lib/api/schemas/ai-recognition";
import { cn } from "@/lib/utils";

type AIRecognitionStreamPanelStatus = "running" | "complete" | "error" | "stopped";

interface AIRecognitionStreamPanelProps {
  stage: AiRecognitionStreamStage | null;
  status: AIRecognitionStreamPanelStatus;
  subscriptionsSeen: number;
  warningsSeen: number;
  textPreview: string;
  elapsedSeconds: number | null;
  hasErrorDetails?: boolean;
  mobile?: boolean;
  actionsDisabled?: boolean;
  onDismiss?: () => void;
  onOpenErrorDetails?: () => void;
}

const STAGE_ORDER: AiRecognitionStreamStage[] = [
  "input-read",
  "model-start",
  "model-stream",
  "validating",
  "finalizing",
];

// 阶段顺序来自 shared SSE contract；partial/delta 事件只驱动进度反馈，不能当成可导入草稿。
const STAGE_LABEL_KEYS: Record<AiRecognitionStreamStage, MessageKey> = {
  "input-read": "aiRecognition.streamStage.inputRead",
  "model-start": "aiRecognition.streamStage.modelStart",
  "model-stream": "aiRecognition.streamStage.modelStream",
  validating: "aiRecognition.streamStage.validating",
  finalizing: "aiRecognition.streamStage.finalizing",
};

const STATUS_LABEL_KEYS: Record<AIRecognitionStreamPanelStatus, MessageKey> = {
  running: "aiRecognition.streamStatus.running",
  complete: "aiRecognition.streamStatus.complete",
  error: "aiRecognition.streamStatus.error",
  stopped: "aiRecognition.streamStatus.stopped",
};

export function AIRecognitionStreamPanel({
  stage,
  status,
  subscriptionsSeen,
  warningsSeen,
  textPreview,
  elapsedSeconds,
  hasErrorDetails = false,
  mobile = false,
  actionsDisabled = false,
  onDismiss,
  onOpenErrorDetails,
}: AIRecognitionStreamPanelProps) {
  const { t } = useI18n();
  const activeIndex = stage ? STAGE_ORDER.indexOf(stage) : -1;
  const canDismiss = status !== "running" && Boolean(onDismiss);
  const stageLabel = stage ? t(STAGE_LABEL_KEYS[stage]) : t("aiRecognition.streamWaiting");
  // 运行中耗时对屏幕阅读器隐藏，避免每秒刷新打断用户；终态耗时再作为稳定文本暴露。
  const elapsedLabel = elapsedSeconds === null
    ? null
    : t(status === "running" ? "aiRecognition.elapsedRunning" : "aiRecognition.elapsedFinal", { seconds: elapsedSeconds });
  const statusIcon = status === "running"
    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
    : status === "complete"
      ? <CheckCircle2 className="h-3.5 w-3.5" />
      : <AlertTriangle className="h-3.5 w-3.5" />;

  return (
    <aside
      data-testid="ai-recognition-stream-panel"
      className={cn(
        "max-h-full w-full min-w-0 max-w-md overflow-y-auto rounded-lg border border-border bg-card/95 p-3 shadow-lg shadow-black/10",
        mobile ? "space-y-2" : "space-y-3",
      )}
      role="status"
      aria-live="polite"
      aria-label={t("aiRecognition.streamTitle")}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/40 text-muted-foreground">
            <Activity className="h-4 w-4" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h3 className="truncate text-sm font-semibold text-foreground">{t("aiRecognition.streamTitle")}</h3>
            <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
              <span>{stageLabel}</span>
              {elapsedLabel ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span aria-hidden={status === "running" ? "true" : undefined} className="tabular-nums">{elapsedLabel}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <span className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium",
          status === "complete"
            ? "border-primary/30 bg-primary/10 text-primary"
            : status === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-border bg-secondary/40 text-muted-foreground",
        )}>
          {statusIcon}
          {t(STATUS_LABEL_KEYS[status])}
        </span>
      </div>

      <ol className="grid grid-cols-6 gap-1" aria-hidden="true">
        {STAGE_ORDER.map((item, index) => {
          const active = item === stage;
          const done = status === "complete" || (activeIndex >= 0 && index < activeIndex);
          return (
            <li
              key={item}
              className={cn(
                "h-1.5 min-w-0 rounded-full transition-colors",
                active ? "bg-primary" : done ? "bg-primary/60" : "bg-border",
              )}
            />
          );
        })}
      </ol>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <StreamMetric label={t("aiRecognition.streamDraftsSeen")} value={String(subscriptionsSeen)} />
        <StreamMetric label={t("aiRecognition.streamWarningsSeen")} value={String(warningsSeen)} />
      </dl>

      {hasErrorDetails ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 justify-start border-destructive/30 bg-destructive/10 px-2 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
          disabled={actionsDisabled}
          onClick={onOpenErrorDetails}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {t("aiRecognition.errorDetailsOpen")}
        </Button>
      ) : null}

      {textPreview ? (
        <section className="rounded-md bg-secondary/30 px-2 py-1.5">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <MessageSquareText className="h-3.5 w-3.5" />
            {t("aiRecognition.streamTextPreview")}
          </div>
          <p className="line-clamp-3 whitespace-pre-wrap wrap-break-word text-xs leading-5 text-foreground">
            {textPreview}
          </p>
        </section>
      ) : null}

      {canDismiss ? (
        <div className="flex border-t border-border pt-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 border-border"
            disabled={actionsDisabled}
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
            {t("common.close")}
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

function StreamMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-secondary/30 px-2 py-1.5">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
