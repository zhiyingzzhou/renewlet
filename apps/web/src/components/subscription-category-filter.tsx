import { lazy, Suspense, useEffect, useState } from "react";
import { Filter, Search } from "lucide-react";

import { SubscriptionFilterPopoverFrame } from "@/components/subscription-filter-popover-frame";
import { subscriptionFilterLayout } from "@/components/subscription-filter-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MobileBottomDrawerContent, MobileDrawerRoot, MobileDrawerTrigger } from "@/components/ui/mobile-drawer";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/I18nProvider";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { cn } from "@/lib/utils";
import type { ConfigItem } from "@/types/config";
import type { Category } from "@/types/subscription";

const SubscriptionCategoryChoices = lazy(() => import("@/components/subscription-category-choices"));

interface SubscriptionCategoryFilterProps {
  categories: ConfigItem[];
  categoryCounts: Readonly<Record<string, number>> | undefined;
  selectedCategories: Category[];
  onToggleCategory: (category: Category) => void;
  onClearCategories: () => void;
  onApply: (categories: Category[]) => void;
  mode: "popover" | "drawer";
  className?: string;
}

function toggleCategoryValue(categories: Category[], category: Category) {
  return categories.includes(category)
    ? categories.filter((item) => item !== category)
    : [...categories, category];
}

export function SubscriptionCategoryFilter({
  categories,
  categoryCounts,
  selectedCategories,
  onToggleCategory,
  onClearCategories,
  onApply,
  mode,
  className,
}: SubscriptionCategoryFilterProps) {
  const { t, label } = useI18n();
  const [open, setOpen] = useState(false);
  const [draftCategories, setDraftCategories] = useState<Category[]>(selectedCategories);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      return;
    }

    if (mode === "drawer") {
      // 移动端抽屉先编辑草稿，点击“应用”后再提交，防止用户滑动筛选时列表在背后频繁重排。
      setDraftCategories(selectedCategories);
      setSearchQuery("");
    }
  }, [mode, open, selectedCategories]);

  const singleCategory = selectedCategories.length === 1 ? selectedCategories[0] : undefined;
  const selectedConfig = singleCategory ? categories.find((category) => category.value === singleCategory) : undefined;
  const triggerLabel = singleCategory
    ? (selectedConfig ? label(selectedConfig.labels) : singleCategory)
    : selectedCategories.length ? t("subscriptions.category.selectedCount", { count: selectedCategories.length }) : t("subscriptions.category.open");
  const canClearCategories = selectedCategories.length > 0 || draftCategories.length > 0;

  const searchInput = (
    <>
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder={t("subscriptions.category.searchPlaceholder")}
        className={cn("border-border bg-secondary pl-10", mode === "drawer" ? "h-11" : "h-10")}
      />
    </>
  );
  const optionGrid = (
    <Suspense fallback={<DialogModulePending label={t("common.loading")} />}>
      <SubscriptionCategoryChoices
        categories={categories}
        categoryCounts={categoryCounts}
        selectedCategories={selectedCategories}
        activeCategories={mode === "drawer" ? draftCategories : selectedCategories}
        searchQuery={searchQuery}
        mode={mode}
        onToggleCategory={mode === "drawer" ? (value) => setDraftCategories((current) => toggleCategoryValue(current, value)) : onToggleCategory}
      />
    </Suspense>
  );

  if (mode === "drawer") {
    return (
      <MobileDrawerRoot open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
        <div className={cn("min-w-0", className)} data-testid="mobile-category-filter">
          <MobileDrawerTrigger asChild>
            <Button variant="outline" className="h-11 w-full min-w-0 justify-start border-border bg-secondary px-3">
              <Filter className="h-4 w-4" />
              <span className="truncate">{triggerLabel}</span>
            </Button>
          </MobileDrawerTrigger>
        </div>

        {open && (
          <MobileBottomDrawerContent
            title={t("subscriptions.category.drawerTitle")}
            description={t("subscriptions.category.drawerTitle")}
            descriptionMode="sr-only"
            closeLabel={t("common.close")}
            bodyClassName={null}
          >
            <div className="px-5 pb-3">
              <div className="relative">{searchInput}</div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              {optionGrid}
            </div>

            <div className="flex gap-3 border-t border-border bg-card px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {canClearCategories && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 shrink-0 text-muted-foreground"
                  onClick={() => {
                    onApply([]);
                    setOpen(false);
                  }}
                >
                  {t("subscriptions.category.clearSelection")}
                </Button>
              )}
              <Button
                type="button"
                className="h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary-glow"
                onClick={() => {
                  onApply(draftCategories);
                  setOpen(false);
                }}
              >
                {t("subscriptions.category.apply")}
              </Button>
            </div>
          </MobileBottomDrawerContent>
        )}
      </MobileDrawerRoot>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("shrink-0", className)} data-testid="desktop-category-filter">
        <PopoverTrigger asChild>
          <Button variant="outline" className={subscriptionFilterLayout.desktopCategoryTrigger}>
            <Filter className="h-4 w-4" />
            <span className="truncate">{triggerLabel}</span>
          </Button>
        </PopoverTrigger>
      </div>

      {/* 桌面分类选择即时生效；H5 Drawer 保留草稿确认，避免小屏滑动筛选时背后列表频繁重排。 */}
      <SubscriptionFilterPopoverFrame
        title={t("subscriptions.category.drawerTitle")}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        contentTestId="desktop-category-filter-popover"
        scrollTestId="desktop-category-filter-scroll"
        footerTestId="desktop-category-filter-footer"
        searchInput={searchInput}
        footer={
          selectedCategories.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              className="h-9 text-muted-foreground"
              onClick={onClearCategories}
            >
              {t("subscriptions.category.clearSelection")}
            </Button>
          ) : undefined
        }
      >
        {optionGrid}
      </SubscriptionFilterPopoverFrame>
    </Popover>
  );
}
