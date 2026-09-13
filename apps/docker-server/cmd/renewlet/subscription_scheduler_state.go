package main

// subscription_scheduler_state.go 维护 Cron 的用户级 due-index 和逐订阅 repeat schedule。
// next_* 只负责缩小候选集，最终幂等仍由本地日期规则、lastAutoRenewLocalDate 与 notification job 唯一键保证。

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

const subscriptionSchedulerStatesCollection = "subscription_scheduler_states"

type subscriptionSchedulerState struct {
	AutoRenewCount                 int
	RepeatReminderCount            int
	LastAutoRenewLocalDate         string
	NextAutoRenewCheckAtUTC        string
	NextDailyNotificationDueAtUTC  string
	NextRepeatNotificationDueAtUTC string
}

type subscriptionSchedulerRefreshOptions struct {
	ResetAutoRenewCheck           bool
	Now                           time.Time
	SkipCurrentNotificationWindow bool
}

type subscriptionSchedulerAggregateInput struct {
	AutoRenewCount      int `db:"auto_renew_count"`
	RepeatReminderCount int `db:"repeat_reminder_count"`
}

func getSubscriptionSchedulerState(app core.App, userID string) (subscriptionSchedulerState, error) {
	if userID == "" {
		return subscriptionSchedulerState{}, nil
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err == nil {
		return subscriptionSchedulerStateFromRecord(record), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return subscriptionSchedulerState{}, err
	}
	return refreshSubscriptionSchedulerState(app, userID, false)
}

func refreshSubscriptionSchedulerState(app core.App, userID string, resetAutoRenewCheck bool) (subscriptionSchedulerState, error) {
	return refreshSubscriptionSchedulerStateWithOptions(app, userID, subscriptionSchedulerRefreshOptions{ResetAutoRenewCheck: resetAutoRenewCheck})
}

func refreshSubscriptionSchedulerStateWithOptions(app core.App, userID string, options subscriptionSchedulerRefreshOptions) (subscriptionSchedulerState, error) {
	if userID == "" {
		return subscriptionSchedulerState{}, nil
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	options.Now = now
	var state subscriptionSchedulerState
	// 缺失状态的并发读取不能各自创建一行；计数快照、提醒索引重建与状态写入必须一起提交或回滚。
	// 只使用 txApp，既复用设置/导入的外层事务，也避免持有写事务后又从原 app 申请写连接。
	err := app.RunInTransaction(func(txApp core.App) error {
		counts, err := readSubscriptionSchedulerAggregateInput(txApp, userID)
		if err != nil {
			return err
		}
		settings := schedulerSettingsForUser(txApp, userID)
		// 这个入口只用于缺失状态、设置变化和离线重建；普通订阅 mutation 与通知推进不得调用用户级 schedule rebuild。
		if err := rebuildSubscriptionRepeatScheduleForUser(txApp, userID, settings, now); err != nil {
			return err
		}
		state, err = writeSubscriptionSchedulerAggregate(txApp, userID, counts, options)
		return err
	})
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	return state, nil
}

func readSubscriptionSchedulerAggregateInput(app core.App, userID string) (subscriptionSchedulerAggregateInput, error) {
	var counts subscriptionSchedulerAggregateInput
	err := app.DB().NewQuery(`SELECT
		COALESCE(SUM(CASE WHEN autoRenew = 1 THEN 1 ELSE 0 END), 0) AS auto_renew_count,
		COALESCE(SUM(CASE WHEN repeatReminderEnabled = 1 THEN 1 ELSE 0 END), 0) AS repeat_reminder_count
		FROM subscriptions WHERE user = {:user}`).Bind(dbx.Params{"user": userID}).One(&counts)
	return counts, err
}

func writeSubscriptionSchedulerAggregate(
	app core.App,
	userID string,
	counts subscriptionSchedulerAggregateInput,
	options subscriptionSchedulerRefreshOptions,
) (subscriptionSchedulerState, error) {
	if userID == "" {
		return subscriptionSchedulerState{}, nil
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	collection, err := app.FindCollectionByNameOrId(subscriptionSchedulerStatesCollection)
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return subscriptionSchedulerState{}, err
		}
		record = core.NewRecord(collection)
		record.Set("user", userID)
	}
	lastAutoRenewLocalDate := record.GetString("lastAutoRenewLocalDate")
	if options.ResetAutoRenewCheck {
		// 订阅写入后同一天的自动续订判定必须失效；否则新增过期 autoRenew 项会被 last-date gate 跳到明天。
		lastAutoRenewLocalDate = ""
	}
	settings := schedulerSettingsForUser(app, userID)
	nextRepeat, err := earliestSubscriptionRepeatDue(app, userID)
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	record.Set("autoRenewCount", counts.AutoRenewCount)
	record.Set("repeatReminderCount", counts.RepeatReminderCount)
	record.Set("lastAutoRenewLocalDate", lastAutoRenewLocalDate)
	// next* 字段是 Cron 热路径索引，不是幂等事实源；单用户逻辑和 notification_jobs 唯一键仍负责防重。
	record.Set("nextAutoRenewCheckAtUTC", nextAutoRenewCheckAt(now, settings.Timezone, counts.AutoRenewCount, lastAutoRenewLocalDate))
	record.Set("nextDailyNotificationDueAtUTC", nextDailyNotificationDueAt(now, settings.Timezone, settings.NotificationTimeLocal, options.SkipCurrentNotificationWindow))
	record.Set("nextRepeatNotificationDueAtUTC", nextRepeat)
	if err := app.Save(record); err != nil {
		return subscriptionSchedulerState{}, err
	}
	return subscriptionSchedulerStateFromRecord(record), nil
}

func advanceSubscriptionSchedulerDueState(
	app core.App,
	userID string,
	settings appSettings,
	now time.Time,
	skipCurrentNotificationWindow bool,
	repeatCandidates []notificationSubscription,
) (subscriptionSchedulerState, error) {
	if userID == "" {
		return subscriptionSchedulerState{}, nil
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return refreshSubscriptionSchedulerStateWithOptions(app, userID, subscriptionSchedulerRefreshOptions{
				Now:                           now,
				SkipCurrentNotificationWindow: skipCurrentNotificationWindow,
			})
		}
		return subscriptionSchedulerState{}, err
	}
	for _, candidate := range repeatCandidates {
		if err := replaceNotificationSubscriptionRepeatSchedule(app, userID, candidate, settings, now); err != nil {
			return subscriptionSchedulerState{}, err
		}
	}
	nextRepeat, err := earliestSubscriptionRepeatDue(app, userID)
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	// 通知运行时只推进两个 due 索引；订阅计数由 mutation delta 维护，不能在每分钟 Cron 中回扫事实表。
	record.Set("nextDailyNotificationDueAtUTC", nextDailyNotificationDueAt(now, settings.Timezone, settings.NotificationTimeLocal, skipCurrentNotificationWindow))
	record.Set("nextRepeatNotificationDueAtUTC", nextRepeat)
	if err := app.Save(record); err != nil {
		return subscriptionSchedulerState{}, err
	}
	return subscriptionSchedulerStateFromRecord(record), nil
}

func applySubscriptionSchedulerDelta(app core.App, userID string, before *core.Record, after *core.Record, now time.Time) (subscriptionSchedulerState, error) {
	// stats 与 scheduler 共用同一份 before/after 投影，避免两个 aggregate 对 autoRenew/repeat 状态产生不同解释。
	delta, err := subscriptionderived.Between(subscriptionDerivedSnapshot(before), subscriptionDerivedSnapshot(after), userID)
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	collection, err := app.FindCollectionByNameOrId(subscriptionSchedulerStatesCollection)
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return subscriptionSchedulerState{}, err
		}
		if before != nil || after == nil {
			return subscriptionSchedulerState{}, errors.New("SUBSCRIPTION_DERIVED_SCHEDULER_MISSING")
		}
		hasOther, lookupErr := subscriptionHasOtherFact(app, userID, after.Id)
		if lookupErr != nil {
			return subscriptionSchedulerState{}, lookupErr
		}
		if hasOther {
			return subscriptionSchedulerState{}, errors.New("SUBSCRIPTION_DERIVED_SCHEDULER_MISSING")
		}
		record = core.NewRecord(collection)
		record.Set("user", userID)
	}
	autoRenewCount := record.GetInt("autoRenewCount") + delta.AutoRenew
	repeatReminderCount := record.GetInt("repeatReminderCount") + delta.RepeatReminder
	if autoRenewCount < 0 || repeatReminderCount < 0 {
		return subscriptionSchedulerState{}, errors.New("SUBSCRIPTION_DERIVED_SCHEDULER_INVALID")
	}
	settings := schedulerSettingsForUser(app, userID)
	nextRepeat, err := earliestSubscriptionRepeatDue(app, userID)
	if err != nil {
		return subscriptionSchedulerState{}, err
	}
	// mutation 与事实行处于同一 PocketBase transaction；派生失败必须让订阅保存一起回滚。
	record.Set("autoRenewCount", autoRenewCount)
	record.Set("repeatReminderCount", repeatReminderCount)
	record.Set("lastAutoRenewLocalDate", "")
	record.Set("nextAutoRenewCheckAtUTC", nextAutoRenewCheckAt(now, settings.Timezone, autoRenewCount, ""))
	record.Set("nextDailyNotificationDueAtUTC", nextDailyNotificationDueAt(now, settings.Timezone, settings.NotificationTimeLocal, false))
	record.Set("nextRepeatNotificationDueAtUTC", nextRepeat)
	if err := app.Save(record); err != nil {
		return subscriptionSchedulerState{}, err
	}
	return subscriptionSchedulerStateFromRecord(record), nil
}

func rebuildSubscriptionRepeatScheduleForUser(app core.App, userID string, settings appSettings, now time.Time) error {
	// 这是用户级破坏性重建，只能由设置时区/提醒规则变化、迁移或离线修复触发。
	if _, err := app.DB().NewQuery("DELETE FROM subscription_repeat_schedule WHERE user_id = {:user}").Bind(dbx.Params{"user": userID}).Execute(); err != nil {
		return err
	}
	for offset := 0; ; offset += notificationSubscriptionPageSize {
		records, err := app.FindRecordsByFilter("subscriptions", "user = {:user} && repeatReminderEnabled = true", "id", notificationSubscriptionPageSize, offset, dbx.Params{"user": userID})
		if err != nil {
			return err
		}
		for _, record := range records {
			if err := replaceSubscriptionRepeatSchedule(app, record, settings, now); err != nil {
				return err
			}
		}
		if len(records) < notificationSubscriptionPageSize {
			return nil
		}
	}
}

func earliestSubscriptionRepeatDue(app core.App, userID string) (string, error) {
	var row struct {
		NextDue string `db:"next_due_at_utc"`
	}
	err := app.DB().NewQuery(`SELECT next_due_at_utc FROM subscription_repeat_schedule
		WHERE user_id = {:user} ORDER BY next_due_at_utc ASC, subscription_id ASC LIMIT 1`).Bind(dbx.Params{"user": userID}).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return row.NextDue, err
}

func markSubscriptionAutoRenewChecked(app core.App, userID string, localDate string) error {
	state, err := getSubscriptionSchedulerState(app, userID)
	if err != nil {
		return err
	}
	record, err := app.FindFirstRecordByFilter(subscriptionSchedulerStatesCollection, "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		return err
	}
	if state.LastAutoRenewLocalDate == localDate {
		return nil
	}
	record.Set("lastAutoRenewLocalDate", localDate)
	record.Set("nextAutoRenewCheckAtUTC", nextAutoRenewCheckAfterLocalDate(localDate, schedulerSettingsForUser(app, userID).Timezone))
	return app.Save(record)
}

func subscriptionSchedulerStateFromRecord(record *core.Record) subscriptionSchedulerState {
	return subscriptionSchedulerState{
		AutoRenewCount:                 record.GetInt("autoRenewCount"),
		RepeatReminderCount:            record.GetInt("repeatReminderCount"),
		LastAutoRenewLocalDate:         record.GetString("lastAutoRenewLocalDate"),
		NextAutoRenewCheckAtUTC:        record.GetString("nextAutoRenewCheckAtUTC"),
		NextDailyNotificationDueAtUTC:  record.GetString("nextDailyNotificationDueAtUTC"),
		NextRepeatNotificationDueAtUTC: record.GetString("nextRepeatNotificationDueAtUTC"),
	}
}

func listAutoRenewDueUserIDs(app core.App, now time.Time, limit int) ([]string, error) {
	return listSchedulerDueUserIDs(app, "s.autoRenewCount > 0 AND (s.nextAutoRenewCheckAtUTC = '' OR s.nextAutoRenewCheckAtUTC <= {:now})", now, limit, "s.nextAutoRenewCheckAtUTC ASC, s.user ASC", nil)
}

func listNotificationDueUserIDsExcluding(app core.App, now time.Time, limit int, excludeUserIDs map[string]struct{}) ([]string, error) {
	filter := "(s.nextDailyNotificationDueAtUTC = '' OR s.nextDailyNotificationDueAtUTC <= {:now} OR (s.repeatReminderCount > 0 AND (s.nextRepeatNotificationDueAtUTC = '' OR s.nextRepeatNotificationDueAtUTC <= {:now})))"
	return listSchedulerDueUserIDs(app, filter, now, limit, "s.nextDailyNotificationDueAtUTC ASC, s.nextRepeatNotificationDueAtUTC ASC, s.user ASC", excludeUserIDs)
}

func listSchedulerDueUserIDs(app core.App, filter string, now time.Time, limit int, sortOrder string, excludeUserIDs map[string]struct{}) ([]string, error) {
	if limit <= 0 {
		limit = subscriptionRenewalMaintenancePageSize
	}
	var rows []struct {
		UserID string `db:"user"`
	}
	params := dbx.Params{"now": now.UTC().Format(time.RFC3339), "limit": limit}
	excludeClause := schedulerExcludeClause(params, excludeUserIDs)
	demoClause := ""
	if demoModePolicy.Enabled() {
		demoClause = " AND lower(u.email) != lower({:demoEmail})"
		params["demoEmail"] = demoModePolicy.Email
	}
	// due-index 枚举走内部 SQL join：banned/demo/本 tick seen 用户在数据库层过滤，避免一页保留 due 的用户饿住后续候选。
	err := app.DB().NewQuery(fmt.Sprintf(`SELECT s.user AS user
		FROM subscription_scheduler_states AS s
		JOIN users AS u ON u.id = s.user
		WHERE u.banned = 0%s AND %s%s
		ORDER BY %s
		LIMIT {:limit}`, demoClause, filter, excludeClause, sortOrder)).
		Bind(params).
		All(&rows)
	if err != nil {
		return nil, err
	}
	userIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		userID := row.UserID
		if userID == "" || demoModePolicy.IsUserID(app, userID) {
			continue
		}
		userIDs = append(userIDs, userID)
	}
	return userIDs, nil
}

func schedulerExcludeClause(params dbx.Params, excludeUserIDs map[string]struct{}) string {
	if len(excludeUserIDs) == 0 {
		return ""
	}
	ids := make([]string, 0, len(excludeUserIDs))
	for id := range excludeUserIDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	if len(ids) == 0 {
		return ""
	}
	// exclude 列表来自本 tick 内存状态，也必须走 dbx 占位参数；排序只为让 SQL 和测试输出稳定。
	sort.Strings(ids)
	placeholders := make([]string, len(ids))
	for i, id := range ids {
		key := fmt.Sprintf("excludeUser%d", i)
		placeholders[i] = "{:" + key + "}"
		params[key] = id
	}
	return " AND s.user NOT IN (" + strings.Join(placeholders, ", ") + ")"
}

func schedulerSettingsForUser(app core.App, userID string) appSettings {
	user, err := app.FindRecordById("users", userID)
	if err != nil {
		return defaultAppSettings()
	}
	settings, err := currentUserSettings(app, user)
	if err != nil {
		return defaultAppSettings()
	}
	return settings
}

func nextAutoRenewCheckAt(now time.Time, timezone string, autoRenewCount int, lastAutoRenewLocalDate string) string {
	if autoRenewCount <= 0 {
		return ""
	}
	today := todayDateOnly(now, timezone)
	if lastAutoRenewLocalDate != today {
		return now.UTC().Format(time.RFC3339)
	}
	return nextAutoRenewCheckAfterLocalDate(today, timezone)
}

func nextAutoRenewCheckAfterLocalDate(localDate string, timezone string) string {
	return scheduleLocalDateTimeUTC(addDateOnly(localDate, 1), "00:00", timezone)
}

func nextDailyNotificationDueAt(now time.Time, timezone string, localTime string, skipCurrentWindow bool) string {
	if skipCurrentWindow {
		return getNextLocalScheduleOccurrence(now, timezone, localTime).ScheduledInstantUTC
	}
	current := getLocalScheduleDecision(now, timezone, localTime, maxInt(envInt("NOTIFICATION_CRON_WINDOW_MINUTES", 2), 0), false)
	if current.Due {
		return current.ScheduledInstantUTC
	}
	return getNextLocalScheduleOccurrence(now, timezone, localTime).ScheduledInstantUTC
}

func nextRepeatNotificationDueAt(now time.Time, settings appSettings, subscriptions []notificationSubscription) string {
	if len(subscriptions) == 0 {
		return ""
	}
	current := getRepeatScheduleDecision(now, settings, subscriptions, maxInt(envInt("NOTIFICATION_CRON_WINDOW_MINUTES", 2), 0))
	if current.Due {
		return current.ScheduledInstantUTC
	}
	if next, ok := getNextRepeatScheduleOccurrence(now, settings, subscriptions); ok {
		return next.ScheduledInstantUTC
	}
	return ""
}

func scheduleLocalDateTimeUTC(localDate string, localTime string, timezone string) string {
	instant, err := getScheduleInstant(localDate, localTime, timezone)
	if err != nil {
		return time.Now().UTC().Format(time.RFC3339)
	}
	return instant.Format(time.RFC3339)
}
