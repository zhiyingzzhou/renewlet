-- Immutable Renewlet v0.3.28 D1 fixture from commit 2b3e89dbf7168b5266370c3095676f32f12cbeea.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) >= 1 AND length(name) <= 80),
  -- Public API token 明文只在创建响应出现一次；D1 只保存 hash，避免数据库泄漏后直接接管 API。
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 43),
  token_prefix TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 6 AND 16 AND substr(token_prefix, 1, 4) = 'rlt_'),
  scopes_json TEXT NOT NULL DEFAULT '["read"]' CHECK (scopes_json = '["read"]'),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  -- R2 key 不公开；所有私有资产读取先过这张 owner metadata 表。
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'icon')),
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE auth_security_settings (
  key TEXT PRIMARY KEY CHECK (key = 'global'),
  turnstile_enabled INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_enabled IN (0, 1)),
  turnstile_site_key TEXT NOT NULL DEFAULT '',
  turnstile_secret TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE calendar_feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'subscription')),
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  -- ICS 客户端只能按 URL 拉取；这里保存可恢复 token，让登录用户刷新后仍能复制自己的订阅地址。
  token TEXT NOT NULL UNIQUE CHECK (length(token) = 43),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'all' AND subscription_id IS NULL)
    OR (scope = 'subscription' AND subscription_id IS NOT NULL)
  )
);
CREATE TABLE cloud_backup_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'webdav' CHECK (provider IN ('webdav', 's3')),
  config_json TEXT NOT NULL DEFAULT '{}',
  -- 云存储凭据是 write-only secret；API 只返回 credentialSet，普通导出和云快照都不能读取后打包。
  credential_json TEXT NOT NULL DEFAULT '{}',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily', 'weekly')),
  retention INTEGER NOT NULL DEFAULT 7 CHECK (retention >= 1 AND retention <= 30),
  last_backup_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle', 'success', 'failed')),
  last_error TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE cloud_backup_targets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('webdav', 's3')),
  config_json TEXT NOT NULL DEFAULT '{}',
  -- 每个 provider 独立保存 write-only secret；响应只能返回 credentialSet，不允许明文回显。
  credential_json TEXT NOT NULL DEFAULT '{}',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily', 'weekly')),
  schedule_time TEXT NOT NULL DEFAULT '03:00' CHECK (schedule_time GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(schedule_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23),
  schedule_weekday TEXT NOT NULL DEFAULT 'monday' CHECK (schedule_weekday IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  retention INTEGER NOT NULL DEFAULT 7 CHECK (retention >= 1 AND retention <= 30),
  last_backup_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle', 'success', 'failed')),
  last_error TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, next_run_at_utc TEXT,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE custom_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
CREATE TABLE exchange_rate_snapshots (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (
    month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  base TEXT NOT NULL DEFAULT 'USD' CHECK (base = 'USD'),
  rates_json TEXT NOT NULL CHECK (json_valid(rates_json)),
  requested_provider TEXT NOT NULL CHECK (requested_provider IN ('frankfurter', 'floatrates', 'exchange-api')),
  provider TEXT NOT NULL CHECK (provider IN ('frankfurter', 'floatrates', 'exchange-api')),
  source_date TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  warning_json TEXT CHECK (warning_json IS NULL OR json_valid(warning_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month)
);
CREATE TABLE media_icon_index_refresh_jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('thesvg', 'selfhst', 'dashboardIcons')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error TEXT,
  artifact_hash TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, index_hash TEXT);
CREATE TABLE "media_icon_indexes" (
  key TEXT PRIMARY KEY CHECK (key = 'active'),
  hash TEXT,
  search_r2_key TEXT,
  detail_r2_key TEXT,
  icon_count INTEGER NOT NULL DEFAULT 0 CHECK (icon_count >= 0),
  provider_counts_json TEXT NOT NULL DEFAULT '{}',
  provider_status_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT,
  index_updated_at TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE mfa_auth_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ticket 表示“密码已通过但二因子未完成”，短期、限次数、成功后一次性删除。
  ticket_hash TEXT NOT NULL UNIQUE CHECK (length(ticket_hash) = 43),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  methods_json TEXT NOT NULL,
  payload_ciphertext TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 恢复码明文只在生成响应出现一次；D1 只保存带安装级账号安全密钥的 HMAC。
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 43),
  used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, code_hash)
);
CREATE TABLE mfa_totp_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- TOTP seed 只能加密保存；备份、导出和普通 settings payload 都不能读取这张表。
  secret_ciphertext TEXT NOT NULL,
  last_accepted_step INTEGER NOT NULL DEFAULT 0 CHECK (last_accepted_step >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE notification_job_messages (
  job_id TEXT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8192),
  PRIMARY KEY (job_id, chunk_index)
);
CREATE TABLE notification_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_local_date TEXT NOT NULL,
  scheduled_local_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  scheduled_instant_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, scheduled_local_date, scheduled_local_time, time_zone)
);
CREATE TABLE passkey_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenge_id_hash TEXT NOT NULL UNIQUE CHECK (length(challenge_id_hash) = 43),
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  -- 独立 Passkey 登录开始时用户未知；finish 阶段再通过 credential 反查账号并校验 RP/origin。
  session_data_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  credential_json TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE public_status_pages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (length(token) = 43),
  show_prices INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, hide_expired INTEGER NOT NULL DEFAULT 0, hide_lifetime INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  -- 产品 session token 只进 HttpOnly cookie；D1 只存 hash，泄库不能直接接管会话。
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
, csrf_token_hash TEXT);
CREATE TABLE settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE subscription_derived_backfills (
  name TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);
CREATE TABLE subscription_list_index (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  website TEXT,
  notes TEXT,
  search_text_lower TEXT NOT NULL,
  category TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  currency TEXT NOT NULL,
  payment_method TEXT,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  public_hidden INTEGER NOT NULL DEFAULT 0,
  next_billing_date TEXT NOT NULL,
  trial_end_date TEXT,
  one_time_term_count INTEGER,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  reminder_days INTEGER NOT NULL DEFAULT 0,
  repeat_reminder_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE subscription_repeat_schedule (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  next_due_at_utc TEXT NOT NULL,
  PRIMARY KEY (user_id, subscription_id)
);
CREATE TABLE subscription_scheduler_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_renew_count INTEGER NOT NULL DEFAULT 0,
  repeat_reminder_count INTEGER NOT NULL DEFAULT 0,
  last_auto_renew_local_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, next_auto_renew_check_at_utc TEXT, next_daily_notification_due_at_utc TEXT, next_repeat_notification_due_at_utc TEXT);
CREATE TABLE subscription_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  tag_norm TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, subscription_id, tag_norm)
);
CREATE TABLE "subscription_user_stats" (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_count INTEGER NOT NULL DEFAULT 0,
  trial_count INTEGER NOT NULL DEFAULT 0,
  active_count INTEGER NOT NULL DEFAULT 0,
  expired_count INTEGER NOT NULL DEFAULT 0,
  paused_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (total_count >= 0 AND trial_count >= 0 AND active_count >= 0 AND expired_count >= 0 AND paused_count >= 0 AND cancelled_count >= 0),
  CHECK (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)
);
CREATE TABLE "subscriptions" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo TEXT,
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  custom_days INTEGER,
  custom_cycle_unit TEXT,
  one_time_term_count INTEGER,
  one_time_term_unit TEXT,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  public_hidden INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  start_date TEXT,
  next_billing_date TEXT NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  auto_calculate_next_billing_date INTEGER NOT NULL,
  trial_end_date TEXT,
  website TEXT,
  notes TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  reminder_days INTEGER NOT NULL,
  repeat_reminder_enabled INTEGER NOT NULL,
  repeat_reminder_interval TEXT NOT NULL,
  repeat_reminder_window TEXT NOT NULL,
  cost_sharing_json TEXT NOT NULL DEFAULT '{}',
  cost_sharing_collection_reminder_enabled INTEGER NOT NULL DEFAULT 0,
  cost_sharing_next_collection_reminder_date TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE "telegram_bot_bindings" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  -- 重建表只复制当前契约列，用于把测试期已应用的旧 D1 表收敛到当前形状。
  bot_token_hash TEXT NOT NULL CHECK (length(bot_token_hash) = 43),
  webhook_secret_hash TEXT NOT NULL CHECK (length(webhook_secret_hash) = 43),
  status TEXT NOT NULL CHECK (status IN ('installing', 'installed')),
  last_update_id INTEGER NOT NULL DEFAULT 0 CHECK (last_update_id >= 0),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  reset_token_hash TEXT,
  reset_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_api_tokens_user_created ON api_tokens (user_id, created_at DESC, id DESC);
CREATE INDEX idx_assets_user_kind_updated ON assets (user_id, kind, updated_at DESC);
CREATE UNIQUE INDEX idx_calendar_feeds_token ON calendar_feeds (token);
CREATE UNIQUE INDEX idx_calendar_feeds_user_all_unique ON calendar_feeds (user_id) WHERE scope = 'all';
CREATE INDEX idx_calendar_feeds_user_scope_updated_id
  ON calendar_feeds (user_id, scope, updated_at DESC, id DESC);
CREATE UNIQUE INDEX idx_calendar_feeds_user_subscription_unique ON calendar_feeds (user_id, subscription_id) WHERE scope = 'subscription';
CREATE INDEX idx_cloud_backup_configs_schedule ON cloud_backup_configs (enabled, schedule_enabled, updated_at);
CREATE INDEX idx_cloud_backup_targets_next_run
  ON cloud_backup_targets (schedule_enabled, next_run_at_utc, user_id, provider);
CREATE INDEX idx_cloud_backup_targets_schedule ON cloud_backup_targets (schedule_enabled, updated_at);
CREATE UNIQUE INDEX idx_media_icon_index_refresh_jobs_active_provider
  ON media_icon_index_refresh_jobs (provider)
  WHERE status IN ('queued', 'running');
CREATE INDEX idx_media_icon_index_refresh_jobs_provider_queued_at
  ON media_icon_index_refresh_jobs (provider, queued_at DESC);
CREATE INDEX idx_mfa_recovery_user_used ON mfa_recovery_codes (user_id, used_at);
CREATE INDEX idx_mfa_tickets_user_expires ON mfa_auth_tickets (user_id, expires_at);
CREATE INDEX idx_notification_jobs_status ON notification_jobs (status, scheduled_instant_utc);
CREATE INDEX idx_notification_jobs_user_created ON notification_jobs (user_id, created_at DESC);
CREATE INDEX idx_notification_jobs_user_status_time
  ON notification_jobs (user_id, status, scheduled_instant_utc DESC, created_at DESC, id DESC);
CREATE INDEX idx_passkey_challenges_user_kind ON passkey_challenges (user_id, kind);
CREATE INDEX idx_passkeys_user ON passkey_credentials (user_id, created_at DESC);
CREATE UNIQUE INDEX idx_public_status_pages_token ON public_status_pages (token);
CREATE UNIQUE INDEX idx_public_status_pages_user_unique ON public_status_pages (user_id);
CREATE INDEX idx_public_status_visible_order
  ON subscriptions (user_id, public_hidden, pinned DESC, created_at DESC, id DESC);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_subscription_list_index_user_billing_cycle_order
  ON subscription_list_index (user_id, billing_cycle, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_category_order
  ON subscription_list_index (user_id, category, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_currency_order
  ON subscription_list_index (user_id, currency, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_order
  ON subscription_list_index (user_id, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_payment_method_order
  ON subscription_list_index (user_id, payment_method, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_pinned_order
  ON subscription_list_index (user_id, pinned, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_public_hidden_order
  ON subscription_list_index (user_id, public_hidden, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_reminder_order
  ON subscription_list_index (user_id, reminder_days, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_list_index_user_repeat_order
  ON subscription_list_index (user_id, repeat_reminder_enabled, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_repeat_schedule_due
  ON subscription_repeat_schedule (user_id, next_due_at_utc, subscription_id);
CREATE INDEX idx_subscription_scheduler_auto_due
  ON subscription_scheduler_state (next_auto_renew_check_at_utc, user_id);
CREATE INDEX idx_subscription_scheduler_daily_due
  ON subscription_scheduler_state (next_daily_notification_due_at_utc, user_id);
CREATE INDEX idx_subscription_scheduler_repeat_due
  ON subscription_scheduler_state (next_repeat_notification_due_at_utc, user_id);
CREATE INDEX idx_subscription_tags_user_tag_order
  ON subscription_tags (user_id, tag_norm, created_at DESC, subscription_id DESC);
CREATE INDEX idx_subscription_tags_user_updated
  ON subscription_tags (user_id, updated_at DESC, tag_norm);
CREATE INDEX idx_subscriptions_user_auto_renew_due
  ON subscriptions (user_id, auto_renew, next_billing_date, id);
CREATE INDEX idx_subscriptions_user_billing_cycle_order
  ON subscriptions (user_id, billing_cycle, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_category_order
  ON subscriptions (user_id, category, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_cost_sharing_collection_due
  ON subscriptions (user_id, cost_sharing_collection_reminder_enabled, cost_sharing_next_collection_reminder_date, id);
CREATE INDEX idx_subscriptions_user_created ON subscriptions (user_id, created_at DESC);
CREATE INDEX idx_subscriptions_user_created_id ON subscriptions (user_id, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_currency_order
  ON subscriptions (user_id, currency, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_logo ON subscriptions (user_id, logo);
CREATE INDEX idx_subscriptions_user_next_billing ON subscriptions (user_id, next_billing_date);
CREATE INDEX idx_subscriptions_user_payment_method_order
  ON subscriptions (user_id, payment_method, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_pinned_order
  ON subscriptions (user_id, pinned, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_public_hidden_order
  ON subscriptions (user_id, public_hidden, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_reminder_date_due
  ON subscriptions (user_id, next_billing_date, id);
CREATE INDEX idx_subscriptions_user_reminder_due
  ON subscriptions (user_id, next_billing_date, id);
CREATE INDEX idx_subscriptions_user_reminder_mode_order
  ON subscriptions (user_id, reminder_days, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_repeat_reminder
  ON subscriptions (user_id, repeat_reminder_enabled, next_billing_date, id);
CREATE INDEX idx_subscriptions_user_repeat_reminder_order
  ON subscriptions (user_id, repeat_reminder_enabled, created_at DESC, id DESC);
CREATE INDEX idx_subscriptions_user_repeat_trial_reminder
  ON subscriptions (user_id, repeat_reminder_enabled, status, trial_end_date, id);
CREATE INDEX idx_subscriptions_user_tags_updated
  ON subscriptions (user_id, updated_at DESC, id DESC) WHERE tags_json != '[]';
CREATE INDEX idx_subscriptions_user_trial_reminder
  ON subscriptions (user_id, trial_end_date, id);
CREATE INDEX idx_subscriptions_user_trial_reminder_date_due
  ON subscriptions (user_id, trial_end_date, id);
CREATE INDEX idx_telegram_bot_bindings_webhook_secret ON telegram_bot_bindings (webhook_secret_hash);
CREATE INDEX idx_users_banned_id
  ON users (banned, id);
CREATE INDEX idx_users_lower_email ON users (lower(email));
CREATE INDEX idx_users_role_banned ON users (role, banned);
CREATE TRIGGER renewlet_notification_message_contract_insert
BEFORE INSERT ON notification_jobs
FOR EACH ROW
WHEN json_type(NEW.result_json, '$.message') IS NOT NULL OR length(CAST(NEW.result_json AS BLOB)) > 65536
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_MESSAGE_STORAGE_CONTRACT_INVALID');
END;
CREATE TRIGGER renewlet_notification_message_contract_update
BEFORE UPDATE OF result_json ON notification_jobs
FOR EACH ROW
WHEN json_type(NEW.result_json, '$.message') IS NOT NULL OR length(CAST(NEW.result_json AS BLOB)) > 65536
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_MESSAGE_STORAGE_CONTRACT_INVALID');
END;
CREATE TRIGGER renewlet_settings_locale_contract_insert
BEFORE INSERT ON settings
FOR EACH ROW
WHEN CASE
  WHEN json_valid(NEW.settings_json) = 0 THEN 1
  WHEN json_type(NEW.settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(NEW.settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(NEW.settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US', 'ru-RU') THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID');
END;
CREATE TRIGGER renewlet_settings_locale_contract_update
BEFORE UPDATE OF settings_json ON settings
FOR EACH ROW
WHEN CASE
  WHEN json_valid(NEW.settings_json) = 0 THEN 1
  WHEN json_type(NEW.settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(NEW.settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(NEW.settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US', 'ru-RU') THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID');
END;
INSERT INTO "calendar_feeds" ("id", "user_id", "scope", "subscription_id", "token", "created_at", "updated_at") VALUES ('feed_all_fixture', 'usr_fixture', 'all', NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "calendar_feeds" ("id", "user_id", "scope", "subscription_id", "token", "created_at", "updated_at") VALUES ('feed_sub_fixture', 'usr_fixture', 'subscription', 'sub_fixture', 'sssssssssssssssssssssssssssssssssssssssssss', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (1, '0001_initial.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (2, '0002_subscription_extra.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (3, '0003_users_lower_email_index.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (4, '0004_clean_invalid_subscription_logos.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (5, '0005_calendar_feeds.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (6, '0006_subscription_pinned.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (7, '0007_subscription_custom_cycle_unit.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (8, '0008_subscription_one_time_term.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (9, '0009_public_status.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (10, '0010_subscription_auto_renew.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (11, '0011_cloud_backup.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (12, '0012_cloud_backup_targets.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (13, '0013_media_icon_indexes.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (14, '0014_subscription_logo_index.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (15, '0015_media_icon_index_split.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (16, '0016_notification_scheduler_indexes.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (17, '0017_subscription_scheduler_state.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (18, '0018_subscription_cost_sharing.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (19, '0019_subscription_cost_sharing_current_user_payer.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (20, '0020_api_tokens.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (21, '0021_telegram_bot_bindings.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (22, '0022_rebuild_telegram_bot_bindings.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (23, '0023_mfa.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (24, '0024_nullable_subscription_start_date.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (25, '0025_query_plan_indexes.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (26, '0026_subscription_filter_indexes.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (27, '0027_worker_performance_state.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (28, '0028_media_icon_index_refresh_jobs.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (29, '0029_media_icon_index_refresh_jobs_index_hash.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (30, '0030_decimal_money_and_cookie_sessions.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (31, '0031_subscription_stats_source_updated_at.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (32, '0032_exchange_rate_snapshots.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (33, '0033_auth_security_settings.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (34, '0034_cost_sharing_collection_reminders.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (35, '0035_rebuild_cost_sharing_collection_reminder_schema.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (36, '0036_subscription_derived_state_v2.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (37, '0037_subscription_cycle_fields.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (38, '0038_calendar_feed_management.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (39, '0039_rebuild_subscription_collection_projections.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (40, '0040_exclusive_settings_locale_preference.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (41, '0041_exclusive_notification_message_snapshots.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (42, '0042_public_status_filters.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (43, '0043_settings_locale_preference_ru_ru.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (44, '0044_exclusive_settings_locale_guard.sql', '2026-08-25T00:00:00.000Z');
INSERT INTO "settings" ("user_id", "settings_json", "created_at", "updated_at") VALUES ('usr_fixture', '{"localePreference":"en-US","timezone":"UTC"}', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscription_derived_backfills" ("name", "completed_at") VALUES ('subscription-derived-state-v3', '2026-08-25T12:00:00.000Z');
INSERT INTO "subscription_list_index" ("subscription_id", "user_id", "name", "website", "notes", "search_text_lower", "category", "billing_cycle", "currency", "payment_method", "status", "pinned", "public_hidden", "next_billing_date", "trial_end_date", "one_time_term_count", "auto_renew", "reminder_days", "repeat_reminder_enabled", "created_at", "updated_at") VALUES ('sub_fixture', 'usr_fixture', 'Historical Service', NULL, NULL, 'historical service


work
工具', 'software', 'monthly', 'USD', NULL, 'active', 0, 0, '2026-08-27', NULL, NULL, 1, 3, 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscription_list_index" ("subscription_id", "user_id", "name", "website", "notes", "search_text_lower", "category", "billing_cycle", "currency", "payment_method", "status", "pinned", "public_hidden", "next_billing_date", "trial_end_date", "one_time_term_count", "auto_renew", "reminder_days", "repeat_reminder_enabled", "created_at", "updated_at") VALUES ('sub_paused', 'usr_fixture', 'Historical Service', NULL, NULL, 'historical service


work
工具', 'software', 'monthly', 'USD', NULL, 'paused', 0, 0, '2026-08-27', NULL, NULL, 1, 3, 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscription_repeat_schedule" ("user_id", "subscription_id", "next_due_at_utc") VALUES ('usr_fixture', 'sub_fixture', '2026-08-25T12:00:00Z');
INSERT INTO "subscription_repeat_schedule" ("user_id", "subscription_id", "next_due_at_utc") VALUES ('usr_fixture', 'sub_paused', '2026-08-25T12:00:00Z');
INSERT INTO "subscription_scheduler_state" ("user_id", "auto_renew_count", "repeat_reminder_count", "last_auto_renew_local_date", "created_at", "updated_at", "next_auto_renew_check_at_utc", "next_daily_notification_due_at_utc", "next_repeat_notification_due_at_utc") VALUES ('usr_fixture', 2, 2, '', '2026-08-25T12:00:00Z', '2026-08-25T12:00:00Z', '2026-08-25T12:00:00Z', '2026-08-26T08:00:00Z', '2026-08-25T12:00:00Z');
INSERT INTO "subscription_tags" ("user_id", "subscription_id", "tag_norm", "tag", "created_at", "updated_at") VALUES ('usr_fixture', 'sub_fixture', 'work', 'work', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscription_tags" ("user_id", "subscription_id", "tag_norm", "tag", "created_at", "updated_at") VALUES ('usr_fixture', 'sub_fixture', '工具', '工具', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscription_tags" ("user_id", "subscription_id", "tag_norm", "tag", "created_at", "updated_at") VALUES ('usr_fixture', 'sub_paused', 'work', 'work', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscription_tags" ("user_id", "subscription_id", "tag_norm", "tag", "created_at", "updated_at") VALUES ('usr_fixture', 'sub_paused', '工具', '工具', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscription_user_stats" ("user_id", "total_count", "trial_count", "active_count", "expired_count", "paused_count", "cancelled_count", "created_at", "updated_at") VALUES ('usr_fixture', 2, 0, 1, 0, 1, 0, '2026-08-25T12:00:00Z', '2026-08-25T12:00:00Z');
INSERT INTO "subscriptions" ("id", "user_id", "name", "logo", "price", "currency", "billing_cycle", "custom_days", "custom_cycle_unit", "one_time_term_count", "one_time_term_unit", "category", "status", "pinned", "public_hidden", "payment_method", "start_date", "next_billing_date", "auto_renew", "auto_calculate_next_billing_date", "trial_end_date", "website", "notes", "tags_json", "reminder_days", "repeat_reminder_enabled", "repeat_reminder_interval", "repeat_reminder_window", "cost_sharing_json", "cost_sharing_collection_reminder_enabled", "cost_sharing_next_collection_reminder_date", "extra_json", "created_at", "updated_at") VALUES ('sub_fixture', 'usr_fixture', 'Historical Service', NULL, '12.50', 'USD', 'monthly', NULL, NULL, NULL, NULL, 'software', 'active', 0, 0, NULL, '2026-01-24', '2026-08-27', 1, 1, NULL, NULL, NULL, '[" Work ","work","工具"]', 3, 1, '1h', '72h', '{}', 0, NULL, '{}', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "subscriptions" ("id", "user_id", "name", "logo", "price", "currency", "billing_cycle", "custom_days", "custom_cycle_unit", "one_time_term_count", "one_time_term_unit", "category", "status", "pinned", "public_hidden", "payment_method", "start_date", "next_billing_date", "auto_renew", "auto_calculate_next_billing_date", "trial_end_date", "website", "notes", "tags_json", "reminder_days", "repeat_reminder_enabled", "repeat_reminder_interval", "repeat_reminder_window", "cost_sharing_json", "cost_sharing_collection_reminder_enabled", "cost_sharing_next_collection_reminder_date", "extra_json", "created_at", "updated_at") VALUES ('sub_paused', 'usr_fixture', 'Historical Service', NULL, '12.50', 'USD', 'monthly', NULL, NULL, NULL, NULL, 'software', 'paused', 0, 0, NULL, '2026-01-24', '2026-08-27', 1, 1, NULL, NULL, NULL, '[" Work ","work","工具"]', 3, 1, '1h', '72h', '{}', 0, NULL, '{}', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
INSERT INTO "users" ("id", "email", "name", "role", "banned", "ban_reason", "password_hash", "reset_token_hash", "reset_token_expires_at", "created_at", "updated_at") VALUES ('usr_fixture', 'fixture@example.com', 'Fixture', 'admin', 0, '', 'hash', NULL, NULL, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
COMMIT;
PRAGMA foreign_keys = ON;
