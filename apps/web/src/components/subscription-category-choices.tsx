import { useMemo, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";
import { colorWithAlpha } from "@/lib/color";
import { cn } from "@/lib/utils";
import type { ConfigItem } from "@/types/config";
import type { Category } from "@/types/subscription";

interface CategoryChoicesProps {
  categories: ConfigItem[];
  categoryCounts: Readonly<Record<string, number>> | undefined;
  selectedCategories: Category[];
  activeCategories: Category[];
  searchQuery: string;
  mode: "popover" | "drawer";
  onToggleCategory: (value: Category) => void;
}

interface CategoryFilterOption {
  value: Category;
  label: string;
  color?: string | undefined;
  count?: number | undefined;
}

interface CategoryCheckboxChipProps {
  option: CategoryFilterOption;
  selected: boolean;
  onToggle: () => void;
  className?: string;
}

function selectedCategoryStyle(color?: string): CSSProperties | undefined {
  if (!color) return undefined;
  // 分类色来自用户配置，只参与轻量强调；透明度固定，避免自定义高饱和色压过状态语义色。
  return {
    backgroundColor: colorWithAlpha(color, 0.12) ?? undefined,
    borderColor: colorWithAlpha(color, 0.35) ?? undefined,
    color,
  };
}

function CategoryCheckboxChip({ option, selected, onToggle, className }: CategoryCheckboxChipProps) {
  const { t } = useI18n();
  const selectedStyle = selected ? selectedCategoryStyle(option.color) : undefined;

  return (
    <label
      className={cn(
        "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm font-semibold transition-colors",
        "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-foreground hover:border-primary/50 hover:bg-secondary/70",
        className,
      )}
      style={selectedStyle}
    >
      <input
        type="checkbox"
        checked={selected}
        aria-label={option.label}
        aria-description={option.count === undefined ? undefined : t("subscriptions.count", { count: option.count })}
        onChange={onToggle}
        className="sr-only"
      />
      <span className="max-w-40 truncate">{option.label}</span>
      {option.count !== undefined && <span aria-hidden="true" className="text-xs font-normal tabular-nums">{option.count}</span>}
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
    </label>
  );
}

export default function SubscriptionCategoryChoices({
  categories, categoryCounts, selectedCategories, activeCategories, searchQuery, mode, onToggleCategory,
}: CategoryChoicesProps) {
  const { t, label } = useI18n();
  const options = useMemo<CategoryFilterOption[]>(() => {
    const counts = new Map(Object.entries(categoryCounts ?? {}));
    const configured = new Map(categories.map((category) => [category.value, category]));
    const selected = new Set([...selectedCategories, ...activeCategories]);
    const historical = [...new Set([...counts.keys(), ...selected])].filter((value) => !configured.has(value));
    // facets 统计全账号；分页或当前筛选结果会漏掉仍可并选的分类。已选分类归零后须保留取消入口。
    const available: CategoryFilterOption[] = [];
    for (const value of [...configured.keys(), ...historical.sort()]) {
      const count = categoryCounts === undefined ? undefined : counts.get(value) ?? 0;
      if (count === 0 && !selected.has(value)) continue;
      const category = configured.get(value);
      available.push({ value, label: category ? label(category.labels) : value, color: category?.color, count });
    }
    return available;
  }, [categories, categoryCounts, selectedCategories, activeCategories, label]);
  const visibleOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) => option.label.toLowerCase().includes(query));
  }, [options, searchQuery]);
  return visibleOptions.length === 0 ? (
    <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-secondary/40 px-4 text-center text-sm text-muted-foreground">
      {t("subscriptions.category.emptyMatch")}
    </div>
  ) : (
    <div>
      {categoryCounts !== undefined && <p className="mb-2 text-xs text-muted-foreground">{t("subscriptions.category.countScope")}</p>}
      <div aria-label={t("subscriptions.category.drawerTitle")} className="flex flex-wrap gap-2">
        {visibleOptions.map((option) => (
          <CategoryCheckboxChip
            key={option.value}
            option={option}
            selected={activeCategories.includes(option.value)}
            onToggle={() => onToggleCategory(option.value)}
            {...(mode === "drawer" ? { className: "min-h-11" } : {})}
          />
        ))}
      </div>
    </div>
  );
}
