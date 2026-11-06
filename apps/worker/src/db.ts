import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import {
  appSettingsSchema,
  type ApiAppSettings,
} from "@renewlet/shared/schemas/settings";
import {
  normalizeSettingsValue,
} from "@renewlet/shared/settings-normalization";
import {
  apiSubscriptionCollectionItemSchema,
  apiSubscriptionSchema,
  type ApiSubscription,
  type ApiSubscriptionCollectionItem,
} from "@renewlet/shared/schemas/subscriptions";
import { publicApiSubscriptionSchema } from "@renewlet/shared/schemas/public-api";
import { customConfigSchema } from "@renewlet/shared/schemas/custom-config";
import { DISABLED_REMINDER_DAYS, MAX_REMINDER_DAYS } from "@renewlet/shared/runtime";
import { moneyFromUnknown } from "@renewlet/shared/money";
import type { AdminUser } from "@renewlet/shared/schemas/admin";
import type { AssetInUseDetails } from "@renewlet/shared/schemas/media";
import type { ApiTokenRow, AssetRow, Env, NotificationJobRow, SubscriptionCollectionRow, SubscriptionRow, TelegramBotBindingRow, UserRow } from "./types";

/**
 * D1 数据访问层只暴露 Renewlet 产品语义。
 *
 * Worker 运行面不模拟 PocketBase REST；所有 D1 snake_case 行都必须在这里转换为 shared API schema，
 * 避免前端按运行面维护两套数据形状。
 */

const userColumnNames = [
  "id",
  "email",
  "name",
  "role",
  "banned",
  "ban_reason",
  "password_hash",
  "reset_token_hash",
  "reset_token_expires_at",
  "created_at",
  "updated_at",
] as const;

export const SUBSCRIPTION_COLUMN_NAMES = [
  "id",
  "user_id",
  "name",
  "logo",
  "price",
  "currency",
  "billing_cycle",
  "custom_days",
  "custom_cycle_unit",
  "one_time_term_count",
  "one_time_term_unit",
  "category",
  "status",
  "pinned",
  "public_hidden",
  "payment_method",
  "start_date",
  "next_billing_date",
  "auto_renew",
  "auto_calculate_next_billing_date",
  "trial_end_date",
  "website",
  "notes",
  "tags_json",
  "reminder_days",
  "repeat_reminder_enabled",
  "repeat_reminder_interval",
  "repeat_reminder_window",
  "cost_sharing_json",
  "cost_sharing_collection_reminder_enabled",
  "cost_sharing_next_collection_reminder_date",
  "extra_json",
  "created_at",
  "updated_at",
  "balance",
  "balance_currency",
] as const;

export const SUBSCRIPTION_COLLECTION_COLUMN_NAMES = [
  "id",
  "name",
  "logo",
  "price",
  "currency",
  "billing_cycle",
  "custom_days",
  "custom_cycle_unit",
  "one_time_term_count",
  "one_time_term_unit",
  "category",
  "status",
  "pinned",
  "public_hidden",
  "payment_method",
  "start_date",
  "next_billing_date",
  "auto_renew",
  "auto_calculate_next_billing_date",
  "trial_end_date",
  "reminder_days",
  "cost_sharing_json",
  "created_at",
  "balance",
  "balance_currency",
] as const satisfies readonly (keyof SubscriptionCollectionRow)[];

const assetColumnNames = [
  "id",
  "user_id",
  "kind",
  "r2_key",
  "original_name",
  "mime_type",
  "size_bytes",
  "created_at",
  "updated_at",
] as const;

const notificationJobColumnNames = [
  "id",
  "user_id",
  "scheduled_local_date",
  "scheduled_local_time",
  "time_zone",
  "scheduled_instant_utc",
  "status",
  "attempts",
  "last_error",
  "result_json",
  "created_at",
  "updated_at",
] as const;

const apiTokenColumnNames = [
  "id",
  "user_id",
  "name",
  "token_hash",
  "token_prefix",
  "scopes_json",
  "last_used_at",
  "created_at",
  "updated_at",
] as const;

const telegramBotBindingColumnNames = [
  "id",
  "user_id",
  "chat_id",
  "bot_token_hash",
  "webhook_secret_hash",
  "status",
  "last_update_id",
  "last_used_at",
  "created_at",
  "updated_at",
] as const;

export const USER_COLUMNS = userColumnNames.join(", ");
export const USER_COLUMNS_FROM_USERS = userColumnNames.map((column) => `users.${column} AS ${column}`).join(", ");
export const SUBSCRIPTION_COLUMNS = SUBSCRIPTION_COLUMN_NAMES.join(", ");

export function subscriptionRowValues(row: SubscriptionRow): unknown[] {
  return SUBSCRIPTION_COLUMN_NAMES.map((column) => row[column]);
}
export const ASSET_COLUMNS = assetColumnNames.join(", ");
export const NOTIFICATION_JOB_COLUMNS = notificationJobColumnNames.join(", ");
export const API_TOKEN_COLUMNS = apiTokenColumnNames.join(", ");
export const API_TOKEN_COLUMNS_FROM_API_TOKENS = apiTokenColumnNames.map((column) => `api_tokens.${column} AS ${column}`).join(", ");
export const TELEGRAM_BOT_BINDING_COLUMNS = telegramBotBindingColumnNames.join(", ");

/** Worker 统一使用 ISO instant；用户本地日期/时间只保存在业务字段中。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** D1 主键带领域前缀，便于日志和导入排查；安全性不依赖 id 不可猜。 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** D1 没有布尔类型；所有公开响应都应在出站前把 0/1 收敛回 boolean。 */
export function intToBool(value: number | null | undefined): boolean {
  return value === 1;
}

/** toAdminUser 是管理员用户管理响应的出站门，不能直接把 password_hash 等 D1 字段透给前端。 */
export function toAdminUser(
  row: UserRow,
  mfa: Pick<AdminUser, "mfaEnabled" | "mfaMethods" | "passkeysEnabled" | "passkeyCount"> = {
    mfaEnabled: false,
    mfaMethods: [],
    passkeysEnabled: false,
    passkeyCount: 0,
  },
): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    banned: intToBool(row.banned),
    mfaEnabled: mfa.mfaEnabled,
    mfaMethods: mfa.mfaMethods,
    passkeysEnabled: mfa.passkeysEnabled,
    passkeyCount: mfa.passkeyCount,
    banReason: row.ban_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listApiTokenRows(env: Env, userId: string): Promise<ApiTokenRow[]> {
  const result = await env.DB.prepare(`SELECT ${API_TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`)
    .bind(userId)
    .all<ApiTokenRow>();
  return result.results;
}

export async function getTelegramBotBinding(env: Env, userId: string): Promise<TelegramBotBindingRow | null> {
  return await env.DB.prepare(`SELECT ${TELEGRAM_BOT_BINDING_COLUMNS} FROM telegram_bot_bindings WHERE user_id = ? LIMIT 1`).bind(userId).first<TelegramBotBindingRow>();
}

/** email 查找在 SQL 层 lower 对齐，避免登录大小写差异制造重复账号语义。 */
export async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(?) LIMIT 1`).bind(email).first<UserRow>();
}

/** findUserById 只服务认证和管理员路径；公开用户响应仍需经过 toAdminUser/session schema。 */
export async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`).bind(id).first<UserRow>();
}

/** listUsers 只允许管理员调用方使用；普通用户列表能力不能从这里绕过 route 守卫暴露。 */
export async function listUsers(env: Env): Promise<UserRow[]> {
  const result = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC`).all<UserRow>();
  return result.results;
}

/** hasEnabledAdmin 是首装状态机的事实查询，setup UI 不能只信任环境变量。 */
export async function hasEnabledAdmin(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' AND banned = 0 LIMIT 1").first<{ id: string }>();
  return row !== null;
}

/** enabledAdminCount 支撑防自锁逻辑；最后一个启用管理员不能被降级、禁用或删除。 */
export async function enabledAdminCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND banned = 0 LIMIT 1").first<{ count: number }>();
  return row?.count ?? 0;
}

/** 后台读取没有设备语言；缺行只返回 auto 默认值，不替账号持久化任何请求语言。 */
export async function getSettings(env: Env, userId: string): Promise<ApiAppSettings> {
  const row = await env.DB.prepare("SELECT settings_json FROM settings WHERE user_id = ? LIMIT 1").bind(userId).first<{ settings_json: string }>();
  return settingsFromRowJson(row?.settings_json);
}

/** 首次补建 settings 固定写 auto；ON CONFLICT 后回读可承接并发登录已经创建的账号设置。 */
export async function ensureSettings(env: Env, userId: string): Promise<ApiAppSettings> {
  const existing = await env.DB.prepare("SELECT settings_json FROM settings WHERE user_id = ? LIMIT 1").bind(userId).first<{ settings_json: string }>();
  if (existing) return normalizeSettingsJson(existing.settings_json);

  const defaults = createDefaultAppSettings();
  const timestamp = nowIso();
  await env.DB.prepare(`
    INSERT INTO settings (user_id, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).bind(userId, JSON.stringify(defaults), timestamp, timestamp).run();

  const stored = await env.DB.prepare("SELECT settings_json FROM settings WHERE user_id = ? LIMIT 1").bind(userId).first<{ settings_json: string }>();
  return stored ? normalizeSettingsJson(stored.settings_json) : defaults;
}

/** 保存设置前重跑完整 shared schema，确保 D1 写入后的数据仍可被 Go/前端同一契约消费。 */
export async function putSettings(env: Env, userId: string, settings: ApiAppSettings): Promise<ApiAppSettings> {
  const parsed = appSettingsSchema.parse(settings);
  await settingsUpsertStatement(env, userId, parsed).run();
  return parsed;
}

export function settingsUpsertStatement(env: Env, userId: string, settings: ApiAppSettings): D1PreparedStatement {
  const parsed = appSettingsSchema.parse(settings);
  const timestamp = nowIso();
  return env.DB.prepare(`
    INSERT INTO settings (user_id, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
  `).bind(userId, JSON.stringify(parsed), timestamp, timestamp);
}

export function normalizeSettingsJson(value: string): ApiAppSettings {
  // 排他迁移后，存在的 settings 行必须满足数据库契约；静默回落会掩盖漂移并以默认值执行后台任务。
  return normalizeSettingsValue(JSON.parse(value) as unknown, createDefaultAppSettings());
}

/** 缺行使用 auto 默认值；只要 settings 行存在就严格解析，禁止把损坏或旧契约数据误判成缺行。 */
export function settingsFromRowJson(value: string | null | undefined): ApiAppSettings {
  return value == null ? createDefaultAppSettings() : normalizeSettingsJson(value);
}

/** getCustomConfig 保留用户自定义文本原貌；产品内置标签翻译不在 Worker 里生成。 */
export async function getCustomConfig(env: Env, userId: string): Promise<unknown> {
  const row = await env.DB.prepare("SELECT config_json FROM custom_configs WHERE user_id = ? LIMIT 1").bind(userId).first<{ config_json: string }>();
  if (!row) return { categories: [], statuses: [], paymentMethods: [], currencies: [] };
  try {
    return JSON.parse(row.config_json) as unknown;
  } catch {
    // 自定义配置坏 JSON 只回到空结构；最终规范化仍在前端 domain，避免 Worker 复制 UI 规则。
    return { categories: [], statuses: [], paymentMethods: [], currencies: [] };
  }
}

/** putCustomConfig 只写当前用户配置 JSON；结构语义由 shared schema 和前端 domain 共同约束。 */
export async function putCustomConfig(env: Env, userId: string, config: unknown): Promise<unknown> {
  const timestamp = nowIso();
  await env.DB.prepare(`
    INSERT INTO custom_configs (user_id, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
  `).bind(userId, JSON.stringify(config), timestamp, timestamp).run();
  return config;
}

function apiOneTimeTermFields(row: Pick<SubscriptionRow, "one_time_term_count" | "one_time_term_unit">) {
  // D1 历史 NULL/非正服务期都表示买断；必须在 DTO 总入口收敛，避免非法数量穿过 shared 正整数契约。
  if (row.one_time_term_count === null || row.one_time_term_count <= 0 || !row.one_time_term_unit) return {};
  return {
    oneTimeTermCount: row.one_time_term_count,
    oneTimeTermUnit: row.one_time_term_unit,
  };
}

export function toApiSubscriptionCollectionItem(row: SubscriptionCollectionRow): ApiSubscriptionCollectionItem {
  // cost_sharing_json 是 D1 唯一持久化形态，出站必须重新过 shared schema，防止 Worker 与 Docker costSharing 漂移。
  const costSharing = parseJsonObject(row.cost_sharing_json ?? "{}");
  const normalized = {
    id: row.id,
    name: row.name,
    ...(row.logo ? { logo: row.logo } : {}),
    price: moneyFromUnknown(row.price) ?? "0",
    ...(row.balance == null ? {} : { balance: row.balance }),
    ...(row.balance_currency == null ? {} : { balanceCurrency: row.balance_currency }),
    currency: row.currency,
    billingCycle: row.billing_cycle,
    ...(row.custom_days === null ? {} : { customDays: row.custom_days }),
    ...(row.custom_cycle_unit === null ? {} : { customCycleUnit: row.custom_cycle_unit }),
    ...apiOneTimeTermFields(row),
    category: row.category,
    status: row.status,
    pinned: intToBool(row.pinned),
    publicHidden: intToBool(row.public_hidden),
    ...(row.payment_method ? { paymentMethod: row.payment_method } : {}),
    startDate: row.start_date,
    nextBillingDate: row.next_billing_date,
    autoRenew: row.billing_cycle === "one-time" ? false : intToBool(row.auto_renew),
    autoCalculateNextBillingDate: row.billing_cycle === "one-time"
      ? false
      : intToBool(row.auto_calculate_next_billing_date),
    ...(row.trial_end_date ? { trialEndDate: row.trial_end_date } : {}),
    reminderDays: row.reminder_days,
    ...(Object.keys(costSharing).length > 0 ? { costSharing } : {}),
  };
  return apiSubscriptionCollectionItemSchema.parse(normalized);
}

export function toApiSubscription(row: SubscriptionRow): ApiSubscription {
  const extra = parseJsonObject(row.extra_json);
  const normalized = {
    ...toApiSubscriptionCollectionItem(row),
    ...(row.website ? { website: row.website } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    tags: parseStringArray(row.tags_json),
    repeatReminderEnabled: intToBool(row.repeat_reminder_enabled),
    repeatReminderInterval: row.repeat_reminder_interval,
    repeatReminderWindow: row.repeat_reminder_window,
    extra,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return apiSubscriptionSchema.parse(normalized);
}

export function toPublicApiSubscription(row: SubscriptionRow) {
  const costSharing = parseJsonObject(row.cost_sharing_json ?? "{}");
  const extra = parseJsonObject(row.extra_json);
  return publicApiSubscriptionSchema.parse({
    id: row.id,
    name: row.name,
    ...(row.logo ? { logo: row.logo } : {}),
    price: moneyFromUnknown(row.price) ?? "0",
    ...(row.balance == null ? {} : { balance: row.balance }),
    ...(row.balance_currency == null ? {} : { balanceCurrency: row.balance_currency }),
    currency: row.currency,
    billingCycle: row.billing_cycle,
    ...(row.custom_days === null ? {} : { customDays: row.custom_days }),
    ...(row.custom_cycle_unit === null ? {} : { customCycleUnit: row.custom_cycle_unit }),
    ...apiOneTimeTermFields(row),
    category: row.category,
    status: row.status,
    pinned: intToBool(row.pinned),
    publicHidden: intToBool(row.public_hidden),
    ...(row.payment_method ? { paymentMethod: row.payment_method } : {}),
    startDate: row.start_date,
    nextBillingDate: row.next_billing_date,
    autoRenew: row.billing_cycle === "one-time" ? false : intToBool(row.auto_renew),
    autoCalculateNextBillingDate: intToBool(row.auto_calculate_next_billing_date),
    ...(row.trial_end_date ? { trialEndDate: row.trial_end_date } : {}),
    ...(row.website ? { website: row.website } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    tags: parseStringArray(row.tags_json),
    reminderDays: row.reminder_days,
    repeatReminderEnabled: intToBool(row.repeat_reminder_enabled),
    repeatReminderInterval: row.repeat_reminder_interval,
    repeatReminderWindow: row.repeat_reminder_window,
    ...(Object.keys(costSharing).length > 0 ? { costSharing } : {}),
    extra,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export async function getSubscription(env: Env, userId: string, id: string): Promise<SubscriptionRow | null> {
  return await env.DB.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = ? AND id = ? LIMIT 1`).bind(userId, id).first<SubscriptionRow>();
}

/** countSubscriptions 只统计当前用户，是分页元数据和管理概览的用户隔离边界。 */
export async function countSubscriptions(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ? LIMIT 1").bind(userId).first<{ count: number }>();
  return row?.count ?? 0;
}

/** listSubscriptions 用游标分页拉全量，只供用户主动列表、导出、日历和设置页概览这类显式读取场景复用。 */
export async function listSubscriptions(env: Env, userId: string): Promise<SubscriptionRow[]> {
  const rows: SubscriptionRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listSubscriptionsPage(env, userId, { limit: 100, cursor });
    rows.push(...page);
    if (page.length < 100) return rows;
    const last = page.at(-1);
    if (!last) return rows;
    cursor = publicSubscriptionCursor(last);
  }
}

export async function listNotificationScheduleCandidateSubscriptions(
  env: Env,
  userId: string,
  options: { scheduledLocalDate: string; includeExpired: boolean; showExpired: boolean },
): Promise<SubscriptionRow[]> {
  const maxDate = addDateOnlyDays(options.scheduledLocalDate, MAX_REMINDER_DAYS);
  // 三类日常候选分支各自走日期索引；UNION 后再由 collector 做 date-only 精确判断。
  const selects = [
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND status != 'cancelled' AND reminder_days != ? AND next_billing_date >= ? AND next_billing_date <= ?`,
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND status != 'cancelled' AND reminder_days != ? AND trial_end_date >= ? AND trial_end_date <= ?`,
  ];
  const params: unknown[] = [
    userId, DISABLED_REMINDER_DAYS, options.scheduledLocalDate, maxDate,
    userId, DISABLED_REMINDER_DAYS, options.scheduledLocalDate, maxDate,
  ];
  if (options.includeExpired && options.showExpired) {
    selects.push(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND status != 'cancelled' AND reminder_days != ? AND next_billing_date < ?`);
    params.push(userId, DISABLED_REMINDER_DAYS, options.scheduledLocalDate);
  }
  selects.push(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND cost_sharing_collection_reminder_enabled = 1
        AND cost_sharing_next_collection_reminder_date IS NOT NULL
        AND cost_sharing_next_collection_reminder_date <= ?`);
  params.push(userId, options.scheduledLocalDate);
  // scheduled cron 只走索引镜像列缩候选；精确 reminderDays、成员周期和收款成员 payload 由 collector 统一过滤。
  const result = await env.DB.prepare(`${selects.join("\nUNION\n")}\nORDER BY created_at DESC, id DESC`)
    .bind(...params)
    .all<SubscriptionRow>();
  return result.results;
}

export async function listRepeatReminderCandidateSubscriptions(env: Env, userId: string, localDate: string): Promise<SubscriptionRow[]> {
  const maxDate = addDateOnlyDays(localDate, MAX_REMINDER_DAYS);
  const result = await env.DB.prepare(`
    SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND status != 'cancelled' AND repeat_reminder_enabled = 1 AND reminder_days != ?
        AND next_billing_date >= ? AND next_billing_date <= ?
    UNION
    SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND status != 'cancelled' AND repeat_reminder_enabled = 1 AND reminder_days != ?
        AND status = 'trial' AND trial_end_date >= ? AND trial_end_date <= ?
    ORDER BY created_at DESC, id DESC
  `).bind(
    userId, DISABLED_REMINDER_DAYS, localDate, maxDate,
    userId, DISABLED_REMINDER_DAYS, localDate, maxDate,
  ).all<SubscriptionRow>();
  return result.results;
}

/** 分页只按当前 user_id 查询，游标不能跨用户复用或泄露其它用户订阅。 */
export async function listSubscriptionsPage(
  env: Env,
  userId: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<SubscriptionRow[]> {
  const cursor = parsePublicSubscriptionCursor(options.cursor);
  const limit = Math.max(1, Math.min(options.limit, 101));
  if (!cursor) {
    const result = await env.DB.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(userId, limit)
      .all<SubscriptionRow>();
    return result.results;
  }
  // 游标排序字段必须和 ORDER BY 完全一致，避免同一 created_at 下漏读或重复读。
  const result = await env.DB.prepare(`
    SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
    WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(userId, cursor.createdAt, cursor.createdAt, cursor.id, limit).all<SubscriptionRow>();
  return result.results;
}

export function publicSubscriptionCursor(row: Pick<SubscriptionRow, "created_at" | "id">): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id }));
}

/** 游标只是分页位置，不是权限凭据；解析失败时调用方按 bad request 处理。 */
export function parsePublicSubscriptionCursor(value?: string): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record["createdAt"] !== "string" || typeof record["id"] !== "string") return null;
    return { createdAt: record["createdAt"], id: record["id"] };
  } catch {
    return null;
  }
}

export async function getAsset(env: Env, userId: string, id: string): Promise<AssetRow | null> {
  // D1 metadata 是 R2 私有资产的权限索引；所有读取都必须带 userId 过滤。
  return await env.DB.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE user_id = ? AND id = ? LIMIT 1`).bind(userId, id).first<AssetRow>();
}

export type OwnedAssetMetadata = Pick<AssetRow, "id" | "r2_key" | "original_name" | "mime_type" | "size_bytes">;

/** JSON1 集合参数避免资产数量突破 D1 绑定上限；owner 条件必须先于任何 R2 读取。 */
export async function getOwnedAssetsByIds(env: Env, userId: string, ids: readonly string[]): Promise<OwnedAssetMetadata[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const result = await env.DB.prepare(`SELECT id, r2_key, original_name, mime_type, size_bytes FROM assets
    WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) LIMIT ?`)
    .bind(userId, JSON.stringify(uniqueIds), uniqueIds.length).all<OwnedAssetMetadata>();
  return result.results;
}

/** listAssets 是 Logo/Icon 选择器的数据源；kind 和 userId 共同限制可见资产集合。 */
export async function listAssets(env: Env, userId: string, kind: string, page: number, perPage: number): Promise<{ items: AssetRow[]; total: number }> {
  const offset = (page - 1) * perPage;
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM assets WHERE user_id = ? AND kind = ? LIMIT 1").bind(userId, kind).first<{ count: number }>();
  const rows = await env.DB.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(userId, kind, perPage, offset)
    .all<AssetRow>();
  return { items: rows.results, total: totalRow?.count ?? 0 };
}

export async function countAssetReferences(env: Env, userId: string, assetId: string): Promise<AssetInUseDetails> {
  const assetUrl = `/api/app/assets/${assetId}`;
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ? AND logo = ? LIMIT 1")
    .bind(userId, assetUrl)
    .first<{ count: number }>();
  const subscriptionLogoCount = row?.count ?? 0;
  const paymentMethodIconCount = await countPaymentMethodIconReferences(env, userId, assetUrl);
  return {
    usageCount: subscriptionLogoCount + paymentMethodIconCount,
    subscriptionLogoCount,
    paymentMethodIconCount,
  };
}

async function countPaymentMethodIconReferences(env: Env, userId: string, assetUrl: string): Promise<number> {
  const row = await env.DB.prepare("SELECT config_json FROM custom_configs WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ config_json: string }>();
  if (!row) return 0;
  // 删除资产必须失败闭合；坏 custom config 不能被当作“没有引用”，否则会误删仍在 UI 使用的图标。
  const config = customConfigSchema.parse(JSON.parse(row.config_json));
  return config.paymentMethods.filter((item) => item.icon === assetUrl).length;
}

export async function deleteAssetMetadata(env: Env, userId: string, id: string): Promise<void> {
  // R2 object 删除和 D1 metadata 删除不在同一事务；metadata 带 owner 条件，避免失败重试时误删他人记录。
  await env.DB.prepare("DELETE FROM assets WHERE user_id = ? AND id = ?").bind(userId, id).run();
}

export async function listSubscriptionTags(env: Env, userId: string, limit = 50): Promise<string[]> {
  // 这些标签名会进入第三方 AI prompt；只传用户已经持久化的标签文本，不带历史订阅名称、金额或备注。
  const rows = await env.DB.prepare(`
    SELECT tag_row.tag
    FROM subscription_tags AS tag_row
    WHERE tag_row.user_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM subscription_tags AS candidate
        WHERE candidate.user_id = tag_row.user_id
          AND candidate.tag_norm = tag_row.tag_norm
          AND (
            candidate.updated_at > tag_row.updated_at
            OR (candidate.updated_at = tag_row.updated_at AND candidate.subscription_id > tag_row.subscription_id)
            OR (
              candidate.updated_at = tag_row.updated_at
              AND candidate.subscription_id = tag_row.subscription_id
              AND candidate.tag > tag_row.tag
            )
          )
      )
    ORDER BY tag_row.updated_at DESC, tag_row.subscription_id DESC, tag_row.tag_norm ASC
    LIMIT ?
  `)
    .bind(userId, limit)
    .all<{ tag: string }>();
  return rows.results.map((row) => row.tag);
}

/** parseStringArray 用于读取历史 JSON 字段；坏值回落为空数组，不把脏数据继续传给前端。 */
export function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** parseJsonObject 保证 extra/result 等动态 JSON 出站时至少是普通对象。 */
export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** parseJobResult 容忍历史任务结果坏 JSON，通知历史面板不应因单条审计行损坏而整体失败。 */
export function parseJobResult(row: NotificationJobRow): unknown {
  try {
    return JSON.parse(row.result_json) as unknown;
  } catch {
    return {};
  }
}

function addDateOnlyDays(value: string, days: number): string {
  const parts = value.split("-");
  if (parts.length !== 3) return value;
  const year = Number.parseInt(parts[0] ?? "", 10);
  const month = Number.parseInt(parts[1] ?? "", 10);
  const day = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return value;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}
