/**
 * 订阅详情弹窗。
 *
 * 架构位置：列表、仪表盘和日历共用这一份只读详情，编辑仍交回页面级 CRUD 控制器。
 * 注意：金额、周期、状态和提醒标签必须继续复用订阅 domain 常量，避免不同入口展示口径分叉。
 */
import { useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Edit2, ExternalLink, RotateCw } from "lucide-react";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import {
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
} from "@/types/subscription";
import { AddToCalendarDialog } from "@/components/add-to-calendar-dialog";
import { preloadRenewSubscriptionDialog } from "@/components/renew-subscription-dialog-loader";
import { SubscriptionLogo } from "@/components/subscription-logo";
import {
  createSubscriptionDetailLoadingSlots,
  SubscriptionDetailScaffold,
  type SubscriptionDetailLoadingStructure,
} from "@/components/subscription-detail-scaffold";
import { SubscriptionStatusBadge } from "@/components/subscription-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MobileBottomDrawerContent, MobileDrawerRoot } from "@/components/ui/mobile-drawer";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useSettings } from "@/hooks/use-settings";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { formatCurrency as formatPreciseCurrency, formatCompactCurrencyAmount } from "@/lib/currency";
import type { DateOnly } from "@/lib/time/date-only";
import {
  formatBillingCycleLabel,
  isOneTimeBuyout,
  isOneTimeFixedTerm,
  projectSubscriptionDailyCost,
} from "@/lib/subscription-billing";
import {
  getSubscriptionPriceReference,
  type SubscriptionCurrencyConverter,
} from "@/modules/subscriptions/domain/subscription-price-reference";
import { getEffectiveSubscriptionStatus } from "@/modules/subscriptions/domain/subscription-status";
import { isManualRenewEligible } from "@renewlet/shared/subscription-renewal";
import { calculateCostSharingSummary } from "@renewlet/shared/cost-sharing";

const DEFAULT_LOGO_FALLBACK_COLOR = "hsl(var(--primary))";

interface SubscriptionDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: Subscription | null;
  loadingPreview: SubscriptionCollectionItem | null;
  onEditSubscription?: (subscription: Subscription) => void;
  onRenewSubscription?: (id: string, restoreTarget?: HTMLElement | null) => void;
  today: DateOnly | string;
  currencyConvert: SubscriptionCurrencyConverter;
  currencyRatesReady: boolean;
  priceReferenceCurrency: string | null;
  loading?: boolean | undefined;
}

interface SubscriptionDetailContentProps {
  subscription: Subscription | null;
  loading: boolean;
  loadingPreview: SubscriptionCollectionItem | null;
  categoryLabel: string;
  paymentMethodLabel: string | undefined;
  today: DateOnly | string;
  onClose: () => void;
  onEditSubscription?: (subscription: Subscription) => void;
  onRenewSubscription?: (id: string, restoreTarget?: HTMLElement | null) => void;
  onAddToCalendar: () => void;
  currencyConvert: SubscriptionCurrencyConverter;
  currencyRatesReady: boolean;
  priceReferenceCurrency: string | null;
}

function DetailRow({
  label,
  children,
  alignStart = false,
}: {
  label: string;
  children: ReactNode;
  alignStart?: boolean;
}) {
  return (
    <div className={cn("grid gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]", alignStart ? "items-start" : "items-center")}>
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-foreground sm:text-right">{children}</div>
    </div>
  );
}

function resolveDetailLoadingStructure(
  preview: SubscriptionCollectionItem | null,
  today: DateOnly | string,
): SubscriptionDetailLoadingStructure {
  const buyout = preview !== null && isOneTimeBuyout(preview);
  return {
    showCalendarAction: preview !== null && !buyout,
    showBalance: preview?.balance !== undefined,
    showCostSharing: preview?.costSharing?.enabled === true,
    showDailyAverage: preview !== null && projectSubscriptionDailyCost(preview.price, preview, today) !== null,
    showNextBillingDate: preview !== null && (!buyout || preview.startDate !== null),
    showPaymentMethod: Boolean(preview?.paymentMethod),
    showStartDate: !buyout && preview?.startDate !== null && preview?.startDate !== undefined,
    showTrialEndDate: preview?.trialEndDate !== undefined,
  };
}

function SubscriptionDetailContent({
  subscription,
  loading,
  loadingPreview,
  categoryLabel,
  paymentMethodLabel,
  today,
  onClose,
  onEditSubscription,
  onRenewSubscription,
  onAddToCalendar,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
}: SubscriptionDetailContentProps) {
  const { data: settings } = useSettings();
  const { t, locale, formatDateOnly, formatCurrency } = useI18n();
  if (loading) {
    const loadingSlots = createSubscriptionDetailLoadingSlots({
      structure: resolveDetailLoadingStructure(loadingPreview, today),
      canEdit: Boolean(onEditSubscription),
      canRenew: Boolean(
        loadingPreview
        && onRenewSubscription
        && isManualRenewEligible(loadingPreview),
      ),
      label: t("common.loading"),
    });
    return (
      <SubscriptionDetailScaffold
        {...loadingSlots}
        data-testid="subscription-detail-data-loading"
      />
    );
  }
  if (!subscription) return null;

  const effectiveStatus = getEffectiveSubscriptionStatus(subscription, today);
  const inheritedReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const isBuyout = isOneTimeBuyout(subscription);
  const isFixedTermOneTime = isOneTimeFixedTerm(subscription);
  const dailyCost = projectSubscriptionDailyCost(subscription.price, subscription, today);
  const canManualRenew = Boolean(onRenewSubscription) && isManualRenewEligible(subscription);
  const costSharingSummary = calculateCostSharingSummary(subscription.costSharing, subscription.price, {
    baseCurrency: subscription.currency,
    convert: currencyConvert,
  });
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
  const renewalLabel = isBuyout
    ? t("subscription.oneTimeMode.buyout")
    : isFixedTermOneTime
      ? t("subscription.oneTimeMode.term")
    : subscription.autoRenew
      ? t("subscription.renewal.auto")
      : t("subscription.renewal.manual");
  const nextBillingLabel =
    isBuyout
      ? t("subscription.detail.purchaseDate")
      : isFixedTermOneTime
        ? t("subscription.detail.expiryDate")
      : t("subscription.detail.nextBilling");
  const reminderLabel = subscription.reminderDays === DISABLED_REMINDER_DAYS
    ? t("subscription.card.reminderDisabled")
    : subscription.reminderDays === INHERIT_REMINDER_DAYS
      ? t("subscription.card.reminderInherit", { days: inheritedReminderDays })
      : t("reminder.days", { days: subscription.reminderDays });

  const handleEdit = () => {
    if (!onEditSubscription) return;
    // 详情和编辑都是 modal；先关详情再交给页面打开编辑，避免两个焦点陷阱同时存在。
    onClose();
    onEditSubscription(subscription);
  };

  return (
    <SubscriptionDetailScaffold
      summary={(
        <>
          <div className="min-w-0">
            <p className="truncate text-2xl font-bold text-foreground">
              {formatCurrency(subscription.price, subscription.currency)}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatBillingCycleLabel(subscription, locale)}
            </p>
            {priceReferenceLabel ? (
              <p className="truncate text-xs tabular-nums text-muted-foreground">
                {priceReferenceLabel}
              </p>
            ) : null}
          </div>
          <SubscriptionStatusBadge status={effectiveStatus} />
        </>
      )}
      facts={(
        <>
          {dailyCost !== null ? (
            <DetailRow label={t(dailyCost.basis === "ownership-to-date"
              ? "subscription.detail.dailyCostToDate"
              : "subscription.detail.dailyAverage")}>
              <span className="tabular-nums">
                {formatCompactCurrencyAmount(dailyCost.amount, subscription.currency, locale)}
              </span>
            </DetailRow>
          ) : null}
          {subscription.balance !== undefined && subscription.balanceCurrency ? (
            <DetailRow label={t("subscription.field.balance")}>
              <span className="wrap-break-word tabular-nums">
                {formatPreciseCurrency(subscription.balance, subscription.balanceCurrency, locale, 6)}
              </span>
            </DetailRow>
          ) : null}
          {costSharingSummary.enabled ? (
            <div className="grid gap-2 rounded-lg border border-border bg-secondary/40 p-3">
              <DetailRow label={t("subscription.field.price")}>
                <span className="font-semibold">{formatCurrency(costSharingSummary.total, subscription.currency)}</span>
              </DetailRow>
              <DetailRow label={t("subscription.costSharing.memberTotal")}>
                <span className="font-semibold text-warning">{formatCurrency(costSharingSummary.memberTotal, subscription.currency)}</span>
              </DetailRow>
              <DetailRow label={t("subscription.costSharing.yourShare")}>
                <span className="font-semibold text-primary">{formatCurrency(costSharingSummary.yourShare, subscription.currency)}</span>
              </DetailRow>
              <DetailRow label={t("subscription.costSharing.recoverableAmount")}>
                <span className="font-semibold">{formatCurrency(costSharingSummary.recoverableAmount, subscription.currency)}</span>
              </DetailRow>
            </div>
          ) : null}
          <DetailRow label={t("subscription.detail.category")}>
            <span className="wrap-break-word">{categoryLabel}</span>
          </DetailRow>
          {subscription.paymentMethod ? (
            <DetailRow label={t("subscription.field.paymentMethod")}>
              <span className="wrap-break-word">{paymentMethodLabel ?? subscription.paymentMethod}</span>
            </DetailRow>
          ) : null}
          {isBuyout ? (
            subscription.startDate ? (
              <DetailRow label={nextBillingLabel}>
                {formatDateOnly(subscription.startDate, "full")}
              </DetailRow>
            ) : null
          ) : (
            <DetailRow label={nextBillingLabel}>
              {formatDateOnly(subscription.nextBillingDate, "full")}
            </DetailRow>
          )}
          {subscription.startDate && !isBuyout ? (
            <DetailRow label={t("subscription.detail.startDate")}>
              {formatDateOnly(subscription.startDate, "full")}
            </DetailRow>
          ) : null}
          {subscription.trialEndDate ? (
            <DetailRow label={t("subscription.detail.trialEndDate")}>
              {formatDateOnly(subscription.trialEndDate, "full")}
            </DetailRow>
          ) : null}
          <DetailRow label={t("subscription.detail.reminder")}>
            {reminderLabel}
          </DetailRow>
          <DetailRow label={t("subscription.detail.paymentType")}>
            <Badge variant={subscription.billingCycle === "one-time" ? "secondary" : subscription.autoRenew ? "outline" : "secondary"} className="w-fit sm:ml-auto">
              {renewalLabel}
            </Badge>
          </DetailRow>
          <DetailRow label={t("subscription.detail.publicVisibility")}>
            <Badge variant={subscription.publicHidden ? "secondary" : "outline"} className="w-fit sm:ml-auto">
              {subscription.publicHidden ? t("subscription.publicVisibilityHidden") : t("subscription.publicVisibilityVisible")}
            </Badge>
          </DetailRow>
        </>
      )}
      extensions={(
        <>
          {subscription.tags.length > 0 ? (
            <DetailRow label={t("subscription.field.tags")} alignStart>
              <div className="flex flex-wrap gap-1 sm:justify-end">
                {subscription.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="max-w-full truncate text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </DetailRow>
          ) : null}
          {subscription.website ? (
            <DetailRow label={t("subscription.field.website")}>
              <a
                href={subscription.website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center justify-end gap-1 text-primary hover:underline"
              >
                <span className="truncate">{subscription.website}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </a>
            </DetailRow>
          ) : null}
          {subscription.notes ? (
            <div className="grid gap-2 border-t border-border pt-3">
              <p className="text-sm text-muted-foreground">{t("subscription.field.notes")}</p>
              <div className="whitespace-pre-wrap wrap-break-word rounded-lg border border-border bg-secondary/40 p-3 text-sm leading-6 text-foreground">
                {subscription.notes}
              </div>
            </div>
          ) : null}
        </>
      )}
      actions={(
        <>
          <Button variant="outline" className="w-full justify-center border-border sm:w-auto" onClick={onClose}>
            {t("common.close")}
          </Button>
          {!isBuyout ? (
            <Button variant="outline" className="w-full justify-center border-border sm:w-auto" onClick={onAddToCalendar}>
              <CalendarPlus className="h-4 w-4" />
              {t("subscription.addToCalendar")}
            </Button>
          ) : null}
          {canManualRenew ? (
            <Button
              variant="outline"
              className="w-full justify-center border-border sm:w-auto"
              onPointerEnter={preloadRenewSubscriptionDialog}
              onFocus={preloadRenewSubscriptionDialog}
              onTouchStart={preloadRenewSubscriptionDialog}
              onClick={() => onRenewSubscription?.(subscription.id)}
            >
              <RotateCw className="h-4 w-4" />
              {t("subscription.renew")}
            </Button>
          ) : null}
          {onEditSubscription ? (
            <Button className="w-full justify-center bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto" onClick={handleEdit}>
              <Edit2 className="h-4 w-4" />
              {t("common.edit")}
            </Button>
          ) : null}
        </>
      )}
    />
  );
}

export function SubscriptionDetailDialog({
  open,
  onOpenChange,
  subscription,
  loadingPreview,
  onEditSubscription,
  onRenewSubscription,
  today,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
  loading,
}: SubscriptionDetailDialogProps) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const { config } = useCustomConfigState();
  const { t, label } = useI18n();
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const detailFocusSessionRef = useRef(false);
  const detailClosingRef = useRef(false);
  const detailRestoreFocusRef = useRef<HTMLElement | null>(null);
  const suppressDetailFocusRestoreRef = useRef(false);
  const [showAddToCalendarDialog, setShowAddToCalendarDialog] = useState(false);
  const [calendarSubscription, setCalendarSubscription] = useState<Subscription | null>(null);
  const titleSubscription = subscription ?? loadingPreview;
  const title = titleSubscription?.name ?? t("subscription.detailFallbackTitle");
  const description = titleSubscription
    ? t("subscription.detailDescription", { name: titleSubscription.name })
    : t("subscription.detailFallbackDescription");
  const category = titleSubscription
    ? config.categories.find((item) => item.value === titleSubscription.category)
    : undefined;
  const categoryLabel = titleSubscription
    ? category ? label(category.labels) : titleSubscription.category
    : null;
  const paymentMethod = subscription?.paymentMethod
    ? config.paymentMethods.find((item) => item.value === subscription.paymentMethod)
    : undefined;
  const paymentMethodLabel = subscription?.paymentMethod
    ? paymentMethod ? label(paymentMethod.labels) : subscription.paymentMethod
    : undefined;
  const headerLogo = titleSubscription ? (
    <SubscriptionLogo
      name={titleSubscription.name}
      logo={titleSubscription.logo}
      fallbackColor={category?.color ?? DEFAULT_LOGO_FALLBACK_COLOR}
      size="md"
    />
  ) : null;
  const headerDescription = categoryLabel ? (
    <>
      <span aria-hidden="true" className="min-w-0 wrap-break-word">{categoryLabel}</span>
      <span className="sr-only">{description}</span>
    </>
  ) : description;
  const handleDetailOpenChange = (nextOpen: boolean) => {
    detailClosingRef.current = !nextOpen;
    onOpenChange(nextOpen);
  };
  const closeDetail = () => handleDetailOpenChange(false);
  const openAddToCalendar = () => {
    if (!subscription) return;
    // 添加到日历会先关闭详情；保留当前订阅快照，避免父级关闭动画清理 selected id 后子弹窗丢数据。
    suppressDetailFocusRestoreRef.current = true;
    setCalendarSubscription(subscription);
    setShowAddToCalendarDialog(true);
    closeDetail();
  };
  const handleAddToCalendarOpenChange = (nextOpen: boolean) => {
    setShowAddToCalendarDialog(nextOpen);
    if (!nextOpen) {
      setCalendarSubscription(null);
    }
  };
  const editFromDetail = (nextSubscription: Subscription) => {
    suppressDetailFocusRestoreRef.current = true;
    onEditSubscription?.(nextSubscription);
  };
  const renewFromDetail = (id: string) => {
    // 续订与编辑使用同一 modal 交接规则；关闭后的焦点回到详情原入口，而非已卸载的 footer。
    suppressDetailFocusRestoreRef.current = true;
    closeDetail();
    onRenewSubscription?.(id, detailRestoreFocusRef.current);
  };
  const detailContent = loading || subscription ? (
    <SubscriptionDetailContent
      subscription={subscription}
      loading={loading === true}
      loadingPreview={loadingPreview}
      categoryLabel={categoryLabel ?? ""}
      paymentMethodLabel={paymentMethodLabel}
      today={today}
      onClose={closeDetail}
      onAddToCalendar={openAddToCalendar}
      currencyConvert={currencyConvert}
      currencyRatesReady={currencyRatesReady}
      priceReferenceCurrency={priceReferenceCurrency}
      {...(onEditSubscription ? { onEditSubscription: editFromDetail } : {})}
      {...(onRenewSubscription ? { onRenewSubscription: renewFromDetail } : {})}
    />
  ) : null;
  // 受控 Root 没有 Trigger 引用；每次打开会话只保存一次真实入口，切换 modal 时则禁止焦点回跳背景。
  const captureDetailRestoreFocus = () => {
    if (detailFocusSessionRef.current) return;
    detailFocusSessionRef.current = true;
    detailClosingRef.current = false;
    suppressDetailFocusRestoreRef.current = false;
    detailRestoreFocusRef.current = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null;
  };
  const handleOpenAutoFocus = (event: Event) => {
    captureDetailRestoreFocus();
    if (!detailTitleRef.current) return;
    // 长详情的首个交互项可能位于正文或 footer；焦点落到标题才能保证打开时仍从顶部开始阅读。
    event.preventDefault();
    detailTitleRef.current.focus();
  };
  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    // 响应式形态切换也会卸载 Content；只有 Root 发出的真实关闭才能结束会话并恢复入口。
    if (!detailClosingRef.current) return;
    detailClosingRef.current = false;
    detailFocusSessionRef.current = false;
    const shouldRestoreFocus = !suppressDetailFocusRestoreRef.current;
    suppressDetailFocusRestoreRef.current = false;
    const restoreTarget = detailRestoreFocusRef.current;
    detailRestoreFocusRef.current = null;
    if (shouldRestoreFocus && restoreTarget?.isConnected) restoreTarget.focus();
  };

  return (
    <>
      {isMobile ? (
        <MobileDrawerRoot open={open} onOpenChange={handleDetailOpenChange} shouldScaleBackground={false}>
          {open ? (
            <MobileBottomDrawerContent
              title={title}
              description={headerDescription}
              descriptionMode={categoryLabel ? "visible" : "sr-only"}
              closeLabel={t("common.close")}
              icon={headerLogo}
              className="h-[calc(var(--app-viewport-height)-1rem)]"
              headerClassName="shrink-0 border-b border-border pb-4"
              bodyClassName={null}
              onOpenAutoFocus={captureDetailRestoreFocus}
              onCloseAutoFocus={handleCloseAutoFocus}
              aria-busy={loading ? true : undefined}
            >
              {detailContent}
            </MobileBottomDrawerContent>
          ) : null}
        </MobileDrawerRoot>
      ) : (
        <Dialog open={open} onOpenChange={handleDetailOpenChange}>
          <DialogContent
            layout="frame"
            closeLabel={t("common.close")}
            className="h5-dialog-frame gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-lg"
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
            aria-busy={loading ? true : undefined}
          >
            <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-14 text-left">
              <div className="flex min-w-0 items-start gap-3">
                {headerLogo ? <span aria-hidden="true" className="shrink-0">{headerLogo}</span> : null}
                <div className="min-w-0 flex-1">
                  <DialogTitle ref={detailTitleRef} tabIndex={-1} className="truncate text-xl outline-none">
                    {title}
                  </DialogTitle>
                  <DialogDescription className={categoryLabel ? "mt-1 min-w-0 wrap-break-word text-left leading-5" : "sr-only"}>
                    {headerDescription}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            {detailContent}
          </DialogContent>
        </Dialog>
      )}
      {showAddToCalendarDialog ? (
        <AddToCalendarDialog
          open={showAddToCalendarDialog}
          onOpenChange={handleAddToCalendarOpenChange}
          subscription={calendarSubscription}
          loadingPreview={calendarSubscription}
        />
      ) : null}
    </>
  );
}

export type { SubscriptionDetailDialogProps };
