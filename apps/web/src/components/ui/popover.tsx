/**
 * 弹出层设计系统原语。
 *
 * 架构位置：封装 Radix Popover，并优先复用父浮层容器，解决弹窗/抽屉内浮层定位问题。
 *
 * 注意： 该行为会影响 ColorPicker、SearchableSelect、TimePicker 等嵌套浮层控件。
 */
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { useFloatingPortalContainer } from "@/components/ui/floating-portal-container";
import {
  MobileOverlaySheet,
  resolveMobileSheetDetent,
  shouldSuppressMobileOverlayTriggerEvent,
  useIsMobileOverlay,
  useMobileOverlayOpenLifecycle,
  type MobileSheetDetent,
  type MobileSheetKind,
} from "@/components/ui/mobile-overlay";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { cn } from "@/lib/utils";

const PopoverOpenContext = React.createContext<{
  onSheetAnimationEnd: (open: boolean) => void;
  open: boolean;
  present: boolean;
  setOpen: (open: boolean) => void;
  sheetOpen: boolean;
}>({
  onSheetAnimationEnd: () => {},
  open: false,
  present: false,
  setOpen: () => {},
  sheetOpen: false,
});

function Popover({
  defaultOpen,
  modal: modalProp,
  onOpenChange,
  open: openProp,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) {
  const isMobileOverlay = useIsMobileOverlay();
  const overlayOpen = useMobileOverlayOpenLifecycle({
    animateClose: isMobileOverlay,
    defaultOpen,
    onOpenChange,
    open: openProp,
  });

  return (
    <PopoverOpenContext.Provider
      value={{
        onSheetAnimationEnd: overlayOpen.onSheetAnimationEnd,
        open: overlayOpen.open,
        present: overlayOpen.present,
        setOpen: overlayOpen.setOpen,
        sheetOpen: overlayOpen.sheetOpen,
      }}
    >
      <PopoverPrimitive.Root
        modal={modalProp ?? isMobileOverlay}
        open={overlayOpen.open}
        onOpenChange={overlayOpen.setOpen}
        {...props}
      />
    </PopoverOpenContext.Provider>
  );
}

Popover.displayName = PopoverPrimitive.Root.displayName;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ onClickCapture, onPointerDownCapture, ...props }, ref) => (
  <PopoverPrimitive.Trigger
    ref={ref}
    {...props}
    onClickCapture={(event) => {
      if (shouldSuppressMobileOverlayTriggerEvent(event)) return;
      onClickCapture?.(event);
    }}
    onPointerDownCapture={(event) => {
      if (shouldSuppressMobileOverlayTriggerEvent(event)) return;
      onPointerDownCapture?.(event);
    }}
  />
));
PopoverTrigger.displayName = PopoverPrimitive.Trigger.displayName;

const PopoverClose = PopoverPrimitive.Close;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    mobileCloseLabel?: string;
    mobileDescription?: React.ReactNode;
    mobileDetent?: MobileSheetDetent;
    mobileHeaderLayout?: "flush" | "padded";
    mobileKind?: MobileSheetKind;
    mobilePresentation?: "sheet" | "anchored";
    mobileTitle?: React.ReactNode;
    portalContainer?: HTMLElement | null;
  }
>(({
  className,
  align = "center",
  sideOffset = 4,
  portalContainer,
  mobileCloseLabel,
  mobileDescription,
  mobileDetent = "auto",
  mobileHeaderLayout = "padded",
  mobileKind = "panel",
  mobilePresentation = "sheet",
  mobileTitle,
  children,
  "aria-label": ariaLabel,
  onInteractOutside,
  onPointerDownOutside,
  ...props
}, ref) => {
  const inheritedPortalContainer = useFloatingPortalContainer();
  const container = portalContainer ?? inheritedPortalContainer ?? undefined;
  const portalContainerProps = container === undefined ? {} : { container };
  const {
    onSheetAnimationEnd,
    present,
    setOpen,
    sheetOpen,
  } = React.useContext(PopoverOpenContext);
  const isMobileOverlay = useIsMobileOverlay();
  const useMobileSheet = isMobileOverlay && mobilePresentation === "sheet";
  const locale = getApiLocale();
  const resolvedMobileDetent = resolveMobileSheetDetent({
    kind: mobileKind,
    requestedDetent: mobileDetent,
  });
  const resolvedMobileTitle = mobileTitle ?? (typeof ariaLabel === "string" ? ariaLabel : translate(locale, "common.selectPlaceholder"));
  const resolvedMobileCloseLabel = mobileCloseLabel ?? translate(locale, "common.close");
  const titleMode = mobileTitle ? "visible" : "sr-only";

  if (portalContainer === undefined && inheritedPortalContainer === null) {
    return null;
  }

  const content = (
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        // 父 Dialog 的滚动锁会把 body 的 pointer-events 设为 none；Portal 内的浮层必须显式恢复自身交互，否则点击面板控件会被 Radix 当作 outside interaction。
        "pointer-events-auto h5-floating-content z-50 w-72 overflow-hidden border bg-popover p-4 text-popover-foreground shadow-md outline-none",
        !useMobileSheet &&
          "rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      {...(onInteractOutside ? { onInteractOutside } : {})}
      {...(onPointerDownOutside ? { onPointerDownOutside } : {})}
      {...props}
    >
      {children}
    </PopoverPrimitive.Content>
  );

  if (useMobileSheet) {
    return (
      <MobileOverlaySheet
        open={sheetOpen}
        present={present}
        onOpenChange={setOpen}
        onAnimationEnd={onSheetAnimationEnd}
        container={container}
        detent={resolvedMobileDetent}
        kind={mobileKind}
        title={resolvedMobileTitle}
        titleMode={titleMode}
        titleLayout={mobileHeaderLayout}
        description={mobileDescription}
        closeLabel={resolvedMobileCloseLabel}
      >
        {content}
      </MobileOverlaySheet>
    );
  }

  return (
    <PopoverPrimitive.Portal {...portalContainerProps}>
      {content}
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverTrigger, PopoverClose, PopoverContent };
