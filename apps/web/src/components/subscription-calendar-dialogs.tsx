/**
 * 续费/到期日历弹窗组合。
 *
 * 架构位置：SubscriptionCalendar 负责日期网格和事件聚合，本文件只展示选中日期列表；
 * 订阅详情复用通用 SubscriptionDetailDialog。
 *
 * 注意： 弹窗中的金额、周期和状态标签必须继续复用 subscription domain 常量，避免日历视图口径分叉。
 */
import type { SubscriptionCollectionItem } from '@/types/subscription';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { CalendarEventList } from './calendar-event-list';
import { CalendarDays } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomDrawerContent, MobileDrawerRoot } from '@/components/ui/mobile-drawer';
import { TruncatedTooltipText } from '@/components/ui/truncated-tooltip-text';
import { useCustomConfigState } from '@/contexts/CustomConfigContext';
import { useI18n } from '@/i18n/I18nProvider';
import type { DateOnly } from '@/lib/time/date-only';
import { getEffectiveSubscriptionStatus } from '@/modules/subscriptions/domain/subscription-status';
import { SubscriptionLogo } from '@/components/subscription-logo';
import { formatBillingCycleLabel } from '@/lib/subscription-billing';
import { SubscriptionStatusBadge } from '@/components/subscription-status-badge';
import { subscriptionEventLabelKey, type UpcomingSubscriptionEvent } from '@/modules/subscriptions/domain/upcoming-reminders';

const DEFAULT_LOGO_FALLBACK_COLOR = "hsl(var(--primary))";

interface CalendarSubscriptionLogoProps {
  subscription: SubscriptionCollectionItem;
  categoryColor: string | undefined;
  className?: string | undefined;
}

function CalendarSubscriptionLogo({ subscription, categoryColor, className }: CalendarSubscriptionLogoProps) {
  return <SubscriptionLogo name={subscription.name} logo={subscription.logo} fallbackColor={categoryColor ?? DEFAULT_LOGO_FALLBACK_COLOR} size="sm" className={className} />;
}

export interface CalendarDaySubscriptions {
  date: Date;
  events: UpcomingSubscriptionEvent[];
}

export interface DaySubscriptionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDaySubs: CalendarDaySubscriptions | null;
  onSelectSubscription: (subscription: SubscriptionCollectionItem) => void;
  onPrefetchSubscription: (id: string) => void;
  today: DateOnly | string;
  isMobile?: boolean | undefined;
  pending?: boolean;
}

interface DaySubscriptionsListProps {
  pending: boolean;
  events: UpcomingSubscriptionEvent[];
  onSelectSubscription: (subscription: SubscriptionCollectionItem) => void;
  onPrefetchSubscription: (id: string) => void;
  today: DateOnly | string;
}

function DaySubscriptionsList({ events, onSelectSubscription, onPrefetchSubscription, today, pending }: DaySubscriptionsListProps) {
  const { config } = useCustomConfigState();
  const { t, locale, formatCurrency } = useI18n();

  if (pending) return <div aria-busy="true"><Skeleton className="h-48 w-full rounded-lg" /></div>;

  if (events.length === 0) {
    return <p role="status" className="py-4 text-center text-sm text-muted-foreground">{t("common.noData")}</p>;
  }

  return (
    <CalendarEventList count={events.length} getItemKey={(index) => events[index]!.id}
      estimatedItemSize={82} testId="calendar-day-subscription-list" renderItem={(index) => {
        const event = events[index]!;
        const sub = event.subscription;
        // 当天列表和详情弹窗保持同一口径，确保旧过期数据不会在同一个日历流程里显示成不同状态。
        const effectiveStatus = getEffectiveSubscriptionStatus(sub, today);

        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelectSubscription(sub)}
            onPointerEnter={() => onPrefetchSubscription(sub.id)}
            onFocus={() => onPrefetchSubscription(sub.id)}
            className={cn("group flex min-w-0 w-full max-w-full items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3 text-left transition-colors hover:bg-secondary/60", index < events.length - 1 && "mb-2")}
            data-testid="calendar-day-subscription-item"
          >
            <CalendarSubscriptionLogo
              subscription={sub}
              categoryColor={
                config.categories.find((item) => item.value === sub.category)?.color ??
                DEFAULT_LOGO_FALLBACK_COLOR
              }
            />
            <div className="min-w-0 flex-1">
              <TruncatedTooltipText as="p" text={sub.name} className="text-sm font-medium" />
              <p className="text-xs text-muted-foreground">
                {t(subscriptionEventLabelKey(event))} · {formatBillingCycleLabel(sub, locale)}
              </p>
            </div>
            <div className="min-w-0 max-w-[42%] shrink-0 text-right">
              <p className="truncate font-semibold text-foreground">
                {event.amount === null ? "—" : formatCurrency(event.amount, sub.currency)}
              </p>
              <SubscriptionStatusBadge status={effectiveStatus} className="max-w-full truncate" />
            </div>
          </button>
        );
      }}
    />
  );
}

export function DaySubscriptionsDialog({
  open,
  onOpenChange,
  selectedDaySubs,
  onSelectSubscription,
  onPrefetchSubscription,
  today,
  isMobile = false,
  pending = false,
}: DaySubscriptionsDialogProps) {
  const { t, formatDateTime } = useI18n();
  const selectedDayLabel = selectedDaySubs
    ? formatDateTime(selectedDaySubs.date, { month: "short", day: "numeric" })
    : "";

  if (isMobile) {
    // 移动端当天列表使用 Drawer，避免小屏上 Dialog 高度和日历网格滚动互相挤压。
    return (
      <MobileDrawerRoot open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
        {open && (
          <MobileBottomDrawerContent
            title={selectedDaySubs
              ? t("calendar.dayRenewals", { date: selectedDayLabel })
              : t("calendar.dayListFallbackDescription")}
            description={selectedDaySubs
              ? t("calendar.dayListDescription", { date: selectedDayLabel })
              : t("calendar.dayListFallbackDescription")}
            descriptionMode="sr-only"
            closeLabel={t("common.close")}
            icon={<CalendarDays className="h-5 w-5 shrink-0 text-primary" />}
            className="min-h-[42dvh]"
          >
              {selectedDaySubs && (
                <DaySubscriptionsList
                  pending={pending}
                  events={selectedDaySubs.events}
                  onSelectSubscription={onSelectSubscription}
                  onPrefetchSubscription={onPrefetchSubscription}
                  today={today}
                />
              )}
          </MobileBottomDrawerContent>
        )}
      </MobileDrawerRoot>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            {selectedDaySubs && t("calendar.dayRenewals", { date: selectedDayLabel })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {selectedDaySubs
              ? t("calendar.dayListDescription", { date: selectedDayLabel })
              : t("calendar.dayListFallbackDescription")}
          </DialogDescription>
        </DialogHeader>

        {selectedDaySubs && (
          <div className="grid max-h-[calc(var(--app-viewport-height)-8rem)] gap-2 overflow-y-auto">
            <DaySubscriptionsList
              pending={pending}
              events={selectedDaySubs.events}
              onSelectSubscription={onSelectSubscription}
              onPrefetchSubscription={onPrefetchSubscription}
              today={today}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
