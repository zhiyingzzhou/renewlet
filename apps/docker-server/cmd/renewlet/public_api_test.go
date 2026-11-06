package main

// Public API 测试保护独立 bearer token、hash 存储、owner 隔离和删除失效边界。
// 这些入口会被 Telegram/CLI/Shortcuts 复用，不能退化成登录 session 或公开页 token 的别名。

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestPublicAPITokenLifecycleAndReadRoutes(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, sessionToken := createRouteTestUser(t, app, "public-api")
	otherUser, otherSessionToken := createRouteTestUser(t, app, "public-api-other")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.Timezone = "UTC"
	createCalendarFeedTestSettings(t, app, user, settings)

	today := todayDateOnly(time.Now().UTC(), "UTC")
	renewalDate := addDateOnly(today, 10)
	trialDate := addDateOnly(today, 5)
	expiryDate := addDateOnly(today, 8)
	renewal := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":                         "Renewal Plan",
		"balance":                      "0",
		"balanceCurrency":              "EUR",
		"status":                       "active",
		"startDate":                    "",
		"nextBillingDate":              renewalDate,
		"autoCalculateNextBillingDate": false,
		"notes":                        "private note stays in the owner DTO",
	})
	trial := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Trial Plan",
		"status":          "trial",
		"trialEndDate":    trialDate,
		"nextBillingDate": addDateOnly(today, 40),
	})
	expiry := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":             "Fixed Term Plan",
		"billingCycle":     "one-time",
		"oneTimeTermCount": 6,
		"oneTimeTermUnit":  "month",
		"status":           "active",
		"nextBillingDate":  expiryDate,
	})
	expiry.Set("autoCalculateNextBillingDate", true)
	if !publicAPISubscriptionFromRecord(expiry).AutoCalculateNextBillingDate {
		t.Fatal("public API mapper must preserve the published autoCalculateNextBillingDate value")
	}
	foreign := createRouteTestSubscription(t, app, otherUser.Id, map[string]interface{}{
		"name":            "Foreign Plan",
		"nextBillingDate": renewalDate,
	})

	invalidCreateRes := serveTestRequest(t, app, http.MethodPost, "/api/app/api-tokens", `{"name":"Telegram","plainToken":"leak"}`, sessionToken)
	if invalidCreateRes.Code != http.StatusBadRequest {
		t.Fatalf("expected strict token create body to reject unknown fields, got %d: %s", invalidCreateRes.Code, invalidCreateRes.Body.String())
	}

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/api-tokens", `{"name":" Telegram Bot "}`, sessionToken)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("expected token create 201, got %d: %s", createRes.Code, createRes.Body.String())
	}
	if createRes.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected token create to be no-store, got %#v", createRes.Header())
	}
	createBody := decodeAPISuccessDataForTest[apiTokenCreateResponse](t, createRes.Body.Bytes())
	if !publicAPITokenRe.MatchString(createBody.PlainToken) {
		t.Fatalf("plainToken does not match public API token shape: %q", createBody.PlainToken)
	}
	if createBody.Token.Name != "Telegram Bot" || createBody.Token.TokenPrefix != createBody.PlainToken[:publicAPITokenPrefixLength] {
		t.Fatalf("unexpected token DTO: %#v", createBody.Token)
	}
	if strings.Contains(createRes.Body.String(), "revokedAt") {
		t.Fatalf("token create response must not expose revoked tombstone field: %s", createRes.Body.String())
	}

	stored, err := app.FindRecordById("api_tokens", createBody.Token.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.GetString("tokenHash") == createBody.PlainToken || stored.GetString("tokenHash") == "" {
		t.Fatalf("database must store token hash only, got %q", stored.GetString("tokenHash"))
	}
	if stored.GetString("tokenPrefix") != createBody.PlainToken[:publicAPITokenPrefixLength] {
		t.Fatalf("unexpected stored prefix: %q", stored.GetString("tokenPrefix"))
	}
	if stored.GetString("lastUsedAt") != "" {
		t.Fatalf("new token should start unused: last=%q", stored.GetString("lastUsedAt"))
	}

	listRes := serveTestRequest(t, app, http.MethodGet, "/api/app/api-tokens", "", sessionToken)
	if listRes.Code != http.StatusOK {
		t.Fatalf("expected token list 200, got %d: %s", listRes.Code, listRes.Body.String())
	}
	if strings.Contains(listRes.Body.String(), createBody.PlainToken) || strings.Contains(listRes.Body.String(), stored.GetString("tokenHash")) {
		t.Fatalf("token list leaked plain token or hash: %s", listRes.Body.String())
	}

	for _, target := range []string{"/api/public/v1/me", "/api/public/v1/me?api_token=" + createBody.PlainToken} {
		res := serveTestRequest(t, app, http.MethodGet, target, "", sessionToken)
		if res.Code != http.StatusUnauthorized {
			t.Fatalf("expected session/query token to be rejected for %s, got %d: %s", target, res.Code, res.Body.String())
		}
	}

	publicToken := "Bearer " + createBody.PlainToken
	meRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/me", "", publicToken)
	if meRes.Code != http.StatusOK || !strings.Contains(meRes.Body.String(), `"scopes":["read"]`) {
		t.Fatalf("expected public me 200, got %d: %s", meRes.Code, meRes.Body.String())
	}
	if meRes.Header().Get("Cache-Control") != "no-store" || meRes.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("expected public API no-store/nosniff headers, got %#v", meRes.Header())
	}
	used, err := app.FindRecordById("api_tokens", createBody.Token.ID)
	if err != nil {
		t.Fatal(err)
	}
	if used.GetString("lastUsedAt") == "" {
		t.Fatal("expected public API request to update lastUsedAt")
	}
	firstLastUsedAt := used.GetString("lastUsedAt")
	freshAuditRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/status", "", publicToken)
	if freshAuditRes.Code != http.StatusOK {
		t.Fatalf("expected fresh public API status 200, got %d: %s", freshAuditRes.Code, freshAuditRes.Body.String())
	}
	freshUsed, err := app.FindRecordById("api_tokens", createBody.Token.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := freshUsed.GetString("lastUsedAt"); got != firstLastUsedAt {
		t.Fatalf("fresh public API request must not rewrite lastUsedAt, before=%q after=%q", firstLastUsedAt, got)
	}
	staleLastUsedAt := time.Now().UTC().Add(-auditTouchInterval - time.Minute).Format(time.RFC3339Nano)
	freshUsed.Set("lastUsedAt", staleLastUsedAt)
	if err := app.Save(freshUsed); err != nil {
		t.Fatal(err)
	}
	staleAuditRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/status", "", publicToken)
	if staleAuditRes.Code != http.StatusOK {
		t.Fatalf("expected stale public API status 200, got %d: %s", staleAuditRes.Code, staleAuditRes.Body.String())
	}
	staleUsed, err := app.FindRecordById("api_tokens", createBody.Token.ID)
	if err != nil {
		t.Fatal(err)
	}
	if staleUsed.GetString("lastUsedAt") == staleLastUsedAt {
		t.Fatalf("stale public API request should refresh lastUsedAt, still %q", staleUsed.GetString("lastUsedAt"))
	}

	listPublicRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/subscriptions?limit=1", "", publicToken)
	if listPublicRes.Code != http.StatusOK {
		t.Fatalf("expected public subscriptions 200, got %d: %s", listPublicRes.Code, listPublicRes.Body.String())
	}
	listBody := decodeAPISuccessDataForTest[publicAPISubscriptionsResponse](t, listPublicRes.Body.Bytes())
	if listBody.Total != 3 || len(listBody.Subscriptions) != 1 || listBody.NextCursor == nil {
		t.Fatalf("unexpected paged subscriptions response: %#v", listBody)
	}
	if strings.Contains(listPublicRes.Body.String(), `"user"`) {
		t.Fatalf("public API subscription DTO must not expose owner relation: %#v", listBody.Subscriptions[0])
	}
	if _, err := parsePublicSubscriptionCursorPayload(*listBody.NextCursor); err != nil {
		t.Fatalf("public API must keep the legacy created/id cursor: %v", err)
	}
	nextPublicRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/subscriptions?limit=1&cursor="+url.QueryEscape(*listBody.NextCursor), "", publicToken)
	if nextPublicRes.Code != http.StatusOK {
		t.Fatalf("expected public API legacy cursor to remain readable, got %d: %s", nextPublicRes.Code, nextPublicRes.Body.String())
	}

	listAllRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/subscriptions?limit=3", "", publicToken)
	if listAllRes.Code != http.StatusOK {
		t.Fatalf("expected full public subscriptions 200, got %d: %s", listAllRes.Code, listAllRes.Body.String())
	}
	listAllBody := decodeAPISuccessDataForTest[publicAPISubscriptionsResponse](t, listAllRes.Body.Bytes())
	if !publicAPITestListContainsStartDateNull(listAllBody.Subscriptions, renewal.Id) {
		t.Fatalf("expected public API list to preserve startDate null, got %#v", listAllBody.Subscriptions)
	}

	detailRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/subscriptions/"+renewal.Id, "", publicToken)
	if detailRes.Code != http.StatusOK || !strings.Contains(detailRes.Body.String(), `"name":"Renewal Plan"`) {
		t.Fatalf("expected own subscription detail 200, got %d: %s", detailRes.Code, detailRes.Body.String())
	}
	detailBody := decodeAPISuccessDataForTest[publicAPISubscriptionEnvelope](t, detailRes.Body.Bytes())
	if detailBody.Subscription.StartDate != nil {
		t.Fatalf("expected public subscription detail to preserve startDate null, got %#v", detailBody.Subscription)
	}
	foreignRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/subscriptions/"+foreign.Id, "", publicToken)
	if foreignRes.Code != http.StatusNotFound {
		t.Fatalf("expected foreign subscription detail 404, got %d: %s", foreignRes.Code, foreignRes.Body.String())
	}

	statusRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/status", "", publicToken)
	if statusRes.Code != http.StatusOK {
		t.Fatalf("expected public status 200, got %d: %s", statusRes.Code, statusRes.Body.String())
	}
	statusBody := decodeAPISuccessDataForTest[publicAPIStatusResponse](t, statusRes.Body.Bytes())
	if statusBody.Total != 3 || statusBody.ByStatus["active"] != 2 || statusBody.ByStatus["trial"] != 1 {
		t.Fatalf("unexpected status summary: %#v", statusBody)
	}

	dueRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/due?days=30", "", publicToken)
	if dueRes.Code != http.StatusOK {
		t.Fatalf("expected public due 200, got %d: %s", dueRes.Code, dueRes.Body.String())
	}
	for _, body := range []string{listAllRes.Body.String(), detailRes.Body.String(), dueRes.Body.String()} {
		if !strings.Contains(body, `"balance":"0"`) || !strings.Contains(body, `"balanceCurrency":"EUR"`) {
			t.Fatalf("authorized public API lost balance pair: %s", body)
		}
	}
	dueBody := decodeAPISuccessDataForTest[publicAPIDueResponse](t, dueRes.Body.Bytes())
	if dueBody.Days != 30 || len(dueBody.Items) != 3 {
		t.Fatalf("unexpected due response: %#v", dueBody)
	}
	for _, expected := range []struct {
		record  *core.Record
		dueType string
		dueDate string
	}{
		{record: renewal, dueType: "renewal", dueDate: renewalDate},
		{record: trial, dueType: "trial", dueDate: trialDate},
		{record: expiry, dueType: "expiry", dueDate: expiryDate},
	} {
		if !publicAPITestDueContains(dueBody.Items, expected.record.Id, expected.dueType, expected.dueDate) {
			t.Fatalf("expected due response to contain %s/%s/%s, got %#v", expected.record.Id, expected.dueType, expected.dueDate, dueBody.Items)
		}
	}
	if strings.Contains(dueRes.Body.String(), foreign.Id) {
		t.Fatalf("due response leaked another user's subscription: %s", dueRes.Body.String())
	}
	for _, item := range dueBody.Items {
		if item.Subscription.ID == renewal.Id && item.Subscription.StartDate != nil {
			t.Fatalf("expected due item to preserve startDate null, got %#v", item.Subscription)
		}
	}

	foreignDeleteRes := serveTestRequest(t, app, http.MethodDelete, "/api/app/api-tokens/"+createBody.Token.ID, "", otherSessionToken)
	if foreignDeleteRes.Code != http.StatusNotFound {
		t.Fatalf("expected cross-user token delete to return 404, got %d: %s", foreignDeleteRes.Code, foreignDeleteRes.Body.String())
	}
	if _, err := app.FindRecordById("api_tokens", createBody.Token.ID); err != nil {
		t.Fatalf("cross-user delete must not remove owner token: %v", err)
	}

	deleteRes := serveTestRequest(t, app, http.MethodDelete, "/api/app/api-tokens/"+createBody.Token.ID, "", sessionToken)
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("expected token delete 200, got %d: %s", deleteRes.Code, deleteRes.Body.String())
	}
	if _, err := app.FindRecordById("api_tokens", createBody.Token.ID); err == nil {
		t.Fatal("expected deleted API token record to be removed from database")
	}
	deletedRes := serveTestRequest(t, app, http.MethodGet, "/api/public/v1/me", "", publicToken)
	if deletedRes.Code != http.StatusUnauthorized {
		t.Fatalf("expected deleted token to be rejected, got %d: %s", deletedRes.Code, deletedRes.Body.String())
	}
}

func publicAPITestDueContains(items []publicAPIDueItem, subscriptionID string, dueType string, dueDate string) bool {
	for _, item := range items {
		if item.DueType != dueType || item.DueDate != dueDate {
			continue
		}
		if item.Subscription.ID == subscriptionID {
			return true
		}
	}
	return false
}

func publicAPITestListContainsStartDateNull(items []publicAPISubscriptionResponse, subscriptionID string) bool {
	for _, item := range items {
		if item.ID == subscriptionID {
			return item.StartDate == nil
		}
	}
	return false
}
