/**
 * 统计卡片原语。
 *
 * 架构位置：dashboard/public-status 共用的指标展示层，负责一致的信息层级和展示密度。
 *
 * 注意： 不在这里计算指标含义；金额换算和日期窗口属于 subscriptions domain。
 */
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ReactNode;
  variant?: 'default' | 'primary' | 'warning';
  density?: "default" | "compact";
  className?: string;
  "data-testid"?: string;
}

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  variant = 'default',
  density = "default",
  className,
  "data-testid": dataTestId,
}: StatCardProps) {
  const compact = density === "compact";

  return (
    <div
      data-testid={dataTestId}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card shadow-card transition-all duration-300 hover:bg-card-hover",
        compact ? "p-4 lg:p-6" : "p-6",
        className,
      )}
    >
      <div className={cn("grid min-w-0 gap-2", compact && "gap-1.5 lg:gap-2")}>
        <div className="flex items-center justify-between gap-3">
          <p className={cn("min-w-0 wrap-anywhere font-medium text-muted-foreground", compact ? "text-xs lg:text-sm" : "text-sm")}>
            {title}
          </p>
          <div
            aria-hidden="true"
            className={cn(
              "flex shrink-0 items-center justify-center rounded-lg",
              compact ? "h-10 w-10 [&_svg]:h-5 [&_svg]:w-5 lg:h-12 lg:w-12 lg:[&_svg]:h-6 lg:[&_svg]:w-6" : "h-12 w-12",
              variant === 'default' && "bg-secondary text-muted-foreground",
              variant === 'primary' && "bg-secondary text-primary",
              variant === 'warning' && "bg-warning/10 text-warning",
            )}
          >
            {icon}
          </div>
        </div>
        <p className={cn(
          "min-w-0 wrap-anywhere font-bold tracking-tight",
          compact ? "text-2xl lg:text-3xl" : "text-3xl",
          variant === "warning" && "text-warning",
        )}>
          {value}
        </p>
        {subtitle && (
          <p className={cn("min-w-0 wrap-anywhere text-muted-foreground", compact ? "text-[11px] leading-4 lg:text-xs" : "text-xs")}>
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}
