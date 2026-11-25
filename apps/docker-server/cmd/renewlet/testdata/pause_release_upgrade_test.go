package main

import (
	"os"
	"path/filepath"
	"strings"
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
	records := []struct {
		id, status, category string
		pinned               bool
	}{
		{"releasedactive1", "active", "productivity", true},
		{"releasedpaused1", "paused", "legacy-tools", false},
	}
	seed := os.Getenv("RENEWLET_TEST_PAUSE_PHASE") == "seed"
	if seed {
		user, _ := createRouteTestUser(t, app, "release-upgrade")
		createTestTOTPCredential(t, app, user.Id)
		createTestPasskeyCredential(t, app, user.Id)
		token, _, _, err := createAppSession(app, user.Id)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "upgrade-test-session"), []byte(token), 0600); err != nil {
			t.Fatal(err)
		}
		for _, record := range records {
			createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
				"id": record.id, "name": record.status, "status": record.status, "category": record.category, "pinned": record.pinned,
				"startDate": "2026-01-01", "nextBillingDate": "2099-01-01", "autoCalculateNextBillingDate": false,
				"autoRenew": false, "repeatReminderEnabled": true, "reminderDays": 3,
			})
		}
	}
	user, err := app.FindAuthRecordByEmail("users", "admin-release-upgrade@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !user.ValidatePassword("password123") || user.GetString("role") != "user" {
		t.Fatal("existing account changed")
	}
	seedRecord, err := app.FindFirstRecordByData("mfa_totp_credentials", "user", user.Id)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := decryptMFASecret(app, seedRecord.GetString("secretCiphertext"))
	if err != nil || secret != testTOTPSecret {
		t.Fatal("existing MFA credential did not decrypt")
	}
	passkey, err := app.FindFirstRecordByData("passkey_credentials", "user", user.Id)
	if err != nil || passkey.GetString("credentialId") != "test-passkey-"+user.Id || passkey.GetString("publicKey") != "AA" {
		t.Fatal("existing passkey changed")
	}
	saved, err := os.ReadFile(filepath.Join(dir, "upgrade-test-session"))
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := appAuthRecordByToken(app, string(saved))
	if err != nil || owner == nil || owner.Id != user.Id {
		t.Fatal("existing cookie session changed")
	}
	if !seed {
		status := serveTestRequest(t, app, "GET", "/api/app/auth/options", "", "")
		if status.Code != 200 || !strings.Contains(status.Body.String(), `"oidc":false`) {
			t.Fatal("upgraded site should start with OIDC disabled")
		}
		for _, name := range []string{"oidc_links", "oidc_flows"} {
			rows, err := app.FindAllRecords(name)
			if err != nil || len(rows) != 0 {
				t.Fatalf("unexpected %s after upgrade", name)
			}
		}
	}
	for _, want := range records {
		query := subscriptionListQuery{Categories: []string{want.category}}
		page, exceeded, err := boundedSubscriptionRecordsForQuery(app, user.Id, query, "2026-01-01", subscriptionCollectionLimit)
		if err != nil || exceeded || page.Total != 1 || len(page.Rows) != 1 {
			t.Fatalf("category %q: total=%d rows=%d exceeded=%v error=%v", want.category, page.Total, len(page.Rows), exceeded, err)
		}
		got := subscriptionCollectionAPIFromRecord(page.Rows[0])
		if got.ID != want.id || got.Category != want.category || got.Pinned != want.pinned {
			t.Fatalf("category %q: id=%q category=%q pinned=%v", want.category, got.ID, got.Category, got.Pinned)
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
