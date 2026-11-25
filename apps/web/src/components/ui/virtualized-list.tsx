/**
 * 共享虚拟列表原语。
 *
 * 架构位置：
 * - 将 TanStack Virtual 的使用集中在一个轻量、无样式包装中。
 * - 调用方仍负责 item markup、Tailwind class 和滚动容器。
 *
 * 注意：调用方必须通过 `getScrollElement` 传入真实滚动容器；本组件会计算 scrollMargin，
 * 让列表可以稳定放在 header/filter 下方。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  defaultRangeExtractor,
  measureElement as measureVirtualElement,
  observeElementRect,
  useVirtualizer,
  type Rect,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

type VirtualItemKey = string | number | bigint;

type VirtualizedListProps = {
  /** 总项数来自调用方筛选后的稳定列表；虚拟器不感知业务分页。 */
  count: number;
  /** 估算高度是滚动体验边界，必须覆盖动态内容的常见最大值，避免滚动条跳动。 */
  estimatedItemSize: number | ((index: number) => number);
  /** key 必须来自业务稳定 id，不能用可变展示文案。 */
  getItemKey: (index: number) => VirtualItemKey;
  /** Renewlet 的滚动根通常是 #root 或 Dialog body，显式传入可避免 window 滚动假设。 */
  getScrollElement: () => HTMLElement | null;
  renderItem: (index: number, virtualItem: VirtualItem) => ReactNode;
  className?: string;
  itemClassName?: string | ((index: number, virtualItem: VirtualItem) => string | undefined);
  overscan?: number;
  gap?: number;
  testId?: string;
  retainKeyboardFocus?: boolean;
};

function getInitialRect() {
  if (typeof window === "undefined") {
    return { width: 1024, height: 768 };
  }

  return {
    width: Math.max(window.innerWidth, 1),
    height: Math.max(window.innerHeight, 1),
  };
}

function getScrollMargin(container: HTMLElement, scrollElement: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  if (containerRect.height === 0 && scrollRect.height === 0) {
    // 隐藏布局恢复前 DOMRect 可能全为 0；沿 offsetParent 链定位可避免虚拟项在首次可见时整体跳动。
    return getOffsetTopWithinScrollElement(container, scrollElement);
  }
  return Math.max(0, scrollElement.scrollTop + containerRect.top - scrollRect.top);
}

function getOffsetTopWithinScrollElement(container: HTMLElement, scrollElement: HTMLElement) {
  let offsetTop = 0;
  let current: HTMLElement | null = container;

  while (current && current !== scrollElement) {
    offsetTop += current.offsetTop;
    current = current.offsetParent instanceof HTMLElement ? current.offsetParent : null;
  }

  return offsetTop;
}

/** VirtualizedList 封装 TanStack Virtual 与 Renewlet 固定滚动根之间的 scrollMargin 适配。 */
export function VirtualizedList({
  count,
  estimatedItemSize,
  getItemKey,
  getScrollElement,
  renderItem,
  className,
  itemClassName,
  overscan = 4,
  gap = 0,
  testId,
  retainKeyboardFocus = false,
}: VirtualizedListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    if (!retainKeyboardFocus || focusedIndex === null) return indexes;
    // 焦点行及前后两行（含日期标题）必须留在 DOM，Tab/Shift+Tab 才能跨虚拟窗口继续，滚动也不会卸载当前焦点。
    for (const index of [focusedIndex - 2, focusedIndex - 1, focusedIndex, focusedIndex + 1, focusedIndex + 2]) {
      if (index >= 0 && index < range.count) indexes.push(index);
    }
    return [...new Set(indexes)].sort((a, b) => a - b);
  }, [focusedIndex, retainKeyboardFocus]);
  const initialRect = useMemo(() => getInitialRect(), []);
  const estimateSize = useCallback((index: number) => (
    typeof estimatedItemSize === "number" ? estimatedItemSize : estimatedItemSize(index)
  ), [estimatedItemSize]);
  const measureElementWithFallback = useCallback(
    (
      element: HTMLDivElement,
      entry: ResizeObserverEntry | undefined,
      instance: Virtualizer<HTMLElement, HTMLDivElement>,
    ) => {
      const measuredSize = measureVirtualElement(element, entry, instance);
      if (measuredSize > 0) return measuredSize;

      // 浏览器首帧或隐藏布局可能暂时返回 0；估算高度用于维持滚动范围，真实尺寸随后由 ResizeObserver 校正。
      return estimateSize(instance.indexFromElement(element));
    },
    [estimateSize],
  );
  const observeRectWithFallback = useCallback(
    (
      instance: Virtualizer<HTMLElement, HTMLDivElement>,
      callback: (rect: Rect) => void,
    ) =>
      observeElementRect(instance, (rect) => {
        callback({
          // ResizeObserver 在首轮布局前可能给 0 尺寸；初始 viewport 兜底能减少虚拟器抖动。
          width: rect.width > 0 ? rect.width : initialRect.width,
          height: rect.height > 0 ? rect.height : initialRect.height,
        });
      }),
    [initialRect],
  );

  const measureScrollMargin = useCallback(() => {
    const container = containerRef.current;
    const scrollElement = getScrollElement();
    if (!container || !scrollElement) return;

    const nextScrollMargin = getScrollMargin(container, scrollElement);
    setScrollMargin((current) => (Math.abs(current - nextScrollMargin) < 1 ? current : nextScrollMargin));
  }, [getScrollElement]);

  useLayoutEffect(() => {
    measureScrollMargin();
  }, [count, measureScrollMargin]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const scrollElement = getScrollElement();
    if (!container || !scrollElement || typeof ResizeObserver === "undefined") return undefined;

    // 头部/筛选区高度变化会改 scrollMargin；同时观察容器和滚动根，避免虚拟项整体漂移。
    const observer = new ResizeObserver(() => measureScrollMargin());
    observer.observe(container);
    observer.observe(scrollElement);

    const ownerWindow = scrollElement.ownerDocument.defaultView ?? window;
    ownerWindow.addEventListener("resize", measureScrollMargin);
    return () => {
      observer.disconnect();
      ownerWindow.removeEventListener("resize", measureScrollMargin);
    };
  }, [getScrollElement, measureScrollMargin]);

  // TanStack Virtual 有意返回命令式 virtualizer 实例；把它限制在本原语内，避免调用方扩散不兼容 hook 模式。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count,
    estimateSize,
    gap,
    getItemKey,
    getScrollElement,
    initialRect,
    measureElement: measureElementWithFallback,
    observeElementRect: observeRectWithFallback,
    overscan,
    scrollMargin,
    rangeExtractor,
  });

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      data-testid={testId}
      onFocusCapture={retainKeyboardFocus ? (event) => {
        const row = event.target.closest<HTMLElement>("[data-index]");
        if (row) setFocusedIndex(Number(row.dataset["index"]));
      } : undefined}
      onBlurCapture={retainKeyboardFocus ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(null);
      } : undefined}
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const resolvedItemClassName =
          typeof itemClassName === "function"
            ? itemClassName(virtualItem.index, virtualItem)
            : itemClassName;

        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            className={resolvedItemClassName}
            data-index={virtualItem.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            {renderItem(virtualItem.index, virtualItem)}
          </div>
        );
      })}
    </div>
  );
}
