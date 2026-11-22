import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { buildRenewalCalendarEvent, type RenewalCalendarEvent } from "@renewlet/shared/calendar-events";
import type { CalendarEvent } from "calendar-link";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";
import {
  CalendarDays,
  CalendarPlus,
  Clipboard,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MobileBottomDrawerContent, MobileDrawerRoot } from "@/components/ui/mobile-drawer";
import { Skeleton } from "@/components/ui/skeleton";
import {
  createSubscriptionCalendarLoadingSlots,
  SubscriptionCalendarFactRow,
  SubscriptionCalendarScaffold,
  type SubscriptionCalendarScaffoldSlots,
} from "@/components/subscription-calendar-scaffold";
import { toast } from "@/components/ui/sonner";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import {
  useCalendarFeedStatus,
  useCreateCalendarFeed,
  useDeleteCalendarFeed,
  useRotateCalendarFeed,
} from "@/hooks/use-calendar-feed";
import { useSettings } from "@/hooks/use-settings";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useI18n } from "@/i18n/I18nProvider";
import { addDateOnly } from "@/lib/time/date-only";
import { formatBillingCycleLabel } from "@/lib/subscription-billing";
import {
  buildAndroidCalendarIntentUrl,
  isAndroidChromeUserAgent,
  openValidatedWebcalUrl,
} from "@/shared/browser/calendar-links";
import { copyTextToClipboard, type ClipboardCopyTarget } from "@/shared/browser/clipboard";
import { downloadFile } from "@/shared/browser/download-file";
import { calendarFeedService, type CalendarFeedTarget } from "@/services/calendar-feed-service";
import {
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  type Subscription,
  type SubscriptionCollectionItem,
} from "@/types/subscription";

const providerResource = createLazyDialogResource(() =>
  import("calendar-link").then(({ google, outlook, office365, yahoo }) => ({ google, outlook, office365, yahoo })),
);

interface AddToCalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null 表示上层详情已被清理；此时不能渲染会创建 token 的子弹窗。 */
  subscription: Subscription | null;
  loadingPreview: SubscriptionCollectionItem | null;
  loading?: boolean | undefined;
}

interface SubscriptionCalendarDialogContentProps {
  open: boolean;
  subscription: Subscription | null;
  isExpiryEvent: boolean;
  loading: boolean;
  loadingLabel: string;
}

interface CalendarProviderLink {
  href: string;
  label: string;
}

type SystemCalendarActionPhase = "idle" | "opening";

export function AddToCalendarDialog({
  open,
  onOpenChange,
  subscription,
  loadingPreview,
  loading,
}: AddToCalendarDialogProps) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const { t } = useI18n();
  const desktopTitleRef = useRef<HTMLHeadingElement>(null);
  if (!subscription && !loading) return null;

  const titleSubscription = subscription ?? loadingPreview;
  const isExpiryEvent = titleSubscription?.billingCycle === "one-time";
  const title = titleSubscription
    ? isExpiryEvent
      ? t("subscription.addToCalendarExpiryTitle")
      : t("subscription.addToCalendarTitle")
    : t("subscription.addToCalendar");
  const description = titleSubscription
    ? isExpiryEvent
      ? t("subscription.addToCalendarExpiryDescription", { name: titleSubscription.name })
      : t("subscription.addToCalendarDescription", { name: titleSubscription.name })
    : t("common.loading");
  const content = (
    <SubscriptionCalendarDialogContent
      open={open}
      subscription={subscription}
      isExpiryEvent={isExpiryEvent}
      loading={loading === true}
      loadingLabel={t("common.loading")}
    />
  );

  if (isMobile) {
    return (
      <MobileDrawerRoot open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
        {open ? (
          <MobileBottomDrawerContent
            title={title}
            description={description}
            descriptionMode={titleSubscription ? "visible" : "sr-only"}
            closeLabel={t("common.close")}
            icon={<CalendarPlus className="h-5 w-5 shrink-0 text-primary" />}
            className="h-[calc(var(--app-viewport-height)-1rem)]"
            headerClassName="shrink-0 border-b border-border pb-4"
            bodyClassName={null}
            aria-busy={loading ? true : undefined}
          >
            {content}
          </MobileBottomDrawerContent>
        ) : null}
      </MobileDrawerRoot>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        layout="frame"
        closeLabel={t("common.close")}
        className="h5-dialog-frame gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-md"
        aria-busy={loading ? true : undefined}
        onOpenAutoFocus={(event) => {
          // 静态标题先接收初始焦点，避免弹窗打开即把键盘用户带到会产生外部副作用的首个日历操作。
          event.preventDefault();
          desktopTitleRef.current?.focus();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 text-left">
          <DialogTitle ref={desktopTitleRef} tabIndex={-1} className="flex items-center gap-2 text-base leading-6">
            <CalendarPlus className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 wrap-break-word">{title}</span>
          </DialogTitle>
          <DialogDescription className={titleSubscription ? "text-left leading-5" : "sr-only"}>
            {description}
          </DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

/** Feed URL 是低权限 bearer secret；所有写入都经统一 target mutation 收敛订阅弹窗与设置中心缓存。 */
function SubscriptionCalendarDialogContent({
  open,
  subscription,
  isExpiryEvent,
  loading,
  loadingLabel,
}: SubscriptionCalendarDialogContentProps) {
  const { t, locale, label, formatCurrency, formatDateOnly } = useI18n();
  const { config } = useCustomConfigState();
  const { data: settings } = useSettings();
  const [providerSession, setProviderSession] = useState(providerResource);
  const { value: providers, error: providerError } = useLazyDialogSession(open, providerSession);
  const subscriptionId = subscription?.id ?? "";
  const feedTarget = useMemo<CalendarFeedTarget>(
    () => ({ scope: "subscription", subscriptionId }),
    [subscriptionId],
  );
  const subscriptionFeedStatus = useCalendarFeedStatus(feedTarget, open && !loading && subscription !== null);
  const createSubscriptionFeed = useCreateCalendarFeed();
  const rotateSubscriptionFeed = useRotateCalendarFeed();
  const deleteSubscriptionFeed = useDeleteCalendarFeed();
  const [isDownloadingCalendar, setIsDownloadingCalendar] = useState(false);
  const [isRetryingFeedStatus, setIsRetryingFeedStatus] = useState(false);
  const [systemCalendarActionPhase, setSystemCalendarActionPhase] =
    useState<SystemCalendarActionPhase>("idle");
  const feedUrlInputRef = useRef<HTMLInputElement>(null);
  const generateFeedButtonRef = useRef<HTMLButtonElement>(null);
  const visibleFeedUrl = subscriptionFeedStatus.data?.feedUrl ?? null;
  const category = subscription
    ? config.categories.find((item) => item.value === subscription.category)
    : undefined;
  const paymentMethod = subscription?.paymentMethod
    ? config.paymentMethods.find((item) => item.value === subscription.paymentMethod)
    : undefined;
  const categoryLabel = subscription
    ? category ? label(category.labels) : subscription.category
    : "";
  const paymentMethodLabel = subscription
    ? paymentMethod ? label(paymentMethod.labels) : subscription.paymentMethod
    : undefined;
  const billingCycleLabel = subscription ? formatBillingCycleLabel(subscription, locale) : "";
  const globalReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const reminderDays = subscription
    ? subscription.reminderDays === DISABLED_REMINDER_DAYS
      ? undefined
      : subscription.reminderDays === INHERIT_REMINDER_DAYS
        ? globalReminderDays
        : subscription.reminderDays
    : undefined;

  const renewalEvent = useMemo<RenewalCalendarEvent | null>(() => {
    if (!subscription) return null;
    return buildRenewalCalendarEvent({
      subscription,
      labels: {
        amount: formatCurrency(subscription.price, subscription.currency),
        billingCycle: billingCycleLabel,
        category: categoryLabel,
        paymentMethod: paymentMethodLabel,
      },
      // “不提醒”只影响 ICS alarm；一次性下载仍保留这条续费/到期事件本身。
      reminderDays,
      text: {
        amount: ({ amount }) => t("subscription.addToCalendar.description.amount", { amount }),
        billingCycle: (cycle) => t("subscription.addToCalendar.description.billingCycle", { cycle }),
        category: (value) => t("subscription.addToCalendar.description.category", { category: value }),
        paymentMethod: (value) => t("subscription.addToCalendar.description.paymentMethod", {
          paymentMethod: value,
        }),
        notes: (notes) => t("subscription.addToCalendar.description.notes", { notes }),
      },
    });
  }, [
    billingCycleLabel,
    categoryLabel,
    formatCurrency,
    paymentMethodLabel,
    reminderDays,
    subscription,
    t,
  ]);

  const calendarEvent = useMemo<CalendarEvent | null>(() => {
    if (!subscription || !renewalEvent) return null;
    const event: CalendarEvent = {
      allDay: true,
      busy: false,
      description: renewalEvent.description,
      end: addDateOnly(subscription.nextBillingDate, { days: 1 }),
      start: subscription.nextBillingDate,
      title: subscription.name,
      uid: renewalEvent.uid,
    };
    if (subscription.website) {
      event.url = subscription.website;
    }
    return event;
  }, [
    renewalEvent,
    subscription,
  ]);

  const links = useMemo<CalendarProviderLink[]>(() => {
    if (!calendarEvent || !providers) return [];
    return [
      { href: providers.google(calendarEvent), label: t("subscription.addToCalendarGoogle") },
      { href: providers.outlook(calendarEvent), label: t("subscription.addToCalendarOutlook") },
      { href: providers.office365(calendarEvent), label: t("subscription.addToCalendarOffice365") },
      { href: providers.yahoo(calendarEvent), label: t("subscription.addToCalendarYahoo") },
    ];
  }, [
    calendarEvent,
    providers,
    t,
  ]);

  const androidSystemCalendarHref = useMemo(() => {
    // Android 的备用地址来自 Google Calendar；链接模块就绪后才暴露可跳转的 intent，ICS 与订阅源独立可用。
    if (!subscription || !renewalEvent || !links[0]) return undefined;
    return buildAndroidCalendarIntentUrl({
      title: subscription.name,
      description: renewalEvent.description,
      startDate: subscription.nextBillingDate,
      endDate: addDateOnly(subscription.nextBillingDate, { days: 1 }),
      fallbackUrl: links[0].href,
    });
  }, [links, renewalEvent, subscription]);

  const handleGenerateFeed = useCallback(async () => {
    if (!subscription || createSubscriptionFeed.isPending) return;
    try {
      await createSubscriptionFeed.mutateAsync(feedTarget);
      toast.success(t("subscription.addToCalendarFeedGenerated"));
    } catch {
      toast.error(t("subscription.addToCalendarFeedGenerateFailed"));
    }
  }, [createSubscriptionFeed, feedTarget, subscription, t]);

  const handleOpenExistingFeed = useCallback(async () => {
    if (!visibleFeedUrl || systemCalendarActionPhase !== "idle") return;
    setSystemCalendarActionPhase("opening");
    try {
      await openValidatedWebcalUrl(visibleFeedUrl);
      toast.success(t("subscription.addToCalendarOpenSystemResult"));
    } catch {
      toast.error(t("subscription.addToCalendarOpenSystemFailed"), {
        description: t("subscription.addToCalendarOpenSystemFailedDescription"),
      });
    } finally {
      setSystemCalendarActionPhase("idle");
    }
  }, [systemCalendarActionPhase, visibleFeedUrl, t]);

  const handleRegenerate = useCallback(async () => {
    if (
      !subscription
      || rotateSubscriptionFeed.isPending
      || systemCalendarActionPhase !== "idle"
    ) {
      return false;
    }
    try {
      await rotateSubscriptionFeed.mutateAsync(feedTarget);
      toast.success(t("subscription.addToCalendarRegenerated"));
      return true;
    } catch {
      toast.error(t("subscription.addToCalendarRegenerateFailed"));
      return false;
    }
  }, [feedTarget, rotateSubscriptionFeed, subscription, systemCalendarActionPhase, t]);

  const handleRevoke = useCallback(async () => {
    if (
      !subscription
      || deleteSubscriptionFeed.isPending
      || systemCalendarActionPhase !== "idle"
    ) {
      return false;
    }
    try {
      await deleteSubscriptionFeed.mutateAsync(feedTarget);
      toast.success(t("subscription.addToCalendarRevoked"));
      return true;
    } catch {
      toast.error(t("subscription.addToCalendarRevokeFailed"));
      return false;
    }
  }, [deleteSubscriptionFeed, feedTarget, subscription, systemCalendarActionPhase, t]);

  const handleCopyFeedUrl = useCallback(async (target?: ClipboardCopyTarget | null) => {
    if (!visibleFeedUrl) return;
    const copyResult = await copyTextToClipboard(visibleFeedUrl, { target });
    if (copyResult.ok) {
      toast.success(t("subscription.addToCalendarFeedUrlCopied"));
      return;
    }
    toast.error(t("subscription.addToCalendarFeedUrlCopyFailed"), {
      description: t("subscription.addToCalendarFeedUrlCopyFailedDescription"),
    });
  }, [visibleFeedUrl, t]);

  const handleDownload = useCallback(async () => {
    if (!subscription) return;
    setIsDownloadingCalendar(true);
    try {
      const ics = await calendarFeedService.downloadSubscriptionIcs(subscription.id);
      downloadFile(ics, `renewlet-${safeCalendarFilename(subscription.id)}.ics`);
      toast.success(t("subscription.addToCalendarDownloaded"));
    } catch {
      toast.error(t("subscription.addToCalendarDownloadFailed"));
    } finally {
      setIsDownloadingCalendar(false);
    }
  }, [subscription, t]);

  const handleRetryFeedStatus = async () => {
    if (isRetryingFeedStatus) return;
    setIsRetryingFeedStatus(true);
    try {
      await subscriptionFeedStatus.refetch();
    } finally {
      setIsRetryingFeedStatus(false);
    }
  };

  let scaffoldSlots: SubscriptionCalendarScaffoldSlots;
  if (loading || !subscription || !renewalEvent) {
    scaffoldSlots = createSubscriptionCalendarLoadingSlots(loadingLabel);
  } else {
    const hasFeedStatusData = subscriptionFeedStatus.data !== undefined;
    // 首次 query 只决定动作类型；mutation 才进入按钮 busy，有缓存的后台刷新不能让已知操作退回占位态。
    const isFeedStatusUnavailable = !hasFeedStatusData
      && (subscriptionFeedStatus.isError || isRetryingFeedStatus);
    const isFeedStatusPending = !hasFeedStatusData && !isFeedStatusUnavailable;
    const isSystemCalendarActionPending = systemCalendarActionPhase !== "idle";
    const isFeedMutationPending = createSubscriptionFeed.isPending
      || rotateSubscriptionFeed.isPending
      || deleteSubscriptionFeed.isPending;
    const syncStatus = isFeedStatusPending
      ? t("subscription.addToCalendarSyncLoading")
      : isFeedStatusUnavailable
        ? t("subscription.addToCalendarSyncFailed")
        : visibleFeedUrl
          ? t("subscription.addToCalendarSyncEnabled")
          : t("subscription.addToCalendarSyncDisabled");
    scaffoldSlots = {
      facts: (
        <>
          <SubscriptionCalendarFactRow
            icon={<CalendarDays className="h-4 w-4 text-primary" />}
            label={t("subscription.addToCalendarEventDate")}
            value={formatDateOnly(subscription.nextBillingDate, "full")}
            strong
          />
          <SubscriptionCalendarFactRow
            label={t("subscription.addToCalendarEventType")}
            value={isExpiryEvent
              ? t("subscription.addToCalendarExpiryEvent")
              : t("subscription.addToCalendarRenewalEvent")}
          />
          <SubscriptionCalendarFactRow
            label={t("subscription.addToCalendarSyncStatus")}
            value={syncStatus}
          />
        </>
      ),
      syncHeading: (
        <h3 className="text-sm font-medium text-foreground">
          {t("subscription.addToCalendarContinuousSync")}
        </h3>
      ),
      syncContent: isFeedStatusPending ? (
        <div role="status" data-testid="subscription-calendar-feed-status-loading">
          <span className="sr-only">{t("subscription.addToCalendarFeedStatusLoading")}</span>
          <Skeleton aria-hidden="true" className="h-11 w-full" />
        </div>
      ) : isFeedStatusUnavailable ? (
        <div
          role="alert"
          className="flex min-h-11 flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{t("subscription.addToCalendarFeedStatusFailed")}</span>
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0 justify-center border-destructive/30"
            onClick={() => void handleRetryFeedStatus()}
            disabled={isRetryingFeedStatus}
            aria-busy={isRetryingFeedStatus ? true : undefined}
          >
            <RefreshCw className={isRetryingFeedStatus ? "animate-spin" : undefined} />
            {isRetryingFeedStatus
              ? t("subscription.addToCalendarFeedStatusRetrying")
              : t("subscription.addToCalendarFeedStatusRetry")}
          </Button>
        </div>
      ) : visibleFeedUrl ? (
        <div className="grid min-w-0 gap-3">
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              ref={feedUrlInputRef}
              value={visibleFeedUrl}
              readOnly
              className="min-w-0 border-border bg-secondary font-mono text-xs"
              aria-label={t("subscription.addToCalendarFeedUrl")}
            />
            <Button
              type="button"
              variant="outline"
              className="h-11 justify-center border-border"
              onClick={() => void handleCopyFeedUrl(feedUrlInputRef.current)}
              disabled={isFeedMutationPending}
            >
              <Clipboard className="h-4 w-4" />
              {t("subscription.addToCalendarCopyFeedUrl")}
            </Button>
          </div>
          <div className="flex min-w-0 flex-col gap-2 min-[480px]:flex-row min-[480px]:flex-wrap">
            <Button
              type="button"
              variant="outline"
              className="h-11 justify-center border-border"
              onClick={() => void handleOpenExistingFeed()}
              disabled={isSystemCalendarActionPending || isFeedMutationPending}
              aria-busy={isSystemCalendarActionPending ? true : undefined}
            >
              {isSystemCalendarActionPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <CalendarPlus className="h-4 w-4" />}
              {isSystemCalendarActionPending
                ? t("subscription.addToCalendarOpenSystemLoading")
                : t("subscription.addToCalendarSubscribeSystem")}
            </Button>
            <CalendarFeedConfirmAction
              icon={<RefreshCw className="h-4 w-4" />}
              triggerLabel={t("subscription.addToCalendarRegenerate")}
              title={t("subscription.addToCalendarRegenerateTitle")}
              description={t("subscription.addToCalendarRegenerateDescription")}
              confirmLabel={t("subscription.addToCalendarRegenerate")}
              loadingLabel={t("subscription.addToCalendarRegenerateLoading")}
              pending={rotateSubscriptionFeed.isPending}
              disabled={isSystemCalendarActionPending || isFeedMutationPending}
              onConfirm={handleRegenerate}
            />
            <CalendarFeedConfirmAction
              icon={<Trash2 className="h-4 w-4" />}
              triggerLabel={t("subscription.addToCalendarRevoke")}
              title={t("subscription.addToCalendarRevokeTitle")}
              description={t("subscription.addToCalendarRevokeDescription")}
              confirmLabel={t("subscription.addToCalendarRevoke")}
              loadingLabel={t("subscription.addToCalendarRevokeLoading")}
              pending={deleteSubscriptionFeed.isPending}
              disabled={isSystemCalendarActionPending || isFeedMutationPending}
              onConfirm={handleRevoke}
              replacementFocusRef={generateFeedButtonRef}
              destructive
            />
          </div>
        </div>
      ) : (
        <Button
          ref={generateFeedButtonRef}
          type="button"
          variant="default"
          className="h-11 w-full justify-center"
          onClick={() => void handleGenerateFeed()}
          disabled={createSubscriptionFeed.isPending}
          aria-busy={createSubscriptionFeed.isPending ? true : undefined}
        >
          {createSubscriptionFeed.isPending
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <CalendarPlus className="h-4 w-4" />}
          {createSubscriptionFeed.isPending
            ? t("subscription.addToCalendarGenerateFeedLoading")
            : t("subscription.addToCalendarGenerateFeed")}
        </Button>
      ),
      oneTimeHeading: (
        <h3 className="text-sm font-medium text-foreground">
          {t("subscription.addToCalendarOneTimeAdd")}
        </h3>
      ),
      oneTimeActions: (
        <>
          {isAndroidChromeUserAgent() && androidSystemCalendarHref ? (
            <Button variant="outline" asChild className="h-11 justify-center border-border">
              <a href={androidSystemCalendarHref} rel="noopener noreferrer">
                <CalendarPlus className="h-4 w-4" />
                {t("subscription.addToCalendarAndroidSingleEvent")}
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-11 justify-center border-border"
            onClick={() => void handleDownload()}
            disabled={isDownloadingCalendar}
            aria-busy={isDownloadingCalendar ? true : undefined}
          >
            {isDownloadingCalendar
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Download className="h-4 w-4" />}
            {t("subscription.addToCalendarDownloadIcs")}
          </Button>
        </>
      ),
      notice: (
        <p className="text-xs leading-5 text-muted-foreground">
          {t("subscription.addToCalendarOneTimeIndependentNotice")}
        </p>
      ),
      providerHeading: (
        <p className="text-xs font-medium uppercase text-muted-foreground">
          {t("subscription.addToCalendarOnlineServices")}
        </p>
      ),
      providers: providerError ? (
        <Button type="button" variant="ghost" onClick={() => setProviderSession({ ...providerResource })}>
          {t("system.retry")}
        </Button>
      ) : !providers ? createSubscriptionCalendarLoadingSlots(loadingLabel).providers : (
        <>
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm text-foreground transition-colors last:border-b-0 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span className="truncate">{link.label}</span>
              <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          ))}
        </>
      ),
    };
  }

  return (
    <SubscriptionCalendarScaffold
      {...scaffoldSlots}
      data-testid={loading ? "subscription-calendar-data-loading" : undefined}
    />
  );
}

function safeCalendarFilename(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "subscription";
}

function CalendarFeedConfirmAction({
  icon,
  triggerLabel,
  title,
  description,
  confirmLabel,
  loadingLabel,
  destructive = false,
  onConfirm,
  replacementFocusRef,
  pending,
  disabled,
}: {
  icon: ReactNode;
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  loadingLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<boolean>;
  replacementFocusRef?: RefObject<HTMLButtonElement | null>;
  pending: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) setOpen(nextOpen);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant={destructive ? "ghost" : "outline"}
          className={destructive
            ? "h-11 text-destructive hover:text-destructive"
            : "h-11 border-border"}
          disabled={disabled}
        >
          {icon}
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={replacementFocusRef ? (event) => {
          const replacement = replacementFocusRef.current;
          // 成功撤销会卸载原触发按钮；取消时替代项不存在，必须保留 Radix 的 Trigger 恢复路径。
          if (!replacement) return;
          event.preventDefault();
          replacement.focus();
        } : undefined}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11" disabled={pending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void onConfirm().then((succeeded) => {
                if (succeeded) setOpen(false);
              });
            }}
            disabled={pending}
            aria-busy={pending ? true : undefined}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {pending ? loadingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
