package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

type schedulerMissingReadApp struct {
	core.App
	awaitMissingRead func() error
}

func (app *schedulerMissingReadApp) FindFirstRecordByFilter(collection any, filter string, params ...dbx.Params) (*core.Record, error) {
	record, err := app.App.FindFirstRecordByFilter(collection, filter, params...)
	// 仅同步真实数据库返回的缺失快照，不伪造结果；事务创建和事务内查询仍走 PocketBase 原实现。
	if collection == subscriptionSchedulerStatesCollection && errors.Is(err, sql.ErrNoRows) {
		if waitErr := app.awaitMissingRead(); waitErr != nil {
			return nil, waitErr
		}
	}
	return record, err
}

func TestNotificationOverviewConcurrentFirstRead(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, _ := createRouteTestUser(t, app, "overview-concurrent")
	otherUser, _ := createRouteTestUser(t, app, "overview-other-owner")
	const readers = 12
	queryContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	missingReads := atomic.Int32{}
	// 聚齐首次读取和创建前读取的真实缺失快照，确定性打开“已读未建”窗口；事务内读取不会使用事务外快照。
	readBatches := [2]chan struct{}{make(chan struct{}), make(chan struct{})}
	concurrentApp := &schedulerMissingReadApp{App: app, awaitMissingRead: func() error {
		ordinal := int(missingReads.Add(1))
		batch := (ordinal - 1) / readers
		if batch >= len(readBatches) {
			return nil
		}
		if ordinal%readers == 0 {
			close(readBatches[batch])
		}
		select {
		case <-readBatches[batch]:
			return nil
		case <-queryContext.Done():
			return queryContext.Err()
		}
	}}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	// 在鉴权后的 handler 边界并发，避免测试被会话 last-seen 写入串行化而掩盖状态首次创建竞态。
	router.GET("/api/app/notifications/overview", func(event *core.RequestEvent) error {
		event.Auth = user.Clone()
		return handleNotificationOverview(concurrentApp, event)
	}).BindFunc(apiErrorMiddleware)
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, readers)
	var ready sync.WaitGroup
	ready.Add(readers)
	// 同一冷账号并行打开概览，只允许创建一份调度状态，不能靠前端请求去重才能正确。
	for range readers {
		go func() {
			request := httptest.NewRequest(http.MethodGet, "/api/app/notifications/overview", nil)
			response := httptest.NewRecorder()
			ready.Done()
			<-start
			mux.ServeHTTP(response, request)
			results <- response
		}()
	}
	ready.Wait()
	close(start)
	for range readers {
		response := <-results
		if response.Code != http.StatusOK {
			t.Errorf("concurrent overview returned %d: %s", response.Code, response.Body.String())
		}
	}
	for _, owner := range []struct {
		id   string
		want int64
	}{{user.Id, 1}, {otherUser.Id, 0}} {
		count, err := app.CountRecords(subscriptionSchedulerStatesCollection, dbx.HashExp{"user": owner.id})
		if err != nil || count != owner.want {
			t.Fatalf("scheduler owner %s: count=%d want=%d err=%v", owner.id, count, owner.want, err)
		}
	}
}

func TestSchedulerRefreshRollsBackRepeatSchedule(t *testing.T) {
	for _, operation := range []string{"INSERT", "UPDATE"} {
		t.Run(operation, func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			registerRecordHooks(app)
			user, _ := createRouteTestUser(t, app, "scheduler-rollback")
			subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
				"autoRenew": false, "repeatReminderEnabled": true, "repeatReminderWindow": "72h",
			})
			if _, err := app.DB().NewQuery(`INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
				VALUES ({:user}, {:subscription}, '2026-01-02T00:00:00Z')
				ON CONFLICT(user_id, subscription_id) DO UPDATE SET next_due_at_utc = excluded.next_due_at_utc`).
				Bind(dbx.Params{"user": user.Id, "subscription": subscription.Id}).Execute(); err != nil {
				t.Fatal(err)
			}
			if operation == "INSERT" {
				if _, err := app.DB().NewQuery("DELETE FROM subscription_scheduler_states WHERE user = {:user}").Bind(dbx.Params{"user": user.Id}).Execute(); err != nil {
					t.Fatal(err)
				}
			}
			before, err := earliestSubscriptionRepeatDue(app, user.Id)
			if err != nil || before == "" {
				t.Fatalf("missing rollback fixture: due=%q err=%v", before, err)
			}
			if _, err := app.DB().NewQuery(fmt.Sprintf(`CREATE TRIGGER fail_scheduler_write
				BEFORE %s ON subscription_scheduler_states
				BEGIN SELECT RAISE(ABORT, 'injected scheduler failure'); END`, operation)).Execute(); err != nil {
				t.Fatal(err)
			}
			// 派生索引先被重建、状态行后写入；最后一步失败必须回滚整组写入，而不是留下新索引配旧状态。
			_, err = refreshSubscriptionSchedulerStateWithOptions(app, user.Id, subscriptionSchedulerRefreshOptions{
				Now: time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC),
			})
			if err == nil || !strings.Contains(err.Error(), "injected scheduler failure") {
				t.Fatalf("expected original storage failure, got %v", err)
			}
			after, err := earliestSubscriptionRepeatDue(app, user.Id)
			if err != nil || after != before {
				t.Fatalf("failed refresh changed schedule: before=%q after=%q err=%v", before, after, err)
			}
		})
	}
}

func TestSchedulerRefreshReusesOuterTransaction(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "scheduler-nested")
	options := subscriptionSchedulerRefreshOptions{Now: time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC)}
	rollback := errors.New("caller rollback")
	err := app.RunInTransaction(func(txApp core.App) error {
		if _, err := refreshSubscriptionSchedulerStateWithOptions(txApp, user.Id, options); err != nil {
			return err
		}
		count, err := txApp.CountRecords(subscriptionSchedulerStatesCollection, dbx.HashExp{"user": user.Id})
		if err != nil || count != 1 {
			return fmt.Errorf("state must be visible inside caller transaction: count=%d err=%v", count, err)
		}
		return rollback
	})
	if err != rollback {
		t.Fatalf("expected caller rollback, got %v", err)
	}
	count, err := app.CountRecords(subscriptionSchedulerStatesCollection, dbx.HashExp{"user": user.Id})
	if err != nil || count != 0 {
		t.Fatalf("caller rollback leaked state: count=%d err=%v", count, err)
	}
	var first subscriptionSchedulerState
	if err := app.RunInTransaction(func(txApp core.App) error {
		var err error
		first, err = refreshSubscriptionSchedulerStateWithOptions(txApp, user.Id, options)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	second, err := refreshSubscriptionSchedulerStateWithOptions(app, user.Id, options)
	if err != nil || first != second {
		t.Fatalf("repeated refresh changed derived result: first=%+v second=%+v err=%v", first, second, err)
	}
}

func TestSchedulerWarmReadDoesNotRebuild(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "scheduler-warm")
	expected, err := getSubscriptionSchedulerState(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	var actual subscriptionSchedulerState
	operations, err := measureSubscriptionDBOperations(app, func() error {
		var err error
		actual, err = getSubscriptionSchedulerState(app, user.Id)
		return err
	})
	if err != nil || actual != expected {
		t.Fatalf("warm read changed state: actual=%+v expected=%+v err=%v", actual, expected, err)
	}
	// 缺失状态修复不能把已有状态的普通读取变成订阅全表扫描或派生索引重建。
	if operations.ReadQueries != 1 || operations.WriteStatements != 0 {
		t.Fatalf("warm read must remain one query and no writes: %+v", operations)
	}
}

func TestSchedulerDueUserIDsExcludeBannedUsers(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	activeUser, _ := createRouteTestUser(t, app, "scheduler-active")
	bannedUser, _ := createRouteTestUser(t, app, "scheduler-banned")
	createRouteTestSubscription(t, app, activeUser.Id, map[string]interface{}{"autoRenew": true, "nextBillingDate": "2026-01-01"})
	createRouteTestSubscription(t, app, bannedUser.Id, map[string]interface{}{"autoRenew": true, "nextBillingDate": "2026-01-01"})
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	for _, userID := range []string{activeUser.Id, bannedUser.Id} {
		if _, err := refreshSubscriptionSchedulerStateWithOptions(app, userID, subscriptionSchedulerRefreshOptions{Now: now, ResetAutoRenewCheck: true}); err != nil {
			t.Fatal(err)
		}
	}
	bannedUser.Set("banned", true)
	if err := app.Save(bannedUser); err != nil {
		t.Fatal(err)
	}

	users, err := listAutoRenewDueUserIDs(app, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0] != activeUser.Id {
		t.Fatalf("expected only active due user %q, got %#v", activeUser.Id, users)
	}
}

func TestNotificationDueUserIDsCanPagePastRetainedDueUsers(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	firstUser, _ := createRouteTestUser(t, app, "scheduler-retained-first")
	secondUser, _ := createRouteTestUser(t, app, "scheduler-retained-second")
	createDueSchedulerState(t, app, firstUser.Id, "2026-01-01T00:00:00Z")
	createDueSchedulerState(t, app, secondUser.Id, "2026-01-01T00:00:00Z")

	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	firstPage, err := listNotificationDueUserIDsExcluding(app, now, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstPage) != 1 {
		t.Fatalf("expected first page to contain one due user, got %#v", firstPage)
	}
	seen := map[string]struct{}{firstPage[0]: {}}
	secondPage, err := listNotificationDueUserIDsExcluding(app, now, 1, seen)
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPage) != 1 || secondPage[0] == firstPage[0] {
		t.Fatalf("expected query-level exclude to page past retained due user, first=%#v second=%#v", firstPage, secondPage)
	}
}

func createDueSchedulerState(t *testing.T, app core.App, userID string, dueAt string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(subscriptionSchedulerStatesCollection)
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("nextDailyNotificationDueAtUTC", dueAt)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
}
