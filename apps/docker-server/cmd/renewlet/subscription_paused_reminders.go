package main

import (
	"errors"

	"github.com/pocketbase/pocketbase/core"
)

// 只移除停用订阅自身的排程。其他订阅可能有待重试的旧 occurrence，不能按升级时刻重算整个账号。
func migratePausedReminders(app core.App) error {
	return app.RunInTransaction(func(tx core.App) error {
		var missing []struct {
			ID string `db:"id"`
		}
		if err := tx.DB().NewQuery(`SELECT id FROM users WHERE NOT EXISTS
			(SELECT 1 FROM subscription_scheduler_states WHERE user = users.id)`).All(&missing); err != nil {
			return err
		}
		for _, user := range missing {
			if _, err := refreshSubscriptionSchedulerStateWithOptions(tx, user.ID, subscriptionSchedulerRefreshOptions{}); err != nil {
				return err
			}
		}
		if _, err := tx.DB().NewQuery(`DELETE FROM subscription_repeat_schedule AS r WHERE EXISTS (
			SELECT 1 FROM subscriptions AS s WHERE s.user = r.user_id AND s.id = r.subscription_id
			AND s.status IN ('paused','cancelled'))`).Execute(); err != nil {
			return err
		}
		const count = `(SELECT COUNT(*) FROM subscriptions s WHERE s.user = a.user
			AND s.repeatReminderEnabled = true AND s.status NOT IN ('paused','cancelled'))`
		const due = `COALESCE((SELECT MIN(next_due_at_utc) FROM subscription_repeat_schedule WHERE user_id = a.user), '')`
		const drift = `a.repeatReminderCount != ` + count + ` OR COALESCE(a.nextRepeatNotificationDueAtUTC, '') != ` + due
		if _, err := tx.DB().NewQuery(`UPDATE subscription_scheduler_states AS a SET repeatReminderCount = ` + count +
			`, nextRepeatNotificationDueAtUTC = ` + due + ` WHERE ` + drift).Execute(); err != nil {
			return err
		}
		var invalid int
		if err := tx.DB().NewQuery(`SELECT EXISTS(SELECT 1 FROM subscription_scheduler_states AS a WHERE ` + drift + `)`).Row(&invalid); err != nil {
			return err
		}
		if invalid != 0 {
			return errors.New("subscription scheduler mismatch after pause migration")
		}
		return nil
	})
}
