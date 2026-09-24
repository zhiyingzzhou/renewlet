/**
 * 日期选择原语。
 *
 * 架构位置：基于 react-day-picker 封装项目内的日期选择交互，订阅续费日期和筛选日期共用这里。
 *
 * 注意： Renewlet 的业务日期是 date-only；不要在此组件内引入用户时区换算。
 */
import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Day,
  DayButton,
  DayPicker,
  type CalendarDay as DayPickerCalendarDay,
  type CalendarMonth,
  type Modifiers,
} from "react-day-picker";
import { addMonths, subMonths, setMonth, setYear } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useI18n } from "@/i18n/I18nProvider";
import { useLunarCalendar } from "@/contexts/CustomConfigContext";
import { dateToDateOnly } from "@/lib/time/date-only";
import {
  formatChineseLunarDateOnly,
  formatChineseLunarDateOnlyCompact,
} from "@/lib/time/chinese-lunar";

export type CalendarProps = React.ComponentProps<typeof DayPicker> & {
  showLunarCalendar?: boolean;
};

type CalendarCaptionProps = {
  calendarMonth: CalendarMonth;
  displayIndex: number;
} & React.HTMLAttributes<HTMLDivElement>;

type CalendarDayButtonProps = {
  day: DayPickerCalendarDay;
  modifiers: Modifiers;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

type CalendarDayProps = {
  day: DayPickerCalendarDay;
  modifiers: Modifiers;
} & React.HTMLAttributes<HTMLDivElement>;

type CalendarNavContextValue = {
  displayMonth: Date;
  goToPreviousMonth: () => void;
  goToNextMonth: () => void;
  handleMonthChange: (month: Date) => void;

  yearPickerOpen: boolean;
  setYearPickerOpen: (open: boolean) => void;
  monthPickerOpen: boolean;
  setMonthPickerOpen: (open: boolean) => void;

  yearRangeStart: number;
  setYearRangeStart: React.Dispatch<React.SetStateAction<number>>;
};

const CalendarNavContext = React.createContext<CalendarNavContextValue | null>(null);
const CalendarLunarContext = React.createContext(false);

function useCalendarNav() {
  const ctx = React.useContext(CalendarNavContext);
  if (!ctx) throw new Error("CalendarNavContext is missing");
  return ctx;
}

// 保持组件 identity 稳定，避免 Popover 因标题组件重挂载而闪烁。
/**
 * 自定义月份标题（MonthCaption）：
 * - 用 Popover 实现「年/月」快速选择
 * - 左右按钮切换月份
 */
function CalendarCaption({
  calendarMonth: _calendarMonth,
  displayIndex: _displayIndex,
  className,
  ...divProps
}: CalendarCaptionProps) {
  const {
    displayMonth,
    goToPreviousMonth,
    goToNextMonth,
    handleMonthChange,
    yearPickerOpen,
    setYearPickerOpen,
    monthPickerOpen,
    setMonthPickerOpen,
    yearRangeStart,
    setYearRangeStart,
  } = useCalendarNav();
  const { t, formatDateTime } = useI18n();

  const currentYear = displayMonth.getFullYear();
  const currentMonthIndex = displayMonth.getMonth();
  const monthLabels = useMemo(
    () => Array.from({ length: 12 }, (_, index) => formatDateTime(new Date(2024, index, 1), { month: "short" })),
    [formatDateTime],
  );

  return (
    <div
      {...divProps}
      className={cn("flex justify-center items-center gap-1 pt-1 relative", className)}
    >
      {/* 上个月按钮 */}
      <button
        type="button"
        onClick={goToPreviousMonth}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute left-1",
        )}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {/* 年份选择器 */}
      <Popover open={yearPickerOpen} onOpenChange={setYearPickerOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-sm font-medium hover:bg-secondary"
          >
            {formatDateTime(displayMonth, { year: "numeric" })}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-65 p-3"
          align="center"
          mobileDetent="compact"
          mobileKind="panel"
          sideOffset={4}
          // 年/月面板内部点击不应触发自动聚焦关闭，否则键盘用户难以连续选择。
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between mb-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setYearRangeStart((prev) => prev - 12)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-primary hover:text-primary"
              onClick={() => {
                const today = new Date();
                handleMonthChange(today);
                setYearRangeStart(Math.floor(today.getFullYear() / 12) * 12);
                setYearPickerOpen(false);
              }}
            >
              {t("common.today")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setYearRangeStart((prev) => prev + 12)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 12 }, (_, i) => {
              const year = yearRangeStart + i;
              const isSelected = year === currentYear;
              const isCurrent = year === new Date().getFullYear();
              return (
                <button
                  key={year}
                  type="button"
                  onClick={() => {
                    handleMonthChange(setYear(displayMonth, year));
                    setYearPickerOpen(false);
                  }}
                  className={cn(
                    "h-8 rounded-md text-sm font-medium transition-all",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : isCurrent
                        ? "bg-accent text-accent-foreground hover:bg-accent/80"
                        : "hover:bg-secondary text-foreground",
                  )}
                >
                  {year}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* 月份选择器 */}
      <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-sm font-medium hover:bg-secondary"
          >
            {formatDateTime(displayMonth, { month: "long" })}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-55 p-3"
          align="center"
          mobileDetent="compact"
          mobileKind="panel"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-center mb-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-primary hover:text-primary"
              onClick={() => {
                handleMonthChange(new Date());
                setMonthPickerOpen(false);
              }}
            >
              {t("common.today")}
            </Button>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {monthLabels.map((month, index) => {
              const isSelected = index === currentMonthIndex;
              const isCurrent =
                index === new Date().getMonth() && currentYear === new Date().getFullYear();

              return (
                <button
                  key={month}
                  type="button"
                  onClick={() => {
                    handleMonthChange(setMonth(displayMonth, index));
                    setMonthPickerOpen(false);
                  }}
                  className={cn(
                    "h-8 rounded-md text-sm font-medium transition-all",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : isCurrent
                        ? "bg-accent text-accent-foreground hover:bg-accent/80"
                        : "hover:bg-secondary text-foreground",
                  )}
                >
                  {month}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* 下个月按钮 */}
      <button
        type="button"
        onClick={goToNextMonth}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute right-1",
        )}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * 自定义 DayButton：
 * - react-day-picker v9 默认不会把 selected/today 等样式 class 直接应用到 button 上
 * - 为了 1:1 复刻原项目（v8 + shadcn）按钮观感，这里根据 modifiers 在按钮上手动套用 Tailwind 样式
 */
function CalendarDayButton({ day, className, modifiers, children, ...props }: CalendarDayButtonProps) {
  const isSelected = modifiers["selected"] === true;
  const isRangeMiddle = modifiers["range_middle"] === true;
  const isToday = modifiers["today"] === true;
  const isOutside = modifiers["outside"] === true;
  const isDisabled = modifiers["disabled"] === true;
  const isOutsideSelected = isOutside && isSelected;
  const isPrimarySelected = isSelected && !isRangeMiddle && !isOutsideSelected;
  const showLunarCalendar = React.useContext(CalendarLunarContext);
  const { locale, t } = useI18n();
  const dateOnly = showLunarCalendar ? dateToDateOnly(day.date) : null;
  const lunarDate = dateOnly ? formatChineseLunarDateOnlyCompact(dateOnly, locale) : null;
  const lunarDescription = dateOnly ? formatChineseLunarDateOnly(dateOnly, locale) : null;

  return (
    <DayButton
      {...props}
      day={day}
      modifiers={modifiers}
      className={cn(
        buttonVariants({ variant: isPrimarySelected ? "default" : "ghost" }),
        "h5-calendar-day-button font-normal",
        lunarDate ? "h-10 w-10 px-0.5 py-0.5" : "h-9 w-9 p-0",
        isOutside && "text-muted-foreground opacity-50",
        isDisabled && "text-muted-foreground opacity-50",
        isToday && !isSelected && "bg-accent text-accent-foreground",
        isRangeMiddle && "bg-accent text-accent-foreground",
        isOutsideSelected &&
          "bg-accent/50 text-muted-foreground hover:bg-accent/50 hover:text-muted-foreground focus:bg-accent/50 focus:text-muted-foreground opacity-30",
        className,
      )}
      aria-description={lunarDescription ? t("date.chineseLunarDescription", { lunar: lunarDescription }) : undefined}
    >
      <span className="flex min-w-0 max-w-full flex-col items-center justify-center leading-none">
        <span className="text-base tabular-nums leading-5">{children}</span>
        {lunarDate ? (
          <span aria-hidden="true" className="max-w-full truncate whitespace-nowrap text-[10px] leading-3 tracking-tight text-current opacity-70">
            {lunarDate}
          </span>
        ) : null}
      </span>
    </DayButton>
  );
}

/**
 * 自定义 Day（td 单元格）：
 * - 负责 cell 的尺寸/居中
 * - 单日选中态交给 DayButton；cell 只保留范围选择背景和圆角
 */
function CalendarDay({ className, modifiers, ...props }: CalendarDayProps) {
  const isRangeStart = modifiers["range_start"] === true;
  const isRangeMiddle = modifiers["range_middle"] === true;
  const isRangeEnd = modifiers["range_end"] === true;
  const isRangeSelected = isRangeStart || isRangeMiddle || isRangeEnd;
  const isOutsideSelected = modifiers["outside"] === true && isRangeSelected;
  const showLunarCalendar = React.useContext(CalendarLunarContext);

  return (
    <Day
      {...props}
      modifiers={modifiers}
      className={cn(
        "text-center text-sm p-0 relative focus-within:relative focus-within:z-20",
        showLunarCalendar ? "h-10 w-10" : "h-9 w-9",
        "h5-calendar-day",
        isRangeSelected && "bg-accent",
        isOutsideSelected && "bg-accent/50",
        isRangeStart && "rounded-l-md",
        isRangeEnd && "rounded-r-md",
        className,
      )}
    />
  );
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  showLunarCalendar,
  month: controlledMonth,
  onMonthChange,
  locale: dayPickerLocale,
  ...props
}: CalendarProps) {
  const { locale } = useI18n();
  const lunarCalendar = useLunarCalendar();
  const lunarEnabled = showLunarCalendar ?? lunarCalendar.enabled;
  const [internalMonth, setInternalMonth] = useState(
    controlledMonth || props.defaultMonth || new Date(),
  );

  const [yearPickerOpen, setYearPickerOpen] = useState(false);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [yearRangeStart, setYearRangeStart] = useState(() =>
    Math.floor(new Date().getFullYear() / 12) * 12,
  );

  // 受控 month 变化时同步内部月份，避免外层“回到今天”后标题仍停留在旧月份。
  useEffect(() => {
    if (controlledMonth) setInternalMonth(controlledMonth);
  }, [controlledMonth]);

  const displayMonth = controlledMonth || internalMonth;

  const handleMonthChange = useCallback((newMonth: Date) => {
    setInternalMonth(newMonth);
    onMonthChange?.(newMonth);
  }, [onMonthChange]);

  const goToPreviousMonth = useCallback(() => {
    handleMonthChange(subMonths(displayMonth, 1));
  }, [displayMonth, handleMonthChange]);

  const goToNextMonth = useCallback(() => {
    handleMonthChange(addMonths(displayMonth, 1));
  }, [displayMonth, handleMonthChange]);

  const navCtx = useMemo<CalendarNavContextValue>(
    () => ({
      displayMonth,
      goToPreviousMonth,
      goToNextMonth,
      handleMonthChange,
      yearPickerOpen,
      setYearPickerOpen,
      monthPickerOpen,
      setMonthPickerOpen,
      yearRangeStart,
      setYearRangeStart,
    }),
    [
      displayMonth,
      goToPreviousMonth,
      goToNextMonth,
      handleMonthChange,
      yearPickerOpen,
      monthPickerOpen,
      yearRangeStart,
    ],
  );

  return (
    <CalendarNavContext.Provider value={navCtx}>
      <CalendarLunarContext.Provider value={lunarEnabled}>
        <DayPicker
          {...props}
          showOutsideDays={showOutsideDays}
          fixedWeeks
          hideNavigation
          locale={dayPickerLocale ?? (locale === "zh-CN" ? zhCN : enUS)}
          month={displayMonth}
          onMonthChange={handleMonthChange}
          className={cn("h5-calendar-root p-3", lunarEnabled && "h5-calendar-lunar", className)}
          classNames={{
            months: "h5-calendar-months flex flex-col gap-4 sm:flex-row",
            month: "h5-calendar-month grid gap-4",
            month_caption: "h5-calendar-month-caption flex justify-center pt-1 relative items-center",
            caption_label: "text-sm font-medium hidden",
            nav: "flex items-center gap-1",
            month_grid: "h5-calendar-month-grid w-full border-collapse",
            weekdays: "h5-calendar-weekdays flex",
            weekday: "h5-calendar-weekday text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
            week: "h5-calendar-week flex w-full mt-2",
            ...classNames,
          }}
          components={{
            MonthCaption: CalendarCaption,
            Day: CalendarDay,
            DayButton: CalendarDayButton,
          }}
        />
      </CalendarLunarContext.Provider>
    </CalendarNavContext.Provider>
  );
}

Calendar.displayName = "Calendar";

export { Calendar };
