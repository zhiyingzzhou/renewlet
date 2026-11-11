package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func sharedRestartFixture(t *testing.T) (core.App, *core.Record, string, map[string]interface{}) {
	t.Helper()
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "restart-member-dates")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Shared Netflix", "status": "active", "autoRenew": false,
		"startDate": "2026-01-01", "nextBillingDate": "2027-01-01", "autoCalculateNextBillingDate": false,
		"balance": "0", "balanceCurrency": "JPY", "costSharing": json.RawMessage(`{
			"enabled":true,"splitMode":"custom","collectionReminder":{"enabled":true,"reminderDays":3},"members":[
			{"id":"old","name":"旧成员","joinedDate":"2026-01-31","currency":"JPY","customAmount":"0","note":"keep"},
			{"id":"inside","name":"区间内","joinedDate":"2026-11-10","customAmount":"2"},
			{"id":"after","name":"区间外","joinedDate":"2027-01-01","customAmount":"3"},
			{"id":"inherited","name":"继承","customAmount":"4"}]}`),
	})
	body := map[string]interface{}{
		"mode": "restart", "price": "10", "currency": "EUR", "startDate": "2026-11-07", "nextBillingDate": "2026-12-07",
		"autoCalculateNextBillingDate": true,
		"costSharingMemberJoinedDates": []map[string]string{{"id": "old", "joinedDate": "2026-11-07"}, {"id": "after", "joinedDate": "2026-12-07"}},
	}
	return app, record, token, body
}

func TestSharedRestartConfirmsDatesAndPreservesOtherFacts(t *testing.T) {
	app, record, token, body := sharedRestartFixture(t)
	original, _ := costSharingPayloadFromValue(record.Get("costSharing"))
	data, _ := json.Marshal(body)
	payload := renewBodyWithVersion(t, record, string(data))
	path := "/api/app/subscriptions/" + record.Id + "/renew"
	response := serveTestRequest(t, app, http.MethodPost, path, payload, token)
	if response.Code != 200 {
		t.Fatalf("restart: %d %s", response.Code, response.Body.String())
	}
	saved, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	original.Members[0].JoinedDate = "2026-11-07"
	original.Members[2].JoinedDate = "2026-12-07"
	actual, _ := costSharingPayloadFromValue(saved.Get("costSharing"))
	if !reflect.DeepEqual(actual, original) {
		t.Fatalf("other sharing facts changed: %#v", actual)
	}
	if saved.GetString("balance") != "0" || saved.GetString("balanceCurrency") != "JPY" || saved.GetString("price") != "10" || saved.GetString("startDate") != "2026-11-07" || saved.GetString("nextBillingDate") != "2026-12-07" {
		t.Fatalf("incorrect renewed facts: %#v", subscriptionAPIFromRecord(saved))
	}
	if response := serveTestRequest(t, app, http.MethodPost, path, payload, token); response.Code != 409 {
		t.Fatalf("replay: %d", response.Code)
	}
}

func TestSharedRestartRejectsInvalidConfirmationWithoutPartialSave(t *testing.T) {
	app, record, token, body := sharedRestartFixture(t)
	before, _ := json.Marshal(subscriptionAPIFromRecord(record))
	cases := []struct {
		name    string
		updates interface{}
	}{
		{"missing", nil}, {"empty", []interface{}{}},
		{"unknown", []map[string]string{{"id": "foreign", "joinedDate": "2026-11-07"}}},
		{"partial", []map[string]string{{"id": "old", "joinedDate": "2026-11-07"}}},
		{"before", []map[string]string{{"id": "old", "joinedDate": "2026-11-06"}, {"id": "after", "joinedDate": "2026-12-07"}}},
		{"after", []map[string]string{{"id": "old", "joinedDate": "2026-12-08"}, {"id": "after", "joinedDate": "2026-12-07"}}},
		{"duplicate", []map[string]string{{"id": "old", "joinedDate": "2026-11-07"}, {"id": "old", "joinedDate": "2026-11-07"}}},
		{"extra-field", []map[string]string{{"id": "old", "joinedDate": "2026-11-07", "name": "overwrite"}}},
		{"invalid-date", []map[string]string{{"id": "old", "joinedDate": "2026-02-30"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body["costSharingMemberJoinedDates"] = tc.updates
			if tc.name == "missing" {
				delete(body, "costSharingMemberJoinedDates")
			}
			data, _ := json.Marshal(body)
			response := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+record.Id+"/renew", renewBodyWithVersion(t, record, string(data)), token)
			if response.Code != 400 {
				t.Fatalf("expected rejection: %d %s", response.Code, response.Body.String())
			}
			if tc.name == "missing" && (!strings.Contains(response.Body.String(), "SUBSCRIPTION_RENEW_COST_SHARING_INVALID") || strings.Contains(response.Body.String(), "OUT_OF_RANGE.")) {
				t.Fatalf("missing actionable error: %s", response.Body.String())
			}
			saved, err := app.FindRecordById("subscriptions", record.Id)
			if err != nil {
				t.Fatal(err)
			}
			after, _ := json.Marshal(subscriptionAPIFromRecord(saved))
			if string(before) != string(after) {
				t.Fatal("failed confirmation changed facts")
			}
		})
	}
}

func TestSharedRestartRollsBackMemberDatesAndRejectsStaleMembership(t *testing.T) {
	app, record, token, body := sharedRestartFixture(t)
	path := "/api/app/subscriptions/" + record.Id + "/renew"
	data, _ := json.Marshal(body)
	payload := renewBodyWithVersion(t, record, string(data))
	before, _ := json.Marshal(subscriptionAPIFromRecord(record))
	if _, err := app.DB().NewQuery(`CREATE TRIGGER fail_shared_restart BEFORE UPDATE ON subscription_list_index BEGIN SELECT RAISE(ABORT, 'injected shared restart failure'); END`).Execute(); err != nil {
		t.Fatal(err)
	}
	response := serveTestRequest(t, app, http.MethodPost, path, payload, token)
	if response.Code != 500 {
		t.Fatalf("storage failure: %d %s", response.Code, response.Body.String())
	}
	saved, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(subscriptionAPIFromRecord(saved))
	if string(before) != string(after) {
		t.Fatal("partial restart persisted")
	}
	if _, err := app.DB().NewQuery(`DROP TRIGGER fail_shared_restart`).Execute(); err != nil {
		t.Fatal(err)
	}
	sharing, _ := costSharingPayloadFromValue(saved.Get("costSharing"))
	sharing.Members = sharing.Members[1:]
	saved.Set("costSharing", sharing)
	if err := app.Save(saved); err != nil {
		t.Fatal(err)
	}
	response = serveTestRequest(t, app, http.MethodPost, path, payload, token)
	if response.Code != 409 {
		t.Fatalf("stale membership: %d %s", response.Code, response.Body.String())
	}
}
