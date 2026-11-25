import { useState, type CSSProperties } from "react";
import { AuthorizedImage } from "@/components/authorized-image";
import { cn } from "@/lib/utils";

const DEFAULT_FALLBACK_COLOR = "hsl(var(--primary))";

type SubscriptionLogoStyle = CSSProperties & {
  "--subscription-logo-fallback": string;
};

interface SubscriptionLogoProps {
  name: string;
  logo?: string | null | undefined;
  fallbackColor?: string | undefined;
  size?: "xs" | "sm" | "md" | undefined;
  className?: string | undefined;
}

const sizeClassNames = {
  xs: {
    tile: "h-6 w-6 rounded-md border text-[10px]",
    image: "p-0.5",
  },
  sm: {
    tile: "h-10 w-10 rounded-lg border text-sm",
    image: "p-1",
  },
  md: {
    tile: "h-12 w-12 rounded-lg border text-lg",
    image: "p-1",
  },
} satisfies Record<NonNullable<SubscriptionLogoProps["size"]>, { tile: string; image: string }>;

export function SubscriptionLogo(props: SubscriptionLogoProps) {
  // 私有图片获取与解码都可能延迟。换 URL 时重新显示缩写，旧请求不能替新图移除占位。
  return <SubscriptionLogoTile key={props.logo} {...props} />;
}

function SubscriptionLogoTile({
  name,
  logo,
  fallbackColor = DEFAULT_FALLBACK_COLOR,
  size = "md",
  className,
}: SubscriptionLogoProps) {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const classes = sizeClassNames[size];

  const style: SubscriptionLogoStyle = {
    "--subscription-logo-fallback": fallbackColor,
  };

  return (
    <span
      className={cn(
        "subscription-logo-tile flex shrink-0 items-center justify-center overflow-hidden font-bold",
        classes.tile,
        className,
      )}
      style={style}
    >
      {(!logo || loadState !== "loaded") && (
        <span aria-hidden="true" className="subscription-logo-fallback">{name.trim().slice(0, 2).toUpperCase()}</span>
      )}
      {logo && loadState !== "failed" && (
        <AuthorizedImage
          src={logo}
          alt={name}
          className={cn("subscription-logo-image h-full w-full object-contain", classes.image, loadState !== "loaded" && "opacity-0")}
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("failed")}
        />
      )}
    </span>
  );
}
