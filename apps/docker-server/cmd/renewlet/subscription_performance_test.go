package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type subscriptionPerformanceFixtureFile struct {
	Recipe struct {
		IDPrefix             string    `json:"idPrefix"`
		Statuses             []string  `json:"statuses"`
		Categories           []string  `json:"categories"`
		BillingCycles        []string  `json:"billingCycles"`
		Currencies           []string  `json:"currencies"`
		PaymentMethods       []*string `json:"paymentMethods"`
		ReminderDays         []int     `json:"reminderDays"`
		TeamModulo           int       `json:"teamModulo"`
		RepeatReminderModulo int       `json:"repeatReminderModulo"`
		StartDate            string    `json:"startDate"`
		NextBillingDate      string    `json:"nextBillingDate"`
	} `json:"recipe"`
	Mutations []subscriptionPerformanceMutation `json:"mutations"`
	Scenarios []subscriptionPerformanceScenario `json:"scenarios"`
}

type subscriptionPerformanceMutation struct {
	Kind            string   `json:"kind"`
	Index           int      `json:"index"`
	IndexFromSize   bool     `json:"indexFromSize"`
	Status          string   `json:"status"`
	Tags            []string `json:"tags"`
	NextBillingDate string   `json:"nextBillingDate"`
}

type subscriptionPerformanceScenario struct {
	Size     int `json:"size"`
	Expected struct {
		Total                 int            `json:"total"`
		StatusCounts          map[string]int `json:"statusCounts"`
		TagRows               int            `json:"tagRows"`
		AutoRenew             int            `json:"autoRenew"`
		RepeatReminder        int            `json:"repeatReminder"`
		CombinedFilterIndices []int          `json:"combinedFilterIndices"`
	} `json:"expected"`
	OperationBudget struct {
		DerivedWriteBase int `json:"derivedWriteBase"`
		ListReadQueries  int `json:"listReadQueries"`
	} `json:"operationBudget"`
}

type subscriptionPerformanceRecord struct {
	Index                        int
	ID                           string
	Name                         string
	Price                        string
	Currency                     string
	BillingCycle                 string
	CustomDays                   int
	Category                     string
	Status                       string
	Pinned                       bool
	PublicHidden                 bool
	PaymentMethod                *string
	StartDate                    string
	NextBillingDate              string
	AutoRenew                    bool
	AutoCalculateNextBillingDate bool
	TrialEndDate                 string
	Website                      string
	Notes                        string
	Tags                         []string
	ReminderDays                 int
	RepeatReminderEnabled        bool
}

type subscriptionDBOperations struct {
	ReadQueries     int
	WriteStatements int
	DerivedWrites   int
	ReadSQL         []string
	WriteSQL        []string
	Elapsed         time.Duration
	AllocatedBytes  uint64
	SQLDuration     time.Duration
	PoolWaitCount   int64
	PoolWaitTime    time.Duration
}

func TestSubscriptionDerivedStatePerformanceBudget(t *testing.T) {
	if os.Getenv("RENEWLET_PERF_TEST") != "1" {
		t.Skip("set RENEWLET_PERF_TEST=1 to run subscription performance budgets")
	}
	fixture := loadSubscriptionPerformanceFixture(t)
	for _, scenario := range fixture.Scenarios {
		scenario := scenario
		t.Run(fmt.Sprintf("n=%d", scenario.Size), func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			registerRecordHooks(app)
			user := createSchemaTestUser(t, app, fmt.Sprintf("subscription-perf-%d@example.com", scenario.Size))
			initial := buildInitialGoSubscriptionPerformanceScenario(fixture, scenario.Size)
			final := buildGoSubscriptionPerformanceScenario(t, fixture, scenario.Size)
			seedSubscriptionPerformanceRecords(t, app, user.Id, initial)

			for _, mutation := range fixture.Mutations {
				operations, uniqueTagCount := applyMeasuredGoSubscriptionMutation(t, app, user.Id, fixture, scenario.Size, mutation)
				if operations.DerivedWrites > scenario.OperationBudget.DerivedWriteBase+uniqueTagCount {
					t.Fatalf("%s derived writes = %d, budget = %d + %d tags\n%s", mutation.Kind, operations.DerivedWrites,
						scenario.OperationBudget.DerivedWriteBase, uniqueTagCount, operations.WriteSQL)
				}
				t.Logf("n=%d mutation=%s operations=%+v", scenario.Size, mutation.Kind, operations)
			}

			var pageBytes int
			listOperations, err := measureSubscriptionDBOperations(app, func() error {
				page, listErr := listSubscriptionRecordsForQuery(app, user.Id, subscriptionListQuery{Limit: 50}, "2026-08-17")
				if listErr == nil {
					body, marshalErr := json.Marshal(page.Rows)
					pageBytes = len(body)
					return marshalErr
				}
				return listErr
			})
			if err != nil {
				t.Fatal(err)
			}
			if listOperations.ReadQueries != scenario.OperationBudget.ListReadQueries {
				t.Fatalf("list read queries = %d, want %d\n%s", listOperations.ReadQueries, scenario.OperationBudget.ListReadQueries, listOperations.ReadSQL)
			}
			// 序列化的是记录行而非 HTTP envelope；单列字节，不能冒充浏览器线上传输量。
			t.Logf("n=%d list_record_bytes=%d operations=%+v", scenario.Size, pageBytes, listOperations)

			boundedOperations, err := measureSubscriptionDBOperations(app, func() error {
				page, exceeded, listErr := boundedSubscriptionRecordsForQuery(
					app, user.Id, subscriptionListQuery{}, "2026-08-17", scenario.Size,
				)
				if listErr == nil && (exceeded || len(page.Rows) != scenario.Expected.Total || page.Total != int64(scenario.Expected.Total)) {
					return fmt.Errorf("bounded collection = rows:%d total:%d exceeded:%t", len(page.Rows), page.Total, exceeded)
				}
				return listErr
			})
			if err != nil {
				t.Fatal(err)
			}
			if boundedOperations.ReadQueries != scenario.OperationBudget.ListReadQueries {
				t.Fatalf("bounded read queries = %d, want %d\n%s", boundedOperations.ReadQueries, scenario.OperationBudget.ListReadQueries, boundedOperations.ReadSQL)
			}
			t.Logf("n=%d bounded operations=%+v", scenario.Size, boundedOperations)
			if scenario.Size == 1000 || scenario.Size == 5000 {
				assertSubscriptionProjectionQueryPlan(t, app, user.Id)
			}
			assertGoSubscriptionPerformanceOracle(t, app, user.Id, final, scenario)
		})
	}
}

func assertSubscriptionProjectionQueryPlan(t *testing.T, app core.App, userID string) {
	t.Helper()
	var rows []struct {
		Detail string `db:"detail"`
	}
	assertOwnerIndexed := func(query subscriptionListQuery) {
		base := subscriptionProjectionBaseQuery(userID, query)
		base.params["today"] = "2026-08-17"
		plan := buildSubscriptionProjectionPagePlan(base, 51, nil, subscriptionProjectionExactPage, 0)
		if strings.Contains(plan.SQL, "search_text_lower") || strings.Contains(plan.SQL, "next_billing_date AS") {
			t.Fatalf("subscription page CTE must materialize only pagination keys:\n%s", plan.SQL)
		}
		rows = rows[:0]
		if err := app.DB().NewQuery("EXPLAIN QUERY PLAN " + plan.SQL).Bind(plan.Params).All(&rows); err != nil {
			t.Fatal(err)
		}
		details := make([]string, 0, len(rows))
		for _, row := range rows {
			details = append(details, row.Detail)
		}
		joined := strings.Join(details, "\n")
		t.Logf("projection paymentType=%q plan=%s", query.PaymentType, joined)
		if !strings.Contains(joined, "SEARCH idx") || strings.Contains(joined, "SCAN idx") ||
			strings.Contains(joined, "SCAN subscription_list_index") {
			t.Fatalf("subscription projection must stay owner-indexed for paymentType=%q:\n%s", query.PaymentType, joined)
		}
	}
	assertOwnerIndexed(subscriptionListQuery{})
	for _, paymentType := range []string{"auto", "manual", "one-time-buyout", "one-time-fixed-term"} {
		assertOwnerIndexed(subscriptionListQuery{PaymentType: paymentType})
	}

	factPlan := `SELECT id FROM subscriptions
		WHERE user = {:user} AND id IN ({:factID0}, {:factID1})`
	factRows := rows[:0]
	if err := app.DB().NewQuery("EXPLAIN QUERY PLAN " + factPlan).Bind(dbx.Params{
		"user": userID, "factID0": "fact-plan-0", "factID1": "fact-plan-1",
	}).All(&factRows); err != nil {
		t.Fatal(err)
	}
	factDetails := make([]string, 0, len(factRows))
	for _, row := range factRows {
		factDetails = append(factDetails, row.Detail)
	}
	factJoined := strings.Join(factDetails, "\n")
	if !strings.Contains(factJoined, "SEARCH subscriptions") || strings.Contains(factJoined, "SCAN subscriptions") {
		t.Fatalf("subscription facts must stay primary-key indexed:\n%s", factJoined)
	}
}

func TestSubscriptionDerivedMutationRollsBackFactOnFailure(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user := createSchemaTestUser(t, app, "subscription-derived-rollback@example.com")
	if _, err := app.DB().NewQuery(`CREATE TRIGGER fail_subscription_stats_insert
		BEFORE INSERT ON subscription_user_stats
		BEGIN
			SELECT RAISE(ABORT, 'injected derived failure');
		END`).Execute(); err != nil {
		t.Fatal(err)
	}

	record := newSubscriptionRecord(t, app, user.Id, []string{"critical"}, "Rollback Plan")
	if err := app.SaveNoValidate(record); err == nil || !strings.Contains(err.Error(), "injected derived failure") {
		t.Fatalf("expected injected derived failure, got %v", err)
	}

	var counts struct {
		Facts      int `db:"facts"`
		Projection int `db:"projection"`
		Tags       int `db:"tags"`
		Stats      int `db:"stats"`
		Repeat     int `db:"repeat_schedule"`
		Scheduler  int `db:"scheduler"`
	}
	if err := app.DB().NewQuery(`SELECT
		(SELECT COUNT(*) FROM subscriptions WHERE user = {:user}) AS facts,
		(SELECT COUNT(*) FROM subscription_list_index WHERE user_id = {:user}) AS projection,
		(SELECT COUNT(*) FROM subscription_tags WHERE user_id = {:user}) AS tags,
		(SELECT COUNT(*) FROM subscription_user_stats WHERE user_id = {:user}) AS stats,
		(SELECT COUNT(*) FROM subscription_repeat_schedule WHERE user_id = {:user}) AS repeat_schedule,
		(SELECT COUNT(*) FROM subscription_scheduler_states WHERE user = {:user}) AS scheduler`).
		Bind(dbx.Params{"user": user.Id}).One(&counts); err != nil {
		t.Fatal(err)
	}
	if counts != (struct {
		Facts      int `db:"facts"`
		Projection int `db:"projection"`
		Tags       int `db:"tags"`
		Stats      int `db:"stats"`
		Repeat     int `db:"repeat_schedule"`
		Scheduler  int `db:"scheduler"`
	}{}) {
		t.Fatalf("fact and derived rows must roll back together, got %#v", counts)
	}
}

func loadSubscriptionPerformanceFixture(t *testing.T) subscriptionPerformanceFixtureFile {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve subscription performance fixture caller")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "../../../../packages/shared/src/contract-fixtures/subscription-performance-fixtures.json"))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture subscriptionPerformanceFixtureFile
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Recipe.Statuses) == 0 || len(fixture.Recipe.Categories) == 0 || len(fixture.Recipe.BillingCycles) == 0 ||
		len(fixture.Recipe.Currencies) == 0 || len(fixture.Recipe.PaymentMethods) == 0 || len(fixture.Recipe.ReminderDays) == 0 ||
		fixture.Recipe.TeamModulo <= 0 || fixture.Recipe.RepeatReminderModulo <= 0 {
		t.Fatal("subscription performance fixture recipe is incomplete")
	}
	return fixture
}

func buildGoSubscriptionPerformanceScenario(t *testing.T, fixture subscriptionPerformanceFixtureFile, size int) []subscriptionPerformanceRecord {
	t.Helper()
	records := buildInitialGoSubscriptionPerformanceScenario(fixture, size)
	for _, mutation := range fixture.Mutations {
		if mutation.Kind == "create" {
			if !mutation.IndexFromSize {
				t.Fatal("create performance mutation must derive its index from size")
			}
			records = append(records, newGoSubscriptionPerformanceRecord(fixture, size, size))
			continue
		}
		position := -1
		for index := range records {
			if records[index].Index == mutation.Index {
				position = index
				break
			}
		}
		if position < 0 {
			t.Fatalf("missing performance fixture index %d", mutation.Index)
		}
		switch mutation.Kind {
		case "delete":
			records = append(records[:position], records[position+1:]...)
		case "update":
			records[position].Status = mutation.Status
			records[position].Tags = append([]string(nil), mutation.Tags...)
		case "renew":
			records[position].Status = mutation.Status
			records[position].NextBillingDate = mutation.NextBillingDate
		default:
			t.Fatalf("unknown performance mutation %q", mutation.Kind)
		}
	}
	return records
}

func buildInitialGoSubscriptionPerformanceScenario(fixture subscriptionPerformanceFixtureFile, size int) []subscriptionPerformanceRecord {
	records := make([]subscriptionPerformanceRecord, size)
	for index := range size {
		records[index] = newGoSubscriptionPerformanceRecord(fixture, size, index)
	}
	return records
}

func newGoSubscriptionPerformanceRecord(fixture subscriptionPerformanceFixtureFile, size int, index int) subscriptionPerformanceRecord {
	recipe := fixture.Recipe
	status := recipe.Statuses[index%len(recipe.Statuses)]
	billingCycle := recipe.BillingCycles[index%len(recipe.BillingCycles)]
	category := recipe.Categories[index%len(recipe.Categories)]
	trialEndDate := ""
	if status == "trial" {
		trialEndDate = recipe.NextBillingDate
	}
	customDays := 0
	if billingCycle == "custom" {
		customDays = 30
	}
	return subscriptionPerformanceRecord{
		Index:                        index,
		ID:                           fmt.Sprintf("%s%04d%010d", recipe.IDPrefix, size, index),
		Name:                         fmt.Sprintf("Performance Subscription %d-%d", size, index),
		Price:                        fmt.Sprintf("%d", index+1),
		Currency:                     recipe.Currencies[index%len(recipe.Currencies)],
		BillingCycle:                 billingCycle,
		CustomDays:                   customDays,
		Category:                     category,
		Status:                       status,
		Pinned:                       index%3 == 0,
		PublicHidden:                 index%7 == 0,
		PaymentMethod:                recipe.PaymentMethods[index%len(recipe.PaymentMethods)],
		StartDate:                    recipe.StartDate,
		NextBillingDate:              recipe.NextBillingDate,
		AutoRenew:                    index%2 == 0,
		AutoCalculateNextBillingDate: true,
		TrialEndDate:                 trialEndDate,
		Website:                      fmt.Sprintf("https://performance.example/%d/%d", size, index),
		Notes:                        fmt.Sprintf("deterministic fixture %d-%d", size, index),
		Tags:                         []string{fmt.Sprintf("team-%d", index%recipe.TeamModulo), "CATEGORY-" + category},
		ReminderDays:                 recipe.ReminderDays[index%len(recipe.ReminderDays)],
		RepeatReminderEnabled:        index%recipe.RepeatReminderModulo == 0,
	}
}

func seedSubscriptionPerformanceRecords(t *testing.T, app core.App, userID string, records []subscriptionPerformanceRecord) {
	t.Helper()
	for _, fixtureRecord := range records {
		record := newSubscriptionPerformanceCoreRecord(t, app, userID, fixtureRecord)
		if err := app.SaveNoValidate(record); err != nil {
			t.Fatal(err)
		}
	}
}

func newSubscriptionPerformanceCoreRecord(t *testing.T, app core.App, userID string, fixtureRecord subscriptionPerformanceRecord) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Id = fixtureRecord.ID
	record.Load(map[string]any{
		"user": userID, "name": fixtureRecord.Name, "price": fixtureRecord.Price, "currency": fixtureRecord.Currency,
		"billingCycle": fixtureRecord.BillingCycle, "category": fixtureRecord.Category, "status": fixtureRecord.Status,
		"pinned": fixtureRecord.Pinned, "publicHidden": fixtureRecord.PublicHidden, "startDate": fixtureRecord.StartDate,
		"nextBillingDate": fixtureRecord.NextBillingDate, "autoRenew": fixtureRecord.AutoRenew,
		"autoCalculateNextBillingDate": fixtureRecord.AutoCalculateNextBillingDate, "trialEndDate": fixtureRecord.TrialEndDate,
		"website": fixtureRecord.Website, "notes": fixtureRecord.Notes, "tags": fixtureRecord.Tags,
		"costSharing": emptyJSONPayload{}, "extra": emptyJSONPayload{}, "reminderDays": fixtureRecord.ReminderDays,
		"repeatReminderEnabled":  fixtureRecord.RepeatReminderEnabled,
		"repeatReminderInterval": defaultRepeatReminderInterval, "repeatReminderWindow": defaultRepeatReminderWindow,
	})
	if fixtureRecord.CustomDays > 0 {
		record.Set("customDays", fixtureRecord.CustomDays)
		record.Set("customCycleUnit", "day")
	}
	if fixtureRecord.PaymentMethod != nil {
		record.Set("paymentMethod", *fixtureRecord.PaymentMethod)
	}
	return record
}

func applyMeasuredGoSubscriptionMutation(
	t *testing.T,
	app core.App,
	userID string,
	fixture subscriptionPerformanceFixtureFile,
	size int,
	mutation subscriptionPerformanceMutation,
) (subscriptionDBOperations, int) {
	t.Helper()
	index := mutation.Index
	if mutation.IndexFromSize {
		index = size
	}
	fixtureRecord := newGoSubscriptionPerformanceRecord(fixture, size, index)
	uniqueTagCount := len(normalizedSubscriptionTags(fixtureRecord.Tags))
	var operation func() error
	switch mutation.Kind {
	case "create":
		record := newSubscriptionPerformanceCoreRecord(t, app, userID, fixtureRecord)
		operation = func() error { return app.SaveNoValidate(record) }
	case "delete":
		record, err := app.FindRecordById("subscriptions", fixtureRecord.ID)
		if err != nil {
			t.Fatal(err)
		}
		uniqueTagCount = 0
		operation = func() error { return app.Delete(record) }
	case "update", "renew":
		record, err := app.FindRecordById("subscriptions", fixtureRecord.ID)
		if err != nil {
			t.Fatal(err)
		}
		record.Set("status", mutation.Status)
		if mutation.Kind == "update" {
			record.Set("tags", mutation.Tags)
			uniqueTagCount = len(normalizedSubscriptionTags(mutation.Tags))
		} else {
			record.Set("nextBillingDate", mutation.NextBillingDate)
		}
		operation = func() error { return app.SaveNoValidate(record) }
	default:
		t.Fatalf("unknown performance mutation %q", mutation.Kind)
	}
	operations, err := measureSubscriptionDBOperations(app, operation)
	if err != nil {
		t.Fatal(err)
	}
	return operations, uniqueTagCount
}

func measureSubscriptionDBOperations(app core.App, operation func() error) (subscriptionDBOperations, error) {
	concurrent := app.ConcurrentDB().(*dbx.DB)
	nonconcurrent := app.NonconcurrentDB().(*dbx.DB)
	previousConcurrentQuery := concurrent.QueryLogFunc
	previousConcurrentExec := concurrent.ExecLogFunc
	previousNonconcurrentQuery := nonconcurrent.QueryLogFunc
	previousNonconcurrentExec := nonconcurrent.ExecLogFunc
	defer func() {
		concurrent.QueryLogFunc = previousConcurrentQuery
		concurrent.ExecLogFunc = previousConcurrentExec
		nonconcurrent.QueryLogFunc = previousNonconcurrentQuery
		nonconcurrent.ExecLogFunc = previousNonconcurrentExec
	}()

	var mutex sync.Mutex
	operations := subscriptionDBOperations{}
	queryLog := func(_ context.Context, elapsed time.Duration, statement string, _ *sql.Rows, _ error) {
		mutex.Lock()
		defer mutex.Unlock()
		operations.ReadQueries++
		operations.SQLDuration += elapsed
		if len(operations.ReadSQL) < 12 {
			operations.ReadSQL = append(operations.ReadSQL, statement)
		}
	}
	execLog := func(_ context.Context, elapsed time.Duration, statement string, _ sql.Result, _ error) {
		mutex.Lock()
		defer mutex.Unlock()
		operations.WriteStatements++
		operations.SQLDuration += elapsed
		if isSubscriptionDerivedWriteSQL(statement) {
			operations.DerivedWrites++
		}
		if len(operations.WriteSQL) < 12 {
			operations.WriteSQL = append(operations.WriteSQL, statement)
		}
	}
	concurrent.QueryLogFunc = queryLog
	concurrent.ExecLogFunc = execLog
	nonconcurrent.QueryLogFunc = queryLog
	nonconcurrent.ExecLogFunc = execLog

	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	concurrentBefore := concurrent.DB().Stats()
	nonconcurrentBefore := nonconcurrent.DB().Stats()
	startedAt := time.Now()
	err := operation()
	operations.Elapsed = time.Since(startedAt)
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	operations.AllocatedBytes = after.TotalAlloc - before.TotalAlloc
	// database/sql 的连接池等待不等于 SQLite 锁等待；SQL 日志耗时也不包含 Rows 后续消费。
	concurrentAfter := concurrent.DB().Stats()
	nonconcurrentAfter := nonconcurrent.DB().Stats()
	operations.PoolWaitCount = concurrentAfter.WaitCount - concurrentBefore.WaitCount + nonconcurrentAfter.WaitCount - nonconcurrentBefore.WaitCount
	operations.PoolWaitTime = concurrentAfter.WaitDuration - concurrentBefore.WaitDuration + nonconcurrentAfter.WaitDuration - nonconcurrentBefore.WaitDuration
	return operations, err
}

func isSubscriptionDerivedWriteSQL(statement string) bool {
	for _, table := range []string{"subscription_list_index", "subscription_tags", "subscription_user_stats", "subscription_repeat_schedule", "subscription_scheduler_states"} {
		if strings.Contains(statement, table) {
			return true
		}
	}
	return false
}

func assertGoSubscriptionPerformanceOracle(
	t *testing.T,
	app core.App,
	userID string,
	records []subscriptionPerformanceRecord,
	scenario subscriptionPerformanceScenario,
) {
	t.Helper()
	var counts struct {
		Projection int `db:"projection"`
		Tags       int `db:"tags"`
		AutoRenew  int `db:"auto_renew"`
		Repeat     int `db:"repeat_reminder"`
	}
	if err := app.DB().NewQuery(`SELECT
		(SELECT COUNT(*) FROM subscription_list_index WHERE user_id = {:user}) AS projection,
		(SELECT COUNT(*) FROM subscription_tags WHERE user_id = {:user}) AS tags,
		(SELECT COUNT(*) FROM subscriptions WHERE user = {:user} AND autoRenew = true) AS auto_renew,
		(SELECT COUNT(*) FROM subscriptions WHERE user = {:user} AND repeatReminderEnabled = true) AS repeat_reminder`).
		Bind(dbx.Params{"user": userID}).One(&counts); err != nil {
		t.Fatal(err)
	}
	if counts.Projection != scenario.Expected.Total || counts.Tags != scenario.Expected.TagRows ||
		counts.AutoRenew != scenario.Expected.AutoRenew || counts.Repeat != scenario.Expected.RepeatReminder {
		t.Fatalf("derived counts = %#v, expected projection=%d tags=%d autoRenew=%d repeat=%d", counts,
			scenario.Expected.Total, scenario.Expected.TagRows, scenario.Expected.AutoRenew, scenario.Expected.RepeatReminder)
	}

	stats, err := getSubscriptionStats(app, userID)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Total != scenario.Expected.Total {
		t.Fatalf("stats total = %d, want %d", stats.Total, scenario.Expected.Total)
	}
	for status, expected := range scenario.Expected.StatusCounts {
		if stats.ByStatus[status] != expected {
			t.Fatalf("status %s = %d, want %d", status, stats.ByStatus[status], expected)
		}
	}

	var matches []struct {
		SubscriptionID string `db:"subscription_id"`
	}
	if err := app.DB().NewQuery(`SELECT idx.subscription_id
		FROM subscription_list_index AS idx
		WHERE idx.user_id = {:user} AND idx.category = 'developer_tools' AND idx.status = 'cancelled'
		AND EXISTS (SELECT 1 FROM subscription_tags AS tag WHERE tag.user_id = idx.user_id
			AND tag.subscription_id = idx.subscription_id AND tag.tag_norm = 'priority')
		ORDER BY idx.subscription_id`).Bind(dbx.Params{"user": userID}).All(&matches); err != nil {
		t.Fatal(err)
	}
	indexByID := make(map[string]int, len(records))
	for _, record := range records {
		indexByID[record.ID] = record.Index
	}
	indices := make([]int, 0, len(matches))
	for _, match := range matches {
		indices = append(indices, indexByID[match.SubscriptionID])
	}
	sort.Ints(indices)
	if !slices.Equal(indices, scenario.Expected.CombinedFilterIndices) {
		t.Fatalf("combined filter indices = %v, want %v", indices, scenario.Expected.CombinedFilterIndices)
	}

	incremental := readSubscriptionDerivedOracleSnapshot(t, app, userID)
	if err := rebuildSubscriptionDerivedStateForUser(app, userID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	rebuilt := readSubscriptionDerivedOracleSnapshot(t, app, userID)
	if !reflect.DeepEqual(incremental, rebuilt) {
		incrementalJSON, _ := json.Marshal(incremental)
		rebuiltJSON, _ := json.Marshal(rebuilt)
		t.Fatalf("incremental derived state diverged from full rebuild oracle\nincremental=%s\nrebuilt=%s", incrementalJSON, rebuiltJSON)
	}
}

type subscriptionDerivedOracleSnapshot struct {
	Projection []struct {
		SubscriptionID string `db:"subscription_id" json:"subscriptionId"`
		UserID         string `db:"user_id" json:"userId"`
		SearchText     string `db:"search_text_lower" json:"searchText"`
		Status         string `db:"status" json:"status"`
		AutoRenew      int    `db:"auto_renew" json:"autoRenew"`
		RepeatEnabled  int    `db:"repeat_reminder_enabled" json:"repeatEnabled"`
	} `json:"projection"`
	Tags []struct {
		SubscriptionID string `db:"subscription_id" json:"subscriptionId"`
		TagNorm        string `db:"tag_norm" json:"tagNorm"`
		Tag            string `db:"tag" json:"tag"`
	} `json:"tags"`
	Stats         subscriptionStats `json:"stats"`
	RepeatIDs     []string          `json:"repeatIds"`
	AutoRenew     int               `json:"autoRenew"`
	RepeatEnabled int               `json:"repeatEnabled"`
	HasRepeatDue  bool              `json:"hasRepeatDue"`
}

func readSubscriptionDerivedOracleSnapshot(t *testing.T, app core.App, userID string) subscriptionDerivedOracleSnapshot {
	t.Helper()
	var snapshot subscriptionDerivedOracleSnapshot
	if err := app.DB().NewQuery(`SELECT subscription_id, user_id, search_text_lower, status, auto_renew, repeat_reminder_enabled
		FROM subscription_list_index WHERE user_id = {:user} ORDER BY subscription_id`).
		Bind(dbx.Params{"user": userID}).All(&snapshot.Projection); err != nil {
		t.Fatal(err)
	}
	if err := app.DB().NewQuery(`SELECT subscription_id, tag_norm, tag FROM subscription_tags
		WHERE user_id = {:user} ORDER BY subscription_id, tag_norm`).Bind(dbx.Params{"user": userID}).All(&snapshot.Tags); err != nil {
		t.Fatal(err)
	}
	stats, err := getSubscriptionStats(app, userID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Stats = stats
	var repeatRows []struct {
		SubscriptionID string `db:"subscription_id"`
	}
	if err := app.DB().NewQuery(`SELECT subscription_id FROM subscription_repeat_schedule
		WHERE user_id = {:user} ORDER BY subscription_id`).Bind(dbx.Params{"user": userID}).All(&repeatRows); err != nil {
		t.Fatal(err)
	}
	for _, row := range repeatRows {
		snapshot.RepeatIDs = append(snapshot.RepeatIDs, row.SubscriptionID)
	}
	var scheduler struct {
		AutoRenew     int    `db:"autoRenewCount"`
		RepeatEnabled int    `db:"repeatReminderCount"`
		NextRepeatDue string `db:"nextRepeatNotificationDueAtUTC"`
	}
	if err := app.DB().NewQuery(`SELECT autoRenewCount, repeatReminderCount, nextRepeatNotificationDueAtUTC
		FROM subscription_scheduler_states WHERE user = {:user} LIMIT 1`).Bind(dbx.Params{"user": userID}).One(&scheduler); err != nil {
		t.Fatal(err)
	}
	snapshot.AutoRenew = scheduler.AutoRenew
	snapshot.RepeatEnabled = scheduler.RepeatEnabled
	snapshot.HasRepeatDue = scheduler.NextRepeatDue != ""
	return snapshot
}
