package main

// subscription_derived_state.go 维护可删除重建的订阅读模型；subscriptions 始终是唯一事实源。
// 普通写入只能在事实行同一事务内应用单条 delta，全量扫描仅允许启动迁移、离线修复和测试 oracle 调用。

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/zhiyingzzhou/renewlet/apps/docker-server/internal/subscriptionderived"
)

type subscriptionListIndexRow struct {
	SubscriptionID        string `db:"subscription_id"`
	UserID                string `db:"user_id"`
	Name                  string `db:"name"`
	Website               string `db:"website"`
	Notes                 string `db:"notes"`
	SearchTextLower       string `db:"search_text_lower"`
	Category              string `db:"category"`
	BillingCycle          string `db:"billing_cycle"`
	Currency              string `db:"currency"`
	PaymentMethod         string `db:"payment_method"`
	Status                string `db:"status"`
	Pinned                int    `db:"pinned"`
	PublicHidden          int    `db:"public_hidden"`
	NextBillingDate       string `db:"next_billing_date"`
	TrialEndDate          string `db:"trial_end_date"`
	OneTimeTermCount      int    `db:"one_time_term_count"`
	AutoRenew             int    `db:"auto_renew"`
	ReminderDays          int    `db:"reminder_days"`
	RepeatReminderEnabled int    `db:"repeat_reminder_enabled"`
	CreatedAt             string `db:"created_at"`
	UpdatedAt             string `db:"updated_at"`
	Inactive              int    `db:"inactive"`
	TotalCount            int    `db:"total_count"`
}

type subscriptionStats struct {
	Total               int
	AutoRenewCount      int
	RepeatReminderCount int
	ByStatus            map[string]int
}

type subscriptionDerivedMutationKind string

const (
	subscriptionDerivedCreate subscriptionDerivedMutationKind = "create"
	subscriptionDerivedUpdate subscriptionDerivedMutationKind = "update"
	subscriptionDerivedDelete subscriptionDerivedMutationKind = "delete"
)

type subscriptionDerivedMutation struct {
	Before *core.Record
	After  *core.Record
	Kind   subscriptionDerivedMutationKind
	Now    time.Time
}

// 列、索引顺序和关键 CHECK 共同构成派生缓存版本，避免只看“表存在”就把旧 schema 带入热路径。
var subscriptionDerivedTableColumns = map[string][]string{
	"subscription_list_index": {
		"subscription_id", "user_id", "name", "website", "notes", "search_text_lower", "category", "billing_cycle",
		"currency", "payment_method", "status", "pinned", "public_hidden", "next_billing_date", "trial_end_date",
		"one_time_term_count", "auto_renew", "reminder_days", "repeat_reminder_enabled", "created_at", "updated_at",
	},
	"subscription_tags": {
		"user_id", "subscription_id", "tag_norm", "tag", "created_at", "updated_at",
	},
	"subscription_user_stats": {
		"user_id", "total_count", "trial_count", "active_count", "expired_count", "paused_count", "cancelled_count",
		"created_at", "updated_at",
	},
	"subscription_repeat_schedule": {
		"user_id", "subscription_id", "next_due_at_utc",
	},
}

var subscriptionDerivedIndexColumns = map[string][]string{
	"idx_subscription_list_index_user_order":                {"user_id", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_category_order":       {"user_id", "category", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_billing_cycle_order":  {"user_id", "billing_cycle", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_currency_order":       {"user_id", "currency", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_payment_method_order": {"user_id", "payment_method", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_pinned_order":         {"user_id", "pinned", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_public_hidden_order":  {"user_id", "public_hidden", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_reminder_order":       {"user_id", "reminder_days", "-created_at", "-subscription_id"},
	"idx_subscription_list_index_user_repeat_order":         {"user_id", "repeat_reminder_enabled", "-created_at", "-subscription_id"},
	"idx_subscription_tags_user_tag_order":                  {"user_id", "tag_norm", "-created_at", "-subscription_id"},
	"idx_subscription_tags_user_updated":                    {"user_id", "-updated_at", "tag_norm"},
	"idx_subscription_repeat_schedule_due":                  {"user_id", "next_due_at_utc", "subscription_id"},
}

var subscriptionDerivedTableSQLSignatures = map[string][]string{
	"subscription_user_stats": {
		"CHECK (total_count >= 0 AND trial_count >= 0 AND active_count >= 0 AND expired_count >= 0 AND paused_count >= 0 AND cancelled_count >= 0)",
		"CHECK (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)",
	},
}

func ensureSubscriptionDerivedTables(app core.App) error {
	current, err := subscriptionDerivedSchemaCurrent(app)
	if err != nil {
		return err
	}
	if current {
		return createSubscriptionDerivedTables(app)
	}
	// 派生表不承载业务事实；旧列形状必须在服务接流量前原子替换，不能把双 schema 分支留进热路径。
	return app.RunInTransaction(func(txApp core.App) error {
		for _, table := range []string{"subscription_repeat_schedule", "subscription_tags", "subscription_list_index", "subscription_user_stats"} {
			if _, err := txApp.DB().NewQuery("DROP TABLE IF EXISTS " + table).Execute(); err != nil {
				return err
			}
		}
		if err := createSubscriptionDerivedTables(txApp); err != nil {
			return err
		}
		var users []struct {
			UserID string `db:"user_id"`
		}
		if err := txApp.DB().NewQuery("SELECT DISTINCT user AS user_id FROM subscriptions WHERE user != '' ORDER BY user").All(&users); err != nil {
			return err
		}
		for _, row := range users {
			if err := rebuildSubscriptionDerivedStateForUser(txApp, row.UserID, time.Now().UTC()); err != nil {
				return err
			}
		}
		return nil
	})
}

func subscriptionDerivedSchemaCurrent(app core.App) (bool, error) {
	// 四张表共同组成一个可重建缓存版本；任一旧列或缺失索引都必须在接流量前整组替换。
	for table, expected := range subscriptionDerivedTableColumns {
		columns, err := sqliteTableColumns(app, table)
		if err != nil {
			return false, err
		}
		if strings.Join(columns, ",") != strings.Join(expected, ",") {
			return false, nil
		}
	}
	for index, expected := range subscriptionDerivedIndexColumns {
		columns, err := sqliteIndexColumns(app, index)
		if err != nil {
			return false, err
		}
		if strings.Join(columns, ",") != strings.Join(expected, ",") {
			return false, nil
		}
	}
	for table, signatures := range subscriptionDerivedTableSQLSignatures {
		schemaSQL, err := sqliteTableSchemaSQL(app, table)
		if err != nil {
			return false, err
		}
		for _, signature := range signatures {
			if !strings.Contains(normalizeSQLiteSchemaSQL(schemaSQL), normalizeSQLiteSchemaSQL(signature)) {
				return false, nil
			}
		}
	}
	return true, nil
}

func sqliteTableColumns(app core.App, table string) ([]string, error) {
	var rows []struct {
		Name string `db:"name"`
	}
	if err := app.DB().NewQuery("PRAGMA table_info(" + table + ")").All(&rows); err != nil {
		return nil, err
	}
	columns := make([]string, 0, len(rows))
	for _, row := range rows {
		columns = append(columns, row.Name)
	}
	return columns, nil
}

func sqliteIndexColumns(app core.App, index string) ([]string, error) {
	var rows []struct {
		Name sql.NullString `db:"name"`
		Desc int            `db:"desc"`
		Key  int            `db:"key"`
	}
	if err := app.DB().NewQuery("PRAGMA index_xinfo(" + index + ")").All(&rows); err != nil {
		return nil, err
	}
	columns := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Key != 1 || !row.Name.Valid {
			continue
		}
		name := row.Name.String
		if row.Desc == 1 {
			name = "-" + name
		}
		columns = append(columns, name)
	}
	return columns, nil
}

func sqliteTableSchemaSQL(app core.App, table string) (string, error) {
	var row struct {
		SQL string `db:"sql"`
	}
	err := app.DB().NewQuery("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = {:name} LIMIT 1").
		Bind(dbx.Params{"name": table}).
		One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return row.SQL, err
}

func normalizeSQLiteSchemaSQL(value string) string {
	return strings.Join(strings.Fields(strings.ToLower(value)), "")
}

func createSubscriptionDerivedTables(app core.App) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS subscription_list_index (
			subscription_id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			website TEXT NOT NULL DEFAULT '',
			notes TEXT NOT NULL DEFAULT '',
			search_text_lower TEXT NOT NULL DEFAULT '',
			category TEXT NOT NULL,
			billing_cycle TEXT NOT NULL,
			currency TEXT NOT NULL,
			payment_method TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			pinned INTEGER NOT NULL DEFAULT 0,
			public_hidden INTEGER NOT NULL DEFAULT 0,
			next_billing_date TEXT NOT NULL,
			trial_end_date TEXT NOT NULL DEFAULT '',
			one_time_term_count INTEGER NOT NULL DEFAULT 0,
			auto_renew INTEGER NOT NULL DEFAULT 0,
			reminder_days INTEGER NOT NULL DEFAULT -1,
			repeat_reminder_enabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_order ON subscription_list_index (user_id, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_category_order ON subscription_list_index (user_id, category, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_billing_cycle_order ON subscription_list_index (user_id, billing_cycle, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_currency_order ON subscription_list_index (user_id, currency, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_payment_method_order ON subscription_list_index (user_id, payment_method, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_pinned_order ON subscription_list_index (user_id, pinned, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_public_hidden_order ON subscription_list_index (user_id, public_hidden, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_reminder_order ON subscription_list_index (user_id, reminder_days, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_repeat_order ON subscription_list_index (user_id, repeat_reminder_enabled, created_at DESC, subscription_id DESC)`,
		`CREATE TABLE IF NOT EXISTS subscription_tags (
			user_id TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			tag_norm TEXT NOT NULL,
			tag TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (user_id, subscription_id, tag_norm)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_tags_user_tag_order ON subscription_tags (user_id, tag_norm, created_at DESC, subscription_id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_tags_user_updated ON subscription_tags (user_id, updated_at DESC, tag_norm)`,
		`CREATE TABLE IF NOT EXISTS subscription_user_stats (
			user_id TEXT PRIMARY KEY,
			total_count INTEGER NOT NULL DEFAULT 0,
			trial_count INTEGER NOT NULL DEFAULT 0,
			active_count INTEGER NOT NULL DEFAULT 0,
			expired_count INTEGER NOT NULL DEFAULT 0,
			paused_count INTEGER NOT NULL DEFAULT 0,
			cancelled_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			CHECK (total_count >= 0 AND trial_count >= 0 AND active_count >= 0 AND expired_count >= 0 AND paused_count >= 0 AND cancelled_count >= 0),
			CHECK (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)
		)`,
		`CREATE TABLE IF NOT EXISTS subscription_repeat_schedule (
			user_id TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			next_due_at_utc TEXT NOT NULL,
			PRIMARY KEY (user_id, subscription_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_repeat_schedule_due ON subscription_repeat_schedule (user_id, next_due_at_utc, subscription_id)`,
	}
	for _, statement := range statements {
		if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
			return err
		}
	}
	return nil
}

// rebuildSubscriptionDerivedStateForUser 只服务启动迁移、离线修复和测试 oracle；产品请求不得调用它。
func rebuildSubscriptionDerivedStateForUser(app core.App, userID string, now time.Time) error {
	if strings.TrimSpace(userID) == "" {
		return nil
	}
	if _, err := app.DB().NewQuery("DELETE FROM subscription_list_index WHERE user_id = {:user}").Bind(dbx.Params{"user": userID}).Execute(); err != nil {
		return err
	}
	if _, err := app.DB().NewQuery("DELETE FROM subscription_tags WHERE user_id = {:user}").Bind(dbx.Params{"user": userID}).Execute(); err != nil {
		return err
	}
	if _, err := app.DB().NewQuery("DELETE FROM subscription_repeat_schedule WHERE user_id = {:user}").Bind(dbx.Params{"user": userID}).Execute(); err != nil {
		return err
	}
	stats := newSubscriptionStats()
	settings := schedulerSettingsForUser(app, userID)
	for offset := 0; ; offset += subscriptionListScanPageSize {
		records, err := app.FindRecordsByFilter("subscriptions", "user = {:user}", "-created,-id", subscriptionListScanPageSize, offset, dbx.Params{"user": userID})
		if err != nil {
			return err
		}
		for _, record := range records {
			stats.Total++
			stats.ByStatus[record.GetString("status")]++
			if record.GetBool("autoRenew") {
				stats.AutoRenewCount++
			}
			if record.GetBool("repeatReminderEnabled") && subscriptionderived.OrdinaryRemindersAllowed(record.GetString("status")) {
				stats.RepeatReminderCount++
			}
			if err := upsertSubscriptionListProjection(app, record); err != nil {
				return err
			}
			if err := replaceSubscriptionTags(app, record); err != nil {
				return err
			}
			if err := replaceSubscriptionRepeatSchedule(app, record, settings, now); err != nil {
				return err
			}
		}
		if len(records) < subscriptionListScanPageSize {
			break
		}
	}
	if err := replaceSubscriptionStats(app, userID, stats, now); err != nil {
		return err
	}
	_, err := writeSubscriptionSchedulerAggregate(app, userID, subscriptionSchedulerAggregateInput{
		AutoRenewCount:      stats.AutoRenewCount,
		RepeatReminderCount: stats.RepeatReminderCount,
	}, subscriptionSchedulerRefreshOptions{ResetAutoRenewCheck: true, Now: now})
	return err
}

func applySubscriptionDerivedMutation(app core.App, mutation subscriptionDerivedMutation) error {
	if err := validateSubscriptionDerivedMutation(mutation); err != nil {
		return err
	}
	now := mutation.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	beforeUser := subscriptionRecordOwner(mutation.Before)
	afterUser := subscriptionRecordOwner(mutation.After)
	// 先清 before 的行级派生值，再写 after，最后应用 aggregate delta；调用方必须把整个序列包在事实写事务内。
	if mutation.Before != nil {
		if mutation.After == nil {
			// D1 由外键级联撤销 Feed；PocketBase 的 subscriptionId 只是文本，bearer 密钥必须在事实删除事务内显式收敛。
			if err := deleteSubscriptionCalendarFeeds(app, beforeUser, mutation.Before.Id); err != nil {
				return err
			}
		}
		if _, err := app.DB().NewQuery("DELETE FROM subscription_tags WHERE user_id = {:user} AND subscription_id = {:id}").
			Bind(dbx.Params{"user": beforeUser, "id": mutation.Before.Id}).Execute(); err != nil {
			return err
		}
		if mutation.After == nil || beforeUser != afterUser || mutation.Before.Id != mutation.After.Id {
			if _, err := app.DB().NewQuery("DELETE FROM subscription_list_index WHERE user_id = {:user} AND subscription_id = {:id}").
				Bind(dbx.Params{"user": beforeUser, "id": mutation.Before.Id}).Execute(); err != nil {
				return err
			}
		}
		if mutation.After == nil || mutation.Before.Id != mutation.After.Id {
			if _, err := app.DB().NewQuery("DELETE FROM subscription_repeat_schedule WHERE user_id = {:user} AND subscription_id = {:id}").
				Bind(dbx.Params{"user": beforeUser, "id": mutation.Before.Id}).Execute(); err != nil {
				return err
			}
		}
	}
	if mutation.After != nil {
		if err := upsertSubscriptionListProjection(app, mutation.After); err != nil {
			return err
		}
		if err := insertSubscriptionTags(app, mutation.After); err != nil {
			return err
		}
		if err := replaceSubscriptionRepeatSchedule(app, mutation.After, schedulerSettingsForUser(app, afterUser), now); err != nil {
			return err
		}
	}
	for _, userID := range uniqueNonEmptyStrings(beforeUser, afterUser) {
		if err := applySubscriptionStatsDelta(app, userID, mutation.Before, mutation.After, now); err != nil {
			return err
		}
		if _, err := applySubscriptionSchedulerDelta(app, userID, mutation.Before, mutation.After, now); err != nil {
			return err
		}
	}
	return nil
}

func validateSubscriptionDerivedMutation(mutation subscriptionDerivedMutation) error {
	validShape := false
	switch mutation.Kind {
	case subscriptionDerivedCreate:
		validShape = mutation.Before == nil && mutation.After != nil
	case subscriptionDerivedUpdate:
		validShape = mutation.Before != nil && mutation.After != nil
	case subscriptionDerivedDelete:
		validShape = mutation.Before != nil && mutation.After == nil
	}
	if !validShape {
		return fmt.Errorf("invalid subscription %s derived mutation", mutation.Kind)
	}
	row := mutation.After
	if row == nil {
		row = mutation.Before
	}
	if row == nil || row.Id == "" || subscriptionRecordOwner(row) == "" {
		return errors.New("SUBSCRIPTION_DERIVED_IDENTITY_REQUIRED")
	}
	if mutation.Before != nil && mutation.After != nil && (mutation.Before.Id != mutation.After.Id ||
		subscriptionRecordOwner(mutation.Before) != subscriptionRecordOwner(mutation.After)) {
		return errors.New("SUBSCRIPTION_IDENTITY_IMMUTABLE")
	}
	return nil
}

func upsertSubscriptionListProjection(app core.App, record *core.Record) error {
	tags := subscriptionRecordStringSlice(record, "tags")
	_, err := app.DB().NewQuery(`INSERT INTO subscription_list_index (
		subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle, currency,
		payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date, one_time_term_count,
		auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
	) VALUES (
		{:id}, {:user}, {:name}, {:website}, {:notes}, {:search}, {:category}, {:billingCycle}, {:currency},
		{:paymentMethod}, {:status}, {:pinned}, {:publicHidden}, {:nextBillingDate}, {:trialEndDate}, {:oneTimeTermCount},
		{:autoRenew}, {:reminderDays}, {:repeatReminderEnabled}, {:createdAt}, {:updatedAt}
	) ON CONFLICT(subscription_id) DO UPDATE SET
		user_id = excluded.user_id, name = excluded.name, website = excluded.website, notes = excluded.notes,
		search_text_lower = excluded.search_text_lower, category = excluded.category, billing_cycle = excluded.billing_cycle,
		currency = excluded.currency, payment_method = excluded.payment_method, status = excluded.status, pinned = excluded.pinned,
		public_hidden = excluded.public_hidden, next_billing_date = excluded.next_billing_date, trial_end_date = excluded.trial_end_date,
		one_time_term_count = excluded.one_time_term_count, auto_renew = excluded.auto_renew, reminder_days = excluded.reminder_days,
		repeat_reminder_enabled = excluded.repeat_reminder_enabled, created_at = excluded.created_at, updated_at = excluded.updated_at`).Bind(dbx.Params{
		"id": record.Id, "user": record.GetString("user"), "name": record.GetString("name"), "website": record.GetString("website"),
		"notes": record.GetString("notes"), "search": subscriptionSearchTextLower(record, tags), "category": record.GetString("category"),
		"billingCycle": record.GetString("billingCycle"), "currency": record.GetString("currency"), "paymentMethod": record.GetString("paymentMethod"),
		"status": record.GetString("status"), "pinned": boolToSQLiteInt(record.GetBool("pinned")), "publicHidden": boolToSQLiteInt(record.GetBool("publicHidden")),
		"nextBillingDate": record.GetString("nextBillingDate"), "trialEndDate": record.GetString("trialEndDate"), "oneTimeTermCount": record.GetInt("oneTimeTermCount"),
		"autoRenew": boolToSQLiteInt(record.GetBool("autoRenew")), "reminderDays": record.GetInt("reminderDays"),
		"repeatReminderEnabled": boolToSQLiteInt(record.GetBool("repeatReminderEnabled")), "createdAt": projectionRecordTimeString(record, "created"),
		"updatedAt": projectionRecordTimeString(record, "updated"),
	}).Execute()
	return err
}

func replaceSubscriptionTags(app core.App, record *core.Record) error {
	if _, err := app.DB().NewQuery("DELETE FROM subscription_tags WHERE user_id = {:user} AND subscription_id = {:id}").
		Bind(dbx.Params{"user": record.GetString("user"), "id": record.Id}).Execute(); err != nil {
		return err
	}
	return insertSubscriptionTags(app, record)
}

func insertSubscriptionTags(app core.App, record *core.Record) error {
	createdAt := projectionRecordTimeString(record, "created")
	updatedAt := projectionRecordTimeString(record, "updated")
	for _, tag := range normalizedSubscriptionTags(subscriptionRecordStringSlice(record, "tags")) {
		if _, err := app.DB().NewQuery(`INSERT INTO subscription_tags (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
			VALUES ({:user}, {:id}, {:tagNorm}, {:tag}, {:createdAt}, {:updatedAt})`).Bind(dbx.Params{
			"user": record.GetString("user"), "id": record.Id, "tagNorm": strings.ToLower(tag), "tag": tag,
			"createdAt": createdAt, "updatedAt": updatedAt,
		}).Execute(); err != nil {
			return err
		}
	}
	return nil
}

func normalizedSubscriptionTags(tags []string) []string {
	byKey := map[string]string{}
	for _, rawTag := range tags {
		tag := strings.TrimSpace(rawTag)
		if tag != "" {
			byKey[strings.ToLower(tag)] = tag
		}
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, byKey[key])
	}
	return out
}

func replaceSubscriptionRepeatSchedule(app core.App, record *core.Record, settings appSettings, now time.Time) error {
	userID := record.GetString("user")
	if !record.GetBool("repeatReminderEnabled") {
		_, err := app.DB().NewQuery("DELETE FROM subscription_repeat_schedule WHERE user_id = {:user} AND subscription_id = {:id}").
			Bind(dbx.Params{"user": userID, "id": record.Id}).Execute()
		return err
	}
	nextDue := nextRepeatNotificationDueAt(now, settings, []notificationSubscription{notificationSubscriptionFromRecord(record)}, false)
	if nextDue == "" {
		_, err := app.DB().NewQuery("DELETE FROM subscription_repeat_schedule WHERE user_id = {:user} AND subscription_id = {:id}").
			Bind(dbx.Params{"user": userID, "id": record.Id}).Execute()
		return err
	}
	_, err := app.DB().NewQuery(`INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
		VALUES ({:user}, {:id}, {:nextDue})
		ON CONFLICT(user_id, subscription_id) DO UPDATE SET next_due_at_utc = excluded.next_due_at_utc`).
		Bind(dbx.Params{"user": userID, "id": record.Id, "nextDue": nextDue}).Execute()
	return err
}

func replaceNotificationSubscriptionRepeatSchedule(
	app core.App,
	userID string,
	subscription notificationSubscription,
	settings appSettings,
	now time.Time,
	skipCurrentWindow bool,
) error {
	nextDue := nextRepeatNotificationDueAt(now, settings, []notificationSubscription{subscription}, skipCurrentWindow)
	if nextDue == "" {
		_, err := app.DB().NewQuery("DELETE FROM subscription_repeat_schedule WHERE user_id = {:user} AND subscription_id = {:id}").
			Bind(dbx.Params{"user": userID, "id": subscription.ID}).Execute()
		return err
	}
	_, err := app.DB().NewQuery(`INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
		VALUES ({:user}, {:id}, {:nextDue})
		ON CONFLICT(user_id, subscription_id) DO UPDATE SET next_due_at_utc = excluded.next_due_at_utc`).
		Bind(dbx.Params{"user": userID, "id": subscription.ID, "nextDue": nextDue}).Execute()
	return err
}

func applySubscriptionStatsDelta(app core.App, userID string, before *core.Record, after *core.Record, now time.Time) error {
	delta, err := subscriptionderived.Between(subscriptionDerivedSnapshot(before), subscriptionDerivedSnapshot(after), userID)
	if err != nil {
		return err
	}
	timestamp := now.UTC().Format(time.RFC3339Nano)
	result, err := app.DB().NewQuery(`UPDATE subscription_user_stats SET
		total_count = total_count + {:total}, trial_count = trial_count + {:trial},
		active_count = active_count + {:active}, expired_count = expired_count + {:expired},
		paused_count = paused_count + {:paused}, cancelled_count = cancelled_count + {:cancelled}, updated_at = {:now}
		WHERE user_id = {:user}`).
		Bind(dbx.Params{"user": userID, "total": delta.Total, "trial": delta.Trial, "active": delta.Active,
			"expired": delta.Expired, "paused": delta.Paused, "cancelled": delta.Cancelled, "now": timestamp}).Execute()
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 1 {
		return nil
	}
	// 只有账号的第一条 create 可以从零建立 stats；其他缺行说明派生缓存损坏，必须回滚而不是用 delta 伪造全量值。
	if before != nil || after == nil || delta.Total != 1 {
		return errors.New("SUBSCRIPTION_DERIVED_STATS_MISSING")
	}
	hasOther, err := subscriptionHasOtherFact(app, userID, after.Id)
	if err != nil {
		return err
	}
	if hasOther {
		return errors.New("SUBSCRIPTION_DERIVED_STATS_MISSING")
	}
	_, err = app.DB().NewQuery(`INSERT INTO subscription_user_stats (
		user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
	) VALUES ({:user}, {:total}, {:trial}, {:active}, {:expired}, {:paused}, {:cancelled}, {:now}, {:now})`).
		Bind(dbx.Params{"user": userID, "total": delta.Total, "trial": delta.Trial, "active": delta.Active,
			"expired": delta.Expired, "paused": delta.Paused, "cancelled": delta.Cancelled, "now": timestamp}).Execute()
	return err
}

func subscriptionHasOtherFact(app core.App, userID string, excludedID string) (bool, error) {
	var row struct {
		Value int `db:"value"`
	}
	err := app.DB().NewQuery(`SELECT 1 AS value FROM subscriptions
		WHERE user = {:user} AND id != {:id} LIMIT 1`).Bind(dbx.Params{"user": userID, "id": excludedID}).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func replaceSubscriptionStats(app core.App, userID string, stats subscriptionStats, now time.Time) error {
	timestamp := now.UTC().Format(time.RFC3339Nano)
	_, err := app.DB().NewQuery(`INSERT INTO subscription_user_stats (
		user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
	) VALUES ({:user}, {:total}, {:trial}, {:active}, {:expired}, {:paused}, {:cancelled}, {:now}, {:now})
	ON CONFLICT(user_id) DO UPDATE SET total_count = excluded.total_count, trial_count = excluded.trial_count,
		active_count = excluded.active_count, expired_count = excluded.expired_count, paused_count = excluded.paused_count,
		cancelled_count = excluded.cancelled_count, updated_at = excluded.updated_at`).Bind(dbx.Params{
		"user": userID, "total": stats.Total, "trial": stats.ByStatus["trial"], "active": stats.ByStatus["active"],
		"expired": stats.ByStatus["expired"], "paused": stats.ByStatus["paused"], "cancelled": stats.ByStatus["cancelled"], "now": timestamp,
	}).Execute()
	return err
}

func getSubscriptionStats(app core.App, userID string) (subscriptionStats, error) {
	stats := newSubscriptionStats()
	var row struct {
		Total     int `db:"total_count"`
		Trial     int `db:"trial_count"`
		Active    int `db:"active_count"`
		Expired   int `db:"expired_count"`
		Paused    int `db:"paused_count"`
		Cancelled int `db:"cancelled_count"`
	}
	err := app.DB().NewQuery(`SELECT total_count, trial_count, active_count, expired_count, paused_count, cancelled_count
		FROM subscription_user_stats WHERE user_id = {:user} LIMIT 1`).Bind(dbx.Params{"user": userID}).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return stats, nil
	}
	if err != nil {
		return stats, err
	}
	stats.Total = row.Total
	stats.ByStatus["trial"] = row.Trial
	stats.ByStatus["active"] = row.Active
	stats.ByStatus["expired"] = row.Expired
	stats.ByStatus["paused"] = row.Paused
	stats.ByStatus["cancelled"] = row.Cancelled
	return stats, nil
}

func getSubscriptionRecordsByIDs(app core.App, userID string, ids []string) ([]*core.Record, error) {
	if len(ids) == 0 {
		return []*core.Record{}, nil
	}
	// 原生 IN 避免 5000 条 index 成功路径生成超深 OR 表达式；owner 条件仍在同一 SQL 中，返回后再按投影 ID 复原顺序。
	records, err := app.FindRecordsByIds("subscriptions", ids, func(query *dbx.SelectQuery) error {
		query.AndWhere(dbx.NewExp("subscriptions.user = {:user}", dbx.Params{"user": userID}))
		return nil
	})
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*core.Record, len(records))
	for _, record := range records {
		byID[record.Id] = record
	}
	ordered := make([]*core.Record, 0, len(ids))
	for _, id := range ids {
		if record := byID[id]; record != nil {
			ordered = append(ordered, record)
		}
	}
	return ordered, nil
}

func newSubscriptionStats() subscriptionStats {
	return subscriptionStats{ByStatus: map[string]int{"trial": 0, "active": 0, "expired": 0, "paused": 0, "cancelled": 0}}
}

func subscriptionRecordOwner(record *core.Record) string {
	if record == nil {
		return ""
	}
	return record.GetString("user")
}

func subscriptionDerivedSnapshot(record *core.Record) *subscriptionderived.Snapshot {
	if record == nil {
		return nil
	}
	return &subscriptionderived.Snapshot{
		UserID:                subscriptionRecordOwner(record),
		Status:                record.GetString("status"),
		AutoRenew:             record.GetBool("autoRenew"),
		RepeatReminderEnabled: record.GetBool("repeatReminderEnabled"),
	}
}

func uniqueNonEmptyStrings(values ...string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func subscriptionSearchTextLower(record *core.Record, tags []string) string {
	values := []string{record.GetString("name"), record.GetString("website"), record.GetString("notes")}
	values = append(values, tags...)
	return strings.ToLower(strings.Join(values, "\n"))
}

func projectionRecordTimeString(record *core.Record, field string) string {
	value := record.GetDateTime(field)
	if value.IsZero() {
		return ""
	}
	// 列表 cursor 与 Public API 共用 PocketBase DateTime 字符串排序；投影表必须保存同一格式，避免第二页游标被全量过滤。
	return value.String()
}

func boolToSQLiteInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
