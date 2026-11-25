import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nProvider";
import { toast } from "@/components/ui/sonner";
import { appStatusQueryKey } from "@/hooks/use-app-status";
import { oidcService, oidcErrorKey, oidcKeys } from "@/services/oidc-service";
import { getProductCurrentUserId } from "@/services/product-session";

export default function OidcForm({
  site,
  review,
  done,
}: {
  site: boolean;
  review: boolean;
  done: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const user = getProductCurrentUserId() ?? "";
  const key = site ? [...oidcKeys.site, user] : oidcKeys.link(user);
  const config = useQuery({
    queryKey: [...oidcKeys.site, user],
    queryFn: oidcService.settings,
    enabled: site && !review,
    staleTime: 0,
  });
  const link = useQuery({
    queryKey: oidcKeys.link(user),
    queryFn: oidcService.link,
    enabled: !site && !review,
    staleTime: 0,
  });
  const pending = useQuery({
    queryKey: ["oidc", "review", user, site],
    queryFn: oidcService.review,
    enabled: review,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const action = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => {
      await operation();
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: appStatusQueryKey }),
      ]);
      done();
    },
  });
  const [copied, setCopied] = useState(false);
  const query = review ? pending : site ? config : link;
  if (query.isError)
    return (
      <div role="alert">
        <p>{t(oidcErrorKey(query.error))}</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t("system.retry")}
        </Button>
      </div>
    );
  if (query.isPending) return <p role="status">{t("common.loading")}</p>;
  const field = (
    id: string,
    label: string,
    opts: { value?: string; secret?: boolean; required?: boolean; placeholder?: string; url?: boolean } = {},
  ) => (
    <FormField id={"oidc-" + id} label={label}>
      {({ id: fieldId, describedBy }) => (
        <Input
          id={fieldId}
          aria-describedby={describedBy}
          name={id}
          type={opts.secret ? "password" : opts.url ? "url" : "text"}
          autoComplete={id === "password" ? "current-password" : opts.secret ? "new-password" : "off"}
          defaultValue={opts.value ?? ""}
          required={opts.required}
          placeholder={opts.placeholder}
          maxLength={id === "issuer" ? 2048 : id === "clientId" ? 512 : 4096}
        />
      )}
    </FormField>
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action.isPending) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "");
    if (review) {
      if (pending.data?.purpose !== (site ? "test" : "link")) return;
      action.mutate(site ? oidcService.enable : oidcService.confirm);
    } else if (site && config.data) {
      const revision = config.data.revision;
      action.mutate(() =>
        oidcService.test({
          issuer: value("issuer"),
          clientId: value("clientId"),
          secret: value("secret"),
          revision,
        }),
      );
    } else {
      action.mutate(() =>
        link.data?.issuer ? oidcService.unlink(value("password")) : oidcService.bind(value("password")),
      );
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      {review && pending.data ? (
        <div className="grid gap-2 rounded-md border border-border bg-secondary/30 p-3 text-sm">
          <p>{site ? t("settings.oidcTestPassed") : t("settings.oidcConfirmHelp")}</p>
          <p className="break-all">{pending.data.issuer}</p>
          <p className="break-all">{site ? pending.data.clientId : pending.data.subject}</p>
        </div>
      ) : site && config.data ? (
        <>
          <FormField
            id="oidc-callback"
            label={t("settings.oidcCallback")}
            description={t("settings.oidcCallbackHelp")}
          >
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  readOnly
                  value={config.data.callback}
                  onFocus={(e) => e.target.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (!navigator.clipboard) {
                      toast.error(t("settings.oidcCopyFailed"));
                      return;
                    }
                    void navigator.clipboard
                      .writeText(config.data.callback)
                      .then(() => setCopied(true))
                      .catch(() => toast.error(t("settings.oidcCopyFailed")));
                  }}
                >
                  {copied ? t("settings.oidcCopied") : t("settings.oidcCopy")}
                </Button>
              </div>
            )}
          </FormField>
          {field("issuer", t("settings.oidcIssuer"), {
            value: config.data.issuer,
            required: true,
            url: true,
          })}
          {field("clientId", t("settings.oidcClient"), { value: config.data.clientId, required: true })}
          {field("secret", t("settings.oidcSecret"), {
            secret: true,
            required: !config.data.secretConfigured,
            placeholder: config.data.secretConfigured ? t("settings.oidcSavedSecret") : "",
          })}
        </>
      ) : (
        <>
          {link.data?.issuer && (
            <p className="break-all text-sm">
              {t("settings.oidcLinked")} {link.data.issuer}
            </p>
          )}
          {field("password", t("auth.password"), { secret: true, required: true })}
        </>
      )}
      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t(oidcErrorKey(action.error))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={action.isPending || (review && pending.data?.purpose !== (site ? "test" : "link"))}
        >
          {review
            ? site
              ? t("settings.oidcEnable")
              : t("settings.oidcConfirm")
            : site
              ? t("settings.oidcTest")
              : link.data?.issuer
                ? t("settings.oidcUnlink")
                : t("settings.oidcBind")}
        </Button>
        {site && !review && config.data?.enabled && (
          <Button
            type="button"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate(() => oidcService.disable(config.data.revision))}
          >
            {t("settings.oidcDisable")}
          </Button>
        )}
      </div>
    </form>
  );
}
