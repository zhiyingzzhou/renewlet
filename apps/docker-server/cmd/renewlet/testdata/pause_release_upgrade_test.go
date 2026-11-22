package main

import (
	"os"
	"testing"

	"github.com/pocketbase/pocketbase"
)

// 同一测试文件分别由固定发布版本和当前版本编译。交接物是关停后的完整 PocketBase 数据目录。
func TestReleasedPauseDatabaseUpgrade(t *testing.T) {
	dir := os.Getenv("RENEWLET_TEST_PAUSE_DATA")
	if dir == "" {
		t.Fatal("missing isolated fixture directory")
	}
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dir})
	registerAuthHooks(app)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.ResetBootstrapState(); err != nil {
			t.Error(err)
		}
	})
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	seed := os.Getenv("RENEWLET_TEST_PAUSE_PHASE") == "seed"
	if seed {
		user, _ := createRouteTestUser(t, app, "release-upgrade")
		for _, status := range []string{"active", "paused"} {
			createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
				"name": status, "status": status, "startDate": "2026-01-01", "nextBillingDate": "2099-01-01", "autoCalculateNextBillingDate": false,
				"autoRenew": false, "repeatReminderEnabled": true, "reminderDays": 3,
			})
		}
	}
	var subscriptions, schedules, retained int
	if err := app.DB().NewQuery(`SELECT COUNT(*) FROM subscriptions WHERE status IN ('paused','active') AND repeatReminderEnabled=1 AND nextBillingDate='2099-01-01'`).Row(&subscriptions); err != nil {
		t.Fatal(err)
	}
	if err := app.DB().NewQuery(`SELECT COUNT(*) FROM subscription_repeat_schedule`).Row(&schedules); err != nil {
		t.Fatal(err)
	}
	if err := app.DB().NewQuery(`SELECT COUNT(*) FROM subscription_repeat_schedule r JOIN subscriptions s ON s.id=r.subscription_id WHERE s.status='active'`).Row(&retained); err != nil {
		t.Fatal(err)
	}
	want := 1
	if seed {
		want = 2
	}
	if subscriptions != 2 || retained != 1 || schedules != want {
		t.Fatalf("seed=%v: facts=%d active schedules=%d all schedules=%d", seed, subscriptions, retained, schedules)
	}
	var total int
	if err := app.DB().NewQuery(`SELECT SUM(repeatReminderCount) FROM subscription_scheduler_states`).Row(&total); err != nil || total != want {
		t.Fatalf("repeat count=%d error=%v", total, err)
	}
}
