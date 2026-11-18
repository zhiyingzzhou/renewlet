import { useMemo } from 'react';
import type { SubscriptionCollectionItem } from '@/types/subscription';
import { cn } from '@/lib/utils';
import { formatDateOnlyForDisplay, formatDateOnlyMonthDay, type DateOnly } from '@/lib/time/date-only';
import { useI18n } from '@/i18n/I18nProvider';
import { upcomingSubscriptionEventsTask, subscriptionEventLabelKey } from '@/modules/subscriptions/domain/upcoming-reminders';
import { useForecastTask } from '@/modules/subscriptions/application/use-forecast-task';
import { Skeleton } from '@/components/ui/skeleton';
import { Bell } from 'lucide-react';

interface UpcomingRenewalsProps {
  /** 订阅列表（前端 domain 类型）。 */
  subscriptions: SubscriptionCollectionItem[];
  /** Dashboard 页面级账号业务日期。 */
  today: DateOnly | string;
}

/** 即将续费列表组件。 */
export function UpcomingRenewals({ subscriptions, today }: UpcomingRenewalsProps) {
  const { t, formatCurrency, locale } = useI18n();
  const factory = useMemo(
    () => () => upcomingSubscriptionEventsTask({ subscriptions, today }),
    [subscriptions, today],
  );

  const upcoming = useForecastTask(factory);
  if (!upcoming) return <div aria-busy="true"><Skeleton className="h-64 w-full rounded-lg" /></div>;

  if (upcoming.length === 0) {
    return (
      <p className="py-4 text-center text-sm leading-6 text-muted-foreground">{t("upcoming.noneNextTwoWeeks")}</p>
    );
  }

  return (
    <ul className="@container/upcoming grid min-w-0 grid-cols-[max-content_minmax(0,1fr)_max-content] gap-3">
      {upcoming.map((item) => (
        <li
          key={item.id}
          className={cn(
            "col-span-3 grid min-w-0 grid-cols-subgrid items-center rounded-lg border border-border bg-secondary/50 p-4 transition-colors hover:bg-secondary @max-xs/upcoming:grid-cols-[max-content_minmax(0,1fr)] @max-xs/upcoming:gap-x-3 @max-xs/upcoming:gap-y-1",
            !item.projected && item.daysUntil <= 3 && "border-warning/30 bg-warning/5"
          )}
        >
          <div className={cn(
            "flex h-10 min-w-10 items-center justify-center rounded-lg px-1 text-sm font-bold",
            !item.projected && item.daysUntil <= 3
              ? "bg-warning/20 text-warning"
              : "bg-muted text-muted-foreground"
          )}>
            {item.daysUntil === 0 ? t("upcoming.todayShort") : t("upcoming.daysShort", { days: item.daysUntil })}
          </div>
          <div className="min-w-0">
            <p className="min-w-0 wrap-break-word font-medium text-foreground">{item.subscription.name}</p>
            <p className="text-xs text-muted-foreground">
              {t("upcoming.eventOn", {
                date: item.dueDate.slice(0, 4) === today.slice(0, 4)
                  ? formatDateOnlyMonthDay(item.dueDate, locale)
                  : formatDateOnlyForDisplay(item.dueDate, locale),
                event: t(subscriptionEventLabelKey(item)),
              })}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 wrap-break-word">
                {item.kind === "expiry"
                  ? t("subscription.oneTimeMode.term")
                  : item.subscription.autoRenew
                    ? t("subscription.renewal.auto")
                    : t("subscription.renewal.manual")}
              </span>
              {item.reminderEnabled ? (
                <span
                  role="img"
                  aria-label={t("subscription.reminderEnabledHelp")}
                  title={t("subscription.reminderEnabledHelp")}
                  className="inline-flex items-center text-muted-foreground"
                >
                  <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              ) : null}
            </div>
          </div>
          <p className="whitespace-nowrap text-right font-semibold tabular-nums text-foreground @max-xs/upcoming:col-span-2">
            {item.amount === null ? "—" : formatCurrency(item.amount, item.subscription.currency)}
          </p>
        </li>
      ))}
    </ul>
  );
}
