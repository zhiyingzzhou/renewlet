import type { SubscriptionCollectionItem } from "@/types/subscription";

type SubscriptionGridRow =
  | { kind: "heading"; key: string; category: string; count: number }
  | { kind: "cards"; key: string; items: SubscriptionCollectionItem[] };

export function buildSubscriptionGridRows(
  subscriptions: readonly SubscriptionCollectionItem[],
  columns: 1 | 2 | 3,
  categoryOrder?: Iterable<string>,
): SubscriptionGridRow[] {
  const rows: SubscriptionGridRow[] = [];

  function appendCards(items: readonly SubscriptionCollectionItem[]) {
    for (let start = 0; start < items.length; start += columns) {
      const cards = items.slice(start, start + columns);
      rows.push({ kind: "cards", key: `cards:${cards[0]!.id}`, items: cards });
    }
  }

  if (!categoryOrder) {
    appendCards(subscriptions);
    return rows;
  }

  // 输入已按置顶、有效生命周期和用户排序排好。按原序入组，置顶只在本分类内优先。
  const groups = new Map<string, SubscriptionCollectionItem[]>();
  for (const item of subscriptions) {
    const group = groups.get(item.category);
    if (group) group.push(item);
    else groups.set(item.category, [item]);
  }

  function appendGroup(category: string) {
    const items = groups.get(category);
    if (!items) return;
    rows.push({ kind: "heading", key: `heading:${category}`, category, count: items.length });
    appendCards(items);
    groups.delete(category);
  }

  for (const category of categoryOrder) appendGroup(category);
  // 配置缺失的历史分类仍各自成组，按原值排在末尾，避免组序随组内排序或语言切换而变动。
  for (const category of [...groups.keys()].sort()) appendGroup(category);
  return rows;
}
