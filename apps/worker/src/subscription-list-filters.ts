import {
  SUBSCRIPTION_PAYMENT_METHOD_NONE,
  type SubscriptionsListQuery,
} from "@renewlet/shared/schemas/subscriptions";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS } from "@renewlet/shared/runtime";
import {
  SUBSCRIPTION_COLUMN_NAMES,
  SUBSCRIPTION_COLLECTION_COLUMN_NAMES,
} from "./db";
import type { Env, SubscriptionCollectionRow } from "./types";

const SUBSCRIPTION_COLLECTION_COLUMNS_FROM_FACT = SUBSCRIPTION_COLLECTION_COLUMN_NAMES
  .map((column) => `sub.${column}`)
  .join(", ");
const SUBSCRIPTION_COLUMNS_FROM_FACT = SUBSCRIPTION_COLUMN_NAMES.map((column) => `sub.${column}`).join(", ");
const DEFAULT_SUBSCRIPTION_ORDER_SQL = "idx.pinned DESC, idx.inactive ASC, idx.created_at DESC, idx.subscription_id DESC";

export interface PrivateSubscriptionCursor {
  v: 1;
  asOf: string;
  pinned: 0 | 1;
  inactive: 0 | 1;
  createdAt: string;
  id: string;
}

export type SubscriptionCollectionFilters = Omit<SubscriptionsListQuery, "cursor" | "limit">;

export interface SubscriptionSqlQueryPlan {
  sql: string;
  params: unknown[];
}

export interface BoundedSubscriptionCollectionQueryPlan {
  preflight: SubscriptionSqlQueryPlan;
  facts: SubscriptionSqlQueryPlan;
}

/**
 * 订阅筛选保留 exact total：筛选条件只作用于轻量投影，事实表 JOIN 也只读取集合 DTO 所需列。
 *
 * cursor 只能影响本页起点，不能进入 total 口径；否则筛选页顶部统计会随滚动递减。
 */
export async function listSubscriptionsForQuery(
  env: Env,
  userId: string,
  query: SubscriptionsListQuery,
  today: string,
  cursor: PrivateSubscriptionCursor | null,
): Promise<{ rows: SubscriptionCollectionRow[]; total: number }> {
  // 私有页无论是否筛选都走 owner-scoped 投影，确保 Worker 与 Docker 使用同一生命周期顺序和 cursor 键。
  const plan = subscriptionCollectionPageQueryPlan(userId, query, today, query.limit + 1, cursor);
  return await readSubscriptionCollectionPage(env, plan);
}

/** 完整集合先在投影层确认上限，再读取轻量事实列；超限请求不会触碰 subscriptions facts。 */
export async function listBoundedSubscriptionsForQuery(
  env: Env,
  userId: string,
  query: SubscriptionCollectionFilters,
  today: string,
  maxItems: number,
): Promise<{ rows: SubscriptionCollectionRow[]; total: number; exceeded: boolean }> {
  const plan = boundedSubscriptionCollectionQueryPlan(userId, query, today, maxItems + 1);
  const total = await countSubscriptionProjection(env, plan.preflight);
  if (total > maxItems) return { rows: [], total, exceeded: true };

  // count 与读取之间若发生并发写入，额外一行仍会把请求收敛为 422，不能返回伪完整集合。
  const rows = await readSubscriptionCollectionFacts(env, plan.facts);
  if (rows.length > maxItems) return { rows: [], total: rows.length, exceeded: true };
  // 成功响应以事实行数为 total，避免 count 后并发删除留下与返回数组不一致的元数据。
  return { rows, total: rows.length, exceeded: false };
}

type SubscriptionProjectionQuery = { where: string; params: unknown[] };

export function subscriptionCollectionPageQueryPlan(
  userId: string,
  query: SubscriptionCollectionFilters,
  today: string,
  limit: number,
  cursor?: PrivateSubscriptionCursor | null,
): SubscriptionSqlQueryPlan {
  const base = subscriptionListBaseQuery(userId, query, today);
  const cursorCondition = cursor ? `AND (
    idx.pinned < ?
    OR (idx.pinned = ? AND idx.inactive > ?)
    OR (idx.pinned = ? AND idx.inactive = ? AND idx.created_at < ?)
    OR (idx.pinned = ? AND idx.inactive = ? AND idx.created_at = ? AND idx.subscription_id < ?)
  )` : "";
  const cursorParams = cursor ? [
    cursor.pinned,
    cursor.pinned, cursor.inactive,
    cursor.pinned, cursor.inactive, cursor.createdAt,
    cursor.pinned, cursor.inactive, cursor.createdAt, cursor.id,
  ] : [];
  return {
    // D1 单库逐条处理查询；热分页把 exact total 和 page facts 合并，避免 count/facts 双重扫描 owner 投影。
    sql: `
      WITH filtered AS (
        SELECT idx.subscription_id, idx.user_id, idx.pinned, idx.created_at,
          ${subscriptionInactiveRankSql("idx")} AS inactive
        FROM subscription_list_index AS idx
        WHERE ${base.where}
      ), page AS (
        SELECT *
        FROM filtered AS idx
        WHERE 1 = 1 ${cursorCondition}
        ORDER BY ${DEFAULT_SUBSCRIPTION_ORDER_SQL}
        LIMIT ?
      ), totals AS (
        SELECT COUNT(*) AS collection_total FROM filtered
      )
      SELECT totals.collection_total, page.subscription_id AS collection_subscription_id,
        ${SUBSCRIPTION_COLLECTION_COLUMNS_FROM_FACT}
      FROM totals
      LEFT JOIN page ON 1 = 1
      LEFT JOIN subscriptions AS sub ON sub.user_id = page.user_id AND sub.id = page.subscription_id
      ORDER BY page.pinned DESC, page.inactive ASC, page.created_at DESC, page.subscription_id DESC
    `,
    params: [today, ...base.params, ...cursorParams, limit],
  };
}

export function boundedSubscriptionCollectionQueryPlan(
  userId: string,
  query: SubscriptionCollectionFilters,
  today: string,
  limit: number,
): BoundedSubscriptionCollectionQueryPlan {
  const base = subscriptionListBaseQuery(userId, query, today);
  return {
    preflight: {
      sql: `SELECT COUNT(*) AS total FROM (
        SELECT 1 FROM subscription_list_index AS idx WHERE ${base.where} LIMIT ?
      )`,
      params: [...base.params, limit],
    },
    facts: {
      sql: `
        WITH filtered AS (
          SELECT idx.subscription_id, idx.user_id, idx.pinned, idx.created_at,
            ${subscriptionInactiveRankSql("idx")} AS inactive
          FROM subscription_list_index AS idx
          WHERE ${base.where}
          ORDER BY idx.pinned DESC, inactive ASC, idx.created_at DESC, idx.subscription_id DESC
          LIMIT ?
        )
        SELECT ${SUBSCRIPTION_COLLECTION_COLUMNS_FROM_FACT}
        FROM filtered AS idx
        INNER JOIN subscriptions AS sub ON sub.user_id = idx.user_id AND sub.id = idx.subscription_id
        ORDER BY ${DEFAULT_SUBSCRIPTION_ORDER_SQL}
      `,
      params: [today, ...base.params, limit],
    },
  };
}

export function publicStatusSubscriptionQueryPlan(
  userId: string,
  today: string,
  limit: number,
  options: { hideExpired?: boolean; hideLifetime?: boolean } = {},
): SubscriptionSqlQueryPlan {
  const filters: string[] = ["idx.user_id = ?", "idx.public_hidden = 0"];
  const params: unknown[] = [today, userId];
  if (options.hideExpired) {
    filters.push("NOT (idx.status = 'expired' OR (idx.status IN ('active', 'trial') AND idx.next_billing_date < ?))");
    params.push(today);
  }
  if (options.hideLifetime) {
    filters.push("NOT (idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0)");
  }
  return {
    sql: `
      WITH ranked AS (
        SELECT idx.subscription_id, idx.user_id, idx.pinned, idx.created_at,
          ${subscriptionInactiveRankSql("idx")} AS inactive
        FROM subscription_list_index AS idx
        WHERE ${filters.join(" AND ")}
      ), page AS MATERIALIZED (
        SELECT *
        FROM ranked AS idx
        ORDER BY ${DEFAULT_SUBSCRIPTION_ORDER_SQL}
        LIMIT ?
      )
      SELECT ${SUBSCRIPTION_COLUMNS_FROM_FACT}
      FROM page AS idx
      INNER JOIN subscriptions AS sub ON sub.user_id = idx.user_id AND sub.id = idx.subscription_id
      ORDER BY ${DEFAULT_SUBSCRIPTION_ORDER_SQL}
    `,
    params: [...params, limit],
  };
}

function subscriptionInactiveRankSql(alias: string): string {
  return `CASE
    WHEN ${alias}.status IN ('expired', 'paused', 'cancelled') THEN 1
    WHEN ${alias}.billing_cycle = 'one-time' AND COALESCE(${alias}.one_time_term_count, 0) <= 0 THEN 0
    WHEN ${alias}.status IN ('active', 'trial') AND ${alias}.next_billing_date < ? THEN 1
    ELSE 0
  END`;
}

export function isSubscriptionCollectionInactive(
  row: Pick<SubscriptionCollectionRow, "status" | "billing_cycle" | "one_time_term_count" | "next_billing_date">,
  asOf: string,
): 0 | 1 {
  if (row.status === "expired" || row.status === "paused" || row.status === "cancelled") return 1;
  if (row.billing_cycle === "one-time" && (row.one_time_term_count ?? 0) <= 0) return 0;
  return (row.status === "active" || row.status === "trial") && row.next_billing_date < asOf ? 1 : 0;
}

export function privateSubscriptionCursor(
  row: Pick<SubscriptionCollectionRow, "id" | "pinned" | "status" | "billing_cycle" | "one_time_term_count" | "next_billing_date" | "created_at">,
  asOf: string,
): string {
  // 私有 cursor 冻结日界线并携带完整排序元组；Public API 的旧 cursor 由 db.ts 独立维护。
  const payload: PrivateSubscriptionCursor = {
    v: 1,
    asOf,
    pinned: row.pinned === 1 ? 1 : 0,
    inactive: isSubscriptionCollectionInactive(row, asOf),
    createdAt: row.created_at,
    id: row.id,
  };
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function parsePrivateSubscriptionCursor(value?: string): PrivateSubscriptionCursor | null {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(base64)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "asOf,createdAt,id,inactive,pinned,v") return null;
    if (record["v"] !== 1 || !isDateOnly(record["asOf"])) return null;
    if (record["pinned"] !== 0 && record["pinned"] !== 1) return null;
    if (record["inactive"] !== 0 && record["inactive"] !== 1) return null;
    if (typeof record["createdAt"] !== "string" || record["createdAt"].trim() === "") return null;
    if (typeof record["id"] !== "string" || record["id"].trim() === "") return null;
    return {
      v: 1,
      asOf: record["asOf"],
      pinned: record["pinned"],
      inactive: record["inactive"],
      createdAt: record["createdAt"],
      id: record["id"],
    };
  } catch {
    return null;
  }
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function countSubscriptionProjection(env: Env, plan: SubscriptionSqlQueryPlan): Promise<number> {
  const row = await env.DB.prepare(plan.sql)
    .bind(...plan.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function readSubscriptionCollectionFacts(
  env: Env,
  plan: SubscriptionSqlQueryPlan,
): Promise<SubscriptionCollectionRow[]> {
  const page = await env.DB.prepare(plan.sql).bind(...plan.params).all<SubscriptionCollectionRow>();
  return page.results;
}

type NullableSubscriptionCollectionRow = {
  [Key in keyof SubscriptionCollectionRow]: SubscriptionCollectionRow[Key] | null;
};

type SubscriptionCollectionPageResult = NullableSubscriptionCollectionRow & {
  collection_total: number;
  collection_subscription_id: string | null;
};

async function readSubscriptionCollectionPage(
  env: Env,
  plan: SubscriptionSqlQueryPlan,
): Promise<{ rows: SubscriptionCollectionRow[]; total: number }> {
  const result = await env.DB.prepare(plan.sql).bind(...plan.params).all<SubscriptionCollectionPageResult>();
  const total = result.results[0]?.collection_total ?? 0;
  const rows = result.results.flatMap(({ collection_total: _total, collection_subscription_id, ...row }) =>
    collection_subscription_id && typeof row.id === "string" ? [row as SubscriptionCollectionRow] : []);
  return { rows, total };
}

function subscriptionListBaseQuery(
  userId: string,
  query: SubscriptionCollectionFilters,
  today: string,
): { where: string; params: unknown[] } {
  // 所有筛选都在 owner-scoped 投影中完成；事实表 JOIN 只负责返回规范化 DTO 所需字段。
  const conditions = ["idx.user_id = ?"];
  const params: unknown[] = [userId];
  appendSqlJsonArrayCondition(conditions, params, "idx.category", query.category);
  appendSqlJsonArrayCondition(conditions, params, "idx.billing_cycle", query.billingCycle);
  appendSqlJsonArrayCondition(conditions, params, "idx.currency", query.currency);
  appendPaymentMethodCondition(conditions, params, query.paymentMethod);
  appendPaymentTypeCondition(conditions, query.paymentType);
  appendTagCondition(conditions, params, query.tag);
  if (query.nextBillingFrom || query.nextBillingTo) {
    // D1 用 NULL 表示长期买断服务期；日期范围只描述真实续费/到期事件，固定服务期仍正常参与。
    conditions.push("NOT (idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0)");
  }
  if (query.nextBillingFrom) {
    conditions.push("idx.next_billing_date >= ?");
    params.push(query.nextBillingFrom);
  }
  if (query.nextBillingTo) {
    conditions.push("idx.next_billing_date <= ?");
    params.push(query.nextBillingTo);
  }
  if (query.pinned !== undefined) {
    conditions.push("idx.pinned = ?");
    params.push(query.pinned ? 1 : 0);
  }
  if (query.publicHidden !== undefined) {
    conditions.push("idx.public_hidden = ?");
    params.push(query.publicHidden ? 1 : 0);
  }
  appendReminderModeCondition(conditions, params, query.reminderMode);
  if (query.repeatReminder !== undefined) {
    conditions.push("idx.repeat_reminder_enabled = ?");
    params.push(query.repeatReminder ? 1 : 0);
  }
  if (query.q) {
    conditions.push("instr(idx.search_text_lower, ?) > 0");
    params.push(query.q.trim().toLowerCase());
  }
  if (query.status) {
    conditions.push(`(CASE
      WHEN idx.status = 'expired' THEN 'expired'
      WHEN idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0 THEN idx.status
      WHEN idx.status IN ('active', 'trial') AND idx.next_billing_date < ? THEN 'expired'
      ELSE idx.status
    END) = ?`);
    params.push(today, query.status);
  }
  return { where: conditions.join(" AND "), params };
}

function appendSqlJsonArrayCondition(conditions: string[], params: unknown[], column: string, values: readonly string[] | undefined): void {
  if (!values?.length) return;
  // D1 每条 SQL 最多 100 个绑定参数；每个多选维度必须压成一个 JSON 参数再由 JSON1 展开。
  conditions.push(`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(?))`);
  params.push(JSON.stringify(values));
}

function appendPaymentMethodCondition(conditions: string[], params: unknown[], values: readonly string[] | undefined): void {
  if (!values?.length) return;
  const concrete = values.filter((value) => value !== SUBSCRIPTION_PAYMENT_METHOD_NONE);
  const parts: string[] = [];
  if (values.includes(SUBSCRIPTION_PAYMENT_METHOD_NONE)) parts.push("(idx.payment_method IS NULL OR idx.payment_method = '')");
  if (concrete.length > 0) {
    parts.push("idx.payment_method IN (SELECT CAST(value AS TEXT) FROM json_each(?))");
    params.push(JSON.stringify(concrete));
  }
  conditions.push(`(${parts.join(" OR ")})`);
}

function appendPaymentTypeCondition(conditions: string[], paymentType: SubscriptionsListQuery["paymentType"]): void {
  switch (paymentType) {
    case "auto":
      conditions.push("idx.billing_cycle != 'one-time' AND idx.auto_renew = 1");
      break;
    case "manual":
      conditions.push("idx.billing_cycle != 'one-time' AND idx.auto_renew = 0");
      break;
    case "one-time-buyout":
      // D1 历史买断可能保存 NULL；COALESCE 后与 Docker 空数字字段落为 0 的分类语义一致。
      conditions.push("idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0");
      break;
    case "one-time-fixed-term":
      conditions.push("idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) > 0");
      break;
  }
}

function appendTagCondition(conditions: string[], params: unknown[], values: readonly string[] | undefined): void {
  const tags = values
    ?.map((rawValue) => rawValue.trim())
    .filter((value) => value !== "") ?? [];
  if (tags.length === 0) return;
  const selectedTags = tags.map((value) => ({ key: value.toLowerCase(), value }));
  // tag_norm 在应用层完成 Unicode 归一，tag 原文保留大小写精确语义；整维仍只占一个 D1 参数。
  conditions.push(`
    EXISTS (
      SELECT 1 FROM subscription_tags AS tag
      INNER JOIN json_each(?) AS selected
        ON tag.tag_norm = CAST(json_extract(selected.value, '$.key') AS TEXT)
        AND tag.tag = CAST(json_extract(selected.value, '$.value') AS TEXT)
      WHERE tag.user_id = idx.user_id
        AND tag.subscription_id = idx.subscription_id
    )
  `);
  params.push(JSON.stringify(selectedTags));
}

function appendReminderModeCondition(
  conditions: string[],
  params: unknown[],
  mode: SubscriptionsListQuery["reminderMode"],
): void {
  switch (mode) {
    case "disabled":
      conditions.push("idx.reminder_days = ?");
      params.push(DISABLED_REMINDER_DAYS);
      break;
    case "inherit":
      conditions.push("idx.reminder_days = ?");
      params.push(INHERIT_REMINDER_DAYS);
      break;
    case "custom":
      conditions.push("idx.reminder_days >= 0");
      break;
  }
}
