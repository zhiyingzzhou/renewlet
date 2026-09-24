import { SUBSCRIPTION_INDEX_LIMIT, subscriptionBulkPublicVisibilityPayloadSchema, subscriptionBulkPublicVisibilityRequestSchema, type SubscriptionBulkPublicVisibilityRequest } from "@renewlet/shared/schemas/subscriptions";
import { requireAuth } from "./auth";
import { boolToInt, getSettings, nowIso } from "./db";
import { HttpError, readJson, requestLocale, successJson, type AppLocale } from "./http";
import { serverText } from "./server-i18n";
import { dateOnlyInZone } from "./subscription-renewal";
import type { Env, SubscriptionRow } from "./types";

const targetColumns = ["id", "user_id", "public_hidden", "updated_at", "status", "next_billing_date", "billing_cycle", "one_time_term_count"] as const;
type VisibilityTarget = Pick<SubscriptionRow, typeof targetColumns[number]>;
const snapshotColumns = targetColumns.filter((column) => column !== "user_id");

export async function bulkUpdatePublicVisibility(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, subscriptionBulkPublicVisibilityRequestSchema, locale);
  try {
    const today = dateOnlyInZone(new Date(), (await getSettings(env, auth.user.id)).timezone);
    const rows = await listVisibilityTargets(env, auth.user.id, body.selection, today, locale);
    const matchedIds = new Set(rows.map((row) => row.id));
    const failedIds = "ids" in body.selection ? [...new Set(body.selection.ids)].filter((id) => !matchedIds.has(id)) : [];
    const changed = rows.filter((row) => row.public_hidden !== boolToInt(body.publicHidden));
    if (!body.dryRun) await writePublicVisibility(env, auth.user.id, changed, body.publicHidden, locale);
    return successJson(subscriptionBulkPublicVisibilityPayloadSchema.parse({
      matchedCount: rows.length, changedCount: changed.length, skippedCount: rows.length - changed.length, failedIds,
    }));
  } catch (error) {
    throw visibilityError(error, locale);
  }
}

async function listVisibilityTargets(env: Env, userId: string, selection: SubscriptionBulkPublicVisibilityRequest["selection"], today: string, locale: AppLocale): Promise<VisibilityTarget[]> {
  if ("ids" in selection) {
    const ids = [...new Set(selection.ids)];
    const byId = new Map<string, VisibilityTarget>();
    // D1 每条语句最多 100 个绑定参数；400 条读取批次用 JSON1 传两个参数，不能为每个 ID 展开占位符。
    // JSON 目标驱动 ID 点查，避免每个分块重新扫描 owner 下的全部订阅。
    for (let offset = 0; offset < ids.length; offset += 400) {
      const result = await env.DB.prepare(`SELECT ${targetColumns.map((column) => `s.${column}`).join(", ")}
        FROM json_each(?) AS selected CROSS JOIN subscriptions AS s ON s.id = selected.value WHERE s.user_id = ?`)
        .bind(JSON.stringify(ids.slice(offset, offset + 400)), userId).all<VisibilityTarget>();
      for (const row of result.results) byId.set(row.id, row);
    }
    return ids.flatMap((id) => { const row = byId.get(id); return row ? [row] : []; });
  }
  const predicates: string[] = [];
  const values: Array<string | number> = [userId];
  if (selection.categories.includes("expired")) {
    predicates.push("(status = 'expired' OR (status IN ('active', 'trial') AND next_billing_date < ?))");
    values.push(today);
  }
  if (selection.categories.includes("lifetime")) predicates.push("(billing_cycle = 'one-time' AND COALESCE(one_time_term_count, 0) <= 0)");
  const result = await env.DB.prepare(`SELECT ${targetColumns.join(", ")} FROM subscriptions
    WHERE user_id = ? AND (${predicates.join(" OR ")}) ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...values, SUBSCRIPTION_INDEX_LIMIT + 1).all<VisibilityTarget>();
  if (result.results.length > SUBSCRIPTION_INDEX_LIMIT) {
    throw new HttpError(422, serverText(locale, "common.invalidRequestParameters"), "SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED", { limit: SUBSCRIPTION_INDEX_LIMIT });
  }
  return result.results;
}

function visibilitySnapshotQuery(env: Env, userId: string, rows: readonly VisibilityTarget[]) {
  const matches = snapshotColumns.map((column, i) => `s.${column} IS json_extract(expected.value, '$[${i}]')`).join(" AND ");
  // CROSS JOIN 固定 JSON 目标先行；owner 索引先行会让每条事实重新扫描整个 JSON 集合。
  const sql = `WITH expected AS (SELECT value FROM json_each(?))
    SELECT COUNT(*) AS fact_count, COALESCE(SUM(CASE WHEN i.user_id = s.user_id AND i.public_hidden = s.public_hidden THEN 1 ELSE 0 END), 0) AS index_count
    FROM expected CROSS JOIN subscriptions AS s ON s.id = json_extract(expected.value, '$[0]')
    LEFT JOIN subscription_list_index AS i ON i.subscription_id = s.id WHERE s.user_id = ? AND ${matches}`;
  return { sql, values: [JSON.stringify(rows.map((row) => snapshotColumns.map((column) => row[column]))), userId] };
}

export async function writePublicVisibility(env: Env, userId: string, rows: readonly VisibilityTarget[], publicHidden: boolean, locale: AppLocale): Promise<void> {
  if (rows.length === 0) return;
  if (rows.length > SUBSCRIPTION_INDEX_LIMIT || rows.some((row) => row.user_id !== userId)) throw new Error("Invalid visibility mutation owner or size");
  const snapshot = visibilitySnapshotQuery(env, userId, rows);
  const ids = JSON.stringify(rows.map((row) => row.id));
  const target = boolToInt(publicHidden);
  const timestamp = nowIso();
  // 整个请求只提交一个 batch；按 200 条分别提交会留下前批成功、后批失败的半完成状态。
  // JSON1 将 5000 条压成固定四条 SQL；前后 guard 都在事务内，不能在 await batch 之后才发现索引缺行。
  const statements = [
    env.DB.prepare(`SELECT CASE WHEN fact_count = ? AND index_count = ? THEN 1 ELSE json('visibility_snapshot_conflict') END FROM (${snapshot.sql})`)
      .bind(rows.length, rows.length, ...snapshot.values),
    env.DB.prepare(`UPDATE subscriptions SET public_hidden = ?, updated_at = ? WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(target, timestamp, userId, ids),
    env.DB.prepare(`UPDATE subscription_list_index SET public_hidden = ?, updated_at = ? WHERE user_id = ? AND subscription_id IN (SELECT value FROM json_each(?))`)
      .bind(target, timestamp, userId, ids),
    env.DB.prepare(`SELECT CASE WHEN COUNT(*) = ? THEN 1 ELSE json('visibility_projection_conflict') END
      FROM json_each(?) AS selected CROSS JOIN subscriptions AS s ON s.id = selected.value
      JOIN subscription_list_index AS i ON i.subscription_id = s.id
      WHERE s.user_id = ? AND i.user_id = s.user_id AND s.public_hidden = ? AND i.public_hidden = s.public_hidden
        AND s.updated_at = ? AND i.updated_at = s.updated_at`).bind(rows.length, ids, userId, target, timestamp),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // SQLite 的 guard 异常没有稳定业务码；回滚后只读比较事实快照，不能依赖驱动报错字符串判定 409。
    const current = await env.DB.prepare(snapshot.sql).bind(...snapshot.values)
      .first<{ fact_count: number; index_count: number }>().catch(() => null);
    if (current && current.fact_count !== rows.length) throw new HttpError(409, serverText(locale, "subscription.visibilityConflict"), "SUBSCRIPTION_WRITE_CONFLICT");
    throw visibilityError(error, locale);
  }
}

function visibilityError(error: unknown, locale: AppLocale): HttpError {
  if (error instanceof HttpError) return error;
  const requestId = crypto.randomUUID();
  console.error("subscription_public_visibility_failed", { requestId, error });
  return new HttpError(500, serverText(locale, "subscription.visibilityFailed"), "SUBSCRIPTION_PUBLIC_VISIBILITY_FAILED", { requestId });
}
