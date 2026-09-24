import { z } from "zod";
import {
  normalizeSubscriptionTags,
  subscriptionListProjectionValues,
} from "../apps/worker/src/subscription-derived-state";
import type { D1Client } from "./cloudflare-d1-client";

const projectionFactShape = {
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  tags_json: z.string(),
  category: z.string(),
  billing_cycle: z.string(),
  currency: z.string(),
  payment_method: z.string().nullable(),
  status: z.string(),
  pinned: z.number(),
  public_hidden: z.number(),
  next_billing_date: z.string(),
  trial_end_date: z.string().nullable(),
  one_time_term_count: z.number().nullable(),
  auto_renew: z.number(),
  reminder_days: z.number(),
  repeat_reminder_enabled: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
} as const;

const projectionVerificationRowSchema = z.object({
  ...projectionFactShape,
  projection_subscription_id: z.string().nullable(),
  projection_user_id: z.string().nullable(),
  projection_name: z.string().nullable(),
  projection_website: z.string().nullable(),
  projection_notes: z.string().nullable(),
  projection_search_text_lower: z.string().nullable(),
  projection_category: z.string().nullable(),
  projection_billing_cycle: z.string().nullable(),
  projection_currency: z.string().nullable(),
  projection_payment_method: z.string().nullable(),
  projection_status: z.string().nullable(),
  projection_pinned: z.number().nullable(),
  projection_public_hidden: z.number().nullable(),
  projection_next_billing_date: z.string().nullable(),
  projection_trial_end_date: z.string().nullable(),
  projection_one_time_term_count: z.number().nullable(),
  projection_auto_renew: z.number().nullable(),
  projection_reminder_days: z.number().nullable(),
  projection_repeat_reminder_enabled: z.number().nullable(),
  projection_created_at: z.string().nullable(),
  projection_updated_at: z.string().nullable(),
});
type ProjectionVerificationRow = z.infer<typeof projectionVerificationRowSchema>;

const tagVerificationRowSchema = z.object({
  user_id: z.string(),
  subscription_id: z.string(),
  tag_norm: z.string(),
  tag: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
type TagVerificationRow = z.infer<typeof tagVerificationRowSchema>;

const collectionCountRowSchema = z.object({
  facts_count: z.union([z.number(), z.string()]),
  list_count: z.union([z.number(), z.string()]),
  tags_count: z.union([z.number(), z.string()]),
});

function projectionActualValues(row: ProjectionVerificationRow): Array<string | number | null> {
  return [
    row.projection_subscription_id,
    row.projection_user_id,
    row.projection_name,
    row.projection_website,
    row.projection_notes,
    row.projection_search_text_lower,
    row.projection_category,
    row.projection_billing_cycle,
    row.projection_currency,
    row.projection_payment_method,
    row.projection_status,
    row.projection_pinned,
    row.projection_public_hidden,
    row.projection_next_billing_date,
    row.projection_trial_end_date,
    row.projection_one_time_term_count,
    row.projection_auto_renew,
    row.projection_reminder_days,
    row.projection_repeat_reminder_enabled,
    row.projection_created_at,
    row.projection_updated_at,
  ];
}

function tagsBySubscription(rows: readonly TagVerificationRow[]): Map<string, TagVerificationRow[]> {
  const grouped = new Map<string, TagVerificationRow[]>();
  for (const row of rows) {
    const key = `${row.user_id}\u0000${row.subscription_id}`;
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }
  for (const values of grouped.values()) {
    values.sort((left, right) => left.tag_norm < right.tag_norm ? -1 : left.tag_norm > right.tag_norm ? 1 : 0);
  }
  return grouped;
}

function sameScalarValues(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/**
 * 用 Worker 同源规则从 subscriptions 重算 list/tag 投影，并以全局基数反向排除孤儿或额外派生行。
 * 该校验是 v3 marker 的前置条件，不能改成抽样或只核对行数。
 */
export async function assertSubscriptionCollectionProjectionRows(
  client: D1Client,
  pageSize = 200,
): Promise<number> {
  // 逐页从 facts 重算 JS 投影，避免 SQLite lower/group_concat 对 Unicode、重复标签和顺序的处理自证正确。
  let cursorUserId = "";
  let cursorSubscriptionId = "";
  let verified = 0;
  let expectedTagCount = 0;
  for (;;) {
    const rows = await client.query(`
      SELECT
        subscriptions.id, subscriptions.user_id, subscriptions.name, subscriptions.website, subscriptions.notes,
        subscriptions.tags_json, subscriptions.category, subscriptions.billing_cycle, subscriptions.currency,
        subscriptions.payment_method, subscriptions.status, subscriptions.pinned, subscriptions.public_hidden,
        subscriptions.next_billing_date, subscriptions.trial_end_date, subscriptions.one_time_term_count,
        subscriptions.auto_renew, subscriptions.reminder_days, subscriptions.repeat_reminder_enabled,
        subscriptions.created_at, subscriptions.updated_at,
        list_index.subscription_id AS projection_subscription_id,
        list_index.user_id AS projection_user_id,
        list_index.name AS projection_name,
        list_index.website AS projection_website,
        list_index.notes AS projection_notes,
        list_index.search_text_lower AS projection_search_text_lower,
        list_index.category AS projection_category,
        list_index.billing_cycle AS projection_billing_cycle,
        list_index.currency AS projection_currency,
        list_index.payment_method AS projection_payment_method,
        list_index.status AS projection_status,
        list_index.pinned AS projection_pinned,
        list_index.public_hidden AS projection_public_hidden,
        list_index.next_billing_date AS projection_next_billing_date,
        list_index.trial_end_date AS projection_trial_end_date,
        list_index.one_time_term_count AS projection_one_time_term_count,
        list_index.auto_renew AS projection_auto_renew,
        list_index.reminder_days AS projection_reminder_days,
        list_index.repeat_reminder_enabled AS projection_repeat_reminder_enabled,
        list_index.created_at AS projection_created_at,
        list_index.updated_at AS projection_updated_at
      FROM subscriptions
      LEFT JOIN subscription_list_index AS list_index
        ON list_index.subscription_id = subscriptions.id
       AND list_index.user_id = subscriptions.user_id
      WHERE subscriptions.user_id > ?
         OR (subscriptions.user_id = ? AND subscriptions.id > ?)
      ORDER BY subscriptions.user_id, subscriptions.id
      LIMIT ?
    `, [cursorUserId, cursorUserId, cursorSubscriptionId, pageSize], projectionVerificationRowSchema.parse);
    if (rows.length === 0) break;

    // 当前页 identity 通过一个 JSON 参数批量读取，既保留 owner+id 复合边界，也避免每条订阅一次远端往返。
    const identities = rows.map((row) => [row.user_id, row.id]);
    const storedTags = await client.query(`
      SELECT user_id, subscription_id, tag_norm, tag, created_at, updated_at
      FROM subscription_tags
      WHERE (user_id, subscription_id) IN (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
      )
    `, [JSON.stringify(identities)], tagVerificationRowSchema.parse);
    const groupedTags = tagsBySubscription(storedTags);

    for (const row of rows) {
      const expectedTags = normalizeSubscriptionTags(row);
      expectedTagCount += expectedTags.length;
      if (!sameScalarValues(projectionActualValues(row), subscriptionListProjectionValues(row, expectedTags))) {
        throw new Error("subscription_list_index value invariant failed");
      }
      const actualTags = groupedTags.get(`${row.user_id}\u0000${row.id}`) ?? [];
      const expectedTagRows = expectedTags.map((tag) => ({
        user_id: row.user_id,
        subscription_id: row.id,
        tag_norm: tag.key,
        tag: tag.value,
        created_at: row.created_at,
      }));
      if (actualTags.length !== expectedTagRows.length || actualTags.some((tag, index) => {
        const expected = expectedTagRows[index];
        // publicHidden-only writes intentionally leave tag projection timestamps untouched; updated_at means
        // the tag row last changed, not the enclosing subscription's last fact update.
        return expected === undefined || Object.entries(expected).some(([key, value]) => tag[key as keyof TagVerificationRow] !== value);
      })) {
        throw new Error("subscription_tags value invariant failed");
      }
    }
    verified += rows.length;
    const last = rows.at(-1);
    if (!last) throw new Error("Subscription collection verification returned an empty page");
    cursorUserId = last.user_id;
    cursorSubscriptionId = last.id;
    if (rows.length < pageSize) break;
  }

  const [counts] = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM subscriptions) AS facts_count,
      (SELECT COUNT(*) FROM subscription_list_index) AS list_count,
      (SELECT COUNT(*) FROM subscription_tags) AS tags_count
  `, [], collectionCountRowSchema.parse);
  if (
    Number(counts?.facts_count ?? -1) !== verified
    || Number(counts?.list_count ?? -1) !== verified
    || Number(counts?.tags_count ?? -1) !== expectedTagCount
  ) {
    throw new Error("subscription collection cardinality invariant failed");
  }
  return verified;
}
