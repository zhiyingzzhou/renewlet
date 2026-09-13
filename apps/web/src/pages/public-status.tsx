import { useEffect, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  CalendarClock,
  Clock3,
  CreditCard,
  Eye,
  EyeOff,
  Gauge,
  Monitor,
  Moon,
  Sun,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { useParams } from "react-router";
import { SubscriptionLogo } from "@/components/subscription-logo";
import { SubscriptionStatusBadge } from "@/components/subscription-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { TruncatedTooltipText } from "@/components/ui/truncated-tooltip-text";
import { ApiError } from "@/lib/api-client";
import { colorWithAlpha } from "@/lib/color";
import { formatCompactCurrencyAmount } from "@/lib/currency";
import { useTheme } from "@/lib/theme-provider";
import { daysBetweenDateOnly } from "@/lib/time/date-only";
import { usePublicStatus } from "@/hooks/use-public-status-page";
import { useExchangeRates } from "@/hooks/use-exchange-rates";
import { useI18n } from "@/i18n/I18nProvider";
import { useRouteReady } from "@/components/route-progress";
import type { Locale } from "@/i18n/locales";
import type { MessageKey } from "@/i18n/messages";
import {
  formatBillingCycleLabel,
  isOneTimeBuyout,
  projectSubscriptionDailyCost,
  toDailyAmountFromMonthly,
  toMonthlyAmount,
} from "@/lib/subscription-billing";
import type { PublicStatusResponse } from "@/lib/api/schemas/public-status";
import type { ThemeMode } from "@/types/theme";
import { moneyToNumber } from "@renewlet/shared/money";

type PublicStatusSubscription = PublicStatusResponse["subscriptions"][number];
type PublicStatusExchangeRateBasis = NonNullable<PublicStatusResponse["page"]["exchangeRateBasis"]>;
type PublicStatusCurrencyConverter = (amount: number | string, fromCurrency: string, toCurrency: string) => number;

interface PublicStatusThemeOption {
  value: ThemeMode;
  labelKey: MessageKey;
  Icon: LucideIcon;
}

const SYSTEM_PUBLIC_STATUS_THEME_OPTION: PublicStatusThemeOption = {
  value: "system",
  labelKey: "theme.system",
  Icon: Monitor,
};

const PUBLIC_STATUS_THEME_OPTIONS: PublicStatusThemeOption[] = [
  { value: "light", labelKey: "theme.light", Icon: Sun },
  { value: "dark", labelKey: "theme.dark", Icon: Moon },
  SYSTEM_PUBLIC_STATUS_THEME_OPTION,
];

function useNoIndexMeta() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Renewlet Status";

    const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousContent = existing?.getAttribute("content") ?? null;
    const meta = existing ?? document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex,nofollow");
    if (!existing) document.head.appendChild(meta);

    return () => {
      document.title = previousTitle;
      if (existing) {
        if (previousContent === null) {
          existing.removeAttribute("content");
        } else {
          existing.setAttribute("content", previousContent);
        }
      } else {
        meta.remove();
      }
    };
  }, []);
}

function PublicStatusFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app-page bg-background">
      <main className="app-main mx-auto max-w-7xl">
        {children}
      </main>
    </div>
  );
}

function PublicStatusLoading() {
  return (
    <PublicStatusFrame>
      <div className="grid gap-8">
        <div className="mb-1">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="mt-2 h-4 w-64 max-w-full" />
        </div>
        <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-44 rounded-xl" />
          ))}
        </div>
      </div>
    </PublicStatusFrame>
  );
}

function PublicStatusThemeMenu() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const currentOption = PUBLIC_STATUS_THEME_OPTIONS.find((option) => option.value === theme)
    ?? SYSTEM_PUBLIC_STATUS_THEME_OPTION;
  const CurrentIcon = currentOption.Icon;

  const handleThemeChange = (value: string) => {
    if (value === "light" || value === "dark" || value === "system") {
      setTheme(value);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("header.toggleTheme")}
          className="h-10 w-10 shrink-0 border border-border bg-card/80 text-muted-foreground hover:bg-card-hover hover:text-foreground focus-visible:ring-ring sm:h-9 sm:w-9"
          size="icon"
          variant="ghost"
        >
          <CurrentIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup value={theme} onValueChange={handleThemeChange}>
          {PUBLIC_STATUS_THEME_OPTIONS.map(({ value, labelKey, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span>{t(labelKey)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PublicStatusHeader({ data }: { data: PublicStatusResponse }) {
  const { t, formatDateTime } = useI18n();

  return (
    <header className="mb-8 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-foreground">{t("publicStatus.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("publicStatus.headerMeta", { time: formatDateTime(data.page.generatedAt) })}
        </p>
      </div>
      <PublicStatusThemeMenu />
    </header>
  );
}

function PublicStatusError({ notFound }: { notFound: boolean }) {
  const { t } = useI18n();
  return (
    <PublicStatusFrame>
      <div className="mx-auto flex min-h-[calc(var(--app-viewport-height)-8rem)] max-w-lg flex-col items-center justify-center px-4 py-12 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">
          {notFound ? t("publicStatus.notFoundTitle") : t("publicStatus.errorTitle")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {notFound ? t("publicStatus.notFoundDescription") : t("publicStatus.errorDescription")}
        </p>
      </div>
    </PublicStatusFrame>
  );
}

function publicSubscriptionBillingProjection(subscription: PublicStatusSubscription) {
  const billingCycle = subscription.billingCycle;
  if (!billingCycle) return null;
  return {
    billingCycle,
    customDays: subscription.customDays,
    customCycleUnit: subscription.customCycleUnit,
    oneTimeTermCount: subscription.oneTimeTermCount,
    oneTimeTermUnit: subscription.oneTimeTermUnit,
    startDate: subscription.startDate,
  };
}

function publicStatusStats(data: PublicStatusResponse) {
  return data.subscriptions.reduce(
    (counts, subscription) => {
      const isActiveLike = subscription.status === "active" || subscription.status === "trial";
      const billing = publicSubscriptionBillingProjection(subscription);
      const contributesMonthlyCost = isActiveLike
        && billing !== null
        && !isOneTimeBuyout(billing);
      const daysUntilBilling = subscription.nextBillingDate === null
        ? null
        : daysBetweenDateOnly(data.page.asOf, subscription.nextBillingDate);
      return {
        visible: counts.visible + 1,
        active: counts.active + (isActiveLike ? 1 : 0),
        monthlyCost: counts.monthlyCost + (contributesMonthlyCost ? 1 : 0),
        upcoming: counts.upcoming + (isActiveLike && daysUntilBilling !== null && daysUntilBilling >= 0 && daysUntilBilling <= 7 ? 1 : 0),
        inactive: counts.inactive + (["expired", "paused", "cancelled"].includes(subscription.status) ? 1 : 0),
      };
    },
    { visible: 0, active: 0, monthlyCost: 0, upcoming: 0, inactive: 0 },
  );
}

function publicStatusMonthlyTotal(
  data: PublicStatusResponse,
  convert: (amount: number | string, from: string, to: string) => number,
) {
  const targetCurrency = data.page.currency;
  if (!data.page.showPrices || !targetCurrency) return 0;
  return data.subscriptions.reduce((sum, subscription) => {
    if (subscription.status !== "active" && subscription.status !== "trial") return sum;
    const billing = publicSubscriptionBillingProjection(subscription);
    if (subscription.price === undefined || !subscription.currency || !billing) {
      return sum;
    }
    if (isOneTimeBuyout(billing)) return sum;
    const amount = convert(subscription.price, subscription.currency, targetCurrency);
    const monthly = toMonthlyAmount(
      amount,
      billing.billingCycle,
      billing.customDays,
      billing.customCycleUnit,
      billing.oneTimeTermCount,
      billing.oneTimeTermUnit,
    );
    return Number.isFinite(monthly) ? sum + monthly : sum;
  }, 0);
}

function publicStatusConverterFromBasis(basis: PublicStatusExchangeRateBasis | undefined) {
  if (!basis || basis.status !== "locked") return null;
  return (amount: number | string, fromCurrency: string, toCurrency: string): number => {
    const numericAmount = moneyToNumber(amount);
    if (fromCurrency === toCurrency) return numericAmount;
    const fromRate = basis.rates[fromCurrency] || 1;
    const toRate = basis.rates[toCurrency] || 1;
    return (numericAmount / fromRate) * toRate;
  };
}

function PublicStatusSummary({ data }: { data: PublicStatusResponse }) {
  if (data.page.showPrices && data.page.currency) {
    return <PublicStatusMoneySummary data={data} />;
  }
  return <PublicStatusCountSummary data={data} />;
}

function PublicStatusMoneySummary({ data }: { data: PublicStatusResponse }) {
  const { t, formatCurrency, formatNumber } = useI18n();
  const lockedConvert = publicStatusConverterFromBasis(data.page.exchangeRateBasis);
  if (lockedConvert) {
    // 匿名公开页拿到 locked basis 时不能再挂实时汇率 hook；否则快照口径仍会触发浏览器直连外部 provider。
    return (
      <PublicStatusMoneyCards
        data={data}
        convert={lockedConvert}
        moneySubtitle={t("publicStatus.moneySubtitleLocked", { month: data.page.exchangeRateBasis?.month ?? "" })}
        formatCurrency={formatCurrency}
        formatNumber={formatNumber}
      />
    );
  }

  return <PublicStatusLiveMoneySummary data={data} />;
}

function PublicStatusLiveMoneySummary({ data }: { data: PublicStatusResponse }) {
  const { t, formatCurrency, formatNumber } = useI18n();
  const { convert, loading: ratesLoading } = useExchangeRates();
  const currency = data.page.currency;
  if (!currency) return null;
  const moneySubtitle = ratesLoading
    ? t("publicStatus.ratesLoading")
    : data.page.exchangeRateBasis?.status === "live"
      ? t("publicStatus.moneySubtitleLive", { currency })
      : t("publicStatus.moneySubtitle", { currency });

  return (
    <PublicStatusMoneyCards
      data={data}
      convert={convert}
      moneySubtitle={moneySubtitle}
      formatCurrency={formatCurrency}
      formatNumber={formatNumber}
    />
  );
}

function PublicStatusMoneyCards({
  data,
  convert,
  moneySubtitle,
  formatCurrency,
  formatNumber,
}: {
  data: PublicStatusResponse;
  convert: PublicStatusCurrencyConverter;
  moneySubtitle: string;
  formatCurrency: ReturnType<typeof useI18n>["formatCurrency"];
  formatNumber: ReturnType<typeof useI18n>["formatNumber"];
}) {
  const stats = publicStatusStats(data);
  const monthlyTotal = publicStatusMonthlyTotal(data, convert);
  const currency = data.page.currency;
  const { t, locale } = useI18n();
  if (!currency) return null;
  // 公开汇总日均必须复用已按 locked/live 口径算出的月均，不能再次换汇形成第二套匿名页金额结果。
  const dailyTotal = toDailyAmountFromMonthly(monthlyTotal);
  const monthlySubtitle = t("publicStatus.monthlyTotalSubtitle", {
    amount: formatCompactCurrencyAmount(dailyTotal, currency, locale),
    basis: moneySubtitle,
  });

  return (
    <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
      <StatCard
        title={t("publicStatus.monthlyTotal")}
        value={formatCurrency(monthlyTotal, currency)}
        subtitle={monthlySubtitle}
        icon={<CreditCard className="h-6 w-6" />}
        variant="primary"
        className="animate-fade-in"
      />
      <StatCard
        title={t("publicStatus.annualTotal")}
        value={formatCurrency(monthlyTotal * 12, currency)}
        subtitle={moneySubtitle}
        icon={<TrendingUp className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:100ms]"
      />
      <StatCard
        title={t("publicStatus.visibleCount")}
        value={formatNumber(stats.visible)}
        subtitle={t("publicStatus.visibleMoneySubtitle", { count: formatNumber(stats.monthlyCost) })}
        icon={<Eye className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:200ms]"
      />
      <StatCard
        title={t("publicStatus.upcomingCount")}
        value={formatNumber(stats.upcoming)}
        subtitle={t("publicStatus.upcomingSubtitle")}
        icon={<CalendarClock className="h-6 w-6" />}
        variant={stats.upcoming > 0 ? "warning" : "default"}
        className="animate-fade-in [animation-delay:300ms]"
      />
    </div>
  );
}

function PublicStatusCountSummary({ data }: { data: PublicStatusResponse }) {
  const { t, formatNumber } = useI18n();
  const stats = publicStatusStats(data);

  return (
    <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
      <StatCard
        title={t("publicStatus.visibleCount")}
        value={formatNumber(stats.visible)}
        icon={<Eye className="h-6 w-6" />}
        variant="primary"
        className="animate-fade-in"
      />
      <StatCard
        title={t("publicStatus.activeCount")}
        value={formatNumber(stats.active)}
        icon={<Activity className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:100ms]"
      />
      <StatCard
        title={t("publicStatus.upcomingCount")}
        value={formatNumber(stats.upcoming)}
        subtitle={t("publicStatus.upcomingSubtitle")}
        icon={<CalendarClock className="h-6 w-6" />}
        variant={stats.upcoming > 0 ? "warning" : "default"}
        className="animate-fade-in [animation-delay:200ms]"
      />
      <StatCard
        title={t("publicStatus.inactiveCount")}
        value={formatNumber(stats.inactive)}
        subtitle={t("publicStatus.inactiveSubtitle")}
        icon={<AlertCircle className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:300ms]"
      />
    </div>
  );
}

function publicBillingCycleLabel(subscription: PublicStatusSubscription, locale: Locale) {
  const billing = publicSubscriptionBillingProjection(subscription);
  return billing ? formatBillingCycleLabel(billing, locale) : null;
}

function publicSubscriptionDailyCost(subscription: PublicStatusSubscription, asOf: string) {
  // 单条日均只能从 showPrices 后的公开价格投影派生；字段缺失时不得补默认值或读取私有 Subscription。
  const billing = publicSubscriptionBillingProjection(subscription);
  if (subscription.price === undefined || !subscription.currency || !billing) return null;
  return projectSubscriptionDailyCost(subscription.price, billing, asOf);
}

function PublicSubscriptionCard({ subscription, asOf }: { subscription: PublicStatusSubscription; asOf: string }) {
  const { t, locale, formatCurrency, formatDateOnly, formatDateTime } = useI18n();
  const categoryColor = subscription.category.color ?? "hsl(var(--primary))";
  const billingCycleLabel = publicBillingCycleLabel(subscription, locale);
  const dailyCost = publicSubscriptionDailyCost(subscription, asOf);
  // billingCycle 在 showPrices=false 时必须隐藏；nextBillingDate=null 是公开 allowlist 保留的买断日期语义。
  const isProjectedBuyout = subscription.nextBillingDate === null;
  const categoryStyle = {
    backgroundColor: colorWithAlpha(categoryColor, 0.1) ?? undefined,
    borderColor: colorWithAlpha(categoryColor, 0.2) ?? undefined,
    color: categoryColor,
  };

  // 公开 API 只有 allowlist 字段；这里复用视觉原语而不是伪造完整 Subscription，避免私有字段被带入公开组件。
  return (
    <article className="group h-full overflow-hidden rounded-xl border border-border bg-card p-5 shadow-card transition-all duration-300 hover:bg-card-hover">
      <div className="flex items-start gap-4">
        <SubscriptionLogo
          name={subscription.name}
          logo={subscription.logo}
          fallbackColor={categoryColor}
          size="md"
        />

        <div className="grid min-w-0 flex-1 gap-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="min-w-0">
              <TruncatedTooltipText
                as="h2"
                text={subscription.name}
                className="min-w-0 font-semibold text-foreground"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("publicStatus.updatedAt", { time: formatDateTime(subscription.updatedAt) })}
              </p>
            </div>
            {subscription.price !== undefined && subscription.currency ? (
              <div className="shrink-0 text-right">
                <p className="whitespace-nowrap text-xl font-bold text-foreground">
                  {formatCurrency(subscription.price, subscription.currency)}
                </p>
                {billingCycleLabel ? (
                  <p className="text-xs text-muted-foreground">{billingCycleLabel}</p>
                ) : null}
              </div>
            ) : null}

            <div className="col-span-full flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="max-w-full shrink-0 overflow-hidden whitespace-nowrap text-xs"
                style={categoryStyle}
              >
                <TruncatedTooltipText text={subscription.category.label} className="block max-w-full" />
              </Badge>
              <SubscriptionStatusBadge status={subscription.status} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {dailyCost !== null && subscription.currency ? (
              <div className="flex items-center gap-1.5 tabular-nums text-muted-foreground">
                <Gauge className="h-3.5 w-3.5" />
                <span className="text-xs">
                  {t(dailyCost.basis === "ownership-to-date"
                    ? "publicStatus.subscriptionDailyCostToDate"
                    : "publicStatus.subscriptionDailyAverage", {
                    amount: formatCompactCurrencyAmount(dailyCost.amount, subscription.currency, locale),
                  })}
                </span>
              </div>
            ) : null}
            {subscription.startDate ? (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                <span className="text-xs">
                  {t(isProjectedBuyout ? "publicStatus.purchaseDate" : "publicStatus.startDate", {
                    date: formatDateOnly(subscription.startDate),
                  })}
                </span>
              </div>
            ) : null}
            {subscription.nextBillingDate ? <div className="flex items-center gap-1.5 text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              <span className="text-xs">
                {t("publicStatus.nextBillingDate", { date: formatDateOnly(subscription.nextBillingDate) })}
              </span>
            </div> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function PublicStatusPage() {
  useNoIndexMeta();
  const { token } = useParams<{ token: string }>();
  const query = usePublicStatus(token);
  useRouteReady(query.isPending);
  const { t } = useI18n();

  if (query.isPending) {
    return <PublicStatusLoading />;
  }

  if (query.isError || !query.data) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return <PublicStatusError notFound={notFound} />;
  }

  const data = query.data;

  return (
    <PublicStatusFrame>
      <PublicStatusHeader data={data} />

      <div className="grid gap-8">
        <PublicStatusSummary data={data} />

        {data.page.truncated ? (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {t("publicStatus.truncated")}
          </div>
        ) : null}

        {data.subscriptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <EyeOff className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-lg font-medium text-foreground">{t("publicStatus.emptyTitle")}</h2>
          </div>
        ) : (
          <section className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]" aria-label={t("publicStatus.listLabel")}>
            {data.subscriptions.map((subscription, index) => (
              <div
                key={`${subscription.name}-${subscription.startDate ?? "unknown"}-${subscription.nextBillingDate ?? "buyout"}-${index}`}
                className="h-full animate-fade-in"
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <PublicSubscriptionCard subscription={subscription} asOf={data.page.asOf} />
              </div>
            ))}
          </section>
        )}
      </div>
    </PublicStatusFrame>
  );
}
