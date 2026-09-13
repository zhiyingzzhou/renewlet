package main

// schema.go 维护 PocketBase collection 与应用级设置的强约束。
//
// 架构位置：
//   - migration/bootstrap 调用 ensureSchema，让本地开发、首次部署和升级路径复用同一套 schema 收敛。
//   - record hooks 与前端 Zod schema 依赖这些字段名、枚举值和索引语义。
//
// 注意： 字段重命名、索引唯一性和枚举收窄都会影响既有数据，必须按破坏性迁移处理。
import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	maxLogoReferenceLength       = 2048
	maxSubscriptionPrice         = 1_000_000_000
	maxSubscriptionTags          = 100
	maxSubscriptionTagLength     = 40
	maxSubscriptionTagsFieldSize = 16 * 1024
	subscriptionCleanupPageSize  = 500
)

var schemaAutodateCollections = []string{
	"subscriptions",
	"subscription_scheduler_states",
	"settings",
	"custom_configs",
	"exchange_rate_snapshots",
	"assets",
	"notification_jobs",
	"calendar_feeds",
	"public_status_pages",
	"api_tokens",
	"app_sessions",
	"mfa_totp_credentials",
	"mfa_recovery_codes",
	"mfa_auth_tickets",
	"passkey_credentials",
	"passkey_challenges",
	"telegram_bot_bindings",
	"cloud_backup_targets",
	"media_icon_indexes",
	authSecurityCollectionName,
}

// ensureSchema 收敛 PocketBase schema，并只通过内部迁移账本执行一次性历史数据修复。
// 启动热路径可以反复调用它；全表 backfill 必须挂在 runSchemaDataMigrations 后面，不能混进 collection 保存逻辑。
func ensureSchema(app core.App) error {
	if err := ensureCollectionsSchema(app); err != nil {
		return err
	}
	return runSchemaDataMigrations(app)
}

func ensureCollectionsSchema(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return err
	}
	if err := configureAppSettings(app); err != nil {
		return err
	}
	if err := ensureUsersCollectionSchema(app, users); err != nil {
		return err
	}

	if err := migrateLegacySubscriptionPriceNumberField(app); err != nil {
		return err
	}
	if err := ensureSubscriptionsCollection(app, users); err != nil {
		return err
	}
	if err := ensureSubscriptionSchedulerStatesCollection(app, users); err != nil {
		return err
	}
	if err := ensureSettingsCollection(app, users); err != nil {
		return err
	}
	if err := ensureSubscriptionDerivedTables(app); err != nil {
		return err
	}
	if err := ensureCustomConfigsCollection(app, users); err != nil {
		return err
	}
	if err := ensureExchangeRateSnapshotsCollection(app, users); err != nil {
		return err
	}
	if err := ensureAssetsCollection(app, users); err != nil {
		return err
	}
	if err := ensureNotificationJobsCollection(app, users); err != nil {
		return err
	}
	if err := ensureNotificationMessageTable(app); err != nil {
		return err
	}
	if err := ensureCalendarFeedsCollection(app, users); err != nil {
		return err
	}
	if err := ensurePublicStatusPagesCollection(app, users); err != nil {
		return err
	}
	if err := ensureAPITokensCollection(app, users); err != nil {
		return err
	}
	if err := ensureAuthMFACollections(app, users); err != nil {
		return err
	}
	if err := ensureTelegramBotBindingsCollection(app, users); err != nil {
		return err
	}
	if err := ensureCloudBackupTargetsCollection(app, users); err != nil {
		return err
	}
	if err := ensureAuthSecuritySettingsCollection(app); err != nil {
		return err
	}
	return ensureMediaIconIndexesCollection(app)
}

func ensureUsersCollectionSchema(app core.App, users *core.Collection) error {
	before, err := collectionSchemaSnapshot(users)
	if err != nil {
		return err
	}
	users.CreateRule = nil
	ownerRule := "id = @request.auth.id && @request.auth.banned = false"
	users.ListRule = types.Pointer(ownerRule)
	users.ViewRule = types.Pointer(ownerRule)
	users.UpdateRule = types.Pointer(ownerRule)
	users.DeleteRule = types.Pointer(ownerRule)
	if err := upsertField(users, &core.TextField{Name: "role", Max: 32}); err != nil {
		return err
	}
	if err := upsertField(users, &core.BoolField{Name: "banned"}); err != nil {
		return err
	}
	if err := upsertField(users, &core.TextField{Name: "banReason", Max: 500}); err != nil {
		return err
	}
	return saveCollectionIfChanged(app, users, before, false)
}

func upsertField(collection *core.Collection, field core.Field) error {
	existing := collection.Fields.GetByName(field.GetName())
	if existing != nil {
		if existing.Type() != field.Type() {
			return fmt.Errorf("collection %q field %q type mismatch: existing %q, expected %q", collection.Name, field.GetName(), existing.Type(), field.Type())
		}
		// 保留字段 id/system 标记，让 schema 收敛不会被 PocketBase 视为删除后重建字段。
		field.SetId(existing.GetId())
		if existing.GetSystem() {
			field.SetSystem(true)
		}
	}
	collection.Fields.Add(field)
	return nil
}

func upsertTextFieldReplacingLegacyURL(collection *core.Collection, field *core.TextField) error {
	existing := collection.Fields.GetByName(field.GetName())
	if existing != nil && existing.Type() != field.Type() {
		if existing.Type() != core.FieldTypeURL {
			return fmt.Errorf("collection %q field %q type mismatch: existing %q, expected %q", collection.Name, field.GetName(), existing.Type(), field.Type())
		}
		// URLField 和 TextField 底层同为 TEXT；只允许历史 logo URL 字段走这一条，不把它泛化成任意 type replace。
		field.SetId(existing.GetId())
		if existing.GetSystem() {
			field.SetSystem(true)
		}
		collection.Fields.Add(field)
		return nil
	}
	return upsertField(collection, field)
}

func ensureAutodates(collection *core.Collection) error {
	if err := upsertField(collection, &core.AutodateField{Name: "created", OnCreate: true, System: true}); err != nil {
		return err
	}
	return upsertField(collection, &core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true, System: true})
}

func ensureCollection(app core.App, name string, configure func(*core.Collection) error) error {
	return ensureCollectionWithSave(app, name, func(collection *core.Collection) (bool, error) {
		return false, configure(collection)
	})
}

func ensureCollectionWithSave(app core.App, name string, configure func(*core.Collection) (bool, error)) error {
	collection, err := app.FindCollectionByNameOrId(name)
	var before []byte
	if err != nil {
		collection = core.NewBaseCollection(name)
	} else {
		before, err = collectionSchemaSnapshot(collection)
		if err != nil {
			return err
		}
	}
	saveWithoutValidation, err := configure(collection)
	if err != nil {
		return err
	}
	return saveCollectionIfChanged(app, collection, before, saveWithoutValidation)
}

func collectionSchemaSnapshot(collection *core.Collection) ([]byte, error) {
	return json.Marshal(collection)
}

func saveCollectionIfChanged(app core.App, collection *core.Collection, before []byte, saveWithoutValidation bool) error {
	if before != nil {
		after, err := collectionSchemaSnapshot(collection)
		if err != nil {
			return err
		}
		if bytes.Equal(before, after) {
			return nil
		}
	}
	if saveWithoutValidation {
		// 少数兼容迁移需要先保存字段形态，再由 hooks/backfill 修复数据，因此允许跳过 collection validation。
		return app.SaveNoValidate(collection)
	}
	return app.Save(collection)
}

func ownerRules(collection *core.Collection) {
	// 所有业务 collection 都以 user relation 做隔离；route 层管理员能力不能绕过这里的默认 owner 边界。
	listRule := "user = @request.auth.id && @request.auth.banned = false"
	createRule := "@request.auth.id != '' && @request.auth.banned = false && user = @request.auth.id"
	collection.ListRule = types.Pointer(listRule)
	collection.ViewRule = types.Pointer(listRule)
	collection.CreateRule = types.Pointer(createRule)
	collection.UpdateRule = types.Pointer(listRule)
	collection.DeleteRule = types.Pointer(listRule)
}

func userRelation(users *core.Collection) *core.RelationField {
	return &core.RelationField{
		Name:          "user",
		CollectionId:  users.Id,
		CascadeDelete: true,
		MinSelect:     1,
		MaxSelect:     1,
		Required:      true,
	}
}

func ensureSubscriptionsCollection(app core.App, users *core.Collection) error {
	return ensureCollectionWithSave(app, "subscriptions", func(c *core.Collection) (bool, error) {
		ownerRules(c)
		minZero := 0.0
		maxReminder := float64(maxReminderDays)
		replaceLegacyLogoURLField := false
		if existingLogo := c.Fields.GetByName("logo"); existingLogo != nil && existingLogo.Type() == core.FieldTypeURL {
			replaceLegacyLogoURLField = true
		}
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "name", Required: true, Max: 120},
			&core.TextField{Name: "logo", Max: maxLogoReferenceLength},
			subscriptionPriceTextField(),
			&core.TextField{Name: "currency", Required: true, Max: 8, Pattern: `^[A-Z]{3}$`},
			&core.SelectField{Name: "billingCycle", Required: true, Values: []string{"weekly", "monthly", "quarterly", "semi-annual", "annual", "custom", "one-time"}},
			&core.NumberField{Name: "customDays", OnlyInt: true, Min: &minZero},
			&core.SelectField{Name: "customCycleUnit", Values: []string{"day", "week", "month", "year"}},
			&core.NumberField{Name: "oneTimeTermCount", OnlyInt: true, Min: &minZero, Max: &maxReminder},
			&core.SelectField{Name: "oneTimeTermUnit", Values: []string{"day", "week", "month", "year"}},
			&core.TextField{Name: "category", Required: true, Max: 80},
			&core.SelectField{Name: "status", Required: true, Values: []string{"trial", "active", "expired", "paused", "cancelled"}},
			&core.BoolField{Name: "pinned"},
			&core.BoolField{Name: "publicHidden"},
			&core.TextField{Name: "paymentMethod", Max: 80},
			&core.TextField{Name: "startDate", Max: 10, Pattern: `^$|^\d{4}-\d{2}-\d{2}$`},
			&core.TextField{Name: "nextBillingDate", Required: true, Max: 10, Pattern: `^\d{4}-\d{2}-\d{2}$`},
			&core.BoolField{Name: "autoRenew"},
			&core.BoolField{Name: "autoCalculateNextBillingDate"},
			&core.TextField{Name: "trialEndDate", Max: 10, Pattern: `^$|^\d{4}-\d{2}-\d{2}$`},
			&core.URLField{Name: "website"},
			&core.TextField{Name: "notes", Max: 5000},
			&core.JSONField{Name: "tags", MaxSize: maxSubscriptionTagsFieldSize},
			&core.JSONField{Name: "costSharing", MaxSize: 65536},
			// 内部镜像字段只为通知候选索引存在；公共契约仍读取 costSharing JSON。
			&core.BoolField{Name: "costSharingCollectionReminderEnabled"},
			&core.TextField{Name: "costSharingNextCollectionReminderDate", Max: 10, Pattern: `^$|^\d{4}-\d{2}-\d{2}$`},
			&core.JSONField{Name: "extra", MaxSize: 65536},
			&core.NumberField{Name: "reminderDays", OnlyInt: true, Min: types.Pointer(float64(disabledReminderDays)), Max: types.Pointer(float64(maxReminderDays))},
			&core.BoolField{Name: "repeatReminderEnabled"},
			&core.SelectField{Name: "repeatReminderInterval", Values: []string{"1h", "3h", "6h", "12h", "24h"}},
			&core.SelectField{Name: "repeatReminderWindow", Values: []string{"24h", "48h", "72h", "full"}},
		}
		for _, field := range fields {
			if field.GetName() == "logo" {
				logoField, ok := field.(*core.TextField)
				if !ok {
					return false, fmt.Errorf("subscriptions.logo field must be text")
				}
				if err := upsertTextFieldReplacingLegacyURL(c, logoField); err != nil {
					return false, err
				}
				continue
			}
			if err := upsertField(c, field); err != nil {
				return false, err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return false, err
		}
		c.Fields.RemoveByName("costSharingCollectionReminderDays")
		c.AddIndex("idx_subscriptions_user", false, "user", "")
		c.AddIndex("idx_subscriptions_user_logo", false, "user, logo", "")
		c.AddIndex("idx_subscriptions_user_next_billing", false, "user, nextBillingDate", "")
		c.AddIndex("idx_subscriptions_user_category_order", false, "user, category, created, id", "")
		c.AddIndex("idx_subscriptions_user_billing_cycle_order", false, "user, billingCycle, created, id", "")
		c.AddIndex("idx_subscriptions_user_currency_order", false, "user, currency, created, id", "")
		c.AddIndex("idx_subscriptions_user_payment_method_order", false, "user, paymentMethod, created, id", "")
		c.AddIndex("idx_subscriptions_user_pinned_order", false, "user, pinned, created, id", "")
		c.AddIndex("idx_subscriptions_user_public_hidden_order", false, "user, publicHidden, created, id", "")
		c.AddIndex("idx_subscriptions_user_reminder_mode_order", false, "user, reminderDays, created, id", "")
		c.AddIndex("idx_subscriptions_user_repeat_reminder_order", false, "user, repeatReminderEnabled, created, id", "")
		for _, name := range []string{
			"idx_subscriptions_user_auto_renew_due",
			"idx_subscriptions_user_reminder_due",
			"idx_subscriptions_user_trial_reminder",
			"idx_subscriptions_user_repeat_reminder",
			"idx_subscriptions_user_cost_sharing_collection_due",
		} {
			removeIndex(c, name)
		}
		// 旧索引把低选择性字段放在日期前，SQLite/D1 都可能退回按用户宽扫描；这里直接替换同名语义索引。
		c.AddIndex("idx_subscriptions_user_auto_renew_due", false, "user, autoRenew, nextBillingDate, id", "")
		c.AddIndex("idx_subscriptions_user_reminder_due", false, "user, nextBillingDate, id", "")
		c.AddIndex("idx_subscriptions_user_trial_reminder", false, "user, trialEndDate, id", "")
		// 家庭收款提醒单独走 enabled + next reminder date 索引，避免 cron 为 JSON 子字段做全用户扫描。
		c.AddIndex("idx_subscriptions_user_cost_sharing_collection_due", false, "user, costSharingCollectionReminderEnabled, costSharingNextCollectionReminderDate, id", "")
		c.AddIndex("idx_subscriptions_user_repeat_reminder", false, "user, repeatReminderEnabled, nextBillingDate, id", "")
		c.AddIndex("idx_subscriptions_user_repeat_trial_reminder", false, "user, repeatReminderEnabled, status, trialEndDate, id", "")
		return replaceLegacyLogoURLField, nil
	})
}

func ensureSubscriptionSchedulerStatesCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "subscription_scheduler_states", func(c *core.Collection) error {
		ownerRules(c)
		if err := upsertField(c, userRelation(users)); err != nil {
			return err
		}
		if err := upsertField(c, &core.NumberField{Name: "autoRenewCount", OnlyInt: true, Min: types.Pointer(float64(0))}); err != nil {
			return err
		}
		if err := upsertField(c, &core.NumberField{Name: "repeatReminderCount", OnlyInt: true, Min: types.Pointer(float64(0))}); err != nil {
			return err
		}
		if err := upsertField(c, &core.TextField{Name: "lastAutoRenewLocalDate", Max: 10, Pattern: `^$|^\d{4}-\d{2}-\d{2}$`}); err != nil {
			return err
		}
		// next* 字段只是 Cron 热路径索引；提醒幂等仍由单用户逻辑和 notification_jobs 唯一键承担。
		for _, name := range []string{"nextAutoRenewCheckAtUTC", "nextDailyNotificationDueAtUTC", "nextRepeatNotificationDueAtUTC"} {
			if err := upsertField(c, &core.TextField{Name: name, Max: 40}); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_subscription_scheduler_states_user_unique", true, "user", "")
		c.AddIndex("idx_subscription_scheduler_states_auto_due", false, "nextAutoRenewCheckAtUTC, user", "")
		c.AddIndex("idx_subscription_scheduler_states_daily_due", false, "nextDailyNotificationDueAtUTC, user", "")
		c.AddIndex("idx_subscription_scheduler_states_repeat_due", false, "nextRepeatNotificationDueAtUTC, user", "")
		return nil
	})
}

func ensureSettingsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "settings", func(c *core.Collection) error {
		ownerRules(c)
		if err := upsertField(c, userRelation(users)); err != nil {
			return err
		}
		if err := upsertField(c, &core.JSONField{Name: "settings", MaxSize: 65536}); err != nil {
			return err
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// 每个用户只能有一份 settings；route/service 用 upsert 语义，唯一索引是并发写入的最终保护。
		c.AddIndex("idx_settings_user_unique", true, "user", "")
		return nil
	})
}

func ensureCustomConfigsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "custom_configs", func(c *core.Collection) error {
		ownerRules(c)
		if err := upsertField(c, userRelation(users)); err != nil {
			return err
		}
		if err := upsertField(c, &core.JSONField{Name: "config", MaxSize: 65536}); err != nil {
			return err
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// 自定义配置与 settings 分开存储，避免大 JSON 配置保存失败时污染通知/主题等核心设置。
		c.AddIndex("idx_custom_configs_user_unique", true, "user", "")
		return nil
	})
}

func ensureExchangeRateSnapshotsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "exchange_rate_snapshots", func(c *core.Collection) error {
		ownerRules(c)
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "reportMonth", Required: true, Max: 7, Pattern: `^\d{4}-(0[1-9]|1[0-2])$`},
			&core.TextField{Name: "base", Required: true, Max: 3, Pattern: `^USD$`},
			&core.JSONField{Name: "rates", Required: true, MaxSize: 65536},
			&core.SelectField{Name: "requestedProvider", Required: true, Values: []string{"frankfurter", "floatrates", "exchange-api"}},
			&core.SelectField{Name: "provider", Required: true, Values: []string{"frankfurter", "floatrates", "exchange-api"}},
			&core.TextField{Name: "sourceDate", Required: true, Max: 64},
			&core.TextField{Name: "capturedAt", Required: true, Max: 40},
			&core.JSONField{Name: "warning", MaxSize: 16384},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// 月度快照是报表折算事实源；唯一键禁止同一用户同一月份出现两套口径。
		c.AddIndex("idx_exchange_rate_snapshots_user_month_unique", true, "user, reportMonth", "")
		return nil
	})
}

func ensureMediaIconIndexesCollection(app core.App) error {
	return ensureCollection(app, "media_icon_indexes", func(c *core.Collection) error {
		fields := []core.Field{
			&core.TextField{Name: "key", Required: true, Max: 40, Pattern: `^[a-z_]+$`},
			&core.TextField{Name: "hash", Max: 128},
			&core.NumberField{Name: "iconCount", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.JSONField{Name: "providerCounts", MaxSize: 4096},
			&core.JSONField{Name: "providerStatus", MaxSize: builtInIconProviderStatusMaxBytes},
			&core.TextField{Name: "checkedAt", Max: 40},
			&core.TextField{Name: "indexUpdatedAt", Max: 40},
			&core.TextField{Name: "searchIndexGzipBase64", Max: 2_000_000},
			&core.TextField{Name: "detailIndexGzipBase64", Max: 2_000_000},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		c.Fields.RemoveByName("indexGzipBase64")
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// 系统级索引不挂 user relation；普通搜索只读热索引，完整 detail 仅供管理员刷新合并 provider。
		c.AddIndex("idx_media_icon_indexes_key_unique", true, "`key`", "")
		return nil
	})
}

func ensureAuthSecuritySettingsCollection(app core.App) error {
	return ensureCollection(app, authSecurityCollectionName, func(c *core.Collection) error {
		// Turnstile secret 是站点级安全凭据，不挂 user relation，也不开放 PocketBase REST 读写。
		c.ListRule = nil
		c.ViewRule = nil
		c.CreateRule = nil
		c.UpdateRule = nil
		c.DeleteRule = nil
		fields := []core.Field{
			&core.TextField{Name: "key", Required: true, Max: 32, Pattern: `^global$`},
			&core.BoolField{Name: "turnstileEnabled"},
			&core.TextField{Name: "turnstileSiteKey", Max: 256},
			&core.TextField{Name: "turnstileSecret", Max: 4096},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// 只允许 key=global 的单行配置；访问安全策略不能跟用户账号或导出 settings 绑定。
		c.AddIndex("idx_auth_security_settings_key_unique", true, "`key`", "")
		return nil
	})
}

func ensureAssetsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "assets", func(c *core.Collection) error {
		ownerRules(c)
		fields := []core.Field{
			userRelation(users),
			&core.SelectField{Name: "kind", Required: true, Values: []string{"logo", "icon"}},
			// Protected 文件只能通过自定义 /api/app/assets/{id} 读取，确保每次访问都重新校验 owner。
			&core.FileField{Name: "file", MaxSelect: 1, MaxSize: 2 * 1024 * 1024, MimeTypes: []string{"image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"}, Protected: true, Required: true},
			&core.TextField{Name: "mimeType", Max: 100},
			&core.NumberField{Name: "sizeBytes", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.TextField{Name: "originalName", Max: 255},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_assets_user", false, "user", "")
		return nil
	})
}

func ensureNotificationJobsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "notification_jobs", func(c *core.Collection) error {
		ownerRules(c)
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "scheduledLocalDate", Required: true, Max: 10, Pattern: `^\d{4}-\d{2}-\d{2}$`},
			&core.TextField{Name: "scheduledLocalTime", Required: true, Max: 5, Pattern: `^\d{2}:\d{2}$`},
			&core.TextField{Name: "timeZone", Required: true, Max: 128},
			&core.TextField{Name: "scheduledInstantUtc", Required: true, Max: 40},
			&core.SelectField{Name: "status", Required: true, Values: []string{"pending", "sending", "sent", "failed", "skipped"}},
			&core.NumberField{Name: "attempts", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.TextField{Name: "lastError", Max: 2000},
			&core.JSONField{Name: "result", MaxSize: 65536},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// 同一用户/本地日期/本地时间/时区只允许一个 job，是 cron 重试和并发 tick 的幂等锁。
		c.AddIndex("idx_notification_jobs_user_local_date", false, "user, scheduledLocalDate", "")
		c.AddIndex("idx_notification_jobs_user_local_time_unique", true, "user, scheduledLocalDate, scheduledLocalTime, timeZone", "")
		return nil
	})
}

func ensureCalendarFeedsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "calendar_feeds", func(c *core.Collection) error {
		ownerRules(c)
		if err := upsertField(c, userRelation(users)); err != nil {
			return err
		}
		if err := upsertField(c, &core.SelectField{Name: "scope", Required: true, Values: []string{"all", "subscription"}}); err != nil {
			return err
		}
		if err := upsertField(c, &core.TextField{Name: "subscriptionId", Max: 128}); err != nil {
			return err
		}
		// ICS 客户端无法携带 Renewlet 登录态；保存可恢复 token，换取刷新后仍可复制订阅 URL 的体验。
		if err := upsertField(c, &core.TextField{Name: "token", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`}); err != nil {
			return err
		}
		c.Fields.RemoveByName("tokenHash")
		if err := ensureAutodates(c); err != nil {
			return err
		}
		removeIndex(c, "idx_calendar_feeds_user_unique")
		removeIndex(c, "idx_calendar_feeds_token_hash_unique")
		removeIndex(c, "idx_calendar_feeds_user_subscription")
		// token 是公开 ICS route 的 bearer secret；用户维度唯一索引保护管理端展示，token 唯一索引保护公开读取。
		c.AddIndex("idx_calendar_feeds_user_all_unique", true, "user", "scope = 'all'")
		c.AddIndex("idx_calendar_feeds_token_unique", true, "token", "")
		c.AddIndex("idx_calendar_feeds_user_subscription_unique", true, "user, subscriptionId", "scope = 'subscription'")
		c.AddIndex("idx_calendar_feeds_user_scope_updated_id", false, "user, scope, updated DESC, id DESC", "")
		return nil
	})
}

func ensurePublicStatusPagesCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "public_status_pages", func(c *core.Collection) error {
		ownerRules(c)
		if err := upsertField(c, userRelation(users)); err != nil {
			return err
		}
		// token 是公开状态页的 bearer secret；只回显完整 URL，避免前端把 token 当普通设置导入导出。
		if err := upsertField(c, &core.TextField{Name: "token", Required: true, Max: 128, Pattern: `^[A-Za-z0-9_-]{43}$`}); err != nil {
			return err
		}
		if err := upsertField(c, &core.BoolField{Name: "showPrices"}); err != nil {
			return err
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_public_status_pages_user_unique", true, "user", "")
		c.AddIndex("idx_public_status_pages_token_unique", true, "token", "")
		return nil
	})
}

func ensureCloudBackupTargetsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "cloud_backup_targets", func(c *core.Collection) error {
		// credential 字段含云存储 secret；该 collection 只能经自定义 route 脱敏读写，不能开放 PocketBase REST owner 读规则。
		c.ListRule = nil
		c.ViewRule = nil
		c.CreateRule = nil
		c.UpdateRule = nil
		c.DeleteRule = nil
		fields := []core.Field{
			userRelation(users),
			&core.SelectField{Name: "provider", Required: true, Values: []string{"webdav", "s3"}},
			&core.JSONField{Name: "config", MaxSize: 65536},
			// 云存储 credential 只允许 route 层写入和脱敏响应；普通导出/云备份都不会读取后再打包。
			&core.JSONField{Name: "credential", MaxSize: 65536},
			&core.BoolField{Name: "scheduleEnabled"},
			&core.SelectField{Name: "scheduleFrequency", Values: []string{"daily", "weekly"}},
			&core.TextField{Name: "scheduleTime", Max: 5, Pattern: `^\d{2}:\d{2}$`},
			&core.SelectField{Name: "scheduleWeekday", Values: []string{"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}},
			&core.NumberField{Name: "retention", OnlyInt: true, Min: types.Pointer(1.0), Max: types.Pointer(float64(cloudBackupMaxRetention))},
			&core.TextField{Name: "lastBackupAt", Max: 40},
			&core.SelectField{Name: "lastStatus", Values: []string{"idle", "success", "failed"}},
			&core.TextField{Name: "lastError", Max: 2000},
			&core.TextField{Name: "lockedUntil", Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// 每个 provider 一行；唯一索引同时保护 WebDAV/S3 独立策略和并发保存。
		c.AddIndex("idx_cloud_backup_targets_user_provider_unique", true, "user, provider", "")
		c.AddIndex("idx_cloud_backup_targets_schedule", false, "scheduleEnabled, updated", "")
		return nil
	})
}

func migrateLegacyCloudBackupConfigs(app core.App) error {
	if _, err := app.FindCollectionByNameOrId("cloud_backup_configs"); err != nil {
		return nil
	}
	targetCollection, err := app.FindCollectionByNameOrId("cloud_backup_targets")
	if err != nil {
		return err
	}
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("cloud_backup_configs", "id != ''", "created", subscriptionCleanupPageSize, offset)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if err := migrateLegacyCloudBackupConfigRow(app, targetCollection, row); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func migrateLegacyCloudBackupConfigRow(app core.App, targetCollection *core.Collection, row *core.Record) error {
	userID := row.GetString("user")
	if userID == "" {
		return nil
	}
	var stored cloudBackupStoredConfig
	if data, err := jsonBytesFromValue(row.Get("config")); err == nil && strings.TrimSpace(string(data)) != "" {
		_ = json.Unmarshal(data, &stored)
	}
	var credential cloudBackupStoredCredential
	if data, err := jsonBytesFromValue(row.Get("credential")); err == nil && strings.TrimSpace(string(data)) != "" {
		_ = json.Unmarshal(data, &credential)
	}
	policy := cloudBackupPolicy{
		ScheduleEnabled:   row.GetBool("scheduleEnabled"),
		ScheduleFrequency: row.GetString("scheduleFrequency"),
		ScheduleTime:      row.GetString("scheduleTime"),
		ScheduleWeekday:   row.GetString("scheduleWeekday"),
		Retention:         row.GetInt("retention"),
	}
	_ = policy.NormalizeAndValidate(defaultAppLocale)
	status := nonEmptyCloudBackupStatus(row.GetString("lastStatus"))
	for _, provider := range []string{cloudBackupProviderWebDAV, cloudBackupProviderS3} {
		if provider == cloudBackupProviderWebDAV && stored.WebDAV == nil && strings.TrimSpace(credential.WebDAVPassword) == "" {
			continue
		}
		if provider == cloudBackupProviderS3 && stored.S3 == nil && strings.TrimSpace(credential.S3SecretAccessKey) == "" {
			continue
		}
		if _, err := app.FindFirstRecordByFilter("cloud_backup_targets", "user = {:user} && provider = {:provider}", dbx.Params{"user": userID, "provider": provider}); err == nil {
			continue
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		target := core.NewRecord(targetCollection)
		target.Set("user", userID)
		target.Set("provider", provider)
		if provider == cloudBackupProviderWebDAV {
			target.Set("config", cloudBackupStoredConfig{WebDAV: stored.WebDAV})
			target.Set("credential", cloudBackupStoredCredential{WebDAVPassword: credential.WebDAVPassword})
		} else {
			target.Set("config", cloudBackupStoredConfig{S3: stored.S3})
			target.Set("credential", cloudBackupStoredCredential{S3SecretAccessKey: credential.S3SecretAccessKey})
		}
		target.Set("scheduleEnabled", policy.ScheduleEnabled)
		target.Set("scheduleFrequency", policy.ScheduleFrequency)
		target.Set("scheduleTime", policy.ScheduleTime)
		target.Set("scheduleWeekday", policy.ScheduleWeekday)
		target.Set("retention", policy.Retention)
		target.Set("lastBackupAt", strings.TrimSpace(row.GetString("lastBackupAt")))
		target.Set("lastStatus", status)
		target.Set("lastError", strings.TrimSpace(row.GetString("lastError")))
		target.Set("lockedUntil", "")
		if err := app.Save(target); err != nil {
			return err
		}
	}
	return nil
}

func removeIndex(collection *core.Collection, name string) {
	needle := "`" + name + "`"
	indexes := collection.Indexes[:0]
	for _, index := range collection.Indexes {
		if !strings.Contains(index, needle) {
			indexes = append(indexes, index)
		}
	}
	collection.Indexes = indexes
}

func deleteLegacyHashOnlyCalendarFeeds(app core.App) error {
	records, err := app.FindAllRecords("calendar_feeds")
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return nil
		}
		return err
	}
	for _, record := range records {
		if strings.TrimSpace(record.GetString("token")) != "" {
			continue
		}
		// hash-only 旧 feed 无法反推 URL；便利优先的新模型选择删除旧记录，让用户登录后重新生成。
		if err := app.Delete(record); err != nil {
			return err
		}
	}
	return nil
}
