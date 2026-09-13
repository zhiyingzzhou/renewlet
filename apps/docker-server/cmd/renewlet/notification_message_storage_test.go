package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func TestNotificationHistoryBrowserFixture(test *testing.T) {
	userID := os.Getenv("RENEWLET_E2E_NOTIFICATION_USER")
	var app *pocketbase.PocketBase
	if userID == "" {
		app = newSchemaTestApp(test)
		if err := ensureSchema(app); err != nil {
			test.Fatal(err)
		}
		user, _ := createRouteTestUser(test, app, "notification-browser-fixture")
		userID = user.Id
	} else {
		// 浏览器夹具只允许写 Playwright 已创建的固定隔离库；不接收数据目录，也不负责建库或迁移。
		directory, err := filepath.Abs("../../pb_data_e2e")
		if err != nil {
			test.Fatal(err)
		}
		resolved, err := filepath.EvalSymlinks(directory)
		if err != nil || resolved != directory {
			test.Fatalf("browser fixture requires a non-symlink E2E directory: %v", err)
		}
		info, err := os.Lstat(filepath.Join(directory, "data.db"))
		if err != nil || !info.Mode().IsRegular() {
			test.Fatalf("browser fixture requires the existing E2E database: %v", err)
		}
		app = pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: directory})
		registerAuthHooks(app)
		if err := app.Bootstrap(); err != nil {
			test.Fatal(err)
		}
		test.Cleanup(func() { _ = app.ResetBootstrapState() })
		if _, err := app.FindRecordById("users", userID); err != nil {
			test.Fatal(err)
		}
	}
	registerRecordHooks(app)
	expectedMessages := make(map[string]notificationJobResultMessage, 12)
	// 整批夹具走同一真实事务和 finalize，历史 API 必须读到完整正文，而不是由浏览器模拟响应。
	if err := app.RunInTransaction(func(txApp core.App) error {
		for index := 0; index < 12; index++ {
			result := largeNotificationJobResult(1)
			instant := time.Date(2026, 5, 18, 20, index, 0, 0, time.UTC).Format(time.RFC3339)
			result.Schedule = localScheduleOccurrence{
				ScheduledLocalDate: "2026-05-19", ScheduledLocalTime: fmt.Sprintf("04:%02d", index),
				TimeZone: "Asia/Shanghai", ScheduledInstantUTC: instant,
			}
			result.TriggeredAtUTC = instant
			result.Settings.Timezone = "Asia/Shanghai"
			result.Settings.NotificationTimeLocal = "04:00"
			result.Settings.EnabledChannels = []string{"email"}
			result.Message.Title = "Renewlet 订阅提醒"
			result.Message.Timestamp = instant
			result.Message.Content = fmt.Sprintf("通知内容快照 %d\n%s", index, strings.Repeat("Long diagnostic payload ", 40))
			result.Message.Items[0].Name = fmt.Sprintf("Notification Drawer Seed %d", index)
			result.Message.Items[0].Price = "19"
			result.Message.Items[0].Currency = "USD"
			result.Message.Items[0].TargetDate = "2026-05-20"
			result.Message.Items[0].ReminderDays = 1
			result.Message.Items[0].DaysUntil = 1
			reason := "some_channels_failed"
			result.Reason = &reason
			errorText := fmt.Sprintf("email: dial tcp: lookup smtp.example.com: no such host %d", index)
			result.Channels = jobChannels{Attempted: []string{"email"}, Succeeded: []string{}, Failed: []channelFailure{{Channel: "email", Error: errorText}}}
			schedule := localScheduleDecision{localScheduleOccurrence: result.Schedule}
			job, _, err := createNotificationJob(txApp, userID, schedule, notificationStatusFailed, index+1)
			if err != nil {
				return err
			}
			if job == nil {
				return fmt.Errorf("browser notification fixture %d already exists", index)
			}
			if err := finalizeNotificationJob(txApp, job, userID, schedule, notificationStatusFailed, errorText, result); err != nil {
				return err
			}
			expectedMessages[job.Id] = result.Message
		}
		return nil
	}); err != nil {
		test.Fatal(err)
	}
	history, err := loadNotificationHistoryJobs(app, userID, "all", 20, 0)
	if err != nil || len(history) != len(expectedMessages) {
		test.Fatalf("browser fixture history is incomplete: %v", err)
	}
	for _, job := range history {
		if job.Status != notificationStatusFailed || !reflect.DeepEqual(assertNormalizedCronResult(test, job).Message, expectedMessages[job.ID]) {
			test.Fatal("browser fixture changed message or final state")
		}
	}
}

func TestNotificationLargeHistoryPreservesCompleteMessage(t *testing.T) {
	for _, size := range []int{10, 100, 1000, 5000} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			user, token := createRouteTestUser(t, app, "large-history")
			result := largeNotificationJobResult(size)
			schedule := localScheduleDecision{localScheduleOccurrence: result.Schedule}
			record, _, err := createNotificationJob(app, user.Id, schedule, notificationStatusSending, 1)
			if err != nil {
				t.Fatal(err)
			}
			payload, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("items=%d complete result bytes=%d", size, len(payload))
			// 最终状态保存不能受消息条数影响；历史正文必须保留发送时快照，不能截断或从当前订阅重建。
			if err := finalizeNotificationJob(app, record, user.Id, schedule, notificationStatusSent, "", result); err != nil {
				t.Fatal(err)
			}
			history := requestNotificationHistory(t, app, token)
			if len(history.Jobs) != 1 || history.Jobs[0].Status != notificationStatusSent {
				t.Fatalf("unexpected completed history: %+v", history)
			}
			actual := assertNormalizedCronResult(t, history.Jobs[0])
			if !reflect.DeepEqual(actual, result) {
				t.Fatal("history changed the complete sent result")
			}
			operations, err := measureSubscriptionDBOperations(app, func() error {
				_, err := loadNotificationHistoryJobs(app, user.Id, "all", 20, 0)
				return err
			})
			if err != nil || operations.ReadQueries != 1 || operations.WriteStatements != 0 {
				t.Fatalf("history must read one consistent snapshot without writes: %+v %v", operations, err)
			}
		})
	}
}

func TestNotificationMessageReplacementRollsBack(t *testing.T) {
	for _, failure := range []string{"message", "status"} {
		t.Run(failure, func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			user, _ := createRouteTestUser(t, app, "authenticated")
			result := largeNotificationJobResult(1000)
			schedule := localScheduleDecision{localScheduleOccurrence: result.Schedule}
			job, _, err := createNotificationJob(app, user.Id, schedule, notificationStatusSending, 1)
			if err != nil {
				t.Fatal(err)
			}
			if err := finalizeNotificationJob(app, job, user.Id, schedule, notificationStatusFailed, "old failure", result); err != nil {
				t.Fatal(err)
			}
			before, err := loadNotificationHistoryJobs(app, user.Id, "all", 1, 0)
			if err != nil {
				t.Fatal(err)
			}
			statement := "CREATE TRIGGER fail_snapshot BEFORE INSERT ON notification_job_messages BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END"
			if failure == "status" {
				statement = "CREATE TRIGGER fail_snapshot BEFORE UPDATE ON notification_jobs BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END"
			}
			if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
				t.Fatal(err)
			}
			// 同时保护分段写入中断和最终态写入失败；不能只回滚其中一张表。
			if err := finalizeNotificationJob(app, job, user.Id, schedule, notificationStatusSent, "", largeNotificationJobResult(5000)); err == nil || !strings.Contains(err.Error(), "injected snapshot failure") {
				t.Fatalf("expected original failure: %v", err)
			}
			after, err := loadNotificationHistoryJobs(app, user.Id, "all", 1, 0)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("failed replacement changed history: %v", err)
			}
		})
	}
}

func TestNotificationMessageOwnershipAndDeletion(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "authenticated")
	other, otherToken := createRouteTestUser(t, app, "other")
	result := largeNotificationJobResult(1000)
	schedule := localScheduleDecision{localScheduleOccurrence: result.Schedule}
	job, _, err := createNotificationJob(app, user.Id, schedule, notificationStatusSending, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := finalizeNotificationJob(app, job, other.Id, schedule, notificationStatusSent, "", result); err == nil {
		t.Fatal("accepted other user's job")
	}
	if err := finalizeNotificationJob(app, job, user.Id, schedule, notificationStatusSent, "", result); err != nil {
		t.Fatal(err)
	}
	if len(requestNotificationHistory(t, app, otherToken).Jobs) != 0 || len(requestNotificationHistory(t, app, token).Jobs) != 1 {
		t.Fatal("history owner isolation failed")
	}
	if _, err := app.DB().NewQuery("DELETE FROM notification_job_messages WHERE job_id = {:id} AND chunk_index = 1").Bind(dbx.Params{"id": job.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := loadNotificationHistoryJobs(app, user.Id, "all", 1, 0); err == nil {
		t.Fatal("incomplete message was hidden as an empty result")
	}
	if err := app.Delete(user); err != nil {
		t.Fatal(err)
	}
	var remaining struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM notification_job_messages").One(&remaining); err != nil || remaining.Count != 0 {
		t.Fatalf("private message survived user deletion: %+v %v", remaining, err)
	}
}

func TestNotificationCronLargeBatchRetriesOnlyFailedChannel(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "authenticated")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.NotificationReminderDays = 3
	settings.EnabledChannels = []string{"webhook", "telegram"}
	settings.WebhookURL = "https://example.com/notification"
	settings.TelegramBotToken = "123:fixture"
	settings.TelegramChatID = "123"
	createNotificationCronRouteTestSettings(t, app, user, settings)
	if err := app.RunInTransaction(func(txApp core.App) error {
		for index := 0; index < 1000; index++ {
			createRouteTestSubscription(t, txApp, user.Id, map[string]interface{}{"name": fmt.Sprintf("Large batch %d", index), "autoRenew": false, "nextBillingDate": "2026-09-11", "reminderDays": 3})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	webhookCalls, telegramCalls := 0, 0
	failTelegram := true
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host == "example.com" {
			webhookCalls++
			return serverChanTestResponse(http.StatusOK, `{}`), nil
		}
		if request.URL.Host != "api.telegram.org" {
			t.Fatalf("unexpected external request %s", request.URL.Host)
		}
		telegramCalls++
		if failTelegram {
			return serverChanTestResponse(http.StatusBadRequest, `{"ok":false,"description":"fixture failure"}`), nil
		}
		return serverChanTestResponse(http.StatusOK, `{"ok":true}`), nil
	}))
	defer restore()
	options := notificationCronOptions{Now: time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC), WindowMinutes: 2, MaxRetries: 3, StaleSendingMinutes: 15}
	refreshNotificationSchedulerForTest(t, app, user.Id, options.Now)
	first, err := runNotificationCron(app, options)
	if err != nil || first.Failed != 1 {
		t.Fatalf("first run: %+v %v", first, err)
	}
	failTelegram = false
	second, err := runNotificationCron(app, options)
	if err != nil || second.Sent != 1 {
		t.Fatalf("retry run: %+v %v", second, err)
	}
	completedTelegramCalls := telegramCalls
	third, err := runNotificationCron(app, options)
	if err != nil || third.Sent != 0 || third.Failed != 0 || webhookCalls != 1 || telegramCalls != completedTelegramCalls {
		t.Fatalf("successful channel resent: webhook=%d telegram=%d result=%+v err=%v", webhookCalls, telegramCalls, third, err)
	}
	history := requestNotificationHistory(t, app, token)
	if len(history.Jobs) != 1 || len(assertNormalizedCronResult(t, history.Jobs[0]).Message.Items) != 1000 {
		t.Fatal("large cron lost history items")
	}
}

func largeNotificationJobResult(size int) notificationJobResult {
	items := make([]notificationContentItem, size)
	for index := range items {
		items[index] = notificationContentItem{
			Type: "renewal", SubscriptionID: fmt.Sprintf("sub%012d", index), Name: fmt.Sprintf("订阅 🌏 %d", index),
			Price: "12.50", Currency: "CNY", Status: "active", TargetDate: "2026-09-11", ReminderDays: 3, DaysUntil: 3,
		}
	}
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.EnabledChannels = []string{"webhook"}
	now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
	schedule := localScheduleOccurrence{ScheduledLocalDate: "2026-09-08", ScheduledLocalTime: "08:00", TimeZone: "UTC", ScheduledInstantUTC: "2026-09-08T08:00:00Z"}
	return createJobResult("", schedule, settings, appLocale("zh-CN"), buildNotificationContent(now, settings, items, appLocale("zh-CN")), notificationCronOptions{Now: now, WindowMinutes: 2}, jobChannels{Attempted: []string{"webhook"}, Succeeded: []string{"webhook"}})
}
