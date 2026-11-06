package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
)

func TestSubscriptionBalanceLifecycle(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "balance")
	record := createRouteTestSubscription(t, app, user.Id, nil)
	path := "/api/app/subscriptions/" + record.Id
	for _, body := range []string{
		`{"balance":"0","balanceCurrency":"EUR"}`,
		`{"currency":"CNY","pinned":true}`,
		`{"notes":"balance must survive ordinary edits"}`,
	} {
		response := serveTestRequest(t, app, http.MethodPatch, path, body, token)
		if response.Code != 200 {
			t.Fatalf("HTTP %d: %s", response.Code, response.Body.String())
		}
		data := decodeAPISuccessDataForTest[map[string]map[string]interface{}](t, response.Body.Bytes())
		if data["subscription"]["balance"] != "0" || data["subscription"]["balanceCurrency"] != "EUR" {
			t.Fatalf("lost zero balance: %#v", data)
		}
	}
	other, otherToken := createRouteTestUser(t, app, "balance-other")
	_ = other
	response := serveTestRequest(t, app, http.MethodPatch, path, `{"balance":null,"balanceCurrency":null}`, otherToken)
	if response.Code != http.StatusNotFound {
		t.Fatalf("owner isolation: %d", response.Code)
	}
	response = serveTestRequest(t, app, http.MethodPatch, path, `{"balance":null,"balanceCurrency":null}`, token)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	data := decodeAPISuccessDataForTest[map[string]map[string]interface{}](t, response.Body.Bytes())
	for _, key := range []string{"balance", "balanceCurrency"} {
		if _, exists := data["subscription"][key]; exists {
			t.Fatalf("cleared field leaked: %s", key)
		}
	}
	stored, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.GetString("balance") != "" || stored.GetString("balanceCurrency") != "" {
		t.Fatal("balance not cleared")
	}
}

func TestSubscriptionBalanceStrictWriteAndHook(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "balance-invalid")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"balance": "12.123456", "balanceCurrency": "USD"})
	for _, body := range []string{
		`{"balance":"1"}`, `{"balanceCurrency":"USD"}`, `{"balance":null}`,
		`{"balance":"1","balanceCurrency":null}`, `{"balance":0,"balanceCurrency":"USD"}`,
		`{"balance":"","balanceCurrency":"USD"}`, `{"balance":"-1","balanceCurrency":"USD"}`,
		`{"balance":"1000000000.000001","balanceCurrency":"USD"}`,
		`{"balance":"0.0000001","balanceCurrency":"USD"}`, `{"balance":"1e3","balanceCurrency":"USD"}`,
		`{"balance":"1","balanceCurrency":"usd"}`,
	} {
		response := serveTestRequest(t, app, http.MethodPatch, "/api/app/subscriptions/"+record.Id, body, token)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted %s: %d %s", body, response.Code, response.Body.String())
		}
	}
	stored, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.GetString("balance") != "12.123456" {
		t.Fatal("invalid request changed balance")
	}
	stored.Set("balanceCurrency", "")
	if err := app.Save(stored); err == nil {
		t.Fatal("hook accepted partial balance")
	}
}

func TestSubscriptionBalanceImportSnapshot(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "balance-import")
	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"balance": "42", "balanceCurrency": "EUR"})
	for _, source := range []string{`{}`, `{"balance":"0","balanceCurrency":"USD"}`} {
		var subscription importSubscription
		if err := json.Unmarshal([]byte(source), &subscription); err != nil {
			t.Fatal(err)
		}
		setImportSubscriptionRecord(record, user.Id, subscription)
		if source == `{}` && (record.GetString("balance") != "" || record.GetString("balanceCurrency") != "") {
			t.Fatal("historical replacement inherited balance")
		}
		if source != `{}` && (record.GetString("balance") != "0" || record.GetString("balanceCurrency") != "USD") {
			t.Fatal("import lost zero balance")
		}
	}
}

func TestSubscriptionBalanceSchemaUpgrade(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, _ := createRouteTestUser(t, app, "balance-upgrade")
	record := createRouteTestSubscription(t, app, user.Id, nil)
	before := readSubscriptionDerivedOracleSnapshot(t, app, user.Id)
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	collection.Fields.RemoveByName("balance")
	collection.Fields.RemoveByName("balanceCurrency")
	if err := app.Save(collection); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := ensureSchema(app); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.GetString("price") != record.GetString("price") || stored.GetString("balance") != "" || stored.GetString("balanceCurrency") != "" {
		t.Fatal("upgrade changed existing facts")
	}
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(readSubscriptionDerivedOracleSnapshot(t, app, user.Id))
	if string(beforeJSON) != string(afterJSON) {
		t.Fatal("upgrade changed derived state")
	}
}

func TestSubscriptionBalanceReadPerformance(t *testing.T) {
	if os.Getenv("RENEWLET_PERF_TEST") != "1" {
		t.Skip("set RENEWLET_PERF_TEST=1")
	}
	fixture := loadSubscriptionPerformanceFixture(t)
	for _, scenario := range fixture.Scenarios {
		t.Run(fmt.Sprint(scenario.Size), func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			registerRecordHooks(app)
			user := createSchemaTestUser(t, app, "balance-perf@example.com")
			seedSubscriptionPerformanceRecords(t, app, user.Id, buildInitialGoSubscriptionPerformanceScenario(fixture, scenario.Size))
			for _, mode := range []string{"none", "mixed", "all"} {
				// 合成数据直接调整事实列，不重建无关派生表；读取预算从真实集合查询开始计量。
				query := "UPDATE subscriptions SET balance='', balanceCurrency=''"
				if mode == "all" {
					query = "UPDATE subscriptions SET balance='123456.123456', balanceCurrency='EUR'"
				}
				if mode == "mixed" {
					query = "UPDATE subscriptions SET balance='123456.123456', balanceCurrency='EUR' WHERE rowid % 2 = 0"
				}
				if _, err := app.DB().NewQuery(query).Execute(); err != nil {
					t.Fatal(err)
				}
				responseBytes := 0
				ops, err := measureSubscriptionDBOperations(app, func() error {
					page, exceeded, err := boundedSubscriptionRecordsForQuery(app, user.Id, subscriptionListQuery{}, "2026-08-17", scenario.Size)
					if err != nil {
						return err
					}
					if exceeded || len(page.Rows) != scenario.Size {
						return fmt.Errorf("incomplete collection: %d", len(page.Rows))
					}
					encoded, err := json.Marshal(subscriptionCollectionItemsFromRecords(page.Rows))
					responseBytes = len(encoded)
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
				if ops.ReadQueries != scenario.OperationBudget.ListReadQueries {
					t.Fatalf("unbounded reads: %d", ops.ReadQueries)
				}
				t.Logf("n=%d balance=%s reads=%d responseBytes=%d elapsed=%s allocated=%d", scenario.Size, mode, ops.ReadQueries, responseBytes, ops.Elapsed, ops.AllocatedBytes)
			}
		})
	}
}
