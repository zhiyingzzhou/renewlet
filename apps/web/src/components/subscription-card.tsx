/**
 * 订阅卡片组件。
 *
 * 用途：
 * - 在仪表盘与订阅列表展示订阅概览
 * - 提供编辑/复制/删除入口
 * - 根据续费/试用到期情况做提示（颜色/动画）
 *
 * 注意： 卡片直接读取自定义配置来显示分类颜色。若未来支持服务端渲染卡片，
 * 需要把 label/color view model 从上层传入。
 */

import { Checkbox } from "@/components/ui/checkbox";
import { memo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ConfigItem } from '@/types/config';
import {
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  type SubscriptionCollectionItem,
} from '@/types/subscription';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { colorWithAlpha } from '@/lib/color';
import { Calendar, MoreHorizontal, CalendarClock, Bell, CreditCard, CalendarPlus, Copy, Eye, EyeOff, Gauge, Pencil, Pin, PinOff, RotateCw, Trash2 } from 'lucide-react';
import {
  daysBetweenDateOnly,
  type DateOnly,
} from '@/lib/time/date-only';
import { getEffectiveSubscriptionStatus } from '@/modules/subscriptions/domain/subscription-status';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { preloadRenewSubscriptionDialog } from '@/components/renew-subscription-dialog-loader';
import { AuthorizedImage } from '@/components/authorized-image';
import { TruncatedTooltipText } from '@/components/ui/truncated-tooltip-text';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/i18n/I18nProvider';
import { SubscriptionLogo } from '@/components/subscription-logo';
import { SubscriptionStatusBadge } from '@/components/subscription-status-badge';
import { formatCompactCurrencyAmount } from '@/lib/currency';
import {
  formatBillingCycleLabel,
  isOneTimeBuyout,
  isOneTimeFixedTerm,
  projectSubscriptionDailyCost,
} from '@/lib/subscription-billing';
import {
  getSubscriptionPriceReference,
  type SubscriptionCurrencyConverter,
} from '@/modules/subscriptions/domain/subscription-price-reference';
import { isManualRenewEligible } from '@renewlet/shared/subscription-renewal';
import { calculateCostSharingSummary } from '@renewlet/shared/cost-sharing';

export type SubscriptionCardLookup = ReadonlyMap<string, ConfigItem>;

interface SubscriptionCardProps {
  /** 订阅数据（前端 domain 类型）。 */
  subscription: SubscriptionCollectionItem;
  /** 展示模式：grid（卡片）/ list（列表行）。 */
  viewMode?: 'grid' | 'list';
  /** 编辑动作只传 id，页面控制器再从当前缓存快照取完整对象，避免卡片持有编辑弹窗状态。 */
  onEdit?: (id: string) => void;
  /** 删除动作只上抛 id，真正 mutation 和缓存失效统一留在页面应用层。 */
  onDelete?: (id: string) => void;
  /** 复制动作只上抛 id，页面控制器负责打开克隆弹窗并创建新记录。 */
  onClone?: (id: string) => void;
  /** 置顶切换动作由页面持有 mutation，卡片只负责菜单入口。 */
  onTogglePinned?: (id: string) => void;
  /** 公开页隐藏切换由页面持有 mutation，卡片只负责菜单入口。 */
  onTogglePublicHidden?: (id: string) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onSelect?: ((id: string, selected: boolean) => void) | undefined;
  /** 手动续订动作由页面持有 mutation，卡片只负责可见入口。 */
  onRenew?: (id: string) => void;
  /** 卡片主体 primary action：打开只读详情；菜单内动作保持独立。 */
  onViewDetails?: (id: string) => void;
  /** 日历弹层需要完整 detail DTO，由页面级控制器按 intent 读取。 */
  onAddToCalendar?: (id: string) => void;
  /** 指针或键盘意图出现时预取完整详情，冷点击仍由 detail query 接管。 */
  onPrefetchDetails?: (id: string) => void;
  /** 页面级账号业务日期；所有可见卡片在跨午夜时一起刷新。 */
  today: DateOnly | string;
  /** 分类配置查找表由页面级容器构建，避免虚拟列表 item 重复订阅全局配置。 */
  categoryByValue: SubscriptionCardLookup;
  /** 支付方式配置查找表由页面级容器构建，避免可见行滚动时重复查找全局配置。 */
  paymentMethodByValue: SubscriptionCardLookup;
  /** 订阅选择“继承”时展示的全局提醒天数。 */
  inheritedReminderDays?: number | undefined;
  /** 分账摘要和参考价使用同一页面级汇率口径，避免卡片入口和统计口径分叉。 */
  currencyConvert: SubscriptionCurrencyConverter;
  /** 只有拿到真实远端/快照 sourceDate 后才展示参考价。 */
  currencyRatesReady: boolean;
  /** settings 解析后的目标参考货币；null 表示关闭。 */
  priceReferenceCurrency: string | null;
}

const DEFAULT_BADGE_COLOR = "hsl(var(--primary))";
const CARD_ACTION_MENU_CONTENT_CLASSNAME = "pointer-events-auto w-max min-w-40";
const CARD_ACTION_MENU_ITEM_CLASSNAME = "gap-2.5 px-2.5 py-2 text-sm whitespace-nowrap";

type SubscriptionCardMetaTone = "muted" | "warning";

type SubscriptionCardMetaItem = {
  key: string;
  icon: ReactNode;
  text: string;
  tone: SubscriptionCardMetaTone;
  tabular?: boolean;
  truncate?: boolean;
};

const metaToneClassNames = {
  muted: "text-muted-foreground",
  warning: "text-warning",
} satisfies Record<SubscriptionCardMetaTone, string>;

function SubscriptionCardMetaToken({ item }: { item: SubscriptionCardMetaItem }) {
  return (
    <div
      data-testid={`subscription-card-meta-${item.key}`}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap text-xs",
        item.tabular && "tabular-nums",
        metaToneClassNames[item.tone],
      )}
    >
      {item.icon}
      <span className={cn(item.truncate ? "block max-w-24 truncate sm:max-w-32" : "whitespace-nowrap")}>{item.text}</span>
    </div>
  );
}

function SubscriptionCardMetaFlow({ items }: { items: readonly SubscriptionCardMetaItem[] }) {
  const dateItems = items.filter((item) => item.key === "start-date" || item.key === "billing-date");
  const secondaryItems = items.filter((item) => item.key !== "start-date" && item.key !== "billing-date");

  return (
    <div data-testid="subscription-card-meta-flow" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
      {dateItems.length > 0 ? (
        // 日期组是移动卡片的扫描单位，避免付款方式等次要字段抢占到期日期位置。
        <div
          data-testid="subscription-card-meta-date-group"
          className="inline-flex min-w-0 max-w-full flex-[0_1_auto] flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-4"
        >
          {dateItems.map((item) => <SubscriptionCardMetaToken key={item.key} item={item} />)}
        </div>
      ) : null}
      {secondaryItems.map((item) => <SubscriptionCardMetaToken key={item.key} item={item} />)}
    </div>
  );
}

/** 订阅卡片。 */
function SubscriptionCardComponent({
  subscription,
  viewMode = 'grid',
  onEdit,
  onDelete,
  onClone,
  onTogglePinned,
  onTogglePublicHidden,
  selectionMode = false,
  selected = false,
  onSelect,
  onRenew,
  onViewDetails,
  onAddToCalendar,
  onPrefetchDetails,
  today,
  categoryByValue,
  paymentMethodByValue,
  inheritedReminderDays = DEFAULT_NOTIFICATION_REMINDER_DAYS,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
}: SubscriptionCardProps) {
  const { t, locale, label, formatCurrency, formatDateOnly } = useI18n();
  const categoryConfig = categoryByValue.get(subscription.category);
  const categoryLabel = categoryConfig ? label(categoryConfig.labels) : subscription.category;
  const categoryColor = categoryConfig?.color ?? DEFAULT_BADGE_COLOR;
  const categoryBadgeStyle = {
    backgroundColor: colorWithAlpha(categoryColor, 0.1) ?? undefined,
    borderColor: colorWithAlpha(categoryColor, 0.2) ?? undefined,
    color: categoryColor,
  };

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const daysUntilRenewal = daysBetweenDateOnly(today, subscription.nextBillingDate);
  const daysUntilTrialEnd = subscription.trialEndDate ? daysBetweenDateOnly(today, subscription.trialEndDate) : null;
  const isBuyout = isOneTimeBuyout(subscription);
  const isFixedTermOneTime = isOneTimeFixedTerm(subscription);
  const dailyCost = projectSubscriptionDailyCost(subscription.price, subscription, today);
  const hasCalendarEvent = !isBuyout;
  const canManualRenew = Boolean(onRenew) && isManualRenewEligible(subscription);
  const billingCycleLabel = formatBillingCycleLabel(subscription, locale);
  const priceReference = getSubscriptionPriceReference({
    price: subscription.price,
    currency: subscription.currency,
    targetCurrency: priceReferenceCurrency,
    currencyRatesReady,
    currencyConvert,
  });
  const priceReferenceLabel = priceReference === null
    ? null
    : t("subscription.priceReference", {
        amount: formatCurrency(priceReference.amount, priceReference.currency),
      });
  const costSharingSummary = calculateCostSharingSummary(subscription.costSharing, subscription.price, {
    baseCurrency: subscription.currency,
    convert: currencyConvert,
  });
  const renewalBadgeLabel = isBuyout
    ? t("subscription.oneTimeMode.buyout")
    : isFixedTermOneTime
      ? t("subscription.oneTimeMode.term")
    : subscription.autoRenew
      ? t("subscription.renewal.auto")
      : t("subscription.renewal.manual");
  // 卡片是用户最先看到的状态入口，必须用有效状态，避免旧 active/trial 过期数据同时显示“活跃”和“即将续费”。
  const effectiveStatus = getEffectiveSubscriptionStatus(subscription, today);
  const isExpired = effectiveStatus === "expired";
  const isInactive = isExpired || effectiveStatus === "paused" || effectiveStatus === "cancelled";
  // 这里是展示提示窗口，不等同于 Cron 通知窗口；不要把两者的阈值混用。
  const isRenewingSoon = !isInactive && !isBuyout && daysUntilRenewal <= 7 && daysUntilRenewal >= 0;
  const isTrialEndingSoon = !isExpired && subscription.status === 'trial' && daysUntilTrialEnd !== null &&
    daysUntilTrialEnd <= 3 && daysUntilTrialEnd >= 0;
  const billingDateText = isBuyout && subscription.startDate
    ? t("subscription.card.oneTimeDate", { date: formatDateOnly(subscription.startDate) })
    : isBuyout
      ? null
    : isFixedTermOneTime
      ? t("subscription.card.expiresPrefix", { date: formatDateOnly(subscription.nextBillingDate) })
      : t("subscription.card.duePrefix", { date: formatDateOnly(subscription.nextBillingDate) });
  const relativeBillingText = (() => {
    if (isBuyout || effectiveStatus === "paused" || effectiveStatus === "cancelled") {
      return null;
    }

    if (isExpired) {
      return daysUntilRenewal < 0
        ? t("subscription.card.expiredDays", { days: Math.abs(daysUntilRenewal) })
        : t("subscription.card.expired");
    }

    if (isFixedTermOneTime) {
      return daysUntilRenewal === 0
        ? t("subscription.card.expiresToday")
        : t("subscription.card.expiresInDays", { days: daysUntilRenewal });
    }

    return daysUntilRenewal === 0
      ? t("subscription.card.renewsToday")
      : t("subscription.card.renewsInDays", { days: daysUntilRenewal });
  })();
  const billingStatusTone: SubscriptionCardMetaTone = isRenewingSoon ? "warning" : "muted";
  const paymentConfig = subscription.paymentMethod ? paymentMethodByValue.get(subscription.paymentMethod) : undefined;
  const paymentMethodLabel = subscription.paymentMethod
    ? paymentConfig
      ? label(paymentConfig.labels)
      : subscription.paymentMethod
    : null;
  const metaItems: SubscriptionCardMetaItem[] = [
    ...(subscription.startDate && !isBuyout
      ? [{
          key: "start-date",
          icon: <CalendarClock className="h-3.5 w-3.5 shrink-0" />,
          text: `${t("subscription.card.startPrefix")} ${formatDateOnly(subscription.startDate)}`,
          tone: "muted" as const,
        }]
      : []),
    ...(billingDateText
      ? [{
          key: "billing-date",
          icon: <Calendar className="h-3.5 w-3.5 shrink-0" />,
          text: billingDateText,
          tone: "muted" as const,
        }]
      : []),
    ...(dailyCost !== null
      ? [{
          key: "daily-average",
          icon: <Gauge className="h-3.5 w-3.5 shrink-0" />,
          text: t(dailyCost.basis === "ownership-to-date"
            ? "subscription.card.dailyCostToDate"
            : "subscription.card.dailyAverage", {
            amount: formatCompactCurrencyAmount(dailyCost.amount, subscription.currency, locale),
          }),
          tone: "muted" as const,
          tabular: true,
        }]
      : []),
    ...(paymentMethodLabel
      ? [{
          key: "payment-method",
          icon: paymentConfig?.icon ? (
            <AuthorizedImage src={paymentConfig.icon} alt="" className="h-3.5 w-3.5 shrink-0 object-contain" />
          ) : (
            <CreditCard className="h-3.5 w-3.5 shrink-0" />
          ),
          text: paymentMethodLabel,
          tone: "muted" as const,
          truncate: true,
        }]
      : []),
    ...(costSharingSummary.enabled
      ? [{
          key: "cost-sharing",
          icon: <CreditCard className="h-3.5 w-3.5 shrink-0" />,
          text: t("subscription.costSharing.yourShare") + " " + formatCurrency(costSharingSummary.yourShare, subscription.currency),
          tone: "muted" as const,
        }]
      : []),
    ...(relativeBillingText
      ? [{
          key: "relative-billing",
          icon: null,
          text: relativeBillingText,
          tone: billingStatusTone,
        }]
      : []),
  ];

  const handleDeleteConfirm = () => {
    // 删除写入交给页面 mutation；卡片只关闭本地确认框，避免 mutation 失败后留下二次确认遮罩。
    onDelete?.(subscription.id);
    setShowDeleteDialog(false);
  };
  const handleViewDetails = () => {
    onViewDetails?.(subscription.id);
  };
  const handleSelectionClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!selectionMode || !onSelect) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [role='menuitem']")) return;
    onSelect(subscription.id, !selected);
  };
  const handleSelectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selectionMode || !onSelect || event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(subscription.id, !selected);
  };

  return (
    <>
    <div
      data-testid="subscription-card"
      role={selectionMode ? "checkbox" : undefined}
      aria-checked={selectionMode ? selected : undefined}
      aria-label={selectionMode ? t("subscriptions.bulkVisibilitySelectSubscription", { name: subscription.name }) : undefined}
      tabIndex={selectionMode ? 0 : undefined}
      onClick={handleSelectionClick}
      onKeyDown={handleSelectionKeyDown}
      onPointerEnter={() => onPrefetchDetails?.(subscription.id)}
      onFocusCapture={() => onPrefetchDetails?.(subscription.id)}
      className={cn(
        "group relative h-full overflow-hidden rounded-xl border border-border bg-card p-5 shadow-card transition-all duration-300 hover:bg-card-hover",
        onViewDetails && "cursor-pointer",
        selectionMode && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selectionMode && selected && "border-primary/50 bg-primary/5 ring-1 ring-primary/30",
        isInactive && "border-muted bg-muted/20 hover:bg-muted/30",
        isRenewingSoon && "border-warning/40",
        isTrialEndingSoon && "animate-pulse-glow"
      )}
    >
      {selectionMode ? (
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelect?.(subscription.id, checked === true)}
          className="absolute left-3 top-3 z-20 h-5 w-5"
          aria-label={t("subscriptions.bulkVisibilitySelectSubscription", { name: subscription.name })}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      {onViewDetails && !selectionMode ? (
        <button
          type="button"
          aria-label={t("subscription.viewDetailsLabel", { name: subscription.name })}
          className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onClick={handleViewDetails}
          data-testid="subscription-card-primary-action"
        />
      ) : null}
      <div className={cn("relative z-10 flex items-start gap-4", onViewDetails && !selectionMode && "pointer-events-none")}>
        <SubscriptionLogo name={subscription.name} logo={subscription.logo} fallbackColor={categoryColor} size="md" />

        <div className="min-w-0 flex-1 grid gap-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-3 gap-y-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {subscription.pinned ? (
                <>
                  <Pin className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" data-testid="subscription-pinned-title-icon" />
                  <span className="sr-only">{t("subscription.pin")}</span>
                </>
              ) : null}
              <TruncatedTooltipText
                as="h3"
                text={subscription.name}
                className="min-w-0 font-semibold text-foreground"
              />
            </div>

            <div className="min-w-0 max-w-35 shrink-0 text-right sm:max-w-40">
              <p className="truncate text-xl font-bold text-foreground">
                {formatCurrency(subscription.price, subscription.currency)}
              </p>
              <p className="text-xs text-muted-foreground">
                {billingCycleLabel}
              </p>
              {priceReferenceLabel ? (
                <p className="truncate text-xs tabular-nums text-muted-foreground">
                  {priceReferenceLabel}
                </p>
              ) : null}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="pointer-events-auto h-8 w-8 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={t("subscription.moreActions")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={CARD_ACTION_MENU_CONTENT_CLASSNAME}>
                {selectionMode && onViewDetails ? (
                  <DropdownMenuItem className={CARD_ACTION_MENU_ITEM_CLASSNAME} onClick={handleViewDetails}>
                    <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {t("subscription.viewDetailsLabel", { name: subscription.name })}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem className={CARD_ACTION_MENU_ITEM_CLASSNAME} onClick={() => onEdit?.(subscription.id)}>
                  <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {t("common.edit")}
                </DropdownMenuItem>
                {onClone ? (
                  <DropdownMenuItem className={CARD_ACTION_MENU_ITEM_CLASSNAME} onClick={() => onClone(subscription.id)}>
                    <Copy className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {t("subscription.copy")}
                  </DropdownMenuItem>
                ) : null}
                {hasCalendarEvent && onAddToCalendar ? (
                  <DropdownMenuItem className={CARD_ACTION_MENU_ITEM_CLASSNAME} onClick={() => onAddToCalendar?.(subscription.id)}>
                    <CalendarPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {t("subscription.addToCalendar")}
                  </DropdownMenuItem>
                ) : null}
                {canManualRenew ? (
                  <DropdownMenuItem
                    className={CARD_ACTION_MENU_ITEM_CLASSNAME}
                    onPointerEnter={preloadRenewSubscriptionDialog}
                    onFocus={preloadRenewSubscriptionDialog}
                    onTouchStart={preloadRenewSubscriptionDialog}
                    onClick={() => onRenew?.(subscription.id)}
                  >
                    <RotateCw className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {t("subscription.renew")}
                  </DropdownMenuItem>
                ) : null}
                {onTogglePinned ? (
                  <DropdownMenuItem className={CARD_ACTION_MENU_ITEM_CLASSNAME} onClick={() => onTogglePinned(subscription.id)}>
                    {subscription.pinned ? (
                      <PinOff className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Pin className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    {subscription.pinned ? t("subscription.unpin") : t("subscription.pin")}
                  </DropdownMenuItem>
                ) : null}
                {onTogglePublicHidden ? (
                  <DropdownMenuItem className={CARD_ACTION_MENU_ITEM_CLASSNAME} onClick={() => onTogglePublicHidden(subscription.id)}>
                    {subscription.publicHidden ? (
                      <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <EyeOff className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    {subscription.publicHidden ? t("subscription.publicShow") : t("subscription.publicHide")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setShowDeleteDialog(true)}
                  className={cn(CARD_ACTION_MENU_ITEM_CLASSNAME, "text-destructive focus:bg-destructive/10 focus:text-destructive")}
                >
                  <Trash2 className="h-4 w-4 shrink-0" />
                  {t("common.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div data-testid="subscription-card-badge-flow" className="col-span-full flex flex-wrap items-center gap-x-1.5 gap-y-2 sm:gap-2">
              <Badge
                data-testid="subscription-card-badge-category"
                variant="outline"
                className="max-w-full shrink-0 overflow-hidden whitespace-nowrap px-2 text-xs sm:px-2.5"
                style={categoryBadgeStyle}
              >
                <TruncatedTooltipText text={categoryLabel} className="block max-w-full" />
              </Badge>
              <span data-testid="subscription-card-badge-status" className="inline-flex shrink-0">
                <SubscriptionStatusBadge status={effectiveStatus} className="px-2 sm:px-2.5" />
              </span>
              <Badge
                data-testid="subscription-card-badge-renewal"
                variant={isBuyout || isFixedTermOneTime ? "secondary" : subscription.autoRenew ? "outline" : "secondary"}
                className="shrink-0 whitespace-nowrap px-2 text-xs sm:px-2.5"
              >
                {renewalBadgeLabel}
              </Badge>
              {selectionMode ? (
                <Badge variant={subscription.publicHidden ? "secondary" : "outline"} className="shrink-0 gap-1 whitespace-nowrap px-2 text-xs sm:px-2.5">
                  {subscription.publicHidden ? <EyeOff className="h-3 w-3" aria-hidden="true" /> : <Eye className="h-3 w-3" aria-hidden="true" />}
                  {subscription.publicHidden ? t("subscription.publicVisibilityHidden") : t("subscription.publicVisibilityVisible")}
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="grid min-w-0 gap-y-1.5 text-sm">
            <SubscriptionCardMetaFlow items={metaItems} />

            {viewMode === 'list' && !isBuyout && (
              <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <Bell className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-36 truncate text-xs">
                  {subscription.reminderDays === DISABLED_REMINDER_DAYS
                    ? t("subscription.card.reminderDisabled")
                    : subscription.reminderDays === INHERIT_REMINDER_DAYS
                    ? t("subscription.card.reminderInherit", { days: inheritedReminderDays })
                    : t("subscription.card.reminderDays", { days: subscription.reminderDays })}
                </span>
              </div>
            )}
          </div>

          {isTrialEndingSoon && subscription.trialEndDate && (
            <div className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
              <span className="font-medium">
                {t("subscription.card.trialEnds", { date: formatDateOnly(subscription.trialEndDate, "monthDay") })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>

    <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("subscription.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("subscription.deleteDescription", { name: subscription.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

function areSubscriptionCardPropsEqual(prev: SubscriptionCardProps, next: SubscriptionCardProps): boolean {
  return (
    prev.subscription === next.subscription &&
    (prev.viewMode ?? "grid") === (next.viewMode ?? "grid") &&
    prev.today === next.today &&
    prev.inheritedReminderDays === next.inheritedReminderDays &&
    prev.categoryByValue === next.categoryByValue &&
    prev.paymentMethodByValue === next.paymentMethodByValue &&
    prev.currencyConvert === next.currencyConvert &&
    prev.currencyRatesReady === next.currencyRatesReady &&
    prev.priceReferenceCurrency === next.priceReferenceCurrency &&
    prev.onEdit === next.onEdit &&
    prev.onDelete === next.onDelete &&
    prev.onClone === next.onClone &&
    prev.onTogglePinned === next.onTogglePinned &&
    prev.onTogglePublicHidden === next.onTogglePublicHidden &&
    prev.selectionMode === next.selectionMode &&
    prev.selected === next.selected &&
    prev.onSelect === next.onSelect &&
    prev.onRenew === next.onRenew &&
    prev.onAddToCalendar === next.onAddToCalendar &&
    prev.onPrefetchDetails === next.onPrefetchDetails &&
    prev.onViewDetails === next.onViewDetails
  );
}

export const SubscriptionCard = memo(SubscriptionCardComponent, areSubscriptionCardPropsEqual);
SubscriptionCard.displayName = "SubscriptionCard";
