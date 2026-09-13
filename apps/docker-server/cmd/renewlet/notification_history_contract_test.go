package main

// 通知历史契约测试保护前端审计事实源；新写入收敛为空数组，库内坏历史出站为 `{}`。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func TestCreateJobResultUsesEmptyArraysForEmptyCollections(t *testing.T) {
	result := createJobResult(
		"no_enabled_channels",
		localScheduleOccurrence{
			ScheduledLocalDate:  "2026-05-17",
			ScheduledLocalTime:  "08:00",
			TimeZone:            "UTC",
			ScheduledInstantUTC: "2026-05-17T08:00:00Z",
		},
		defaultAppSettings(),
		defaultAppLocale,
		notificationMessage{
			Title:      "Renewlet 订阅提醒",
			Content:    "No subscriptions need reminders today.",
			Timestamp:  "2026-05-17 08:00:00 UTC",
			HasPayload: false,
		},
		notificationCronOptions{Now: time.Date(2026, 5, 17, 8, 0, 0, 0, time.UTC), WindowMinutes: 2},
		jobChannels{},
	)

	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	body := string(payload)
	for _, want := range []string{`"enabledChannels":[]`, `"items":[]`, `"attempted":[]`, `"succeeded":[]`, `"failed":[]`} {
		if !strings.Contains(body, want) {
			t.Fatalf("expected normalized job result to contain %s, got %s", want, body)
		}
	}
}

func TestNotificationHistoryRouteNormalizesNoEnabledChannelsJobArrays(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "authenticated")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.EnabledChannels = []string{}
	createNotificationCronRouteTestSettings(t, app, user, settings)

	result, err := runNotificationCron(app, notificationCronOptions{
		Now:           time.Date(2026, 5, 17, 8, 0, 0, 0, time.UTC),
		Force:         true,
		WindowMinutes: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 {
		t.Fatalf("expected one skipped notification job, got %#v", result)
	}

	body := requestNotificationHistory(t, app, token)
	if len(body.Jobs) != 1 {
		t.Fatalf("expected one history job, got %#v", body.Jobs)
	}
	assertNormalizedCronResult(t, body.Jobs[0])
}

func TestNotificationHistoryRouteDropsRawLegacyMalformedResult(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "authenticated")
	createRawNotificationHistoryJobRecord(t, app, user.Id, types.JSONRaw(`{
		"source":"cron",
		"reason":"no_enabled_channels",
		"force":false,
		"windowMinutes":2,
		"triggeredAtUtc":"2026-05-17T08:00:00Z",
		"schedule":{
			"scheduledLocalDate":"2026-05-17",
			"scheduledLocalTime":"08:00",
			"timeZone":"UTC",
			"scheduledInstantUtc":"2026-05-17T08:00:00Z",
			"due":false,
			"reason":"not_in_time_window(delta=0m)"
		},
		"settings":{
			"timezone":"UTC",
			"locale":"zh-CN",
			"notificationTimeLocal":"08:00",
			"enabledChannels":null,
			"showExpired":true
		},
		"message":{
			"title":"Renewlet 订阅提醒",
			"content":"今天没有需要提醒的订阅。",
			"timestamp":"2026-05-17 08:00:00 UTC",
			"hasPayload":false,
			"items":null
		},
		"channels":{
			"attempted":null,
			"succeeded":null,
			"failed":null
		}
	}`))

	body := requestNotificationHistory(t, app, token)
	if len(body.Jobs) != 1 {
		t.Fatalf("expected one history job, got %#v", body.Jobs)
	}
	assertEmptyJobResult(t, body.Jobs[0])
}

func TestNotificationHistoryRouteNormalizesNoDueItemsMessageArrays(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "authenticated")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.EnabledChannels = []string{"webhook"}
	createNotificationCronRouteTestSettings(t, app, user, settings)
	now := time.Date(2026, 5, 17, 8, 0, 0, 0, time.UTC)
	refreshNotificationSchedulerForTest(t, app, user.Id, now)

	result, err := runNotificationCron(app, notificationCronOptions{
		Now:           now,
		WindowMinutes: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 {
		t.Fatalf("expected one skipped notification job, got %#v", result)
	}

	body := requestNotificationHistory(t, app, token)
	if len(body.Jobs) != 1 {
		t.Fatalf("expected one history job, got %#v", body.Jobs)
	}
	cronResult := assertNormalizedCronResult(t, body.Jobs[0])
	if cronResult.Reason == nil || *cronResult.Reason != "no_due_items" {
		t.Fatalf("expected no_due_items result, got %#v", cronResult.Reason)
	}
	if len(cronResult.Message.Items) != 0 {
		t.Fatalf("expected no due items to remain an empty array, got %#v", cronResult.Message.Items)
	}
}

func TestNotificationHistoryRouteReturnsEffectiveReminderDays(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "authenticated")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.NotificationReminderDays = 5
	settings.EnabledChannels = []string{}
	createNotificationCronRouteTestSettings(t, app, user, settings)
	record := newSubscriptionRecord(t, app, user.Id, []string{}, "Inherited SaaS")
	record.Set("nextBillingDate", "2026-05-22")
	record.Set("reminderDays", inheritReminderDays)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	result, err := runNotificationCron(app, notificationCronOptions{
		Now:           time.Date(2026, 5, 17, 8, 0, 0, 0, time.UTC),
		Force:         true,
		WindowMinutes: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 {
		t.Fatalf("expected one skipped notification job, got %#v", result)
	}

	body := requestNotificationHistory(t, app, token)
	if len(body.Jobs) != 1 {
		t.Fatalf("expected one history job, got %#v", body.Jobs)
	}
	cronResult := assertNormalizedCronResult(t, body.Jobs[0])
	if len(cronResult.Message.Items) != 1 {
		t.Fatalf("expected one notification item, got %#v", cronResult.Message.Items)
	}
	if cronResult.Message.Items[0].ReminderDays != 5 {
		t.Fatalf("expected effective reminder days in history, got %d", cronResult.Message.Items[0].ReminderDays)
	}
}

func TestNotificationHistorySecondPageDoesNotReadSubscriptions(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "history-page-isolation")
	createRawNotificationHistoryJobRecordForDate(t, app, user.Id, "2026-05-17", types.JSONRaw(`{}`))
	createRawNotificationHistoryJobRecordForDate(t, app, user.Id, "2026-05-18", types.JSONRaw(`{}`))
	if _, err := app.DB().NewQuery("DROP TABLE subscriptions").Execute(); err != nil {
		t.Fatal(err)
	}

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/notifications/history?status=all&limit=1&offset=1", "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected history page to remain independent from subscriptions, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[notificationHistoryPageResponse](t, res.Body.Bytes())
	if len(body.Jobs) != 1 || body.Limit != 1 || body.Offset != 1 {
		t.Fatalf("unexpected second history page: %#v", body)
	}
}

func requestNotificationHistory(t *testing.T, app core.App, token string) notificationHistoryPageResponse {
	t.Helper()
	res := serveTestRequest(t, app, http.MethodGet, "/api/app/notifications/history?status=all&limit=20&offset=0", "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected notification history 200, got %d: %s", res.Code, res.Body.String())
	}
	return decodeAPISuccessDataForTest[notificationHistoryPageResponse](t, res.Body.Bytes())
}

func createRawNotificationHistoryJobRecord(t *testing.T, app core.App, userID string, result interface{}) *core.Record {
	return createRawNotificationHistoryJobRecordForDate(t, app, userID, "2026-05-17", result)
}

func createRawNotificationHistoryJobRecordForDate(t *testing.T, app core.App, userID string, scheduledDate string, result interface{}) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("notification_jobs")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("scheduledLocalDate", scheduledDate)
	record.Set("scheduledLocalTime", "08:00")
	record.Set("timeZone", "UTC")
	record.Set("scheduledInstantUtc", scheduledDate+"T08:00:00Z")
	record.Set("status", notificationStatusSkipped)
	record.Set("attempts", 1)
	record.Set("lastError", "")
	payload, err := jsonBytesFromValue(result)
	if err != nil {
		t.Fatal(err)
	}
	metadata, parts, err := splitNotificationJobMessage(payload)
	if err != nil {
		t.Fatal(err)
	}
	record.Set("result", metadata)
	if err := app.SaveNoValidate(record); err != nil {
		t.Fatal(err)
	}
	if err := writeNotificationJobMessage(app, record.Id, parts); err != nil {
		t.Fatal(err)
	}
	return record
}

func assertNormalizedCronResult(t *testing.T, job notificationHistoryJob) notificationJobResult {
	t.Helper()
	var result notificationJobResult
	if err := json.Unmarshal(job.Result, &result); err != nil {
		t.Fatalf("expected cron result JSON to decode: %v; raw=%s", err, job.Result)
	}
	if result.Source != "cron" {
		t.Fatalf("expected cron result source, got %#v from %s", result.Source, job.Result)
	}
	if result.Settings.EnabledChannels == nil {
		t.Fatalf("expected enabledChannels to be [], got nil in %s", job.Result)
	}
	if result.Message.Items == nil {
		t.Fatalf("expected message.items to be [], got nil in %s", job.Result)
	}
	if result.Channels.Attempted == nil {
		t.Fatalf("expected channels.attempted to be [], got nil in %s", job.Result)
	}
	if result.Channels.Succeeded == nil {
		t.Fatalf("expected channels.succeeded to be [], got nil in %s", job.Result)
	}
	if result.Channels.Failed == nil {
		t.Fatalf("expected channels.failed to be [], got nil in %s", job.Result)
	}
	return result
}

func assertEmptyJobResult(t *testing.T, job notificationHistoryJob) {
	t.Helper()
	var result map[string]interface{}
	if err := json.Unmarshal(job.Result, &result); err != nil {
		t.Fatalf("expected empty result JSON to decode: %v; raw=%s", err, job.Result)
	}
	if len(result) != 0 {
		t.Fatalf("expected empty history result for raw legacy payload, got %s", job.Result)
	}
}
