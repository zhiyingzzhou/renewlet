import { useCallback, useRef, type ReactNode } from "react";
import { VirtualizedList } from "@/components/ui/virtualized-list";

interface CalendarEventListProps {
  count: number;
  getItemKey: (index: number) => string;
  renderItem: (index: number) => ReactNode;
  estimatedItemSize: number;
  testId: string;
}

/** 小列表保留自然文档流；大列表使用真实页面/弹窗滚动根，不增加嵌套滚动区域。 */
export function CalendarEventList({ count, getItemKey, renderItem, estimatedItemSize, testId }: CalendarEventListProps) {
  const container = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => {
    let element = container.current?.parentElement;
    while (element) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element;
      element = element.parentElement;
    }
    return document.getElementById("root");
  }, []);
  return (
    <div ref={container} className="min-w-0 max-w-full" data-testid={testId}>
      {count > 100 ? (
        <VirtualizedList count={count} getItemKey={getItemKey} renderItem={renderItem}
          estimatedItemSize={estimatedItemSize} getScrollElement={getScrollElement} retainKeyboardFocus />
      ) : (
        Array.from({ length: count }, (_, index) => <div key={getItemKey(index)}>{renderItem(index)}</div>)
      )}
    </div>
  );
}
