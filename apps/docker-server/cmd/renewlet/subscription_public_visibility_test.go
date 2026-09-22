package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func visibilityTestState(t *testing.T, size int) (core.App, string, string, []string) {
	t.Helper()
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "visibility")
	ids := make([]string, size)
	if err := app.RunInTransaction(func(txApp core.App) error {
		for i := range size {
			ids[i] = fmt.Sprintf("visibility%05d", i)
			record := newSubscriptionPerformanceCoreRecord(t, txApp, user.Id, subscriptionPerformanceRecord{
				ID: ids[i], Name: ids[i], Price: "12", Currency: "USD", BillingCycle: "monthly", Category: "productivity", Status: "active",
				StartDate: "2026-01-01", NextBillingDate: "2027-01-01", ReminderDays: -1, Tags: []string{"Team"},
			})
			if err := txApp.Save(record); err != nil {
				return err
			}
		}
		return rebuildSubscriptionDerivedStateForUser(txApp, user.Id, time.Now())
	}); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	return app, user.Id, token, ids
}

func visibilityBody(t *testing.T, ids []string, target, preview bool) string {
	t.Helper()
	body, err := json.Marshal(map[string]interface{}{"selection": map[string]interface{}{"ids": ids}, "publicHidden": target, "dryRun": preview})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestPublicVisibilityBulkSizes(t *testing.T) {
	for _, size := range []int{5, 100, 500, 5000} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			app, userID, token, ids := visibilityTestState(t, size)
			before := readSubscriptionDerivedOracleSnapshot(t, app, userID)
			for _, target := range []bool{true, false} {
				response := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/bulk-public-visibility", visibilityBody(t, ids, target, false), token)
				if response.Code != 200 {
					t.Fatalf("HTTP %d: %s", response.Code, response.Body.String())
				}
				var envelope struct {
					Data subscriptionBulkPublicVisibilityResponse `json:"data"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if envelope.Data.ChangedCount != size || envelope.Data.MatchedCount != size || len(envelope.Data.FailedIDs) != 0 {
					t.Fatalf("wrong result: %+v", envelope.Data)
				}
				var count struct {
					Count int `db:"count"`
				}
				if err := app.DB().NewQuery(`SELECT COUNT(*) AS count FROM subscriptions s JOIN subscription_list_index i ON i.subscription_id=s.id
					WHERE s.user={:user} AND s.publicHidden={:target} AND i.public_hidden=s.publicHidden AND s.updated=i.updated_at`).Bind(dbx.Params{"user": userID, "target": boolToSQLiteInt(target)}).One(&count); err != nil {
					t.Fatal(err)
				}
				if count.Count != size {
					t.Fatalf("facts/index mismatch: %d", count.Count)
				}
			}
			after := readSubscriptionDerivedOracleSnapshot(t, app, userID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("unrelated derived data changed")
			}
			ops, err := measureSubscriptionDBOperations(app, func() error {
				rows, err := readPublicVisibilityTargets(app, userID, subscriptionBulkPublicVisibilitySelection{IDs: ids}, "2026-09-15")
				if err != nil {
					return err
				}
				return writePublicVisibility(app, userID, rows, true)
			})
			if err != nil {
				t.Fatal(err)
			}
			if ops.WriteStatements != 2 || ops.DerivedWrites != 1 {
				t.Fatalf("unbounded writes: %+v", ops)
			}
			t.Logf("rows=%d reads=%d writes=%d elapsed=%s allocated=%d", size, ops.ReadQueries, ops.WriteStatements, ops.Elapsed, ops.AllocatedBytes)
			if size == 500 {
				for _, statement := range ops.ReadSQL {
					var plan []struct {
						Detail string `db:"detail"`
					}
					if err := app.DB().NewQuery("EXPLAIN QUERY PLAN " + statement).All(&plan); err != nil {
						t.Fatal(err)
					}
					details := []string{}
					for _, row := range plan {
						details = append(details, row.Detail)
					}
					joined := strings.Join(details, "\n")
					if !strings.Contains(joined, "SEARCH s USING INDEX") || !strings.Contains(joined, "id=?)") || strings.Contains(joined, "SCAN s ") || strings.HasSuffix(joined, "SCAN s") {
						t.Fatalf("visibility must point-read IDs: %s", joined)
					}
				}
			}
		})
	}
}

func TestPublicVisibilityPreviewIdempotencyAndOwner(t *testing.T) {
	app, userID, token, ids := visibilityTestState(t, 5)
	foreign, _ := createRouteTestUser(t, app, "visibility-foreign")
	other := createRouteTestSubscription(t, app, foreign.Id, nil)
	selection := append([]string{ids[0], ids[0]}, other.Id, "missing")
	for _, preview := range []bool{true, false, false} {
		r := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/bulk-public-visibility", visibilityBody(t, selection, true, preview), token)
		if r.Code != 200 {
			t.Fatalf("HTTP %d: %s", r.Code, r.Body.String())
		}
		var response struct {
			Data subscriptionBulkPublicVisibilityResponse `json:"data"`
		}
		if err := json.Unmarshal(r.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Data.MatchedCount != 1 || !reflect.DeepEqual(response.Data.FailedIDs, []string{other.Id, "missing"}) {
			t.Fatalf("invalid owner result: %+v", response.Data)
		}
		rows, err := readPublicVisibilityTargets(app, userID, subscriptionBulkPublicVisibilitySelection{IDs: ids}, "2026-09-15")
		if err != nil {
			t.Fatal(err)
		}
		if preview && rows[0].PublicHidden {
			t.Fatal("dry run mutated facts")
		}
	}
	current, err := app.FindRecordById("subscriptions", other.Id)
	if err != nil || current.GetBool("publicHidden") {
		t.Fatal("foreign subscription modified")
	}
	for _, body := range []string{`{"selection":{"ids":null,"categories":["expired"]},"publicHidden":true}`, `{"selection":{"ids":["x"],"categories":null},"publicHidden":true}`, `{"selection":{"ids":null},"publicHidden":true}`, `{"selection":{"ids":[]},"publicHidden":true}`, `{"selection":{"ids":[""]},"publicHidden":true}`, `{"selection":{"ids":["x"]}}`, `{"selection":{"ids":["x"]},"publicHidden":null}`, `{"selection":{"ids":["x"]},"publicHidden":true,"dryRun":null}`, `{"selection":{"ids":["x"],"categories":[]},"publicHidden":true}`, `{"selection":{"ids":["x"],"unknown":true},"publicHidden":true}`} {
		r := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/bulk-public-visibility", body, token)
		if r.Code != 400 {
			t.Fatalf("expected strict 400: %s: %d %s", body, r.Code, r.Body.String())
		}
	}
}

func TestPublicVisibilityTransactionRollbackAndConflict(t *testing.T) {
	app, userID, token, ids := visibilityTestState(t, 500)
	rows, err := readPublicVisibilityTargets(app, userID, subscriptionBulkPublicVisibilitySelection{IDs: ids}, "2026-09-15")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`CREATE TRIGGER fail_visibility BEFORE UPDATE ON subscription_list_index WHEN OLD.subscription_id='visibility00499' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`).Execute(); err != nil {
		t.Fatal(err)
	}
	response := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/bulk-public-visibility", visibilityBody(t, ids, true, false), token)
	if response.Code != 500 {
		t.Fatalf("expected 500, got %d %s", response.Code, response.Body.String())
	}
	current, err := readPublicVisibilityTargets(app, userID, subscriptionBulkPublicVisibilitySelection{IDs: ids}, "2026-09-15")
	if err != nil || !reflect.DeepEqual(rows, current) {
		t.Fatal("failed batch did not roll back facts")
	}
	if _, err := app.DB().NewQuery("DROP TRIGGER fail_visibility; UPDATE subscriptions SET status='paused' WHERE id='visibility00000'").Execute(); err != nil {
		t.Fatal(err)
	}
	if err := writePublicVisibility(app, userID, rows, true); !errors.Is(err, errSubscriptionWriteConflict) {
		t.Fatalf("expected snapshot conflict, got %v", err)
	}
	response = serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/bulk-public-visibility", visibilityBody(t, ids, true, false), token)
	if response.Code != 200 {
		t.Fatalf("retry failed: %d %s", response.Code, response.Body.String())
	}
	single := serveTestRequest(t, app, http.MethodPatch, "/api/app/subscriptions/"+ids[0], `{"publicHidden":false}`, token)
	if single.Code != 200 {
		t.Fatalf("single PATCH failed: %d %s", single.Code, single.Body.String())
	}
}
