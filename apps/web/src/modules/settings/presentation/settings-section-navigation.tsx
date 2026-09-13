import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@/lib/router';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  SideDrawerClose,
  SideDrawerContent,
  SideDrawerDescription,
  SideDrawerRoot,
  SideDrawerTitle,
  SideDrawerTrigger,
} from '@/components/ui/side-drawer';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n/I18nProvider';
import { settingsLayout } from './settings-layout';

const PROGRAMMATIC_SCROLL_IDLE_MS = 160;
const BOTTOM_EDGE_TOLERANCE_PX = 4;

export const SETTINGS_SECTIONS = [
  { id: "settings-account", labelKey: "settings.sectionNav.account" },
  { id: "settings-access-security", labelKey: "settings.sectionNav.accessSecurity" },
  { id: "settings-appearance", labelKey: "settings.sectionNav.appearance" },
  { id: "settings-display", labelKey: "settings.sectionNav.display" },
  { id: "settings-icon-sources", labelKey: "settings.sectionNav.iconSources" },
  { id: "settings-uploaded-icons", labelKey: "settings.sectionNav.uploadedIcons" },
  { id: "settings-ai-recognition", labelKey: "settings.sectionNav.aiRecognition" },
  { id: "settings-budget", labelKey: "settings.sectionNav.budget" },
  { id: "settings-data-config", labelKey: "settings.sectionNav.dataConfig" },
  { id: "settings-cloud-backup", labelKey: "settings.sectionNav.cloudBackup" },
  { id: "settings-exchange", labelKey: "settings.sectionNav.exchange" },
  { id: "settings-calendar-feed", labelKey: "settings.sectionNav.calendarFeed" },
  { id: "settings-public-status", labelKey: "settings.sectionNav.publicStatus" },
  { id: "settings-public-api", labelKey: "settings.sectionNav.publicApi" },
  { id: "settings-timezone", labelKey: "settings.sectionNav.timezone" },
  { id: "settings-notifications", labelKey: "settings.sectionNav.notifications" },
] as const;

export type SettingsSectionDefinition = typeof SETTINGS_SECTIONS[number];
export type SettingsSectionId = SettingsSectionDefinition["id"];
export type SettingsSectionList = readonly SettingsSectionDefinition[];

export function createSettingsSections({
  canManageAccessSecurity,
}: {
  canManageAccessSecurity: boolean;
}): SettingsSectionList {
  return canManageAccessSecurity
    ? SETTINGS_SECTIONS
    : SETTINGS_SECTIONS.filter((section) => section.id !== "settings-access-security");
}

/**
 * 延迟区块的目录导航必须跨过两个独立生命周期：waitingForContent 已锁定 hash/active，
 * 但 fallback 几何不可用于定位；scrolling 才允许消费真实区块位置和 scrollend。
 */
type ProgrammaticNavigation = {
  targetId: SettingsSectionId;
  idleTimer: number | null;
  phase: "waitingForContent" | "scrolling";
};
type SettingsSectionNavigationOptions = {
  deferredSectionIds?: readonly SettingsSectionId[] | undefined;
};
type SettingsSectionNavigationProps = {
  sections: SettingsSectionList;
  activeSectionId: SettingsSectionId;
  onSectionClick: (id: SettingsSectionId) => void;
  onSectionIntent?: ((id: SettingsSectionId) => void) | undefined;
};

function getSectionFromHash(hash: string, sections: SettingsSectionList): SettingsSectionId | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  return sections.some((section) => section.id === id) ? (id as SettingsSectionId) : null;
}

function scrollToSettingsSection(id: SettingsSectionId) {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ block: "start", behavior: "smooth" });
}

function getAppScrollRoot() {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

function parseCssLengthToPx(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.startsWith("calc(") && normalized.endsWith(")")) {
    return parseCssCalcLengthToPx(normalized.slice(5, -1));
  }
  if (normalized.startsWith("env(")) return 0;

  const match = /^(-?\d+(?:\.\d+)?)(px|rem)$/.exec(normalized);
  if (!match) return null;
  const valueNumber = Number.parseFloat(match[1] ?? "0");
  const unit = match[2];
  if (unit === "px") return valueNumber;
  return valueNumber * getRootFontSizePx();
}

function parseCssCalcLengthToPx(expression: string): number | null {
  const terms = expression
    .replace(/\benv\([^)]*\)/g, "0px")
    .match(/[+-]?\s*[^+-]+/g);
  if (!terms) return null;

  let total = 0;
  for (const term of terms) {
    const value = parseCssLengthToPx(term.replace(/\s+/g, ""));
    if (value === null) return null;
    total += value;
  }
  return total;
}

function getRootFontSizePx(): number {
  const rootFontSize = window.getComputedStyle(document.documentElement).fontSize;
  return parseCssLengthToPx(rootFontSize) ?? 16;
}

function getSectionElement(id: SettingsSectionId) {
  const element = document.getElementById(id);
  return element instanceof HTMLElement ? element : null;
}

function getFirstRenderedSection(sections: SettingsSectionList) {
  for (const section of sections) {
    const element = getSectionElement(section.id);
    if (element) return element;
  }
  return null;
}

function getAnchorLinePx(root: HTMLElement, sections: SettingsSectionList) {
  const firstSection = getFirstRenderedSection(sections);
  const scrollMarginTop = firstSection
    ? parseCssLengthToPx(window.getComputedStyle(firstSection).scrollMarginTop) ?? 0
    : 0;
  return root.getBoundingClientRect().top + scrollMarginTop;
}

function isRootScrolledToBottom(root: HTMLElement) {
  return root.scrollHeight > root.clientHeight + BOTTOM_EDGE_TOLERANCE_PX
    && root.scrollHeight - root.scrollTop - root.clientHeight <= BOTTOM_EDGE_TOLERANCE_PX;
}

function resolveActiveSectionFromAnchor(root: HTMLElement, sections: SettingsSectionList): SettingsSectionId {
  const firstSectionId = sections[0]?.id ?? SETTINGS_SECTIONS[0].id;
  if (root.clientHeight <= 0) return firstSectionId;

  const lastSection = sections[sections.length - 1];
  if (isRootScrolledToBottom(root)) return lastSection?.id ?? firstSectionId;

  // 激活锚点直接复用 section 的真实 scroll-margin，避免点击定位和滚动高亮使用两套顶部基准。
  const anchorLine = getAnchorLinePx(root, sections);
  let activeSectionId: SettingsSectionId = firstSectionId;

  for (const section of sections) {
    const element = getSectionElement(section.id);
    if (!element) continue;
    if (element.getBoundingClientRect().top <= anchorLine) {
      activeSectionId = section.id;
      continue;
    }
    break;
  }

  return activeSectionId;
}

function getNextSectionId(id: SettingsSectionId, sections: SettingsSectionList) {
  const currentIndex = sections.findIndex((section) => section.id === id);
  const nextSection = sections[currentIndex + 1];
  return nextSection?.id ?? null;
}

function isAnchorStillWithinSection(root: HTMLElement, id: SettingsSectionId, sections: SettingsSectionList) {
  if (resolveActiveSectionFromAnchor(root, sections) !== id) return false;
  const nextSectionId = getNextSectionId(id, sections);
  if (!nextSectionId) return true;
  const nextSection = getSectionElement(nextSectionId);
  if (!nextSection) return true;
  return nextSection.getBoundingClientRect().top > getAnchorLinePx(root, sections);
}

export function useSettingsSectionNavigation(
  sections: SettingsSectionList = SETTINGS_SECTIONS,
  options: SettingsSectionNavigationOptions = {},
) {
  const firstSectionId = sections[0]?.id ?? SETTINGS_SECTIONS[0].id;
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(firstSectionId);
  const programmaticNavigationRef = useRef<ProgrammaticNavigation | null>(null);
  const deferredSectionsReadyRef = useRef(options.deferredSectionIds?.length ? false : true);
  const deferredScrollFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

  const isDeferredSection = useCallback((id: SettingsSectionId) => (
    options.deferredSectionIds?.some((candidate) => candidate === id) ?? false
  ), [options.deferredSectionIds]);

  const applyAnchorActiveSection = useCallback(() => {
    const root = getAppScrollRoot();
    if (root) setActiveSectionId(resolveActiveSectionFromAnchor(root, sections));
  }, [sections]);

  const scheduleAnchorActiveSection = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!programmaticNavigationRef.current) applyAnchorActiveSection();
    });
  }, [applyAnchorActiveSection]);

  const endProgrammaticNavigation = useCallback((options: { applyAnchorSection?: boolean } = {}) => {
    const navigation = programmaticNavigationRef.current;
    if (navigation && navigation.idleTimer !== null) {
      window.clearTimeout(navigation.idleTimer);
    }
    if (deferredScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(deferredScrollFrameRef.current);
      deferredScrollFrameRef.current = null;
    }
    programmaticNavigationRef.current = null;
    if (options.applyAnchorSection) applyAnchorActiveSection();
  }, [applyAnchorActiveSection]);

  const beginProgrammaticNavigation = useCallback((id: SettingsSectionId) => {
    endProgrammaticNavigation();
    const waitingForContent = isDeferredSection(id) && !deferredSectionsReadyRef.current;
    programmaticNavigationRef.current = {
      targetId: id,
      idleTimer: null,
      phase: waitingForContent ? "waitingForContent" : "scrolling",
    };
    setActiveSectionId(id);
    if (!waitingForContent) scrollToSettingsSection(id);
  }, [endProgrammaticNavigation, isDeferredSection]);

  const markDeferredSectionsReady = useCallback(() => {
    // layout effect 的 ready 早于浏览器派发布局替换事件；下一渲染帧再切到 scrolling，避免旧 scrollend 提前结束新导航。
    deferredSectionsReadyRef.current = true;
    const navigation = programmaticNavigationRef.current;
    if (!navigation || navigation.phase !== "waitingForContent") return;
    if (deferredScrollFrameRef.current !== null) return;
    deferredScrollFrameRef.current = window.requestAnimationFrame(() => {
      deferredScrollFrameRef.current = null;
      if (programmaticNavigationRef.current !== navigation || navigation.phase !== "waitingForContent") return;
      navigation.phase = "scrolling";
      scrollToSettingsSection(navigation.targetId);
    });
  }, []);

  useEffect(() => {
    const syncActiveSectionFromHash = () => {
      const sectionId = getSectionFromHash(window.location.hash, sections);
      if (!sectionId) return;
      window.requestAnimationFrame(() => beginProgrammaticNavigation(sectionId));
    };

    syncActiveSectionFromHash();
    window.addEventListener("hashchange", syncActiveSectionFromHash);
    return () => window.removeEventListener("hashchange", syncActiveSectionFromHash);
  }, [beginProgrammaticNavigation, sections]);

  useEffect(() => {
    if (!sections.some((section) => section.id === activeSectionId)) {
      setActiveSectionId(firstSectionId);
    }
  }, [activeSectionId, firstSectionId, sections]);

  useEffect(() => {
    const root = getAppScrollRoot();
    if (!root) return;

    const cancelForUserScroll = () => {
      if (!programmaticNavigationRef.current) return;
      endProgrammaticNavigation({ applyAnchorSection: true });
    };
    const handleScrollEnd = () => {
      const navigation = programmaticNavigationRef.current;
      if (!navigation || navigation.phase === "waitingForContent") return;
      endProgrammaticNavigation({
        applyAnchorSection: !isAnchorStillWithinSection(root, navigation.targetId, sections),
      });
    };
    const handleScroll = () => {
      const navigation = programmaticNavigationRef.current;
      if (!navigation) {
        scheduleAnchorActiveSection();
        return;
      }
      // fallback 会被真实高级区块整体替换；等待 commit 时忽略布局滚动，但 wheel/touch/pointer/key 仍可取消用户意图。
      if (navigation.phase === "waitingForContent") return;
      if (navigation.idleTimer !== null) window.clearTimeout(navigation.idleTimer);
      navigation.idleTimer = window.setTimeout(
        () => {
          const currentNavigation = programmaticNavigationRef.current;
          endProgrammaticNavigation({
            applyAnchorSection: currentNavigation ? !isAnchorStillWithinSection(root, currentNavigation.targetId, sections) : false,
          });
        },
        PROGRAMMATIC_SCROLL_IDLE_MS,
      );
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowDown"
        || event.key === "ArrowUp"
        || event.key === "PageDown"
        || event.key === "PageUp"
        || event.key === "Home"
        || event.key === "End"
        || event.key === " "
      ) {
        cancelForUserScroll();
      }
    };

    // #root 是唯一滚动面；scroll 事件每帧解析一次真实 DOM 位置，避免 IO 阈值没变化时 active 卡在上一段。
    scheduleAnchorActiveSection();
    root.addEventListener("wheel", cancelForUserScroll, { passive: true, capture: true });
    root.addEventListener("touchstart", cancelForUserScroll, { passive: true, capture: true });
    root.addEventListener("pointerdown", cancelForUserScroll, { passive: true, capture: true });
    root.addEventListener("scroll", handleScroll, { passive: true });
    root.addEventListener("scrollend", handleScrollEnd);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      root.removeEventListener("wheel", cancelForUserScroll, { capture: true });
      root.removeEventListener("touchstart", cancelForUserScroll, { capture: true });
      root.removeEventListener("pointerdown", cancelForUserScroll, { capture: true });
      root.removeEventListener("scroll", handleScroll);
      root.removeEventListener("scrollend", handleScrollEnd);
      window.removeEventListener("keydown", handleKeyDown, true);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      endProgrammaticNavigation();
    };
  }, [endProgrammaticNavigation, scheduleAnchorActiveSection, sections]);

  const handleSectionClick = useCallback((id: SettingsSectionId) => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
    beginProgrammaticNavigation(id);
  }, [beginProgrammaticNavigation]);

  return { activeSectionId, handleSectionClick, markDeferredSectionsReady };
}

function SettingsSectionNavLink({
  section,
  active,
  onSectionClick,
  onSectionIntent,
  variant,
}: {
  section: SettingsSectionDefinition;
  active: boolean;
  onSectionClick: (id: SettingsSectionId) => void;
  onSectionIntent?: ((id: SettingsSectionId) => void) | undefined;
  variant: "desktop" | "mobileDrawer";
}) {
  const { t } = useI18n();
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onSectionClick(section.id);
  };

  return (
    <a
      href={`#${section.id}`}
      aria-current={active ? "location" : undefined}
      onClick={handleClick}
      onPointerEnter={() => onSectionIntent?.(section.id)}
      onFocus={() => onSectionIntent?.(section.id)}
      className={cn(
        "group relative transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant === "desktop"
          ? "block rounded-lg px-3 py-2 text-sm font-medium"
          : "block rounded-lg px-3 py-2 text-sm font-medium",
        active && variant === "desktop" && "bg-primary/10 text-primary",
        !active && variant === "desktop" && "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
        active && variant === "mobileDrawer" && "bg-primary/10 text-primary",
        !active && variant === "mobileDrawer" && "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
      )}
    >
      {variant === "desktop" && active ? (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      ) : null}
      {variant === "mobileDrawer" && active ? (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      ) : null}
      <span className="min-w-0 truncate">{t(section.labelKey)}</span>
    </a>
  );
}

export function DesktopSettingsSectionNav({
  sections,
  activeSectionId,
  onSectionClick,
  onSectionIntent,
}: SettingsSectionNavigationProps) {
  const { t } = useI18n();

  return (
    <nav
      aria-label={t("settings.sectionNavLabel")}
      className={settingsLayout.desktopNav}
      data-testid="settings-section-nav-desktop"
    >
      <div className="grid gap-3">
        <p className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.sectionNavTitle")}
        </p>
        <div className="grid gap-1">
          {sections.map((section) => (
            <SettingsSectionNavLink
              key={section.id}
              section={section}
              active={activeSectionId === section.id}
              onSectionClick={onSectionClick}
              onSectionIntent={onSectionIntent}
              variant="desktop"
            />
          ))}
        </div>
      </div>
    </nav>
  );
}

export function MobileSettingsSectionDrawer({
  sections,
  activeSectionId,
  onSectionClick,
  onSectionIntent,
  open,
  onOpenChange,
}: SettingsSectionNavigationProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const handleSectionClick = (id: SettingsSectionId) => {
    onSectionClick(id);
    onOpenChange(false);
  };

  return (
    <SideDrawerRoot open={open} onOpenChange={onOpenChange}>
      <MobileSettingsPageHeader />
      <SideDrawerContent
        side="left"
        className="w-[min(18rem,calc(100vw-3.5rem))] rounded-r-xl bg-card/95 backdrop-blur-xl"
        data-testid="settings-section-nav-drawer"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 pb-3 pt-[calc(1rem+env(safe-area-inset-top))]">
          <div className="min-w-0">
            <SideDrawerTitle className="text-base font-semibold text-foreground">
              {t("settings.sectionNavTitle")}
            </SideDrawerTitle>
            <SideDrawerDescription className="sr-only">
              {t("settings.sectionNavLabel")}
            </SideDrawerDescription>
          </div>
          <SideDrawerClose asChild>
            <Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-10 w-10 text-muted-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">{t("common.close")}</span>
            </Button>
          </SideDrawerClose>
        </div>

        <nav aria-label={t("settings.sectionNavLabel")} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <ul className="grid gap-1">
            {sections.map((section) => (
              <li key={section.id}>
                <SettingsSectionNavLink
                  section={section}
                  active={activeSectionId === section.id}
                  onSectionClick={handleSectionClick}
                  onSectionIntent={onSectionIntent}
                  variant="mobileDrawer"
                />
              </li>
            ))}
          </ul>
        </nav>
      </SideDrawerContent>
    </SideDrawerRoot>
  );
}

function MobileSettingsPageHeader() {
  const { t } = useI18n();

  return (
    <div
      className={settingsLayout.mobileHeader}
      data-testid="settings-mobile-page-header"
    >
      <div className={settingsLayout.mobileHeaderRow}>
        <div className={settingsLayout.mobileHeaderText}>
          <h1 className={settingsLayout.mobileHeaderTitle}>{t("settings.title")}</h1>
          <p className={settingsLayout.mobileHeaderSubtitle} data-testid="settings-mobile-page-subtitle">
            {t("settings.subtitle")}
          </p>
        </div>
        <SideDrawerTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={settingsLayout.mobileHeaderTrigger}
            aria-label={t("settings.sectionNavOpen")}
          >
            <Menu className="h-4 w-4" />
          </Button>
        </SideDrawerTrigger>
      </div>
    </div>
  );
}

export function useUnsavedChangesGuard(enabled: boolean, onConfirmLeave: () => void) {
  const router = useRouter();
  const [pendingUrl, setPendingUrl] = useState<URL | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      const currentUrl = new URL(window.location.href);
      if (
        nextUrl.pathname === currentUrl.pathname
        && nextUrl.search === currentUrl.search
        && nextUrl.hash === currentUrl.hash
      ) {
        return;
      }
      // 设置目录只改 hash，属于页内定位；不应触发“离开设置页”的未保存确认。
      if (nextUrl.pathname === currentUrl.pathname && nextUrl.search === currentUrl.search) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setPendingUrl(nextUrl);
    };

    // beforeunload 只能显示浏览器通用文案；站内 SPA 导航在这里转成 Renewlet 风格确认弹窗。
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [enabled]);

  useEffect(() => {
    if (enabled) return;
    setPendingUrl(null);
  }, [enabled]);

  const cancelLeave = useCallback(() => {
    setPendingUrl(null);
  }, []);

  const confirmLeave = useCallback(() => {
    if (!pendingUrl) return;
    const nextPath = `${pendingUrl.pathname}${pendingUrl.search}${pendingUrl.hash}`;
    setPendingUrl(null);
    onConfirmLeave();
    router.push(nextPath);
  }, [router, onConfirmLeave, pendingUrl]);

  return {
    pendingLeave: pendingUrl !== null,
    cancelLeave,
    confirmLeave,
  };
}
