import type { AdminUser } from "@renewlet/shared/schemas/admin";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import type { CustomCycleUnit } from "@renewlet/shared/runtime";

/**
 * Env 的 binding 字段来自 `wrangler types --env-file /dev/null` 生成结果；这里仅补 CI 注入的可选构建元信息。
 *
 * `SETUP_ENABLED` 与维护开关在 wrangler.jsonc 中有默认值，但测试和生成配置可能显式省略。
 */
export type Env = Omit<Cloudflare.Env, "SETUP_ENABLED" | "RENEWLET_MAINTENANCE_MODE" | "MEDIA_ICON_INDEX_REFRESH_QUEUE"> & {
  SETUP_ENABLED?: string;
  RENEWLET_MAINTENANCE_MODE?: string;
  SESSION_TTL_DAYS?: string;
  RENEWLET_VERSION?: string;
  RENEWLET_COMMIT?: string;
  RENEWLET_BUILD_TIME?: string;
  MEDIA_ICON_INDEX_REFRESH_QUEUE?: Queue<unknown>;
};

/** D1 users 行模型；只在 Worker 内部使用，公开用户响应必须经过 shared/admin schema。 */
export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  banned: number;
  ban_reason: string;
  password_hash: string;
  reset_token_hash: string | null;
  reset_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Worker session 表保存 session/CSRF hash；浏览器只能通过 HttpOnly cookie 使用原始 session token。 */
export interface SessionRow {
  id: string;
  token_hash: string;
  csrf_token_hash: string | null;
  user_id: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
}

/** 联表认证结果；字段前缀用于避免 users 与 sessions 同名列在 D1 查询中互相覆盖。 */
export interface SessionAuthRow extends UserRow {
  session_id: string;
  session_token_hash: string;
  session_csrf_token_hash: string | null;
  session_user_id: string;
  session_expires_at: string;
  session_created_at: string;
  session_last_seen_at: string;
}

/** TOTP credential 只保存加密 seed 和最后成功 step；验证路径负责防重放。 */
export interface MfaTotpCredentialRow {
  user_id: string;
  secret_ciphertext: string;
  last_accepted_step: number;
  created_at: string;
  updated_at: string;
}

/** 恢复码行只保存 HMAC；明文只在生成响应出现一次。 */
export interface MfaRecoveryCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** MFA ticket 是登录二阶段短期状态，不是 session。 */
export interface MfaAuthTicketRow {
  id: string;
  user_id: string;
  ticket_hash: string;
  expires_at: string;
  attempts: number;
  methods_json: string;
  payload_ciphertext: string | null;
  created_at: string;
  updated_at: string;
}

/** Passkey credential 保存独立登录必需的 public key/counter/transports；它不属于身份验证器 MFA 方法。 */
export interface PasskeyCredentialRow {
  id: string;
  user_id: string;
  name: string;
  credential_id: string;
  public_key: string;
  credential_json: string;
  counter: number;
  transports_json: string;
  created_at: string;
  updated_at: string;
}

/** Passkey challenge 必须短期持久化；独立登录开始时 user_id 为空，finish 后由 credential 反查账号。 */
export interface PasskeyChallengeRow {
  id: string;
  user_id: string | null;
  challenge_id_hash: string;
  kind: "registration" | "authentication";
  challenge: string;
  session_data_json: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** Public API token 行只保存 hash/prefix；明文 token 不进入 D1、备份或导出。 */
export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes_json: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Telegram Bot command binding 只保存 hash 和状态；Webhook 入站不能读取浏览器 session。 */
export interface TelegramBotBindingRow {
  id: string;
  user_id: string;
  chat_id: string;
  bot_token_hash: string;
  webhook_secret_hash: string;
  status: "installing" | "installed";
  last_update_id: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 站点级登录人机验证配置；key 固定为 global，secret 只给 Worker Siteverify 使用，不进入 status、备份或前端响应。 */
export interface AuthSecuritySettingsRow {
  key: "global";
  turnstile_enabled: number;
  turnstile_site_key: string;
  turnstile_secret: string;
  created_at: string;
  updated_at: string;
}

/** D1 订阅行模型；snake_case 与整数布尔必须在 `toApiSubscription` 里收敛到 shared schema。 */
export interface SubscriptionRow {
  id: string;
  user_id: string;
  name: string;
  logo: string | null;
  price: string;
  currency: string;
  billing_cycle: string;
  custom_days: number | null;
  custom_cycle_unit: CustomCycleUnit | null;
  one_time_term_count: number | null;
  one_time_term_unit: CustomCycleUnit | null;
  category: string;
  status: string;
  pinned: number;
  public_hidden: number;
  payment_method: string | null;
  start_date: string | null;
  next_billing_date: string;
  auto_renew: number;
  auto_calculate_next_billing_date: number;
  trial_end_date: string | null;
  website: string | null;
  notes: string | null;
  tags_json: string;
  reminder_days: number;
  repeat_reminder_enabled: number;
  repeat_reminder_interval: string;
  repeat_reminder_window: string;
  cost_sharing_json?: string;
  // 内部镜像列只给 D1 通知候选索引使用；API 出站必须继续从 cost_sharing_json 解析。
  cost_sharing_collection_reminder_enabled: number;
  cost_sharing_next_collection_reminder_date: string | null;
  extra_json: string;
  created_at: string;
  updated_at: string;
}

/** 私有集合查询只读取轻量 DTO 所需列，详情字段不会进入列表、统计或日历的 D1 结果集。 */
export type SubscriptionCollectionRow = Pick<SubscriptionRow,
  | "id"
  | "name"
  | "logo"
  | "price"
  | "currency"
  | "billing_cycle"
  | "custom_days"
  | "custom_cycle_unit"
  | "one_time_term_count"
  | "one_time_term_unit"
  | "category"
  | "status"
  | "pinned"
  | "public_hidden"
  | "payment_method"
  | "start_date"
  | "next_billing_date"
  | "auto_renew"
  | "auto_calculate_next_billing_date"
  | "trial_end_date"
  | "reminder_days"
  | "cost_sharing_json"
  | "created_at"
>;

/** 每用户调度 gate；Cron 先读这里，空状态下不再触碰 subscriptions 候选查询。 */
export interface SubscriptionSchedulerStateRow {
  user_id: string;
  auto_renew_count: number;
  repeat_reminder_count: number;
  last_auto_renew_local_date: string;
  next_auto_renew_check_at_utc?: string | null;
  next_daily_notification_due_at_utc?: string | null;
  next_repeat_notification_due_at_utc?: string | null;
  created_at: string;
  updated_at: string;
}

/** 订阅列表热路径投影；只保存筛选/排序/搜索需要的轻字段，完整 DTO 仍回表读取 subscriptions。 */
export interface SubscriptionListIndexRow {
  subscription_id: string;
  user_id: string;
  name: string;
  website: string | null;
  notes: string | null;
  search_text_lower: string;
  category: string;
  billing_cycle: string;
  currency: string;
  payment_method: string | null;
  status: string;
  pinned: number;
  public_hidden: number;
  next_billing_date: string;
  trial_end_date: string | null;
  one_time_term_count: number | null;
  auto_renew: number;
  reminder_days: number;
  repeat_reminder_enabled: number;
  created_at: string;
  updated_at: string;
}

/** 用户订阅聚合统计；Public API/status 和无筛选 total 不再实时 COUNT 全表。 */
export interface SubscriptionUserStatsRow {
  user_id: string;
  total_count: number;
  trial_count: number;
  active_count: number;
  expired_count: number;
  paused_count: number;
  cancelled_count: number;
  created_at: string;
  updated_at: string;
}

/** R2 私有资产的 D1 元数据索引；权限判断只能信任这里的 user_id，而不是 R2 key。 */
export interface AssetRow {
  id: string;
  user_id: string;
  kind: "logo" | "icon";
  r2_key: string;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

/** 通知任务审计行；本地计划时间和 UTC instant 同存，便于用户解释与后台排序。 */
export interface NotificationJobRow {
  id: string;
  user_id: string;
  scheduled_local_date: string;
  scheduled_local_time: string;
  time_zone: string;
  scheduled_instant_utc: string;
  status: "pending" | "sending" | "sent" | "failed" | "skipped";
  attempts: number;
  last_error: string | null;
  result_json: string;
  created_at: string;
  updated_at: string;
}

/** 日历订阅 token 是低权限 bearer secret，D1 保存明文以便登录用户可查看和撤销。 */
export interface CalendarFeedRow {
  id: string;
  user_id: string;
  scope: "all" | "subscription";
  subscription_id: string | null;
  token: string;
  created_at: string;
  updated_at: string;
}

/** 公开展示页 token 是可撤销 bearer secret；只有完整 URL 回显给登录用户复制。 */
export interface PublicStatusPageRow {
  id: string;
  user_id: string;
  token: string;
  show_prices: number;
  hide_expired: number;
  hide_lifetime: number;
  created_at: string;
  updated_at: string;
}

/** 月度汇率快照锁定报表折算口径；只保存 normalized USD rates 和非密来源 metadata。 */
export interface ExchangeRateSnapshotRow {
  user_id: string;
  month: string;
  base: "USD";
  rates_json: string;
  requested_provider: "frankfurter" | "floatrates" | "exchange-api";
  provider: "frankfurter" | "floatrates" | "exchange-api";
  source_date: string;
  captured_at: string;
  warning_json: string | null;
  created_at: string;
  updated_at: string;
}

/** 云同步与备份目标；credential_json 是 provider 级 write-only secret，出站只能暴露 credentialSet。 */
export interface CloudBackupTargetRow {
  user_id: string;
  provider: "webdav" | "s3";
  config_json: string;
  credential_json: string;
  schedule_enabled: number;
  schedule_frequency: "daily" | "weekly";
  schedule_time: string;
  schedule_weekday: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  retention: number;
  last_backup_at: string | null;
  last_status: "idle" | "success" | "failed";
  last_error: string | null;
  locked_until: string | null;
  next_run_at_utc?: string | null;
  created_at: string;
  updated_at: string;
}

/** 全局内置图标索引 metadata；search/detail gzip 分离，普通搜索不读取完整冷字段索引。 */
export interface MediaIconIndexRow {
  key: "active";
  hash: string | null;
  search_r2_key: string | null;
  detail_r2_key: string | null;
  icon_count: number;
  provider_counts_json: string;
  provider_status_json: string;
  checked_at: string | null;
  index_updated_at: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

/** 内置图标刷新 job；HTTP 只入队，Queue consumer 才允许写 R2 并切换 active 索引。 */
export interface MediaIconIndexRefreshJobRow {
  id: string;
  provider: "thesvg" | "selfhst" | "dashboardIcons";
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  error: string | null;
  index_hash?: string | null;
  artifact_hash?: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 已通过 Worker session 校验的请求上下文。 */
export interface AuthContext {
  session: SessionRow;
  user: UserRow;
}

export type { AdminUser, ApiAppSettings, ApiSubscription };
