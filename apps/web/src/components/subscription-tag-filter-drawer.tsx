import { useEffect, useMemo, useState } from "react";
import { Filter, Search } from "lucide-react";

import { SubscriptionFilterPopoverFrame } from "@/components/subscription-filter-popover-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MobileBottomDrawerContent, MobileDrawerRoot, MobileDrawerTrigger } from "@/components/ui/mobile-drawer";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface TagFilterChipProps {
  /** 用户自定义标签原文，不能走产品内置 Lingui label 映射。 */
  tag: string;
  selected: boolean;
  onToggle: () => void;
  className?: string;
}

interface SubscriptionTagFilterDrawerProps {
  tags: readonly string[];
  selectedTags: readonly string[];
  onApply: (tags: string[]) => void;
  className?: string;
}

interface SubscriptionTagFilterPopoverProps {
  tags: readonly string[];
  selectedTags: readonly string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  className?: string;
}

function toggleTag(tags: readonly string[], tag: string) {
  return tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag];
}

/** TagFilterChip 统一两种筛选浮层的 aria-pressed 语义，避免桌面/移动端选择状态读屏口径分叉。 */
export function TagFilterChip({ tag, selected, onToggle, className }: TagFilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex min-h-8 items-center rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-foreground hover:border-primary/50 hover:bg-secondary/70",
        className,
      )}
      onClick={onToggle}
    >
      <span className="max-w-40 truncate">{tag}</span>
    </button>
  );
}

export function SubscriptionTagFilterPopover({
  tags,
  selectedTags,
  onToggleTag,
  onClearTags,
  className,
}: SubscriptionTagFilterPopoverProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    // 桌面 Popover 的选择即时生效；关闭后清空搜索框，避免下次打开误以为标签被删光。
    if (!open) {
      setSearchQuery("");
    }
  }, [open]);

  const visibleTags = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return tags;
    return tags.filter((tag) => tag.toLowerCase().includes(query));
  }, [searchQuery, tags]);
  const triggerLabel =
    selectedTags.length > 0
      ? t("subscriptions.tags.selectedCount", { count: selectedTags.length })
      : t("subscriptions.tags.open");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("shrink-0", className)} data-testid="desktop-tag-filter">
        <PopoverTrigger asChild>
          <Button variant="outline" className="h-10 shrink-0 border-border bg-secondary px-3">
            <Filter className="h-4 w-4" />
            <span>{triggerLabel}</span>
          </Button>
        </PopoverTrigger>
      </div>

      {/* 桌面标签筛选和分类共用同一条高度链；H5 Drawer 继续独立处理批量选择后的确认提交。 */}
      <SubscriptionFilterPopoverFrame
        title={t("subscriptions.tags.drawerTitle")}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        contentTestId="desktop-tag-filter-popover"
        scrollTestId="desktop-tag-filter-scroll"
        footerTestId="desktop-tag-filter-footer"
        searchInput={(
          <>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("subscriptions.tags.searchPlaceholder")}
              className="h-10 border-border bg-secondary pl-10"
            />
          </>
        )}
        footer={
          selectedTags.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              className="h-9 text-muted-foreground"
              onClick={onClearTags}
            >
              {t("subscriptions.tags.clearSelection")}
            </Button>
          ) : undefined
        }
      >
        {visibleTags.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {visibleTags.map((tag) => (
              <TagFilterChip
                key={tag}
                tag={tag}
                selected={selectedTags.includes(tag)}
                onToggle={() => onToggleTag(tag)}
                className="min-h-9 px-3 text-sm"
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-secondary/40 px-4 text-center text-sm text-muted-foreground">
            {t("subscriptions.tags.emptyMatch")}
          </div>
        )}
      </SubscriptionFilterPopoverFrame>
    </Popover>
  );
}

export function SubscriptionTagFilterDrawer({
  tags,
  selectedTags,
  onApply,
  className,
}: SubscriptionTagFilterDrawerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draftTags, setDraftTags] = useState<string[]>(() => [...selectedTags]);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    // 移动端抽屉使用草稿选择，用户点“应用”前不影响列表，方便在小屏上批量勾选/取消。
    setDraftTags([...selectedTags]);
    setSearchQuery("");
  }, [open, selectedTags]);

  const visibleTags = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return tags;
    return tags.filter((tag) => tag.toLowerCase().includes(query));
  }, [searchQuery, tags]);
  const canClearTags = selectedTags.length > 0 || draftTags.length > 0;
  const triggerLabel =
    selectedTags.length > 0
      ? t("subscriptions.tags.selectedCount", { count: selectedTags.length })
      : t("subscriptions.tags.open");

  return (
    <MobileDrawerRoot open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
      <div className={cn("shrink-0", className)} data-testid="mobile-tag-filter">
        <MobileDrawerTrigger asChild>
          <Button variant="outline" className="h-11 shrink-0 border-border bg-secondary px-3">
            <Filter className="h-4 w-4" />
            <span>{triggerLabel}</span>
          </Button>
        </MobileDrawerTrigger>
      </div>

      {open && (
        <MobileBottomDrawerContent
          title={t("subscriptions.tags.drawerTitle")}
          description={t("subscriptions.tags.drawerTitle")}
          descriptionMode="sr-only"
          closeLabel={t("common.close")}
          bodyClassName={null}
        >
          <div className="px-5 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("subscriptions.tags.searchPlaceholder")}
                className="h-11 border-border bg-secondary pl-10"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
            {visibleTags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {visibleTags.map((tag) => (
                  <TagFilterChip
                    key={tag}
                    tag={tag}
                    selected={draftTags.includes(tag)}
                    onToggle={() => setDraftTags((current) => toggleTag(current, tag))}
                    className="min-h-11 px-3 text-sm"
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-secondary/40 px-4 text-center text-sm text-muted-foreground">
                {t("subscriptions.tags.emptyMatch")}
              </div>
            )}
          </div>

          <div className="flex gap-3 border-t border-border bg-card px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {canClearTags && (
              <Button
                type="button"
                variant="ghost"
                className="h-11 shrink-0 text-muted-foreground"
                onClick={() => {
                  onApply([]);
                  setOpen(false);
                }}
              >
                {t("subscriptions.tags.clearSelection")}
              </Button>
            )}
            <Button
              type="button"
              className="h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary-glow"
              onClick={() => {
                onApply(draftTags);
                setOpen(false);
              }}
            >
              {t("subscriptions.tags.apply")}
            </Button>
          </div>
        </MobileBottomDrawerContent>
      )}
    </MobileDrawerRoot>
  );
}
