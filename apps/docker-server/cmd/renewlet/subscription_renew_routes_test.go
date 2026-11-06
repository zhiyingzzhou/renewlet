package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestSubscriptionRenewRouteAdvancesManualSubscription(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "renew")
	today := todayDateOnly(time.Now().UTC(), "UTC")
	originalStartDate := addDateOnly(today, -42)
	originalNextBillingDate := addDateOnly(today, -14)
	expectedNextBillingDate := addDateOnly(today, 7)
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":                         "Manual Renew",
		"balance":                      "0",
		"balanceCurrency":              "JPY",
		"status":                       "expired",
		"billingCycle":                 "weekly",
		"startDate":                    originalStartDate,
		"nextBillingDate":              originalNextBillingDate,
		"autoRenew":                    false,
		"autoCalculateNextBillingDate": false,
	})

	requestBody, err := json.Marshal(map[string]interface{}{
		"mode":                         "continue",
		"price":                        "15.500000",
		"currency":                     "EUR",
		"startDate":                    nil,
		"nextBillingDate":              expectedNextBillingDate,
		"autoCalculateNextBillingDate": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+record.Id+"/renew", renewBodyWithVersion(t, record, string(requestBody)), token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected renew 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[map[string]map[string]interface{}](t, res.Body.Bytes())
	subscription := body["subscription"]
	if subscription["status"] != "active" {
		t.Fatalf("expected expired manual subscription to become active, got %#v", subscription["status"])
	}
	if subscription["nextBillingDate"] != expectedNextBillingDate {
		t.Fatalf("expected continue renewal to advance original anchor, got %#v", subscription)
	}
	if subscription["price"] != "15.5" || subscription["currency"] != "EUR" {
		t.Fatalf("expected continue renewal to update price/currency, got %#v", subscription)
	}
	if subscription["balance"] != "0" || subscription["balanceCurrency"] != "JPY" {
		t.Fatalf("renewal changed balance: %#v", subscription)
	}
	if subscription["autoRenew"] != false {
		t.Fatalf("expected manual renewal to keep autoRenew=false, got %#v", subscription["autoRenew"])
	}
	if _, ok := subscription["user"]; ok {
		t.Fatalf("renew response must not expose owner field: %#v", subscription)
	}
	reloaded, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.GetString("status") != "active" || reloaded.GetString("nextBillingDate") != expectedNextBillingDate || reloaded.GetString("price") != "15.5" || reloaded.GetString("currency") != "EUR" {
		t.Fatalf("expected record to be renewed, status=%s next=%s", reloaded.GetString("status"), reloaded.GetString("nextBillingDate"))
	}
}

func TestSubscriptionRenewRouteRestartsManualSubscription(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "renew-restart")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":                         "Restart Renew",
		"status":                       "expired",
		"startDate":                    "2026-01-01",
		"nextBillingDate":              "2026-02-01",
		"autoRenew":                    false,
		"autoCalculateNextBillingDate": false,
	})

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+record.Id+"/renew", renewBodyWithVersion(t, record, `{
		"mode":"restart",
		"price":"20",
		"currency":"USD",
		"startDate":"2026-08-12",
		"nextBillingDate":"2026-09-12",
		"autoCalculateNextBillingDate":true
	}`), token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected renew restart 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[map[string]map[string]interface{}](t, res.Body.Bytes())
	subscription := body["subscription"]
	if subscription["status"] != "active" || subscription["startDate"] != "2026-08-12" || subscription["nextBillingDate"] != "2026-09-12" {
		t.Fatalf("expected restart renewal to save new dates and active status, got %#v", subscription)
	}
	if subscription["autoCalculateNextBillingDate"] != true {
		t.Fatalf("expected restart renewal to persist autoCalculateNextBillingDate=true, got %#v", subscription)
	}
	reloaded, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.GetString("startDate") != "2026-08-12" || reloaded.GetString("nextBillingDate") != "2026-09-12" || !reloaded.GetBool("autoCalculateNextBillingDate") {
		t.Fatalf("expected restarted record dates to persist, start=%s next=%s auto=%v", reloaded.GetString("startDate"), reloaded.GetString("nextBillingDate"), reloaded.GetBool("autoCalculateNextBillingDate"))
	}
}

func TestSubscriptionRenewRouteRejectsDisallowedSubscriptions(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "renew-reject")
	otherUser, _ := createRouteTestUser(t, app, "renew-other")

	paused := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":      "Paused Manual",
		"status":    "paused",
		"autoRenew": false,
	})
	automatic := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":      "Automatic",
		"autoRenew": true,
	})
	oneTime := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":         "One Time",
		"billingCycle": "one-time",
		"autoRenew":    false,
	})
	foreign := createRouteTestSubscription(t, app, otherUser.Id, map[string]interface{}{
		"name":      "Foreign",
		"autoRenew": false,
	})
	body := `{"mode":"continue","price":"12","currency":"USD","startDate":null,"nextBillingDate":"2026-03-01","autoCalculateNextBillingDate":false}`

	for _, record := range []*core.Record{paused, automatic, oneTime} {
		res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+record.Id+"/renew", renewBodyWithVersion(t, record, body), token)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("expected disallowed subscription %s to return 400, got %d: %s", record.GetString("name"), res.Code, res.Body.String())
		}
	}
	foreignRes := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+foreign.Id+"/renew", renewBodyWithVersion(t, foreign, body), token)
	if foreignRes.Code != http.StatusNotFound {
		t.Fatalf("expected foreign subscription to return 404, got %d: %s", foreignRes.Code, foreignRes.Body.String())
	}
}

func TestSubscriptionRenewRouteRejectsInvalidBody(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "renew-invalid")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":      "Invalid Body Renew",
		"autoRenew": false,
	})

	cases := []string{
		``,
		`{}`,
		`{"mode":"continue","price":"12","currency":"USD","startDate":null,"nextBillingDate":"2026-03-01","autoCalculateNextBillingDate":false,"extra":true}`,
		`{"mode":"restart","price":"12","currency":"USD","startDate":null,"nextBillingDate":"2026-03-01","autoCalculateNextBillingDate":false}`,
		`{"mode":"restart","price":"12","currency":"USD","startDate":"2026-04-01","nextBillingDate":"2026-03-01","autoCalculateNextBillingDate":false}`,
		`{"mode":"continue","price":"1e3","currency":"USD","startDate":null,"nextBillingDate":"2026-03-01","autoCalculateNextBillingDate":false}`,
		`{"mode":"continue","price":"12","currency":"US","startDate":null,"nextBillingDate":"2026-03-01","autoCalculateNextBillingDate":false}`,
		`{"mode":"continue","price":"12","currency":"usd","startDate":null,"nextBillingDate":"2026-03-01","autoCalculateNextBillingDate":false}`,
	}

	for _, body := range cases {
		res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+record.Id+"/renew", renewBodyWithVersion(t, record, body), token)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("expected invalid renew body to return 400, got %d for %q: %s", res.Code, body, res.Body.String())
		}
	}
}

func TestSubscriptionRenewRouteRejectsRestartOutsideCostSharingMemberRange(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "renew-cost-sharing")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Cost Sharing Restart",
		"status":          "expired",
		"startDate":       "2026-01-01",
		"nextBillingDate": "2026-04-01",
		"autoRenew":       false,
		"costSharing": json.RawMessage(`{
			"enabled": true,
			"splitMode": "equal",
			"collectionReminder": {"enabled": true, "reminderDays": -1},
			"members": [{"id": "member-1", "name": "Member", "joinedDate": "2026-03-01"}]
		}`),
	})

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+record.Id+"/renew", renewBodyWithVersion(t, record, `{
		"mode":"restart",
		"price":"20",
		"currency":"USD",
		"startDate":"2026-08-12",
		"nextBillingDate":"2026-09-12",
		"autoCalculateNextBillingDate":true
	}`), token)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected restart outside cost-sharing member range to return 400, got %d: %s", res.Code, res.Body.String())
	}
}

func renewBodyWithVersion(t *testing.T, record *core.Record, body string) string {
	t.Helper()
	var fields map[string]interface{}
	if json.Unmarshal([]byte(body), &fields) != nil {
		return body
	}
	fields["expectedNextBillingDate"] = record.GetString("nextBillingDate")
	fields["expectedUpdatedAt"] = subscriptionAPIFromRecord(record).UpdatedAt
	data, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestSubscriptionRenewVersionAndRollback(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "renew-version")
	today := todayDateOnly(time.Now().UTC(), "UTC")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"status": "trial", "autoRenew": false, "billingCycle": "weekly",
		"startDate": today, "nextBillingDate": addDateOnly(today, 7),
	})
	path := "/api/app/subscriptions/" + record.Id + "/renew"
	body := renewBodyWithVersion(t, record, `{"mode":"continue","price":"0","currency":"EUR","startDate":null,"nextBillingDate":"`+addDateOnly(today, 14)+`","autoCalculateNextBillingDate":false}`)
	first := serveTestRequest(t, app, http.MethodPost, path, body, token)
	if first.Code != 200 {
		t.Fatalf("first renewal: %d %s", first.Code, first.Body.String())
	}
	second := serveTestRequest(t, app, http.MethodPost, path, body, token)
	if second.Code != 409 {
		t.Fatalf("duplicate renewal: %d %s", second.Code, second.Body.String())
	}
	saved, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if saved.GetString("status") != "trial" || saved.GetString("nextBillingDate") != addDateOnly(today, 14) {
		t.Fatal("trial or date changed incorrectly")
	}
	response := decodeAPISuccessDataForTest[map[string]subscriptionDetailResponse](t, first.Body.Bytes())["subscription"]
	if response.UpdatedAt != subscriptionAPIFromRecord(saved).UpdatedAt {
		t.Fatal("save response version differs from stored version")
	}
	stale := renewBodyWithVersion(t, saved, `{"mode":"continue","price":"0","currency":"EUR","startDate":null,"nextBillingDate":"`+addDateOnly(today, 21)+`","autoCalculateNextBillingDate":false}`)
	saved.Set("price", "20")
	if err := app.Save(saved); err != nil {
		t.Fatal(err)
	}
	if res := serveTestRequest(t, app, http.MethodPost, path, stale, token); res.Code != 409 {
		t.Fatalf("price-only stale version: %d %s", res.Code, res.Body.String())
	}
	latest, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	fresh := renewBodyWithVersion(t, latest, `{"mode":"continue","price":"0","currency":"EUR","startDate":null,"nextBillingDate":"`+addDateOnly(today, 21)+`","autoCalculateNextBillingDate":false}`)
	if _, err := app.DB().NewQuery(`CREATE TRIGGER fail_renewal_projection BEFORE UPDATE ON subscription_list_index BEGIN SELECT RAISE(ABORT, 'injected renewal failure'); END`).Execute(); err != nil {
		t.Fatal(err)
	}
	failed := serveTestRequest(t, app, http.MethodPost, path, fresh, token)
	if failed.Code != 500 {
		t.Fatalf("storage failure must not become conflict/validation: %d %s", failed.Code, failed.Body.String())
	}
	after, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if after.GetString("price") != "20" || after.GetString("nextBillingDate") != addDateOnly(today, 14) {
		t.Fatal("partial renewal persisted")
	}
}

func TestSubscriptionRenewConcurrentConfirmations(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "renew-concurrent")
	today := todayDateOnly(time.Now().UTC(), "UTC")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"autoRenew": false, "billingCycle": "weekly", "startDate": today, "nextBillingDate": addDateOnly(today, 7)})
	raw := `{"mode":"continue","price":"12","currency":"USD","startDate":null,"nextBillingDate":"` + addDateOnly(today, 14) + `","autoCalculateNextBillingDate":false}`
	path := "/api/app/subscriptions/" + record.Id + "/renew"
	if response := serveTestRequest(t, app, http.MethodPost, path, raw, token); response.Code != 400 {
		t.Fatalf("legacy unversioned request accepted: %d", response.Code)
	}
	body := renewBodyWithVersion(t, record, raw)
	start := make(chan struct{})
	responses := make(chan int, 2)
	for range 2 {
		go func() { <-start; responses <- serveTestRequest(t, app, http.MethodPost, path, body, token).Code }()
	}
	close(start)
	counts := map[int]int{}
	for range 2 {
		counts[<-responses]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent results: %v", counts)
	}
}
