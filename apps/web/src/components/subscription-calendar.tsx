/**
 * 续费/到期日历月视图入口（subscription-calendar.tsx）。
 *
 * 架构位置：这里持有当前月份、选中订阅和单日列表状态，负责把订阅
 * 将 DateOnly 分组为日历网格；详情视图复用通用 SubscriptionDetailDialog。
 *
 * 注意：续费日期和试用结束日期都是 DateOnly，分组时不能重新用 Date 解析，
 * 否则浏览器时区会导致事件跨日；事件日期由订阅领域模型统一解析。
 */

import { useState, useMemo } from 'react';
import type { Subscription, SubscriptionCollectionItem } from '@/types/subscription';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { useExchangeRates } from '@/hooks/use-exchange-rates';
import { useSettings } from '@/hooks/use-settings';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  format,
  eachDayOfInterval,
  isSameMonth,
  addMonths,
  subMonths,
  setMonth,
  setYear
} from 'date-fns';
import { cn } from '@/lib/utils';
import { dateOnlyToLocalDate, dateToDateOnly, isSameMonthDateOnly } from '@/lib/time/date-only';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n/I18nProvider';
import { formatBillingCycleLabel } from '@/lib/subscription-billing';
import { SubscriptionDetailDialog } from '@/components/subscription-detail-dialog';
import { CalendarEventList } from './calendar-event-list';
import { DaySubscriptionsDialog } from './subscription-calendar-dialogs';
import type { CalendarDaySubscriptions } from './subscription-calendar-dialogs';
import { calendarSubscriptionEventsTask, subscriptionEventLabelKey, type UpcomingSubscriptionEvent } from '@/modules/subscriptions/domain/upcoming-reminders';
import { useForecastTask } from '@/modules/subscriptions/application/use-forecast-task';
import { Skeleton } from '@/components/ui/skeleton';
import { useZonedToday } from '@/hooks/use-zoned-today';
import { resolveSubscriptionPriceReferenceCurrency } from '@/modules/subscriptions/domain/subscription-price-reference';
import { getSubscriptionCalendarRange } from '@/modules/subscriptions/domain/subscription-calendar-range';
import { useSubscriptionDetailDialog } from '@/hooks/use-subscription-detail-dialog';

interface SubscriptionCalendarProps {
  /** 订阅列表（前端 domain 类型）。 */
  subscriptions: SubscriptionCollectionItem[];
  currentMonth: Date;
  onCurrentMonthChange: (month: Date) => void;
  /** 编辑动作交回上层 CRUD 控制器，完整对象由共享 detail cache 提供。 */
  onEditSubscription?: (id: string) => void;
}

const EMPTY_EVENTS = new Map<string, UpcomingSubscriptionEvent[]>();

const WEEKDAY_REFERENCE_DATES = [
  new Date(2024, 0, 1),
  new Date(2024, 0, 2),
  new Date(2024, 0, 3),
  new Date(2024, 0, 4),
  new Date(2024, 0, 5),
  new Date(2024, 0, 6),
  new Date(2024, 0, 7),
] as const;


/** 续费/到期日历组件。 */
export const SubscriptionCalendar = ({
  subscriptions,
  currentMonth,
  onCurrentMonthChange,
  onEditSubscription,
}: SubscriptionCalendarProps) => {
  const { t, locale, formatDateTime, formatCurrency } = useI18n();
  const isMobileCalendar = useMediaQuery("(max-width: 639px)");
  // 默认货币来自 Settings（持久化到 SQLite），用于日历底部“预计支出”的换算口径。
  const { data: settings } = useSettings();
  const defaultCurrency = settings?.defaultCurrency ?? 'CNY';
  const priceReferenceCurrency = settings ? resolveSubscriptionPriceReferenceCurrency(settings) : null;
  const today = useZonedToday(settings?.timezone ?? "UTC");
  const { convert, loading: ratesLoading, sourceDate: ratesSourceDate } = useExchangeRates(settings?.exchangeRateProvider);
  const currencyRatesReady = Boolean(ratesSourceDate) && !ratesLoading;

  const {
    detailDialogOpen,
    selectedDetailSubscription,
    selectedDetailCollectionItem,
    detailPending,
    handlePrefetchDetails,
    handleViewDetails,
    handleDetailDialogOpenChange,
  } = useSubscriptionDetailDialog(subscriptions);
  const [dayListOpen, setDayListOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [yearPickerOpen, setYearPickerOpen] = useState(false);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [yearRangeStart, setYearRangeStart] = useState(() => Math.floor(dateOnlyToLocalDate(today).getFullYear() / 12) * 12);
  const monthLabels = useMemo(
    () => Array.from({ length: 12 }, (_, index) => formatDateTime(new Date(2024, index, 1), { month: "long" })),
    [formatDateTime],
  );
  const weekdayLabels = useMemo(
    () => WEEKDAY_REFERENCE_DATES.map((date) => formatDateTime(date, { weekday: "short" })),
    [formatDateTime],
  );
  const calendarRange = useMemo(() => getSubscriptionCalendarRange(currentMonth), [currentMonth]);

  const eventFactory = useMemo(
    () => () => calendarSubscriptionEventsTask({ subscriptions, today, ...calendarRange }),
    [subscriptions, today, calendarRange],
  );
  const projectedEvents = useForecastTask(eventFactory);
  const eventsByDate = projectedEvents ?? EMPTY_EVENTS;

  // 只保存选中日期，事件始终从当前集合派生；续订、停用或跨日刷新后，弹窗不能保留旧账期副本。
  const selectedDaySubs: CalendarDaySubscriptions | null = selectedDay
    ? { date: selectedDay, events: eventsByDate.get(dateToDateOnly(selectedDay)) ?? [] }
    : null;

  const monthlySummary = useMemo(() => {
    let renewalsCount = 0;
    let estimatedSpending = 0;

    for (const [dateKey, daySubs] of eventsByDate.entries()) {
      if (!isSameMonthDateOnly(dateKey, dateToDateOnly(currentMonth))) continue;

      renewalsCount += daySubs.length;
      for (const event of daySubs) {
        if (event.amount !== null) estimatedSpending += convert(event.amount, event.subscription.currency, defaultCurrency);
      }
    }

    return { renewalsCount, estimatedSpending };
  }, [eventsByDate, currentMonth, convert, defaultCurrency]);

  // 生成当前月视图需要展示的日期网格（包含前后补齐的周）
  const calendarDays = useMemo(() => {
    return eachDayOfInterval({
      start: dateOnlyToLocalDate(calendarRange.from),
      end: dateOnlyToLocalDate(calendarRange.to),
    });
  }, [calendarRange]);

  const monthlyAgendaGroups = useMemo(() => {
    return calendarDays
      .filter((day) => isSameMonth(day, currentMonth))
      .map((day) => {
        const dateKey = format(day, 'yyyy-MM-dd');
        return {
          date: day,
          dateKey,
          events: eventsByDate.get(dateKey) || [],
        };
      })
      .filter((group) => group.events.length > 0);
  }, [calendarDays, currentMonth, eventsByDate]);

  const agendaRows = useMemo(() => monthlyAgendaGroups.flatMap((group) => [
    { kind: "heading" as const, group, key: `heading:${group.dateKey}` },
    ...group.events.map((event) => ({ kind: "event" as const, event, key: event.id })),
  ]), [monthlyAgendaGroups]);

  const goToPreviousMonth = () => onCurrentMonthChange(subMonths(currentMonth, 1));
  const goToNextMonth = () => onCurrentMonthChange(addMonths(currentMonth, 1));
  const goToToday = () => onCurrentMonthChange(dateOnlyToLocalDate(today));

  const handleSubscriptionClick = (sub: SubscriptionCollectionItem) => {
    handleViewDetails(sub.id);
  };

  const handleShowDayList = (date: Date) => {
    setSelectedDay(date);
    setDayListOpen(true);
  };

  const handleSelectFromList = (sub: SubscriptionCollectionItem) => {
    setDayListOpen(false);
    handleViewDetails(sub.id);
  };

  const handleEditFromDetail = (subscription: Subscription) => {
    onEditSubscription?.(subscription.id);
  };

  return (
    <>
      <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-card sm:p-6" aria-busy={!projectedEvents}>
        {/* 顶部栏 */}
        <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">{t("calendar.title")}</h3>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={goToToday}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t("common.today")}
            </Button>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("calendar.previousMonth")}
                className="h-8 w-8"
                onClick={goToPreviousMonth}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              
              {/* 年份选择器 */}
              <Popover open={yearPickerOpen} onOpenChange={setYearPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-8 px-2 text-sm font-medium hover:bg-secondary"
                  >
                    {formatDateTime(currentMonth, { year: "numeric" })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-70 p-3" align="center">
                  <div className="flex items-center justify-between mb-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setYearRangeStart(prev => prev - 12)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-primary hover:text-primary"
                      onClick={() => {
                        const todayDate = dateOnlyToLocalDate(today);
                        onCurrentMonthChange(todayDate);
                        setYearRangeStart(Math.floor(todayDate.getFullYear() / 12) * 12);
                        setYearPickerOpen(false);
                      }}
                    >
                      {t("common.today")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setYearRangeStart(prev => prev + 12)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {Array.from({ length: 12 }, (_, i) => {
                      const year = yearRangeStart + i;
                      const isSelected = year === currentMonth.getFullYear();
                      const isCurrent = year === dateOnlyToLocalDate(today).getFullYear();
                      return (
                        <button
                          key={year}
                          onClick={() => {
                            onCurrentMonthChange(setYear(currentMonth, year));
                            setYearPickerOpen(false);
                          }}
                          className={cn(
                            "h-9 rounded-lg text-sm font-medium transition-all",
                            isSelected 
                              ? "bg-primary text-primary-foreground" 
                              : isCurrent
                                ? "bg-accent text-accent-foreground hover:bg-accent/80"
                                : "hover:bg-secondary text-foreground"
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
                    variant="ghost"
                    className="h-8 px-2 text-sm font-medium hover:bg-secondary"
                  >
                    {formatDateTime(currentMonth, { month: "long" })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-60 p-3" align="center">
                  <div className="flex items-center justify-center mb-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-primary hover:text-primary"
                      onClick={() => {
                        onCurrentMonthChange(dateOnlyToLocalDate(today));
                        setMonthPickerOpen(false);
                      }}
                    >
                      {t("common.today")}
                    </Button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {monthLabels.map((month, index) => {
                      const isSelected = index === currentMonth.getMonth();
                      const isCurrent = index === dateOnlyToLocalDate(today).getMonth() &&
                                       currentMonth.getFullYear() === dateOnlyToLocalDate(today).getFullYear();
                      return (
                        <button
                          key={month}
                          onClick={() => {
                            onCurrentMonthChange(setMonth(currentMonth, index));
                            setMonthPickerOpen(false);
                          }}
                          className={cn(
                            "h-9 rounded-lg text-sm font-medium transition-all",
                            isSelected 
                              ? "bg-primary text-primary-foreground" 
                              : isCurrent
                                ? "bg-accent text-accent-foreground hover:bg-accent/80"
                                : "hover:bg-secondary text-foreground"
                          )}
                        >
                          {month}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("calendar.nextMonth")}
                className="h-8 w-8"
                onClick={goToNextMonth}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {projectedEvents ? (
          <>
            {/* 星期标题 */}
            <div className="mb-2 grid grid-cols-7">
              {weekdayLabels.map((day) => (
                <div
                  key={day}
                  className="py-2 text-center text-[11px] font-medium text-muted-foreground sm:text-xs"
                >
                  {day}
                </div>
              ))}
            </div>

            {isMobileCalendar ? (
              <>
                {/* 移动端月历概览：只展示事件指示，完整信息放到下方列表。 */}
                <div className="grid min-w-0 grid-cols-7 gap-1">
                  {calendarDays.map((day) => {
                    const dateKey = format(day, 'yyyy-MM-dd');
                    const daySubs = eventsByDate.get(dateKey) || [];
                    const isCurrentMonth = isSameMonth(day, currentMonth);
                    const isDayToday = dateKey === today;
                    const dayLabel = formatDateTime(day, { month: "short", day: "numeric" });
                    const hasRenewals = daySubs.length > 0;
                    const dayContent = (
                      <>
                        <span
                          className={cn(
                            "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium",
                            isDayToday && "bg-primary text-primary-foreground font-semibold",
                            !isDayToday && isCurrentMonth && "text-foreground",
                            !isDayToday && !isCurrentMonth && "text-muted-foreground/45",
                          )}
                        >
                          {format(day, 'd')}
                        </span>
                        <span className="flex h-4 items-center justify-center">
                          {daySubs.length === 1 && (
                            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                          )}
                          {daySubs.length > 1 && (
                            <span className="min-w-4 rounded-full bg-primary/15 px-1 text-[10px] font-semibold leading-4 text-primary">
                              {daySubs.length}
                            </span>
                          )}
                        </span>
                      </>
                    );

                    if (!hasRenewals) {
                      return (
                        <div
                          key={dateKey}
                          className={cn(
                            "flex min-h-11 flex-col items-center justify-center rounded-lg transition-colors",
                            isCurrentMonth ? "bg-secondary/30" : "bg-muted/20",
                          )}
                        >
                          {dayContent}
                        </div>
                      );
                    }

                    return (
                      <button
                        key={dateKey}
                        type="button"
                        aria-label={t("calendar.dayRenewalCount", { date: dayLabel, count: daySubs.length })}
                        onClick={() => handleShowDayList(day)}
                        className={cn(
                          "flex min-h-11 flex-col items-center justify-center rounded-lg border border-border bg-secondary/40 transition-colors hover:border-primary/40 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                          !isCurrentMonth && "bg-muted/30",
                        )}
                      >
                        {dayContent}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-5 min-w-0 max-w-full border-t border-border pt-4" data-testid="calendar-mobile-agenda">
                  <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
                    <h4 className="min-w-0 truncate text-sm font-semibold text-foreground">{t("calendar.mobileAgendaTitle")}</h4>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("calendar.renewalCount", { count: monthlySummary.renewalsCount })}
                    </span>
                  </div>

                  {monthlyAgendaGroups.length > 0 ? (
                    <CalendarEventList count={agendaRows.length} getItemKey={(index) => agendaRows[index]!.key}
                      estimatedItemSize={76} testId="calendar-mobile-agenda-list" renderItem={(index) => {
                        const row = agendaRows[index]!;
                        if (row.kind === "heading") {
                          const group = row.group;
                          return (
                            <div className={cn("mb-2 flex min-w-0 items-center justify-between gap-3 text-xs", index > 0 && "pt-2")}>
                              <span className="min-w-0 truncate font-medium text-muted-foreground">
                                {formatDateTime(group.date, { month: "short", day: "numeric", weekday: "short" })}
                              </span>
                              <span className="shrink-0 text-primary">
                                {t("calendar.dayRenewalCount", { date: formatDateTime(group.date, { month: "short", day: "numeric" }), count: group.events.length })}
                              </span>
                            </div>
                          );
                        }
                        const event = row.event;
                        const sub = event.subscription;
                        return (
                          <button type="button" onClick={() => handleSubscriptionClick(sub)}
                            onPointerEnter={() => handlePrefetchDetails(sub.id)} onFocus={() => handlePrefetchDetails(sub.id)}
                            className={cn("flex min-h-14 w-full min-w-0 max-w-full items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-3 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", index < agendaRows.length - 1 && "mb-2")}
                            data-testid="calendar-mobile-agenda-item">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-foreground">{sub.name}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {t(subscriptionEventLabelKey(event))} · {formatBillingCycleLabel(sub, locale)}
                              </p>
                            </div>
                            <p className="max-w-[45%] shrink-0 truncate text-right text-sm font-semibold text-foreground">
                              {event.amount === null ? "—" : formatCurrency(event.amount, sub.currency)}
                            </p>
                          </button>
                        );
                      }} />
                  ) : (
                    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-secondary/30 px-4 text-center">
                      <CalendarDays className="mb-3 h-6 w-6 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">{t("calendar.mobileAgendaEmpty")}</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* 日历网格 */
              <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-border/50">
                {calendarDays.map((day) => {
                  const dateKey = format(day, 'yyyy-MM-dd');
                  const daySubs = eventsByDate.get(dateKey) || [];
                  const isCurrentMonth = isSameMonth(day, currentMonth);
                  const isDayToday = dateKey === today;

                  return (
                    <div
                      key={dateKey}
                      className={cn(
                        "min-h-20 bg-card p-1.5 transition-colors",
                        !isCurrentMonth && "bg-muted/30"
                      )}
                    >
                      {/* 日期数字 */}
                      <div className="mb-1 flex justify-end">
                        <span
                          className={cn(
                            "flex h-6 w-6 items-center justify-center rounded-full text-xs",
                            isDayToday && "bg-primary text-primary-foreground font-semibold",
                            !isDayToday && isCurrentMonth && "text-foreground",
                            !isDayToday && !isCurrentMonth && "text-muted-foreground/50"
                          )}
                        >
                          {format(day, 'd')}
                        </span>
                      </div>

                      {/* 订阅项 */}
                      <div className="grid gap-0.5">
                        <TooltipProvider delayDuration={200}>
                          {daySubs.slice(0, 2).map((event) => {
                            const sub = event.subscription;
                            return (
                              <Tooltip key={event.id}>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={() => handleSubscriptionClick(sub)}
                                    onPointerEnter={() => handlePrefetchDetails(sub.id)}
                                    onFocus={() => handlePrefetchDetails(sub.id)}
                                    className={cn(
                                      "flex w-full min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-left text-xs transition-colors",
                                      "border-border bg-background text-foreground hover:bg-secondary/60",
                                      "cursor-pointer hover:border-border"
                                    )}
                                  >
                                    <span className="min-w-0 truncate">{sub.name}</span>
                                    {event.projected && <span className="shrink-0 text-muted-foreground">{t("upcoming.projected")}</span>}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">
                                  <p className="font-medium">{sub.name}</p>
                                  <p className="text-muted-foreground">{t(subscriptionEventLabelKey(event))}</p>
                                  <p className="text-muted-foreground">
                                    {event.amount === null ? "—" : formatCurrency(event.amount, sub.currency)}
                                  </p>
                                  <p className="text-muted-foreground/70">{t("calendar.viewDetails")}</p>
                                </TooltipContent>
                              </Tooltip>
                            );
                          })}
                          {daySubs.length > 2 && (
                            <button
                              onClick={() => handleShowDayList(day)}
                              className="w-full cursor-pointer text-center text-xs text-primary hover:text-primary-glow hover:underline"
                            >
                              {t("calendar.more", { count: daySubs.length - 2 })}
                            </button>
                          )}
                        </TooltipProvider>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 月度汇总 */}
            <div className="mt-4 border-t border-border pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="text-sm">
                  <span className="text-muted-foreground">{t("calendar.monthlyRenewals")}</span>
                  <p className="font-semibold text-foreground mt-1">
                    {t("calendar.renewalCount", { count: monthlySummary.renewalsCount })}
                  </p>
                </div>
                <div className="text-sm text-right">
                  <span className="text-muted-foreground">{t("calendar.estimatedSpend")}</span>
                  <p className="font-semibold text-foreground mt-1">
                    {formatCurrency(monthlySummary.estimatedSpending, defaultCurrency)}
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <Skeleton className="h-96 w-full rounded-lg" />
        )}
      </div>


      <SubscriptionDetailDialog
        open={detailDialogOpen}
        onOpenChange={handleDetailDialogOpenChange}
        subscription={selectedDetailSubscription}
        loadingPreview={selectedDetailCollectionItem}
        today={today}
        currencyConvert={convert}
        currencyRatesReady={currencyRatesReady}
        priceReferenceCurrency={priceReferenceCurrency}
        loading={detailPending}
        {...(onEditSubscription ? { onEditSubscription: handleEditFromDetail } : {})}
      />

      <DaySubscriptionsDialog
        open={dayListOpen}
        onOpenChange={setDayListOpen}
        selectedDaySubs={selectedDaySubs}
        onSelectSubscription={handleSelectFromList}
        onPrefetchSubscription={handlePrefetchDetails}
        today={today}
        isMobile={isMobileCalendar}
        pending={!projectedEvents}
      />
    </>
  );
};
