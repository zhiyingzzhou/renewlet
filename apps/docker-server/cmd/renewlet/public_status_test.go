package main

// 公开展示页测试保护公开 token 生命周期、最小字段投影和私有资产代理，防止 Go 后端与 Worker 行为分叉。

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestPublicStatusPageLifecycleAndPublicRoute(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "public-status")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.PublicStatusCurrency = "USD"
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestCustomConfig(t, app, user.Id)

	assetID := createPublicStatusTestAsset(t, app, token, "visible.svg")
	visible := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Visible Plan",
		Price:           "12",
		BillingCycle:    "monthly",
		Category:        "developer_tools",
		Status:          "active",
		PaymentMethod:   "credit_card",
		NextBillingDate: "2099-06-02",
		Website:         "https://billing.example.test",
		Notes:           "private note",
	})
	visible.Set("logo", "/api/app/assets/"+assetID)
	if err := app.Save(visible); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	pinned := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Pinned Plan",
		Price:           "20",
		BillingCycle:    "monthly",
		Status:          "active",
		NextBillingDate: "2099-12-01",
	})
	pinned.Set("pinned", true)
	if err := app.Save(pinned); err != nil {
		t.Fatal(err)
	}
	hidden := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Hidden Plan",
		Price:           "99",
		BillingCycle:    "monthly",
		Status:          "active",
		NextBillingDate: "2099-06-01",
	})
	hidden.Set("publicHidden", true)
	if err := app.Save(hidden); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Legacy Overdue",
		Price:           "10",
		BillingCycle:    "monthly",
		Status:          "active",
		NextBillingDate: "2000-01-01",
	})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Lifetime License",
		Price:           "199",
		BillingCycle:    "one-time",
		Status:          "active",
		NextBillingDate: "2099-01-01",
	})
	unreferencedAssetID := createPublicStatusTestAsset(t, app, token, "unused.svg")

	statusRes := serveTestRequest(t, app, http.MethodGet, "/api/app/public-status-page", "", token)
	if statusRes.Code != http.StatusOK || !strings.Contains(statusRes.Body.String(), `"enabled":false`) {
		t.Fatalf("expected disabled public status page, got %d: %s", statusRes.Code, statusRes.Body.String())
	}

	invalidCreateRes := serveTestRequest(t, app, http.MethodPost, "/api/app/public-status-page", `{"token":"leak"}`, token)
	if invalidCreateRes.Code != http.StatusBadRequest {
		t.Fatalf("expected public status create to reject unknown fields, got %d: %s", invalidCreateRes.Code, invalidCreateRes.Body.String())
	}

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/public-status-page", `{}`, token)
	if createRes.Code != http.StatusOK {
		t.Fatalf("expected public status create 200, got %d: %s", createRes.Code, createRes.Body.String())
	}
	createBody := decodeAPISuccessDataForTest[publicStatusPageCreateResponse](t, createRes.Body.Bytes())
	if !createBody.PublicStatusPage.Enabled || createBody.PublicStatusPage.PageURL == "" || createBody.PublicStatusPage.ShowPrices {
		t.Fatalf("unexpected create response: %#v", createBody.PublicStatusPage)
	}
	publicToken := publicStatusTokenFromURL(t, createBody.PublicStatusPage.PageURL)
	publicTarget := "/api/public/status/" + publicToken

	publicRes := serveTestRequestWithHeaders(t, app, http.MethodGet, publicTarget, "", "", map[string]string{
		"Accept-Language": "zh-CN",
	})
	if publicRes.Code != http.StatusOK {
		t.Fatalf("expected public status 200, got %d: %s", publicRes.Code, publicRes.Body.String())
	}
	if publicRes.Header().Get("Cache-Control") != "no-store" || publicRes.Header().Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Fatalf("expected no-store/noindex headers, got %#v", publicRes.Header())
	}
	publicBody := decodeAPISuccessDataForTest[map[string]any](t, publicRes.Body.Bytes())
	subscriptions := publicBody["subscriptions"].([]any)
	if len(subscriptions) != 4 {
		t.Fatalf("expected exactly four visible subscriptions, got %#v", subscriptions)
	}
	if names := publicStatusTestSubscriptionNames(subscriptions); strings.Join(names, ",") != "Pinned Plan,Lifetime License,Visible Plan,Legacy Overdue" {
		t.Fatalf("public subscriptions should follow list default order, got %#v", names)
	}
	item := publicStatusTestSubscriptionByName(t, subscriptions, "Visible Plan")
	if item["name"] != "Visible Plan" {
		t.Fatalf("unexpected public subscription: %#v", item)
	}
	category, ok := item["category"].(map[string]any)
	if !ok || category["label"] != "开发工具" {
		t.Fatalf("public category should follow the visitor request instead of the account preference: %#v", item["category"])
	}
	if publicStatusTestSubscriptionByName(t, subscriptions, "Legacy Overdue")["status"] != "expired" {
		t.Fatalf("expected legacy overdue active subscription to be exposed as expired: %#v", subscriptions)
	}
	buyout := publicStatusTestSubscriptionByName(t, subscriptions, "Lifetime License")
	if buyout["startDate"] != "2099-01-01" || buyout["nextBillingDate"] != nil {
		t.Fatalf("expected buyout to expose only its purchase date, got %#v", buyout)
	}
	for _, forbidden := range []string{"price", "currency", "billingCycle", "oneTimeTermCount", "oneTimeTermUnit"} {
		if _, ok := buyout[forbidden]; ok {
			t.Fatalf("price-hidden buyout leaked %s: %#v", forbidden, buyout)
		}
	}
	if _, ok := item["price"]; ok {
		t.Fatalf("price must be hidden by default: %#v", item)
	}
	for _, forbidden := range []string{"id", "notes", "website", "tags", "paymentMethod", "extra", "billingCycle"} {
		if _, ok := item[forbidden]; ok {
			t.Fatalf("public response leaked %s: %#v", forbidden, item)
		}
	}
	logo, ok := item["logo"].(string)
	if !ok || !strings.Contains(logo, "/api/public/status/"+publicToken+"/assets/"+assetID) {
		t.Fatalf("expected public asset proxy logo, got %#v", item["logo"])
	}

	patchRes := serveTestRequest(t, app, http.MethodPatch, "/api/app/public-status-page", `{"showPrices":true,"hideExpired":false,"hideLifetime":false}`, token)
	if patchRes.Code != http.StatusOK {
		t.Fatalf("expected public status patch 200, got %d: %s", patchRes.Code, patchRes.Body.String())
	}
	currentMonth := time.Now().UTC().Format("2006-01")
	if err := upsertExchangeRateSnapshot(app, user.Id, exchangeRateSnapshotDTO{
		SchemaVersion:     1,
		Month:             currentMonth,
		Base:              "USD",
		Rates:             map[string]float64{"USD": 1, "CNY": 7},
		RequestedProvider: "frankfurter",
		Provider:          "frankfurter",
		SourceDate:        currentMonth + "-01",
		CapturedAt:        time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
	pricedRes := serveTestRequest(t, app, http.MethodGet, publicTarget, "", "")
	if !strings.Contains(pricedRes.Body.String(), `"price":"12"`) || !strings.Contains(pricedRes.Body.String(), `"currency":"USD"`) {
		t.Fatalf("expected showPrices to expose amount fields, got %s", pricedRes.Body.String())
	}
	pricedBody := decodeAPISuccessDataForTest[map[string]any](t, pricedRes.Body.Bytes())
	if page, ok := pricedBody["page"].(map[string]any); !ok || page["currency"] != "USD" {
		t.Fatalf("expected explicit public status currency, got %#v", pricedBody["page"])
	} else if basis, ok := page["exchangeRateBasis"].(map[string]any); !ok || basis["status"] != "locked" || basis["month"] != currentMonth || basis["base"] != "USD" {
		t.Fatalf("expected locked public exchange rate basis, got %#v", page["exchangeRateBasis"])
	} else if asOf, ok := page["asOf"].(string); !ok || !isValidDateOnly(asOf) {
		t.Fatalf("expected account-timezone asOf date, got %#v", page["asOf"])
	}
	pricedSubscriptions := pricedBody["subscriptions"].([]any)
	pricedItem := publicStatusTestSubscriptionByName(t, pricedSubscriptions, "Visible Plan")
	if pricedItem["billingCycle"] != "monthly" {
		t.Fatalf("expected billing cycle for public amount projection, got %#v", pricedItem)
	}

	assetRes := serveTestRequest(t, app, http.MethodGet, "/api/public/status/"+publicToken+"/assets/"+assetID, "", "")
	if assetRes.Code != http.StatusOK {
		t.Fatalf("expected public asset proxy 200, got %d: %s", assetRes.Code, assetRes.Body.String())
	}
	if assetRes.Header().Get("Cache-Control") != "no-store" || assetRes.Header().Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Fatalf("expected public asset no-store/noindex headers, got %#v", assetRes.Header())
	}
	unreferencedAssetRes := serveTestRequest(t, app, http.MethodGet, "/api/public/status/"+publicToken+"/assets/"+unreferencedAssetID, "", "")
	if unreferencedAssetRes.Code != http.StatusNotFound {
		t.Fatalf("expected unreferenced asset to 404, got %d: %s", unreferencedAssetRes.Code, unreferencedAssetRes.Body.String())
	}

	deleteRes := serveTestRequest(t, app, http.MethodDelete, "/api/app/public-status-page", "", token)
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("expected public status delete 200, got %d: %s", deleteRes.Code, deleteRes.Body.String())
	}
	revokedRes := serveTestRequest(t, app, http.MethodGet, publicTarget, "", "")
	if revokedRes.Code != http.StatusNotFound {
		t.Fatalf("expected revoked public status URL to 404, got %d: %s", revokedRes.Code, revokedRes.Body.String())
	}
}

func createPublicStatusTestAsset(t *testing.T, app core.App, token string, filename string) string {
	t.Helper()
	// 公开资产代理的前提是资产先作为产品私有 /api/app/assets 写入；测试不能回退到 PocketBase 原生 REST/JWT。
	res := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{
			"kind": "logo",
		},
		"file",
		filename,
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if res.Code != http.StatusCreated {
		t.Fatalf("expected SVG asset create 201, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[uploadAssetResponse](t, res.Body.Bytes())
	if !strings.HasPrefix(body.URL, "/api/app/assets/") {
		t.Fatalf("expected uploaded asset URL, got %s", res.Body.String())
	}
	return strings.TrimPrefix(body.URL, "/api/app/assets/")
}

func publicStatusTokenFromURL(t *testing.T, rawURL string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 2 || parts[0] != "status" || parts[1] == "" {
		t.Fatalf("public status URL missing token: %s", rawURL)
	}
	return parts[1]
}

func publicStatusTestSubscriptionByName(t *testing.T, subscriptions []any, name string) map[string]any {
	t.Helper()
	for _, candidate := range subscriptions {
		item, ok := candidate.(map[string]any)
		if ok && item["name"] == name {
			return item
		}
	}
	t.Fatalf("missing public subscription %q in %#v", name, subscriptions)
	return nil
}

func publicStatusTestSubscriptionNames(subscriptions []any) []string {
	names := make([]string, 0, len(subscriptions))
	for _, candidate := range subscriptions {
		item, ok := candidate.(map[string]any)
		if !ok {
			continue
		}
		name, ok := item["name"].(string)
		if ok {
			names = append(names, name)
		}
	}
	return names
}
