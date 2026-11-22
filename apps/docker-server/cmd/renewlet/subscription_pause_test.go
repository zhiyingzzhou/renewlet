package main

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
)

func TestSubscriptionPauseAndResume(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	owner, token := createRouteTestUser(t, app, "pause-owner")
	_, otherToken := createRouteTestUser(t, app, "pause-other")
	record := createRouteTestSubscription(t, app, owner.Id, map[string]interface{}{"balance": "0", "balanceCurrency": "JPY", "autoRenew": false, "autoCalculateNextBillingDate": false, "nextBillingDate": "2001-02-01", "startDate": "2001-01-01", "trialEndDate": "2001-01-15"})
	path := "/api/app/subscriptions/" + record.Id
	patch := func(auth string, body string, status int) {
		t.Helper()
		response := serveTestRequest(t, app, http.MethodPatch, path, body, auth)
		if response.Code != status {
			t.Fatalf("want HTTP %d, got %d: %s", status, response.Code, response.Body.String())
		}
	}
	read := func() subscriptionDetailResponse {
		t.Helper()
		row, err := app.FindRecordById("subscriptions", record.Id)
		if err != nil {
			t.Fatal(err)
		}
		return subscriptionAPIFromRecord(row)
	}
	before := read()
	pause := fmt.Sprintf(`{"status":"paused","expectedUpdatedAt":%q}`, before.UpdatedAt)
	patch(token, `{"status":"paused","price":"99"}`, 400)
	patch(otherToken, pause, 404)
	patch(token, pause, 200)
	patch(token, pause, 409)
	paused := read()
	if paused.Status != "paused" || paused.Price != before.Price || paused.NextBillingDate != before.NextBillingDate {
		t.Fatalf("pause changed billing: %#v", paused)
	}
	patch(token, fmt.Sprintf(`{"status":"trial","expectedUpdatedAt":%q,"nextBillingDate":"2099-02-01"}`, paused.UpdatedAt), 400)
	if read().UpdatedAt != paused.UpdatedAt {
		t.Fatal("invalid resume changed version")
	}
	patch(token, fmt.Sprintf(`{"status":"trial","expectedUpdatedAt":%q,"nextBillingDate":"2099-02-01","trialEndDate":"2099-01-30"}`, paused.UpdatedAt), 200)
	if read().Status != "trial" {
		t.Fatal("trial not restored")
	}
}

func TestPausePreservesPendingFamilyCollection(t *testing.T) {
	app, record, token, _ := sharedRestartFixture(t)
	params := dbx.Params{"id": record.Id}
	if _, err := app.DB().NewQuery("UPDATE subscriptions SET costSharingNextCollectionReminderDate='2001-01-01' WHERE id={:id}").Bind(params).Execute(); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"status":"paused","expectedUpdatedAt":%q}`, subscriptionRecordVersion(record))
	response := serveTestRequest(t, app, http.MethodPatch, "/api/app/subscriptions/"+record.Id, body, token)
	if response.Code != http.StatusOK {
		t.Fatalf("pause failed: %s", response.Body.String())
	}
	paused, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !paused.GetBool("costSharingCollectionReminderEnabled") || paused.GetString("costSharingNextCollectionReminderDate") != "2001-01-01" ||
		paused.GetString("costSharing") != record.GetString("costSharing") {
		t.Fatal("pause altered the pending family collection or its configuration")
	}
}

func TestPausedReminderMigrationRetainsUnrelatedOccurrence(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	owner, _ := createRouteTestUser(t, app, "pause-migration")
	paused := createRouteTestSubscription(t, app, owner.Id, map[string]interface{}{"status": "paused", "repeatReminderEnabled": true})
	active := createRouteTestSubscription(t, app, owner.Id, map[string]interface{}{"repeatReminderEnabled": true})
	params := dbx.Params{"owner": owner.Id, "paused": paused.Id, "active": active.Id}
	for _, sql := range []string{
		`DELETE FROM subscription_repeat_schedule WHERE user_id={:owner}`,
		`INSERT INTO subscription_repeat_schedule (user_id,subscription_id,next_due_at_utc) VALUES ({:owner},{:paused},'2026-01-01T00:00:00Z'),({:owner},{:active},'2026-01-02T00:00:00Z')`,
		`UPDATE subscription_scheduler_states SET repeatReminderCount=2,nextRepeatNotificationDueAtUTC='2026-01-01T00:00:00Z' WHERE user={:owner}`,
	} {
		if _, err := app.DB().NewQuery(sql).Bind(params).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := migratePausedReminders(app); err != nil {
			t.Fatal(err)
		}
	}
	var ok int
	err := app.DB().NewQuery(`SELECT COUNT(*) FROM subscription_scheduler_states WHERE user={:owner} AND repeatReminderCount=1
   AND nextRepeatNotificationDueAtUTC='2026-01-02T00:00:00Z' AND NOT EXISTS(SELECT 1 FROM subscription_repeat_schedule WHERE subscription_id={:paused})`).Bind(params).Row(&ok)
	if err != nil || ok != 1 {
		t.Fatalf("unexpected migrated schedule: %d %v", ok, err)
	}
}
