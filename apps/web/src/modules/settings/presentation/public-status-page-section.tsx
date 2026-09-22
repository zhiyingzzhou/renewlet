import { useEffect, useRef, useState } from "react";
import { Clipboard, ExternalLink, Globe2, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useI18n } from "@/i18n/I18nProvider";
import type { ClipboardCopyTarget } from "@/shared/browser/clipboard";
import { LoadingButtonContent } from "./settings-shared-controls";
import { getSettingsSectionClassName } from "./settings-layout";
import type { PublicStatusPage } from "@/lib/api/schemas/public-status";
import type { SettingsReadState } from "../application/settings-read-state";
import { ManagerDataBoundary } from "./manager-data-boundary";
import { SettingsSectionHeader } from "./settings-section-header";

interface PublicStatusPageSectionProps {
  id?: string;
  className?: string;
  status: SettingsReadState<PublicStatusPage>;
  visibility: SettingsReadState<{ visibleCount: number; hiddenCount: number; expiredCount: number; lifetimeCount: number }>;
  publicStatusCurrency: string;
  effectivePublicStatusCurrency: string;
  publicStatusCurrencyOptions: SearchableSelectOption[];
  isCreating: boolean;
  isDeleting: boolean;
  isUpdating: boolean;
  onCreate: () => void | Promise<void>;
  onCopy: (target?: ClipboardCopyTarget | null) => void | Promise<void>;
  onDelete: () => void | Promise<boolean>;
  onOpenPage: () => void | Promise<void>;
  onRegenerate: () => void | Promise<boolean>;
  onShowPricesChange: (checked: boolean) => void | Promise<void>;
  onHideExpiredChange: (checked: boolean) => void | Promise<void>;
  onHideLifetimeChange: (checked: boolean) => void | Promise<void>;
  onManageVisibility: () => void;
  onBulkPublicVisibility: (categories: Array<"expired" | "lifetime">, publicHidden: boolean, dryRun?: boolean) => Promise<{ matchedCount: number; changedCount: number }>;
  onPublicStatusCurrencyChange: (value: string) => void | Promise<void>;
}

interface PublicStatusLinkRowProps {
  pageUrl: string;
  busy: boolean;
  urlLabel: string;
  copyLabel: string;
  openLabel: string;
  helpText: string;
  onCopy: (target?: ClipboardCopyTarget | null) => void | Promise<void>;
  onOpenPage: () => void | Promise<void>;
}

function PublicStatusLinkRow({
  pageUrl,
  busy,
  urlLabel,
  copyLabel,
  openLabel,
  helpText,
  onCopy,
  onOpenPage,
}: PublicStatusLinkRowProps) {
  const pageUrlInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="grid gap-2">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <Input ref={pageUrlInputRef} value={pageUrl} readOnly className="h-9 border-border bg-secondary font-mono text-xs" aria-label={urlLabel} />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void onCopy(pageUrlInputRef.current);
            }}
            disabled={busy}
            className="justify-center gap-2 border-border"
          >
            <Clipboard className="h-4 w-4" />
            {copyLabel}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onOpenPage} disabled={busy} className="justify-center gap-2 border-border">
            <ExternalLink className="h-4 w-4" />
            {openLabel}
          </Button>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{helpText}</p>
    </div>
  );
}

/**
 * 管理公开展示页的私密 URL。
 *
 * 公开页 token 是可撤销 bearer secret；UI 只展示完整链接和开关，不把 token 拆到其它状态里。
 */
export function PublicStatusPageSection({
  id,
  className,
  status,
  visibility,
  publicStatusCurrency,
  effectivePublicStatusCurrency,
  publicStatusCurrencyOptions,
  isCreating,
  isDeleting,
  isUpdating,
  onCreate,
  onCopy,
  onDelete,
  onOpenPage,
  onRegenerate,
  onShowPricesChange,
  onHideExpiredChange,
  onHideLifetimeChange,
  onManageVisibility,
  onBulkPublicVisibility,
  onPublicStatusCurrencyChange,
}: PublicStatusPageSectionProps) {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = useState<"regenerate" | "revoke" | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCategories, setBulkCategories] = useState<Array<"expired" | "lifetime">>(["expired", "lifetime"]);
  const [bulkHidden, setBulkHidden] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkPreview, setBulkPreview] = useState<{ matchedCount: number; changedCount: number } | null>(null);
  const [bulkPreviewBusy, setBulkPreviewBusy] = useState(false);
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const generateButtonRef = useRef<HTMLButtonElement>(null);
  const page = status.data;
  const enabled = page?.enabled === true;
  const pageUrl = page?.pageUrl ?? null;
  const showPrices = page?.showPrices === true;
  const hideExpired = page?.hideExpired === true;
  const hideLifetime = page?.hideLifetime === true;
  const busy = isCreating || isDeleting || isUpdating || bulkBusy;
  useEffect(() => {
    if (!bulkOpen || bulkCategories.length === 0) {
      setBulkPreview(null);
      return;
    }
    let active = true;
    setBulkPreviewBusy(true);
    void onBulkPublicVisibility(bulkCategories, bulkHidden, true)
      .then((result) => { if (active) setBulkPreview(result); })
      .catch(() => { if (active) setBulkPreview(null); })
      .finally(() => { if (active) setBulkPreviewBusy(false); });
    return () => { active = false; };
  }, [bulkCategories, bulkHidden, bulkOpen, onBulkPublicVisibility]);
  const headerStatus = status.isInitialLoading
    ? t("common.loading")
    : !status.hasData && status.error
      ? t("settings.publicStatusUnknown")
      : status.error
        ? t("settings.publicStatusNotUpdated")
        : enabled
          ? t("settings.publicStatusEnabled")
          : t("settings.publicStatusDisabled");
  const visibilitySummary = visibility.isInitialLoading
    ? t("settings.categoryChecking")
    : !visibility.hasData && visibility.error
      ? t("settings.publicStatusVisibilityUnknown")
      : visibility.error
        ? t("settings.publicStatusVisibilityStale", {
          visible: visibility.data?.visibleCount ?? 0,
          hidden: visibility.data?.hiddenCount ?? 0,
        })
        : t("settings.publicStatusSummary", {
          visible: visibility.data?.visibleCount ?? 0,
          hidden: visibility.data?.hiddenCount ?? 0,
        });
  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <SettingsSectionHeader
        className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
        icon={<Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
        title={t("settings.publicStatus")}
        help={t("settings.publicStatusHelp")}
        summary={visibilitySummary}
        status={(
        <Badge variant={enabled ? "default" : "secondary"} className="w-fit shrink-0">
          {headerStatus}
        </Badge>
        )}
      />

      <ManagerDataBoundary state={status}>
      {pageUrl ? (
        <div className="grid gap-4">
          <PublicStatusLinkRow
            pageUrl={pageUrl}
            busy={busy}
            urlLabel={t("settings.publicStatusUrl")}
            copyLabel={t("settings.publicStatusCopy")}
            openLabel={t("settings.publicStatusOpen")}
            helpText={t("settings.publicStatusOneTimeHelp")}
            onCopy={onCopy}
            onOpenPage={onOpenPage}
          />

          <FormFieldRow
            alignAt="lg"
            className="border-t border-border pt-4"
            rowClassName="lg:grid-cols-2 lg:gap-x-6"
          >
            <FormField
              id="publicStatusShowPrices"
              label={t("settings.publicStatusShowPrices")}
              labelClassName="cursor-pointer text-sm font-medium"
              description={t("settings.publicStatusShowPricesHelp")}
            >
              {({ id, describedBy }) => (
                <Switch
                  id={id}
                  checked={showPrices}
                  disabled={busy}
                  onCheckedChange={onShowPricesChange}
                  aria-label={t("settings.publicStatusShowPrices")}
                  aria-describedby={describedBy}
                />
              )}
            </FormField>

            <FormField
              id="publicStatusHideExpired"
              label={t("settings.publicStatusHideExpired")}
              labelClassName="cursor-pointer text-sm font-medium"
              description={t("settings.publicStatusHideExpiredHelp", { count: visibility.data?.expiredCount ?? 0 })}
            >
              {({ id, describedBy }) => (
                <Switch id={id} checked={hideExpired} disabled={busy} onCheckedChange={onHideExpiredChange} aria-label={t("settings.publicStatusHideExpired")} aria-describedby={describedBy} />
              )}
            </FormField>

            <FormField
              id="publicStatusHideLifetime"
              label={t("settings.publicStatusHideLifetime")}
              labelClassName="cursor-pointer text-sm font-medium"
              description={t("settings.publicStatusHideLifetimeHelp", { count: visibility.data?.lifetimeCount ?? 0 })}
            >
              {({ id, describedBy }) => (
                <Switch id={id} checked={hideLifetime} disabled={busy} onCheckedChange={onHideLifetimeChange} aria-label={t("settings.publicStatusHideLifetime")} aria-describedby={describedBy} />
              )}
            </FormField>

            <FormField
              id="publicStatusCurrency"
              label={t("settings.publicStatusCurrency")}
              labelClassName="text-sm font-medium"
              description={t("settings.publicStatusCurrencyHelp", { currency: effectivePublicStatusCurrency })}
              descriptionClassName="leading-5"
            >
              {({ id, describedBy }) => (
                <SearchableSelect
                  id={id}
                  value={publicStatusCurrency}
                  onValueChange={onPublicStatusCurrencyChange}
                  options={publicStatusCurrencyOptions}
                  placeholder={t("settings.currencyPlaceholder")}
                  searchPlaceholder={t("settings.currencySearch")}
                  emptyMessage={t("settings.currencyEmpty")}
                  disabled={busy}
                  className="h-9 w-full border-border bg-background"
                  contentClassName="max-w-md"
                  aria-label={t("settings.publicStatusCurrency")}
                  aria-describedby={describedBy}
                />
              )}
            </FormField>
          </FormFieldRow>

          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-muted-foreground">{t("settings.publicStatusVisibilityManageHelp")}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:shrink-0">
              <Button type="button" variant="outline" size="sm" onClick={onManageVisibility} disabled={busy} className="justify-center gap-2 border-border">
                <Clipboard className="h-4 w-4" />
                {t("settings.publicStatusManageVisibility")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setBulkOpen(true)} disabled={busy} className="justify-center gap-2 border-border">
                {t("settings.publicStatusQuickBulk")}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={(event) => {
                  confirmationTriggerRef.current = event.currentTarget;
                  setConfirmation("regenerate");
                }}
                disabled={busy}
                aria-busy={isCreating ? true : undefined}
                className="justify-center gap-2 border-border"
              >
                <LoadingButtonContent loading={isCreating} loadingLabel={t("common.saving")}>
                  <RefreshCw className="h-4 w-4" />
                  {t("settings.publicStatusRegenerate")}
                </LoadingButtonContent>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  confirmationTriggerRef.current = event.currentTarget;
                  setConfirmation("revoke");
                }}
                disabled={busy}
                aria-busy={isDeleting ? true : undefined}
                className="justify-center gap-2 text-destructive hover:text-destructive"
              >
                <LoadingButtonContent loading={isDeleting} loadingLabel={t("common.saving")}>
                  <Trash2 className="h-4 w-4" />
                  {t("settings.publicStatusRevoke")}
                </LoadingButtonContent>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-sm leading-6 text-muted-foreground">{t("settings.publicStatusDisabledHelp")}</p>
          <Button ref={generateButtonRef} type="button" size="sm" variant="default" onClick={onCreate} disabled={busy} aria-busy={isCreating ? true : undefined} className="justify-center gap-2 sm:shrink-0">
            <LoadingButtonContent loading={isCreating} loadingLabel={t("common.saving")}>
              <RefreshCw className="h-4 w-4" />
              {t("settings.publicStatusGenerate")}
            </LoadingButtonContent>
          </Button>
        </div>
      )}
      </ManagerDataBoundary>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // 受控确认框有两个自定义触发器；关闭后回到实际触发按钮，撤销导致其卸载时回退到新生成操作。
            const trigger = confirmationTriggerRef.current;
            (trigger?.isConnected ? trigger : generateButtonRef.current)?.focus();
            confirmationTriggerRef.current = null;
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation === "revoke"
                ? t("settings.publicStatusRevokeTitle")
                : t("settings.publicStatusRegenerateTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "revoke"
                ? t("settings.publicStatusRevokeDescription")
                : t("settings.publicStatusRegenerateDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              aria-busy={busy ? true : undefined}
              onClick={(event) => {
                event.preventDefault();
                const operation = confirmation === "revoke" ? onDelete : onRegenerate;
                void Promise.resolve(operation()).then((succeeded) => {
                  if (succeeded !== false) setConfirmation(null);
                });
              }}
            >
              <LoadingButtonContent loading={busy} loadingLabel={t("common.saving")}>
                {confirmation === "revoke"
                  ? t("settings.publicStatusRevoke")
                  : t("settings.publicStatusRegenerate")}
              </LoadingButtonContent>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={bulkOpen} onOpenChange={(open) => { if (!bulkBusy) setBulkOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.publicStatusQuickBulkTitle")}</DialogTitle>
            <DialogDescription>{t("settings.publicStatusQuickBulkDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <label className="flex items-center gap-3 text-sm">
              <Checkbox checked={bulkCategories.includes("expired")} onCheckedChange={(checked) => setBulkCategories((current): Array<"expired" | "lifetime"> => checked === true ? (current.includes("expired") ? current : [...current, "expired"]) : current.filter((item) => item !== "expired"))} />
              <span>{t("settings.publicStatusHideExpired")}（{visibility.data?.expiredCount ?? 0}）</span>
            </label>
            <label className="flex items-center gap-3 text-sm">
              <Checkbox checked={bulkCategories.includes("lifetime")} onCheckedChange={(checked) => setBulkCategories((current): Array<"expired" | "lifetime"> => checked === true ? (current.includes("lifetime") ? current : [...current, "lifetime"]) : current.filter((item) => item !== "lifetime"))} />
              <span>{t("settings.publicStatusHideLifetime")}（{visibility.data?.lifetimeCount ?? 0}）</span>
            </label>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={bulkHidden ? "default" : "outline"} onClick={() => setBulkHidden(true)}>{t("subscription.publicHide")}</Button>
              <Button type="button" size="sm" variant={!bulkHidden ? "default" : "outline"} onClick={() => setBulkHidden(false)}>{t("subscription.publicShow")}</Button>
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {bulkPreviewBusy
                ? t("common.loading")
                : bulkPreview
                  ? t("settings.publicStatusBulkPreview", { matched: bulkPreview.matchedCount, changed: bulkPreview.changedCount })
                  : t("settings.publicStatusBulkPreviewUnavailable")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>{t("common.cancel")}</Button>
            <Button type="button" disabled={bulkBusy || bulkCategories.length === 0} onClick={() => {
              setBulkBusy(true);
              void onBulkPublicVisibility(bulkCategories, bulkHidden).then(() => setBulkOpen(false)).catch(() => undefined).finally(() => setBulkBusy(false));
            }}>{bulkBusy ? t("common.saving") : t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
