import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type SubscriptionStatus } from "@/types/subscription";

const subscriptionStatusBadgeClassNames = {
  trial: "border-warning/20 bg-warning/10 text-warning-ink",
  active: "border-success/20 bg-success/10 text-success-ink",
  expired: "border-border bg-muted text-secondary-foreground",
  paused: "border-border bg-muted text-secondary-foreground",
  cancelled: "border-border bg-muted text-secondary-foreground",
} satisfies Record<SubscriptionStatus, string>;

interface SubscriptionStatusBadgeProps {
  status: SubscriptionStatus;
  className?: string | undefined;
}

export function SubscriptionStatusBadge({ status, className }: SubscriptionStatusBadgeProps) {
  const { label } = useI18n();

  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 whitespace-nowrap text-xs", subscriptionStatusBadgeClassNames[status], className)}
    >
      {label(STATUS_LABELS[status])}
    </Badge>
  );
}
