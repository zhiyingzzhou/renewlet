import { useCallback, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";
import { useNestedDialogCloseGuard } from "@/hooks/use-nested-dialog-close-guard";
import { useI18n } from "@/i18n/I18nProvider";
import type {
  SubscriptionDialogContentProps,
  SubscriptionDialogProps,
} from "@/components/subscription-dialog-types";

const subscriptionDialogResource = createLazyDialogResource(() =>
  import("@/components/subscription-dialog-content").then((module) => module.SubscriptionDialogContent),
);

export function preloadSubscriptionDialog(): Promise<void> {
  return subscriptionDialogResource.load().then(() => undefined);
}

function handleSubscriptionDialogIntent(): void {
  void preloadSubscriptionDialog().catch(() => undefined);
}

/** 表单代码按 intent 加载；同步 shell 在单次 open session 内持续拥有 Portal、焦点域和退出动画。 */
export function SubscriptionDialog(props: SubscriptionDialogProps) {
  const { t } = useI18n();
  const { onOpenChange } = props;
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const handleSubmittingChange = useCallback((pending: boolean) => {
    submittingRef.current = pending;
    setSubmitting(pending);
  }, []);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && submittingRef.current) return;
    onOpenChange(open);
  }, [onOpenChange]);
  const { handleNestedDialogOpenChange, handleParentOpenChange } = useNestedDialogCloseGuard(
    props.open,
    handleOpenChange,
  );
  const { value: Content, error, sessionKey } = useLazyDialogSession(props.open, subscriptionDialogResource);
  const handleRequestClose = useCallback(() => handleParentOpenChange(false), [handleParentOpenChange]);
  const initialCreateSubscription = props.mode === "create" ? props.initialSubscription ?? null : null;
  const clonePreview = props.mode === "create"
    ? initialCreateSubscription ?? props.loadingPreview
    : null;
  const isCloneCreateMode = Boolean(clonePreview);
  const modulePending = Content === null;

  if (props.open && error) throw error;

  return (
    <Dialog open={props.open} onOpenChange={handleParentOpenChange}>
      {"trigger" in props && props.trigger ? (
        <DialogTrigger
          asChild
          onFocus={handleSubscriptionDialogIntent}
          onPointerEnter={handleSubscriptionDialogIntent}
          onTouchStart={handleSubscriptionDialogIntent}
        >
          {props.trigger}
        </DialogTrigger>
      ) : null}

      <DialogContent
        closeLabel={t("common.close")}
        closeDisabled={submitting}
        dismissMode="explicit"
        layout="frame"
        className="h5-dialog-frame h5-subscription-dialog-panel border-border bg-card p-0 sm:max-w-2xl"
        aria-busy={submitting || modulePending || props.loading ? true : undefined}
      >
        <DialogHeader data-subscription-dialog-header="" className="shrink-0 p-6 pb-0">
          <DialogTitle className="text-xl font-semibold">
            {props.mode === "create"
              ? isCloneCreateMode
                ? t("subscription.cloneDialogTitle")
                : t("subscription.dialogCreateTitle")
              : t("subscription.dialogEditTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {props.mode === "create" && clonePreview
              ? t("subscription.cloneDialogDescription", { name: clonePreview.name })
              : props.mode === "create"
                ? t("subscription.dialogCreateDescription")
                : t("subscription.dialogEditDescription")}
          </DialogDescription>
        </DialogHeader>

        {modulePending ? (
          <DialogModulePending label={t("common.loading")} className="min-h-0" />
        ) : (
          <Content
            key={sessionKey}
            {...props}
            onNestedDialogOpenChange={handleNestedDialogOpenChange}
            onRequestClose={handleRequestClose}
            onSubmittingChange={handleSubmittingChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export type { SubscriptionDialogContentProps, SubscriptionDialogProps };
