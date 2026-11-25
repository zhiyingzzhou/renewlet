import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/I18nProvider";
import { toast } from "@/components/ui/sonner";
import { takeOidcReturn } from "@/lib/redirect";

const OidcForm = lazy(() => import("./oidc-form"));

export function OidcCard({
  site = false,
  enabled,
  disabled = false,
}: {
  site?: boolean;
  enabled?: boolean | undefined;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const section = site ? "#settings-access-security" : "#settings-account";
    if (window.location.hash !== section) return;
    const result = takeOidcReturn();
    if (!result) return;
    if (result === (site ? "test" : "link")) {
      setReview(true);
      setOpen(true);
    } else if (result !== "cancelled") {
      toast.error(t("auth.oidcFailed"));
    }
    trigger.current?.scrollIntoView({ block: "center" });
    trigger.current?.focus();
  }, [site, t]);
  const description = site ? t("settings.oidcSiteHelp") : t("settings.oidcAccountHelp");
  return (
    <div className="grid gap-3 rounded-md border border-border bg-secondary/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold">{t("settings.oidcTitle")}</h3>
            {site && (
              <Badge variant={enabled ? "default" : "secondary"}>
                {enabled === undefined
                  ? t("settings.statusUnknown")
                  : enabled
                    ? t("common.enabled")
                    : t("common.disabled")}
              </Badge>
            )}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {site ? t("settings.oidcConfigure") : t("settings.oidcManage")}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setReview(false);
        }}
      >
        {open && (
          <DialogContent
            closeLabel={t("common.close")}
            className="max-h-[calc(var(--app-viewport-height)-2rem)] overflow-y-auto sm:max-w-md"
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              trigger.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>{site ? t("settings.oidcConfigure") : t("settings.oidcManage")}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
              <OidcForm
                site={site}
                review={review}
                done={() => {
                  setReview(false);
                  setOpen(false);
                }}
              />
            </Suspense>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
