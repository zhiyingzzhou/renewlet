import type { Env } from "./types";

export interface SubscriptionFacetsQueryPlan {
  counts: { sql: string; params: [string, string] };
  categories: { sql: string; params: [string] };
  tags: { sql: string; params: [string] };
}

export interface SubscriptionFacetsResult {
  total: number;
  categoryCounts: Record<string, number>;
  tags: string[];
  visibleCount: number;
  hiddenCount: number;
  expiredCount: number;
  lifetimeCount: number;
}

export function subscriptionFacetsQueryPlan(userId: string, today = "9999-12-31"): SubscriptionFacetsQueryPlan {
  return {
    counts: {
      sql: `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN public_hidden = 0 THEN 1 ELSE 0 END), 0) AS visible_count,
        COALESCE(SUM(CASE WHEN public_hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden_count,
        COALESCE(SUM(CASE WHEN status = 'expired' OR (status IN ('active', 'trial') AND next_billing_date < ?) THEN 1 ELSE 0 END), 0) AS expired_count,
        COALESCE(SUM(CASE WHEN billing_cycle = 'one-time' AND COALESCE(one_time_term_count, 0) <= 0 THEN 1 ELSE 0 END), 0) AS lifetime_count
        FROM subscription_list_index WHERE user_id = ?`,
      params: [today, userId],
    },
    categories: {
      sql: `SELECT category, COUNT(*) AS count FROM subscription_list_index
        WHERE user_id = ? GROUP BY category`,
      params: [userId],
    },
    tags: {
      sql: `SELECT tag FROM subscription_tags WHERE user_id = ?
        GROUP BY tag ORDER BY lower(tag), tag`,
      params: [userId],
    },
  };
}

export async function readSubscriptionFacetsForUser(env: Env, userId: string, today = "9999-12-31"): Promise<SubscriptionFacetsResult> {
  const plan = subscriptionFacetsQueryPlan(userId, today);
  const [counts, categories, tags] = await Promise.all([
    env.DB.prepare(plan.counts.sql).bind(...plan.counts.params)
      .first<{ total: number; visible_count: number; hidden_count: number; expired_count: number; lifetime_count: number }>(),
    env.DB.prepare(plan.categories.sql).bind(...plan.categories.params)
      .all<{ category: string; count: number }>(),
    env.DB.prepare(plan.tags.sql).bind(...plan.tags.params)
      .all<{ tag: string }>(),
  ]);
  return {
    total: counts?.total ?? 0,
    categoryCounts: Object.fromEntries(categories.results.map((row) => [row.category, row.count])),
    tags: tags.results.map((row) => row.tag),
    visibleCount: counts?.visible_count ?? 0,
    hiddenCount: counts?.hidden_count ?? 0,
    expiredCount: counts?.expired_count ?? 0,
    lifetimeCount: counts?.lifetime_count ?? 0,
  };
}
