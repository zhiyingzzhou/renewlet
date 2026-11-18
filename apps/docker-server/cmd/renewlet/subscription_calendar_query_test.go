package main

import (
	"net/http"
	"reflect"
	"sort"
	"testing"
)

func TestSubscriptionCalendarIncludesRecurringCandidatesWithoutChangingListDateFilters(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "calendar-candidates")
	foreign, _ := createRouteTestUser(t, app, "calendar-foreign")
	cases := []map[string]interface{}{
		{"name": "overdue", "nextBillingDate": "2020-01-31", "startDate": "2019-01-31", "reminderDays": -2},
		{"name": "overdue-trial", "status": "trial", "nextBillingDate": "2026-01-01"},
		{"name": "from", "nextBillingDate": "2026-06-01"},
		{"name": "to", "nextBillingDate": "2026-06-30"},
		{"name": "future", "nextBillingDate": "2026-07-01"},
		{"name": "trial", "status": "trial", "trialEndDate": "2026-06-15", "nextBillingDate": "2026-07-01"},
		{"name": "fixed", "billingCycle": "one-time", "oneTimeTermCount": 1, "oneTimeTermUnit": "month", "nextBillingDate": "2026-06-15"},
		{"name": "past-fixed", "billingCycle": "one-time", "oneTimeTermCount": 1, "oneTimeTermUnit": "month", "nextBillingDate": "2026-05-31"},
		{"name": "buyout", "billingCycle": "one-time", "nextBillingDate": "2026-06-15"},
		{"name": "paused", "status": "paused", "nextBillingDate": "2026-06-15"},
		{"name": "cancelled", "status": "cancelled", "nextBillingDate": "2026-06-15"},
		{"name": "expired", "status": "expired", "nextBillingDate": "2026-06-15"},
	}
	for _, fields := range cases {
		fields["autoRenew"] = false
		fields["autoCalculateNextBillingDate"] = false
		createRouteTestSubscription(t, app, user.Id, fields)
	}
	createRouteTestSubscription(t, app, foreign.Id, map[string]interface{}{"name": "foreign", "nextBillingDate": "2026-06-15", "autoRenew": false})

	for _, test := range []struct {
		path string
		want []string
	}{
		{"/api/app/subscriptions/calendar?from=2026-06-01&to=2026-06-30", []string{"fixed", "from", "overdue", "overdue-trial", "to", "trial"}},
		{"/api/app/subscriptions/index?nextBillingFrom=2026-06-01&nextBillingTo=2026-06-30", []string{"cancelled", "expired", "fixed", "from", "paused", "to", "trial"}},
	} {
		response := serveTestRequest(t, app, http.MethodGet, test.path, "", token)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", test.path, response.Code, response.Body.String())
		}
		body := decodeAPISuccessDataForTest[subscriptionCollectionMapResponse](t, response.Body.Bytes())
		names := make([]string, 0, len(body.Subscriptions))
		for _, item := range body.Subscriptions {
			names = append(names, item["name"].(string))
			if item["name"] == "overdue" && item["nextBillingDate"] != "2020-01-31" {
				t.Fatalf("calendar read changed the saved billing date: %#v", item)
			}
		}
		sort.Strings(names)
		if !reflect.DeepEqual(names, test.want) {
			t.Fatalf("%s names = %v, want %v", test.path, names, test.want)
		}
	}
}
