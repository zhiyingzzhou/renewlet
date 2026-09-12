import { useRef } from "react";
import { Image as ImageIcon, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MediaCandidateGrid } from "@/components/media-candidate-grid";
import { MediaCandidateViewport } from "@/components/media-candidate-viewport";
import type { MediaCandidate } from "@/lib/api/schemas/media";
import type { UseMediaCandidatesResult } from "@/hooks/use-media-candidates";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nProvider";

/** MediaCandidateSearchPanelProps 描述 Logo/Icon 候选搜索面板与上层弹层之间的状态边界。 */
interface MediaCandidateSearchPanelProps {
  /** `useMediaCandidates` 的完整状态机；面板只负责渲染和转发事件，不直接请求后端。 */
  search: UseMediaCandidatesResult;
  /** 可选标题；嵌入已有标题区域的弹层会省略它。 */
  title?: string | undefined;
  /** 搜索框占位文案，由调用方用当前 i18n 域提供。 */
  placeholder: string;
  /** 尚未搜索时的引导文案。 */
  prompt: string;
  /** 无候选且服务层没有错误时展示的空状态文案。 */
  notFoundLabel: string;
  /** 可选空状态补充说明，通常用于告诉用户还可以手填 URL 或上传。 */
  notFoundHint?: string | undefined;
  /** 当前已选 URL；用于在跨 provider 候选中保持选中态。 */
  selectedValue?: string | null | undefined;
  /** 选择候选后由调用方决定写入表单、关闭弹层或切换 tab。 */
  onSelect: (candidate: MediaCandidate) => void;
  /** 嵌入可关闭容器时显示关闭按钮；普通面板模式不需要。 */
  onClose?: (() => void) | undefined;
  /** 控制缩略图和加载态密度，H5 sheet 通常使用 `sm`。 */
  size?: "sm" | "md" | undefined;
  columnsClassName?: string | undefined;
  panelClassName?: string | undefined;
  inputRowClassName?: string | undefined;
  inputClassName?: string | undefined;
  searchButtonClassName?: string | undefined;
  resultsClassName?: string | undefined;
  resultsContentClassName?: string | undefined;
  dataTestId?: string | undefined;
  showEmptyIcon?: boolean | undefined;
  autoFocus?: boolean | undefined;
}

export function MediaCandidateSearchPanel({
  search,
  title,
  placeholder,
  prompt,
  notFoundLabel,
  notFoundHint,
  selectedValue,
  onSelect,
  onClose,
  size = "md",
  columnsClassName = "grid-cols-4",
  panelClassName,
  inputRowClassName,
  inputClassName,
  searchButtonClassName,
  resultsClassName,
  resultsContentClassName,
  dataTestId,
  showEmptyIcon = false,
  autoFocus = true,
}: MediaCandidateSearchPanelProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const runSearch = () => {
    // 禁用当前按钮会让浏览器把焦点移出 Popover；先把焦点交给仍可交互的输入框，避免 DismissableLayer 误判为外部焦点。
    inputRef.current?.focus();
    search.search();
  };
  const hasResults = search.candidates.builtIn.length > 0 || search.candidates.appStore.length > 0 || search.candidates.favicon.length > 0;
  // 搜索中保留已返回候选，能让 provider 图标先可选，同时继续展示“加载更多”而不是闪回空态。
  const shouldShowResultsArea = hasResults || (!search.isSearching && search.hasSearched);

  return (
    <div className={cn("media-candidate-search-panel gap-3", panelClassName)}>
      {title || onClose ? (
        <div className="flex items-center justify-between">
          {title ? <span className="text-sm font-medium">{title}</span> : <span />}
          {onClose ? (
            <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={cn("flex items-center gap-2", inputRowClassName)}>
        <Input
          ref={inputRef}
          placeholder={placeholder}
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && runSearch()}
          className={cn("flex-1 border-border bg-secondary", inputClassName)}
          autoFocus={autoFocus}
        />
        <Button
          type="button"
          size="sm"
          onClick={runSearch}
          disabled={search.isSearching || !search.query.trim()}
          className={searchButtonClassName}
          aria-label={t("media.search")}
        >
          {search.isSearching ? (
            <Loader2 className={size === "sm" ? "h-3.5 w-3.5 animate-spin" : "h-4 w-4 animate-spin"} />
          ) : (
            <Search className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
          )}
        </Button>
      </div>

      <MediaCandidateViewport
        className={cn("media-candidate-search-results", resultsClassName)}
        contentClassName={resultsContentClassName}
        dataTestId={dataTestId}
      >
        {search.isSearching && !hasResults ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className={size === "sm" ? "h-5 w-5 animate-spin text-primary" : "h-6 w-6 animate-spin text-primary"} />
            {size === "md" ? <span className="ml-2 text-sm text-muted-foreground">{t("media.searching")}</span> : null}
          </div>
        ) : null}

        {shouldShowResultsArea ? (
          <>
            <MediaCandidateGrid
              candidates={search.candidates}
              selectedValue={selectedValue}
              size={size}
              columnsClassName={columnsClassName}
              onSelect={onSelect}
              // 图片加载失败要反馈给 hook 的本轮屏蔽集合，避免失败 favicon 在同一次搜索里反复复活。
              onError={(candidate) => search.removeCandidate(candidate.url)}
            />

            {search.isSearching && hasResults ? (
              <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin text-primary" />
                {t("media.loadingMore")}
              </div>
            ) : null}

            {!search.isSearching && search.hasSearched && !hasResults ? (
              <div className="py-2 text-center">
                {showEmptyIcon ? <ImageIcon className="mx-auto mb-2 h-10 w-10 text-muted-foreground/50" /> : null}
                <p className={cn(size === "sm" ? "text-xs" : "text-sm", "text-muted-foreground")}>{search.error ?? notFoundLabel}</p>
                {notFoundHint ? <p className="mt-1 text-xs text-muted-foreground">{notFoundHint}</p> : null}
              </div>
            ) : null}
          </>
        ) : null}

        {!search.isSearching && !search.hasSearched ? (
          <p className="media-candidate-message py-2 text-center text-xs text-muted-foreground">{prompt}</p>
        ) : null}
      </MediaCandidateViewport>
    </div>
  );
}
