import { useMemo, useState } from "react";
import { Calendar as CalendarIcon, X } from "lucide-react";
import type { Matcher } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/I18nProvider";
import { dateOnlyToLocalDate, dateToDateOnly, type DateOnly } from "@/lib/time/date-only";
import { formatChineseLunarDateOnly } from "@/lib/time/chinese-lunar";
import { useLunarCalendar } from "@/contexts/CustomConfigContext";
import { cn } from "@/lib/utils";

type DateOnlyPickerFieldSize = "default" | "large";
type DateOnlyPickerFieldDisplayStyle = "short" | "monthDay" | "full";

interface DateOnlyPickerFieldProps {
  id: string;
  value: string | undefined;
  onChange: (value: DateOnly | undefined) => void;
  placeholder: string;
  labelId?: string | undefined;
  valueId?: string | undefined;
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  minDate?: string | undefined;
  maxDate?: string | undefined;
  defaultMonth?: string | undefined;
  clearable?: boolean | undefined;
  clearLabel?: string | undefined;
  displayStyle?: DateOnlyPickerFieldDisplayStyle | undefined;
  size?: DateOnlyPickerFieldSize | undefined;
  className?: string | undefined;
  buttonClassName?: string | undefined;
  testId?: string | undefined;
}

export function DateOnlyPickerField({
  id,
  value,
  onChange,
  placeholder,
  labelId,
  valueId,
  describedBy,
  invalid = false,
  disabled = false,
  minDate,
  maxDate,
  defaultMonth,
  clearable = false,
  clearLabel,
  displayStyle = "full",
  size = "default",
  className,
  buttonClassName,
  testId,
}: DateOnlyPickerFieldProps) {
  const { formatDateOnly, locale, t } = useI18n();
  const lunarCalendar = useLunarCalendar();
  const [open, setOpen] = useState(false);
  const selectedDate = value ? dateOnlyToLocalDate(value) : undefined;
  const fallbackMonth = value ?? defaultMonth ?? minDate ?? maxDate;
  const fallbackMonthDate = fallbackMonth ? dateOnlyToLocalDate(fallbackMonth) : undefined;
  const triggerLabelledBy = labelId && valueId ? `${labelId} ${valueId}` : undefined;
  const heightClassName = size === "large" ? "h-11" : "h-10";
  const clearSizeClassName = size === "large" ? "h-11 w-11" : "h-10 w-10";
  const lunarDate = value && lunarCalendar.enabled ? formatChineseLunarDateOnly(value, locale) : null;
  const formattedValue = value ? formatDateOnly(value, displayStyle) : null;
  const disabledMatchers = useMemo<Matcher[] | undefined>(() => {
    const matchers: Matcher[] = [];
    // DayPicker 的 before/after 是排他边界：min/max 当天仍可选，范围外才禁用。
    if (minDate) matchers.push({ before: dateOnlyToLocalDate(minDate) });
    if (maxDate) matchers.push({ after: dateOnlyToLocalDate(maxDate) });
    return matchers.length > 0 ? matchers : undefined;
  }, [maxDate, minDate]);

  const handleSelect = (date: Date | undefined) => {
    onChange(date ? dateToDateOnly(date) : undefined);
    setOpen(false);
  };

  return (
    <div className={cn("flex min-w-0 gap-2", className)} data-testid={testId}>
      <Popover open={disabled ? false : open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-labelledby={triggerLabelledBy}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            className={cn(
              "min-w-0 flex-1 justify-start border-border bg-secondary px-3 text-left font-normal",
              heightClassName,
              !value && "text-muted-foreground",
              invalid && "border-destructive focus-visible:ring-destructive/40",
              disabled && "opacity-60",
              buttonClassName,
            )}
          >
            <CalendarIcon className="h-4 w-4 shrink-0" />
            <span id={valueId} className="min-w-0 truncate">
              {formattedValue
                ? lunarDate
                  ? t("date.gregorianWithLunar", { gregorian: formattedValue, lunar: lunarDate })
                  : formattedValue
                : placeholder}
            </span>
          </Button>
        </PopoverTrigger>
        {/* 日期浮层跟随统一 portal 容器归属；不要在单个日期控件里硬编码 z-index 绕过 Drawer/Dialog。 */}
        <PopoverContent
          className="h5-calendar-popover w-auto border-border bg-card p-0"
          side="top"
          align="start"
          mobileDetent="large"
          mobileKind="calendar"
        >
          <Calendar
            mode="single"
            {...(selectedDate ? { selected: selectedDate } : {})}
            {...(fallbackMonthDate ? { defaultMonth: fallbackMonthDate } : {})}
            {...(disabledMatchers ? { disabled: disabledMatchers } : {})}
            onSelect={handleSelect}
            autoFocus
            className="pointer-events-auto p-3"
          />
        </PopoverContent>
      </Popover>
      {clearable && value ? (
        <Button
          type="button"
          variant="outline"
          className={cn("shrink-0 border-border bg-secondary p-0 text-muted-foreground", clearSizeClassName)}
          aria-label={clearLabel}
          disabled={disabled}
          onClick={() => {
            onChange(undefined);
            setOpen(false);
          }}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
