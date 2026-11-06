import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { AlertTriangle, CalendarDays, CircleDollarSign, Filter, Search } from "lucide-react";
import { AIDraftEditorPanel } from "@/components/ai-recognition/ai-draft-editor-panel";
import {
  BILLING_CYCLE_LABEL_KEYS,
  buildDraftSearchText,
  formatDraftPrice,
} from "@/components/ai-recognition/ai-draft-display";
import type { AIDraftFilter, AIDraftListItem } from "@/components/ai-recognition/ai-recognition-dialog-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import type { AIDraftBlockingIssue } from "@/modules/ai-recognition/domain/ai-draft-preflight";
import { canConfirmAIDraftDefaultValue, isAIDraftConfigValueKnown, type AIDraftConfirmationField } from "@/modules/ai-recognition/domain/ai-recognition-form";
import { cn } from "@/lib/utils";
import type { CustomConfig } from "@/types/config";
import type { AppSettings } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";

const DRAFT_FILTERS = ["all", "warning", "low-confidence", "missing-core"] as const satisfies readonly AIDraftFilter[];

const DRAFT_FILTER_LABEL_KEYS: Record<AIDraftFilter, MessageKey> = {
  all: "aiRecognition.draftFilterAll",
  warning: "aiRecognition.draftFilterWarning",
  "low-confidence": "aiRecognition.draftFilterLowConfidence",
  "missing-core": "aiRecognition.draftFilterMissingCore",
};

interface AIDraftReviewPanelProps {
  drafts: AIDraftListItem[];
  config: CustomConfig;
  settings: AppSettings;
  availableTags?: readonly string[];
  draftBlockingIssuesById: ReadonlyMap<string, readonly AIDraftBlockingIssue[]>;
  generationElapsedSeconds: number | null;
  selectedDraftId: string | null;
  onSelectedDraftIdChange: (id: string | null) => void;
  onChangeDraftForm: (id: string, action: SetStateAction<SubscriptionFormState>) => void;
  onConfirmAllDefaults: () => void;
  onConfirmDraftField: (id: string, field: AIDraftConfirmationField, value?: unknown) => void;
  onNestedDialogOpenChange?: ((open: boolean) => void) | undefined;
  onRemoveDraft: (id: string) => void;
}

export function AIDraftReviewPanel({
  drafts,
  config,
  settings,
  availableTags = [],
  draftBlockingIssuesById,
  generationElapsedSeconds,
  selectedDraftId,
  onSelectedDraftIdChange,
  onChangeDraftForm,
  onConfirmAllDefaults,
  onConfirmDraftField,
  onNestedDialogOpenChange,
  onRemoveDraft,
}: AIDraftReviewPanelProps) {
  const { t, locale } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AIDraftFilter>("all");
  const normalizedQuery = query.trim().toLowerCase();
  const blockingDraftCount = useMemo(
    () => drafts.filter((item) => (draftBlockingIssuesById.get(item.id)?.length ?? 0) > 0).length,
    [draftBlockingIssuesById, drafts],
  );
  const blockingIssueCount = useMemo(
    () => drafts.reduce((count, item) => count + (draftBlockingIssuesById.get(item.id)?.length ?? 0), 0),
    [draftBlockingIssuesById, drafts],
  );
  const confirmableDefaultCount = useMemo(
    () => drafts.reduce((count, item) => count + item.pendingConfirmationFields.filter((field) => canConfirmAIDraftDefaultValue(item.sourceDraft, item.formData, field, config)).length, 0),
    [config, drafts],
  );
  const filteredDrafts = useMemo(() => drafts.filter((item) => {
    if (filter === "warning" && item.sourceDraft.confidence !== "low" && (draftBlockingIssuesById.get(item.id)?.length ?? 0) === 0) return false;
    if (filter === "low-confidence" && item.sourceDraft.confidence !== "low") return false;
    if (filter === "missing-core" && (draftBlockingIssuesById.get(item.id)?.length ?? 0) === 0) return false;
    if (!normalizedQuery) return true;
    return buildDraftSearchText(item.formData).includes(normalizedQuery);
  }), [draftBlockingIssuesById, drafts, filter, normalizedQuery]);
  const selectedDraft = useMemo(
    () => drafts.find((item) => item.id === selectedDraftId) ?? null,
    [drafts, selectedDraftId],
  );
  const selectedDraftNumber = selectedDraft ? drafts.findIndex((item) => item.id === selectedDraft.id) + 1 : 0;
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const draftNumberById = useMemo(
    () => new Map(drafts.map((item, index) => [item.id, index + 1])),
    [drafts],
  );
  const getDraftKey = useCallback(
    (index: number) => filteredDrafts[index]?.id ?? index,
    [filteredDrafts],
  );
  const renderDraft = useCallback((index: number) => {
    const item = filteredDrafts[index];
    if (!item) return null;
    return (
      <DraftRow
        item={item}
        selected={item.id === selectedDraftId}
        draftNumber={draftNumberById.get(item.id) ?? 0}
        blockingIssueCount={draftBlockingIssuesById.get(item.id)?.length ?? 0}
        priceText={formatDraftPrice(item.formData, locale, t("aiRecognition.draftUnknownValue"))}
        cycleText={t(BILLING_CYCLE_LABEL_KEYS[item.formData.billingCycle])}
        onSelect={() => onSelectedDraftIdChange(item.id)}
      />
    );
  }, [draftBlockingIssuesById, draftNumberById, filteredDrafts, locale, onSelectedDraftIdChange, selectedDraftId, t]);

  useEffect(() => {
    // 筛选条件变化后要把选中项钉回可见集合，否则右侧编辑器会指向已被隐藏的草稿。
    if (filteredDrafts.length === 0) {
      if (selectedDraftId) onSelectedDraftIdChange(null);
      return;
    }
    if (!selectedDraftId || !filteredDrafts.some((item) => item.id === selectedDraftId)) {
      onSelectedDraftIdChange(filteredDrafts[0]?.id ?? null);
    }
  }, [filteredDrafts, onSelectedDraftIdChange, selectedDraftId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={t("aiRecognition.draftsTitle")}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex min-w-0 flex-col gap-3 border-b border-border bg-secondary/20 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{t("aiRecognition.draftsTitle")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {generationElapsedSeconds === null
                ? t("aiRecognition.draftsCount", { count: drafts.length })
                : t("aiRecognition.draftsCountWithElapsed", { count: drafts.length, seconds: generationElapsedSeconds })}
            </p>
          </div>
          {confirmableDefaultCount > 0 ? (
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onConfirmAllDefaults}>
              {t("aiRecognition.confirmDefaults")}
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:max-w-3xl sm:flex-row sm:items-center sm:justify-end">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-md border border-border bg-background p-0.5 text-xs">
              <Filter className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {DRAFT_FILTERS.map((nextFilter) => (
                <button
                  key={nextFilter}
                  type="button"
                  className={cn(
                    "whitespace-nowrap rounded-[5px] px-2.5 py-1.5 font-medium transition-colors",
                    filter === nextFilter ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
                  )}
                  onClick={() => setFilter(nextFilter)}
                >
                  {t(DRAFT_FILTER_LABEL_KEYS[nextFilter])}
                </button>
              ))}
            </div>
            <div className="relative sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("aiRecognition.draftSearchPlaceholder")}
                className="h-9 border-border bg-background pl-8 text-sm"
              />
            </div>
          </div>
        </div>

        {blockingIssueCount > 0 ? (
          <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("aiRecognition.draftBlockingSummary", { count: blockingDraftCount, issues: blockingIssueCount })}</span>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(18rem,0.4fr)_minmax(0,0.6fr)] lg:overflow-hidden">
          <div
            ref={scrollRef}
            data-testid="ai-draft-list-scrollport"
            className="h-64 min-h-0 overflow-y-auto border-b border-border bg-background lg:h-full lg:border-b-0 lg:border-r"
          >
            {filteredDrafts.length > 0 ? (
              <VirtualizedList
                count={filteredDrafts.length}
                estimatedItemSize={96}
                getItemKey={getDraftKey}
                getScrollElement={getScrollElement}
                overscan={8}
                gap={0}
                testId="ai-draft-virtualized-list"
                renderItem={renderDraft}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {t("aiRecognition.draftNoMatches")}
              </div>
            )}
          </div>

          <div data-testid="ai-draft-editor-scrollport" className="min-w-0 bg-background lg:min-h-0 lg:overflow-y-auto">
            {selectedDraft ? (
              <AIDraftEditorPanel
                draftId={selectedDraft.id}
                sourceDraft={selectedDraft.sourceDraft}
                formData={selectedDraft.formData}
                draftNumber={selectedDraftNumber}
                config={config}
                settings={settings}
                availableTags={availableTags}
                blockingIssues={draftBlockingIssuesById.get(selectedDraft.id) ?? []}
                setFormData={(action) => onChangeDraftForm(selectedDraft.id, action)}
                onFieldChange={(field, value) => {
                  // 只有编辑出可用值才消费显式确认；清空金额/货币或保留未知配置仍必须继续阻塞。
                  if (isAIDraftFieldValueConfirmed(field, value, config)) {
                    onConfirmDraftField(selectedDraft.id, field, value);
                  }
                }}
                onConfirmField={(field) => onConfirmDraftField(selectedDraft.id, field)}
                onNestedDialogOpenChange={onNestedDialogOpenChange}
                onRemove={() => onRemoveDraft(selectedDraft.id)}
              />
            ) : (
              <div className="flex min-h-72 items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {t("aiRecognition.noSelectedDraft")}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function isAIDraftFieldValueConfirmed(field: keyof SubscriptionFormState, value: unknown, config: CustomConfig): field is AIDraftConfirmationField {
  if (field === "price" || field === "currency" || field === "billingCycle" || field === "status") {
    return typeof value === "string" && value.trim().length > 0;
  }
  if (field === "category") {
    return typeof value === "string" && value.trim().length > 0 && isAIDraftConfigValueKnown(value, config.categories);
  }
  if (field === "paymentMethod") {
    return typeof value === "string" && value.trim().length > 0 && isAIDraftConfigValueKnown(value, config.paymentMethods);
  }
  return false;
}

function DraftRow({
  item,
  selected,
  draftNumber,
  blockingIssueCount,
  priceText,
  cycleText,
  onSelect,
}: {
  item: AIDraftListItem;
  selected: boolean;
  draftNumber: number;
  blockingIssueCount: number;
  priceText: string;
  cycleText: string;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const { formData, sourceDraft } = item;
  // 原始 warning 保留在 diagnostics；列表只标记用户必须处理的缺失字段和低置信度，
  // 避免把“AI 无法确认某个非必填事实”渲染成一串重复提示。
  const warningCount = (sourceDraft.confidence === "low" ? 1 : 0) + blockingIssueCount;
  const metadata = [
    formData.website,
    ...formData.tags.slice(0, 3),
    sourceDraft.confidence === "low" ? t("aiRecognition.confidenceLowShort") : null,
    blockingIssueCount > 0 ? t("aiRecognition.missingCoreShort") : null,
  ].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className={cn(
        "grid w-full gap-2 border-b border-l-2 border-b-border px-3 py-2.5 text-left transition-colors last:border-b-0",
        selected ? "border-l-primary bg-secondary/60" : "border-l-transparent hover:bg-secondary/40",
      )}
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{draftNumber}</span>
            <span className="truncate text-sm font-medium text-foreground">{formData.name}</span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><CircleDollarSign className="h-3.5 w-3.5" />{priceText}</span>
            <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{cycleText}</span>
            <span className="truncate">{formData.nextBillingDate ?? t("aiRecognition.draftUnknownValue")}</span>
          </div>
        </div>
        {warningCount > 0 ? (
          <Badge variant="outline" className="shrink-0 gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            {warningCount}
          </Badge>
        ) : null}
      </div>
      {metadata ? <p className="truncate text-xs text-muted-foreground">{metadata}</p> : null}
    </button>
  );
}
