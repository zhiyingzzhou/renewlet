import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RenewSubscriptionDialogProps } from "@/components/renew-subscription-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { useI18n } from "@/i18n/I18nProvider";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";

const renewSubscriptionDialogResource = createLazyDialogResource(() =>
  import("@/components/renew-subscription-dialog").then((module) => module.RenewSubscriptionDialogContent),
);

export function preloadRenewSubscriptionDialog(): void {
  void renewSubscriptionDialogResource.load().catch(() => undefined);
}

/** 续订代码按 intent 加载，但单次 open session 始终复用同一套 Radix Portal、焦点域和退出动画。 */
export function DeferredRenewSubscriptionDialog(props: RenewSubscriptionDialogProps) {
  const { t } = useI18n();
  const [resource, setResource] = useState(renewSubscriptionDialogResource);
  const { value: Content, error, sessionKey } = useLazyDialogSession(props.open, resource);
  const titleSubscription = props.subscription ?? props.loadingPreview;
  const title = titleSubscription
    ? t("subscription.renew.title", { name: titleSubscription.name })
    : t("subscription.renew");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel={t("common.close")}
        closeDisabled={props.submitting}
        dismissMode="explicit"
        layout="content"
        className="h5-dialog-auto-frame gap-0 border-border bg-card p-0 sm:max-w-lg"
        aria-busy={(!Content && !error) || props.loading ? true : undefined}
        data-testid={Content ? undefined : "renew-subscription-dialog-module-pending"}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = props.restoreFocusRef?.current;
          if (target?.isConnected) target.focus();
          else {
            const heading = document.querySelector<HTMLElement>("main h1, main h2, [data-renewal-focus-fallback]");
            if (heading) { heading.tabIndex = -1; heading.focus(); }
          }
        }}
      >
        {Content ? (
          <Content key={sessionKey} {...props} />
        ) : (
          <>
            <DialogHeader className="shrink-0 p-6 pb-0">
              <DialogTitle className="min-w-0 wrap-anywhere pr-6 text-xl font-semibold">{title}</DialogTitle>
              <DialogDescription className="sr-only">
                {t("subscription.renew.description")}
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <div className="grid min-w-0 gap-4 p-6">
                <p role="alert" className="text-sm text-destructive">{t("subscription.renew.loadFailed")}</p>
                <Button type="button" variant="outline" onClick={() => setResource({ ...renewSubscriptionDialogResource })}>{t("system.retry")}</Button>
              </div>
            ) : <DialogModulePending label={t("common.loading")} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
