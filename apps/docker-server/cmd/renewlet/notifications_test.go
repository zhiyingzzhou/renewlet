package main

// 通知测试保护 due item 分类、reminderDays 哨兵、IANA timezone/HH:mm 本地墙钟和 HTTPS-only 外发边界。

import (
	"encoding/json"
	"maps"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestNotificationSenderRegistryMatchesKnownChannels(t *testing.T) {
	known := make([]string, 0, len(knownChannels))
	for channel := range maps.Keys(knownChannels) {
		known = append(known, channel)
	}
	registered := make([]string, 0, len(notificationSenders))
	for channel := range maps.Keys(notificationSenders) {
		registered = append(registered, channel)
	}
	sort.Strings(known)
	sort.Strings(registered)
	if strings.Join(registered, ",") != strings.Join(known, ",") {
		t.Fatalf("notification sender registry mismatch: registered=%v known=%v", registered, known)
	}
}

func TestNotificationRoutesUseCurrentRequestLocale(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "notification-request-locale")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.EnabledChannels = []string{"serverchan"}
	createNotificationCronRouteTestSettings(t, app, user, settings)

	type capturedNotification struct {
		locale  appLocale
		message notificationMessage
	}
	captured := []capturedNotification{}
	originalSender := notificationSenders["serverchan"]
	notificationSenders["serverchan"] = notificationSenderFunc(func(_ core.App, _ appSettings, message notificationMessage, locale appLocale) error {
		captured = append(captured, capturedNotification{locale: locale, message: message})
		return nil
	})
	defer func() { notificationSenders["serverchan"] = originalSender }()

	headers := map[string]string{"X-Renewlet-Locale": "zh-CN"}
	testResponse := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/notifications/test", `{"channel":"serverchan"}`, token, headers)
	if testResponse.Code != http.StatusOK {
		t.Fatalf("expected notification test 200, got %d: %s", testResponse.Code, testResponse.Body.String())
	}
	manualResponse := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/notifications/run", `{"force":true}`, token, headers)
	if manualResponse.Code != http.StatusOK {
		t.Fatalf("expected manual notification run 200, got %d: %s", manualResponse.Code, manualResponse.Body.String())
	}

	if len(captured) != 2 {
		t.Fatalf("expected test and manual notifications, got %#v", captured)
	}
	if captured[0].locale != localeZhCN || captured[0].message.Title != "Renewlet 测试通知" {
		t.Fatalf("test notification should use the current request locale: %#v", captured[0])
	}
	if captured[1].locale != localeZhCN || captured[1].message.Title != "Renewlet 订阅提醒" {
		t.Fatalf("manual notification should use the current request locale: %#v", captured[1])
	}
}

func TestNotificationCronAutoPreferenceUsesEnglishContent(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "notification-cron-locale")
	settings := defaultAppSettings()
	settings.LocalePreference = string(autoLocalePreference)
	settings.EnabledChannels = []string{"serverchan"}
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	createNotificationCronRouteTestSettings(t, app, user, settings)

	var capturedLocale appLocale
	var capturedMessage notificationMessage
	originalSender := notificationSenders["serverchan"]
	notificationSenders["serverchan"] = notificationSenderFunc(func(_ core.App, _ appSettings, message notificationMessage, locale appLocale) error {
		capturedLocale = locale
		capturedMessage = message
		return nil
	})
	defer func() { notificationSenders["serverchan"] = originalSender }()

	result, err := runNotificationCron(app, notificationCronOptions{
		Force: true,
		Now:   time.Date(2026, 5, 14, 8, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Sent != 1 || capturedLocale != localeEnUS || capturedMessage.Title != "Renewlet subscription reminder" {
		t.Fatalf("auto cron content should use the English background fallback: result=%#v locale=%q message=%#v", result, capturedLocale, capturedMessage)
	}
}

func TestBuildDueNotificationForLocalDate(t *testing.T) {
	settings := defaultAppSettings()
	settings.ShowExpired = true
	settings.Timezone = "Asia/Shanghai"

	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "renewal", Name: "Renewal", Price: "18", Currency: "CNY", Status: "active", NextBillingDate: "2026-05-17", ReminderDays: 3},
		{ID: "trial", Name: "Trial", Price: "9.9", Currency: "USD", Status: "trial", NextBillingDate: "2026-06-01", TrialEndDate: "2026-05-15", ReminderDays: 1},
		{ID: "expired", Name: "Expired", Price: "12", Currency: "EUR", Status: "active", NextBillingDate: "2026-05-01", ReminderDays: 7},
	}, true, accountContentLocale(settings))

	if !message.HasPayload {
		t.Fatal("expected notification payload")
	}
	if len(message.Items) != 3 {
		t.Fatalf("expected 3 notification items, got %d", len(message.Items))
	}
	if message.Items[0].Type != "renewal" || message.Items[1].Type != "trial" || message.Items[2].Type != "expired" {
		t.Fatalf("unexpected item types: %#v", message.Items)
	}
}

func TestBuildDueNotificationSkipsOneTimePurchases(t *testing.T) {
	settings := defaultAppSettings()
	settings.ShowExpired = true
	settings.Timezone = "Asia/Shanghai"

	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "one-time", Name: "Lifetime", Price: "199", Currency: "USD", Status: "active", BillingCycle: "one-time", NextBillingDate: "2026-05-14", TrialEndDate: "2026-05-14", ReminderDays: 0},
	}, true, accountContentLocale(settings))

	if message.HasPayload || len(message.Items) != 0 {
		t.Fatalf("expected one-time purchase to be excluded from notifications, got %#v", message.Items)
	}
}

func TestBuildDueNotificationCreatesOneTimeFixedTermExpiry(t *testing.T) {
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.ShowExpired = false
	settings.Timezone = "Asia/Shanghai"

	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "fixed-term", Name: "Fixed Term", Price: "120", Currency: "USD", Status: "active", BillingCycle: "one-time", OneTimeTermCount: 6, OneTimeTermUnit: "month", NextBillingDate: "2026-05-17", ReminderDays: 3},
	}, true, accountContentLocale(settings))

	if !message.HasPayload || len(message.Items) != 1 {
		t.Fatalf("expected one fixed-term expiry notification, got %#v", message.Items)
	}
	if message.Items[0].Type != "expiry" || message.Items[0].SubscriptionID != "fixed-term" {
		t.Fatalf("expected expiry item, got %#v", message.Items[0])
	}
	if !strings.Contains(message.Content, "即将到期") || strings.Contains(message.Content, "即将续费：") {
		t.Fatalf("expected expiry copy only, got %q", message.Content)
	}
}

func TestBuildDueNotificationUsesEnglishLocale(t *testing.T) {
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.Timezone = "UTC"

	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "renewal", Name: "Renewal", Price: "18", Currency: "USD", Status: "active", NextBillingDate: "2026-05-17", ReminderDays: 3},
	}, true, accountContentLocale(settings))

	if message.Title != "Renewlet subscription reminder" {
		t.Fatalf("unexpected title %q", message.Title)
	}
	if !strings.Contains(message.Content, "Upcoming renewals") || !strings.Contains(message.Content, "3 days before") {
		t.Fatalf("expected English notification content, got %q", message.Content)
	}
}

func TestBuildDueNotificationUsesGlobalReminderForInheritedSubscription(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationReminderDays = 5

	message := buildDueNotificationForLocalDate("2026-05-12", time.Date(2026, 5, 12, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "inherit", Name: "Inherited", Price: "18", Currency: "USD", Status: "active", NextBillingDate: "2026-05-17", ReminderDays: inheritReminderDays},
	}, true, accountContentLocale(settings))

	if !message.HasPayload || len(message.Items) != 1 {
		t.Fatalf("expected inherited reminder item, got %#v", message.Items)
	}
	if message.Items[0].ReminderDays != 5 {
		t.Fatalf("expected effective reminder days in history payload, got %d", message.Items[0].ReminderDays)
	}
}

func TestBuildDueNotificationSkipsDisabledReminderSubscription(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"

	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "quiet", Name: "Quiet", Price: "18", Currency: "USD", Status: "active", NextBillingDate: "2026-05-14", ReminderDays: disabledReminderDays},
	}, true, accountContentLocale(settings))

	if message.HasPayload || len(message.Items) != 0 {
		t.Fatalf("expected disabled reminder subscription to be excluded, got %#v", message.Items)
	}
}

func TestRepeatReminderScheduleBuildsRepeatItem(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"

	subscriptions := []notificationSubscription{{
		ID:                     "critical",
		Name:                   "Critical SaaS",
		Price:                  "99",
		Currency:               "USD",
		Status:                 "active",
		NextBillingDate:        "2026-05-17",
		ReminderDays:           3,
		RepeatReminderEnabled:  true,
		RepeatReminderInterval: "1h",
		RepeatReminderWindow:   "72h",
	}}
	now := time.Date(2026, 5, 14, 9, 0, 30, 0, time.UTC)

	schedule := getNotificationScheduleDecision(now, settings, subscriptions, 2, false)
	if !schedule.Due || schedule.ScheduledLocalTime != "09:00" {
		t.Fatalf("expected 09:00 repeat reminder to be due, got %#v", schedule)
	}

	message := buildDueNotificationForSchedule(schedule.localScheduleOccurrence, now, settings, subscriptions, true, accountContentLocale(settings))
	if !message.HasPayload || len(message.Items) != 1 {
		t.Fatalf("expected one repeat reminder item, got %#v", message)
	}
	item := message.Items[0]
	if item.RepeatReminder == nil || item.RepeatReminder.Interval != "1h" || item.RepeatReminder.Window != "72h" {
		t.Fatalf("expected repeat reminder snapshot, got %#v", item.RepeatReminder)
	}
	expectedRepeatCopy := formatRepeatReminderText("1h", defaultAppLocale)
	if !strings.Contains(message.Content, expectedRepeatCopy) {
		t.Fatalf("expected repeat reminder copy in content, got %q", message.Content)
	}
}

func TestRepeatReminderScheduleSkipsDisabledReminderSubscription(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"

	subscriptions := []notificationSubscription{{
		ID:                     "quiet",
		Name:                   "Quiet SaaS",
		Price:                  "99",
		Currency:               "USD",
		Status:                 "active",
		NextBillingDate:        "2026-05-17",
		ReminderDays:           disabledReminderDays,
		RepeatReminderEnabled:  true,
		RepeatReminderInterval: "1h",
		RepeatReminderWindow:   "72h",
	}}
	now := time.Date(2026, 5, 14, 9, 0, 30, 0, time.UTC)

	schedule := getNotificationScheduleDecision(now, settings, subscriptions, 2, false)
	if schedule.Due {
		t.Fatalf("expected disabled reminder subscription to skip repeat schedule, got %#v", schedule)
	}

	message := buildDueNotificationForSchedule(localScheduleOccurrence{
		ScheduledLocalDate:  "2026-05-14",
		ScheduledLocalTime:  "09:00",
		TimeZone:            "UTC",
		ScheduledInstantUTC: "2026-05-14T09:00:00Z",
	}, now, settings, subscriptions, true, accountContentLocale(settings))
	if message.HasPayload || len(message.Items) != 0 {
		t.Fatalf("expected disabled reminder subscription to skip repeat items, got %#v", message.Items)
	}
}

func TestRepeatReminderScheduleUsesGlobalReminderForInheritedSubscription(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.NotificationReminderDays = 5

	subscriptions := []notificationSubscription{{
		ID:                     "critical",
		Name:                   "Critical SaaS",
		Price:                  "99",
		Currency:               "USD",
		Status:                 "active",
		NextBillingDate:        "2026-05-17",
		ReminderDays:           inheritReminderDays,
		RepeatReminderEnabled:  true,
		RepeatReminderInterval: "1h",
		RepeatReminderWindow:   "full",
	}}
	now := time.Date(2026, 5, 12, 9, 0, 30, 0, time.UTC)

	schedule := getNotificationScheduleDecision(now, settings, subscriptions, 2, false)
	if !schedule.Due || schedule.ScheduledLocalTime != "09:00" {
		t.Fatalf("expected inherited repeat reminder to be due, got %#v", schedule)
	}

	message := buildDueNotificationForSchedule(schedule.localScheduleOccurrence, now, settings, subscriptions, true, accountContentLocale(settings))
	if !message.HasPayload || len(message.Items) != 1 {
		t.Fatalf("expected one inherited repeat item, got %#v", message.Items)
	}
	if message.Items[0].ReminderDays != 5 || message.Items[0].RepeatReminder == nil {
		t.Fatalf("expected effective repeat reminder snapshot, got %#v", message.Items[0])
	}
}

func TestRepeatReminderWindowLimitsLongAdvanceReminder(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	repeat := repeatReminderSnapshot{Interval: "1h", Window: "72h"}

	if _, ok := repeatReminderDueOccurrence(time.Date(2026, 5, 10, 9, 0, 0, 0, time.UTC), settings, 30, "2026-05-17", repeat, 2); ok {
		t.Fatal("expected 72h repeat window to suppress earlier occurrences")
	}
	if occurrence, ok := repeatReminderDueOccurrence(time.Date(2026, 5, 14, 9, 0, 0, 0, time.UTC), settings, 30, "2026-05-17", repeat, 2); !ok || occurrence.ScheduledLocalTime != "09:00" {
		t.Fatalf("expected occurrence inside 72h window, got %#v ok=%v", occurrence, ok)
	}
}

func TestRepeatReminderOccurrenceHandlesDSTGap(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "America/New_York"
	settings.NotificationTimeLocal = "01:30"
	repeat := repeatReminderSnapshot{Interval: "1h", Window: "full"}

	occurrence, ok := repeatReminderDueOccurrence(time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC), settings, 2, "2026-03-09", repeat, 2)
	if !ok {
		t.Fatal("expected repeat reminder to remain due across the DST spring-forward gap")
	}
	if occurrence.ScheduledLocalDate != "2026-03-08" || occurrence.ScheduledLocalTime != "03:30" {
		t.Fatalf("unexpected local occurrence across DST gap: %#v", occurrence)
	}
}

func TestRegularAndRepeatReminderItemsShareOneSchedule(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	schedule := localScheduleOccurrence{
		ScheduledLocalDate:  "2026-05-15",
		ScheduledLocalTime:  "08:00",
		TimeZone:            "UTC",
		ScheduledInstantUTC: "2026-05-15T08:00:00Z",
	}

	message := buildDueNotificationForSchedule(schedule, time.Date(2026, 5, 15, 8, 0, 0, 0, time.UTC), settings, []notificationSubscription{
		{
			ID:                     "repeat",
			Name:                   "Repeat",
			Price:                  "10",
			Currency:               "USD",
			Status:                 "active",
			NextBillingDate:        "2026-05-17",
			ReminderDays:           3,
			RepeatReminderEnabled:  true,
			RepeatReminderInterval: "24h",
			RepeatReminderWindow:   "72h",
		},
		{
			ID:              "regular",
			Name:            "Regular",
			Price:           "20",
			Currency:        "USD",
			Status:          "active",
			NextBillingDate: "2026-05-18",
			ReminderDays:    3,
		},
	}, true, accountContentLocale(settings))

	if len(message.Items) != 2 {
		t.Fatalf("expected regular and repeat items in one schedule, got %#v", message.Items)
	}
	if message.Items[0].RepeatReminder != nil || message.Items[1].RepeatReminder == nil {
		t.Fatalf("expected regular item then repeat item, got %#v", message.Items)
	}
}

func TestRepeatReminderCandidateSubscriptionsMatchFullFiltering(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "repeat-candidates")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.NotificationReminderDays = 5
	now := time.Date(2026, 5, 14, 9, 0, 0, 0, time.UTC)

	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Repeat Explicit", "nextBillingDate": "2026-05-17", "reminderDays": 3, "repeatReminderEnabled": true, "repeatReminderInterval": "1h", "repeatReminderWindow": "72h"})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Repeat Inherit", "nextBillingDate": "2026-05-19", "reminderDays": inheritReminderDays, "repeatReminderEnabled": true, "repeatReminderInterval": "1h", "repeatReminderWindow": "full"})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Repeat Trial", "status": "trial", "nextBillingDate": "2026-06-01", "trialEndDate": "2026-05-17", "reminderDays": 3, "repeatReminderEnabled": true, "repeatReminderInterval": "1h", "repeatReminderWindow": "72h"})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Quiet Repeat", "nextBillingDate": "2026-05-17", "reminderDays": disabledReminderDays, "repeatReminderEnabled": true})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "One Time Repeat", "billingCycle": "one-time", "oneTimeTermCount": 6, "oneTimeTermUnit": "month", "nextBillingDate": "2026-05-17", "reminderDays": 3, "repeatReminderEnabled": true})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Regular Only", "nextBillingDate": "2026-05-17", "reminderDays": 3, "repeatReminderEnabled": false})

	full, err := listNotificationSubscriptions(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := listRepeatReminderCandidateSubscriptions(app, user.Id, settings, now)
	if err != nil {
		t.Fatal(err)
	}
	fullSchedule := getRepeatScheduleDecision(now, settings, full, 2)
	candidateSchedule := getRepeatScheduleDecision(now, settings, candidates, 2)
	if !candidateSchedule.Due || candidateSchedule.ScheduledLocalTime != fullSchedule.ScheduledLocalTime {
		t.Fatalf("candidate repeat schedule = %#v, want %#v", candidateSchedule, fullSchedule)
	}
	fullMessage := buildDueNotificationForSchedule(fullSchedule.localScheduleOccurrence, now, settings, full, true, accountContentLocale(settings))
	candidateMessage := buildDueNotificationForSchedule(candidateSchedule.localScheduleOccurrence, now, settings, candidates, true, accountContentLocale(settings))
	if got, want := notificationItemKeys(candidateMessage.Items), notificationItemKeys(fullMessage.Items); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("candidate repeat items = %#v, want %#v", got, want)
	}
}

func TestNotificationCronNonDueDoesNotCreateJobOrRenewSubscriptions(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "non-due-cron")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	createNotificationCronRouteTestSettings(t, app, user, settings)
	expired := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Expired Auto", "startDate": "2026-01-01", "nextBillingDate": "2026-05-01", "autoRenew": true})
	for i := 0; i < 20; i++ {
		createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Unrelated " + strconv.Itoa(i), "nextBillingDate": "2026-08-01", "repeatReminderEnabled": false})
	}
	now := time.Date(2026, 5, 14, 7, 0, 0, 0, time.UTC)
	refreshNotificationSchedulerForTest(t, app, user.Id, now)

	result, err := runNotificationCron(app, notificationCronOptions{
		Now:           now,
		WindowMinutes: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Processed != 0 || result.Skipped != 0 || len(result.Results) != 0 {
		t.Fatalf("unexpected non-due cron result: %#v", result)
	}
	jobs, err := app.FindAllRecords("notification_jobs")
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 0 {
		t.Fatalf("expected non-due cron not to create jobs, got %d", len(jobs))
	}
	reloaded, err := app.FindRecordById("subscriptions", expired.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.GetString("nextBillingDate"); got != "2026-05-01" {
		t.Fatalf("expected non-due notification cron not to run renewal maintenance, got nextBillingDate=%q", got)
	}
}

func notificationItemKeys(items []notificationContentItem) []string {
	keys := make([]string, 0, len(items))
	for _, item := range items {
		repeat := ""
		if item.RepeatReminder != nil {
			repeat = item.RepeatReminder.Interval + "/" + item.RepeatReminder.Window
		}
		collection := ""
		if item.CostSharing != nil {
			collection = item.CostSharing.MemberName + "/" + item.CostSharing.Amount + "/" + item.CostSharing.Currency
		}
		keys = append(keys, item.Type+"|"+item.Name+"|"+item.TargetDate+"|"+repeat+"|"+collection)
	}
	sort.Strings(keys)
	return keys
}

func TestRepeatReminderCronCreatesOneIdempotentJob(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "repeat")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.EnabledChannels = []string{}
	createNotificationCronRouteTestSettings(t, app, user, settings)

	record := newSubscriptionRecord(t, app, user.Id, []string{}, "Critical SaaS")
	record.Set("nextBillingDate", "2026-05-17")
	record.Set("reminderDays", 3)
	record.Set("repeatReminderEnabled", true)
	record.Set("repeatReminderInterval", "1h")
	record.Set("repeatReminderWindow", "72h")
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 5, 14, 9, 0, 0, 0, time.UTC)
	refreshNotificationSchedulerForTest(t, app, user.Id, now)
	options := notificationCronOptions{
		Now:           now,
		WindowMinutes: 2,
	}
	first, err := runNotificationCron(app, options)
	if err != nil {
		t.Fatal(err)
	}
	second, err := runNotificationCron(app, options)
	if err != nil {
		t.Fatal(err)
	}
	if first.Skipped != 1 || second.Skipped != 1 || second.Results[0].Reason != "already_skipped" {
		t.Fatalf("expected first skipped job then idempotent skip, got first=%#v second=%#v", first, second)
	}
	jobs, err := app.FindAllRecords("notification_jobs")
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("expected one notification job, got %d", len(jobs))
	}
	var result notificationJobResult
	history, err := loadNotificationHistoryJobs(app, user.Id, "all", 1, 0)
	if err != nil || len(history) != 1 {
		t.Fatalf("missing history: %v", err)
	}
	if err := json.Unmarshal(history[0].Result, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Message.Items) != 1 || result.Message.Items[0].RepeatReminder == nil {
		t.Fatalf("expected repeat item in job result, got %#v", result.Message.Items)
	}
}

func TestLocalScheduleDecisionUsesUserTimezone(t *testing.T) {
	now := time.Date(2026, 5, 14, 0, 1, 0, 0, time.UTC)
	decision := getLocalScheduleDecision(now, "Asia/Shanghai", "08:00", 2, false)

	if !decision.Due {
		t.Fatalf("expected schedule to be due, got reason %q", decision.Reason)
	}
	if decision.ScheduledLocalDate != "2026-05-14" {
		t.Fatalf("unexpected local date %q", decision.ScheduledLocalDate)
	}
	if decision.ScheduledInstantUTC != "2026-05-14T00:00:00Z" {
		t.Fatalf("unexpected instant %q", decision.ScheduledInstantUTC)
	}
}

func TestMergeSettingsSanitizesNotificationFields(t *testing.T) {
	settings, err := mergeSettings(defaultAppSettings(), json.RawMessage(`{
		"timezone": "Not/AZone",
		"notificationTimeLocal": "99:99",
		"enabledChannels": ["telegram", "serverchan", "telegram", "unknown", "serverchan", "email"],
		"exchangeRateProvider": "unknown",
		"notificationReminderDays": -2,
		"webhookMethod": "DELETE",
		"webhookHeaders": `+strconv.Quote(legacyWebhookHeadersExample)+`,
		"webhookPayload": `+strconv.Quote(legacyWebhookPayloadExample)+`,
		"wechatMessageType": "xml",
		"barkServerUrl": ""
	}`))
	if err != nil {
		t.Fatal(err)
	}

	if settings.Timezone != "UTC" {
		t.Fatalf("expected timezone fallback, got %q", settings.Timezone)
	}
	if settings.NotificationTimeLocal != "08:00" {
		t.Fatalf("expected local time fallback, got %q", settings.NotificationTimeLocal)
	}
	if settings.NotificationReminderDays != defaultNotificationReminderDays {
		t.Fatalf("expected global reminder fallback, got %d", settings.NotificationReminderDays)
	}
	if len(settings.EnabledChannels) != 3 || settings.EnabledChannels[0] != "telegram" || settings.EnabledChannels[1] != "serverchan" || settings.EnabledChannels[2] != "email" {
		t.Fatalf("unexpected channels %#v", settings.EnabledChannels)
	}
	if settings.ExchangeRateProvider != "frankfurter" {
		t.Fatalf("expected exchange-rate provider fallback, got %q", settings.ExchangeRateProvider)
	}
	if settings.WebhookMethod != "POST" || settings.DingTalkMessageType != dingtalkMessageTypeMarkdown || settings.WechatMessageType != "text" || settings.BarkServerURL != "https://api.day.app" {
		t.Fatalf("settings were not sanitized: %#v", settings)
	}
	if settings.WebhookHeaders != "" || settings.WebhookPayload != "" {
		t.Fatalf("expected legacy Webhook examples to be cleared, got headers=%q payload=%q", settings.WebhookHeaders, settings.WebhookPayload)
	}
}

func TestMergeSettingsPreservesSupportedExchangeRateProvider(t *testing.T) {
	settings, err := mergeSettings(defaultAppSettings(), json.RawMessage(`{
		"exchangeRateProvider": "frankfurter"
	}`))
	if err != nil {
		t.Fatal(err)
	}

	if settings.ExchangeRateProvider != "frankfurter" {
		t.Fatalf("expected exchange-rate provider to be preserved, got %q", settings.ExchangeRateProvider)
	}
}

func TestMergeSettingsPreservesExchangeApiProvider(t *testing.T) {
	settings, err := mergeSettings(defaultAppSettings(), json.RawMessage(`{
		"exchangeRateProvider": "exchange-api"
	}`))
	if err != nil {
		t.Fatal(err)
	}

	if settings.ExchangeRateProvider != "exchange-api" {
		t.Fatalf("expected exchange-rate provider to be preserved, got %q", settings.ExchangeRateProvider)
	}
}

func TestBuildBarkRequestURLAddsSinglePublicSubscriptionIcon(t *testing.T) {
	settings := defaultAppSettings()
	settings.BarkDeviceKey = "device-key"
	settings.BarkSilentPush = true

	requestURL, err := buildBarkRequestURL(settings, notificationMessage{
		Title:     "Renewlet 订阅提醒",
		Content:   "即将续费：\nAWS",
		Timestamp: "2026-05-14 08:00",
		Items: []notificationContentItem{{
			Name:    "AWS",
			LogoURL: "https://cdn.example.com/icons/aws.png?size=128",
		}},
	}, defaultAppLocale)
	if err != nil {
		t.Fatal(err)
	}

	query := requestURL.Query()
	if got := query.Get("icon"); got != "https://cdn.example.com/icons/aws.png?size=128" {
		t.Fatalf("expected Bark icon query to use subscription logo, got %q", got)
	}
	if got := query.Get("group"); got != "Renewlet" {
		t.Fatalf("expected Bark group, got %q", got)
	}
	if got := query.Get("sound"); got != "none" {
		t.Fatalf("expected silent Bark sound, got %q", got)
	}
}

func TestBuildBarkRequestURLSkipsUnsafeOrAmbiguousIcons(t *testing.T) {
	settings := defaultAppSettings()
	settings.BarkDeviceKey = "device-key"
	cases := []struct {
		name  string
		items []notificationContentItem
	}{
		{name: "no items", items: nil},
		{name: "multiple items", items: []notificationContentItem{
			{Name: "AWS", LogoURL: "https://cdn.example.com/aws.png"},
			{Name: "OpenAI", LogoURL: "https://cdn.example.com/openai.png"},
		}},
		{name: "empty logo", items: []notificationContentItem{{Name: "AWS"}}},
		{name: "private asset path", items: []notificationContentItem{{Name: "AWS", LogoURL: "/api/app/assets/abc"}}},
		{name: "data url", items: []notificationContentItem{{Name: "AWS", LogoURL: "data:image/png;base64,abc"}}},
		{name: "blob url", items: []notificationContentItem{{Name: "AWS", LogoURL: "blob:http://example.com/abc"}}},
		{name: "plain http", items: []notificationContentItem{{Name: "AWS", LogoURL: "http://cdn.example.com/aws.png"}}},
		{name: "localhost", items: []notificationContentItem{{Name: "AWS", LogoURL: "https://localhost/aws.png"}}},
		{name: "loopback ip", items: []notificationContentItem{{Name: "AWS", LogoURL: "https://127.0.0.1/aws.png"}}},
		{name: "private ip", items: []notificationContentItem{{Name: "AWS", LogoURL: "https://10.0.0.1/aws.png"}}},
		{name: "userinfo", items: []notificationContentItem{{Name: "AWS", LogoURL: "https://user@example.com/aws.png"}}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requestURL, err := buildBarkRequestURL(settings, notificationMessage{
				Title:     "Renewlet 订阅提醒",
				Content:   "即将续费",
				Timestamp: "2026-05-14 08:00",
				Items:     tc.items,
			}, defaultAppLocale)
			if err != nil {
				t.Fatal(err)
			}
			if got := requestURL.Query().Get("icon"); got != "" {
				t.Fatalf("expected no Bark icon query, got %q", got)
			}
		})
	}
}

func TestNotificationContentItemLogoURLIsInternalOnly(t *testing.T) {
	payload, err := json.Marshal(notificationContentItem{
		Name:    "AWS",
		LogoURL: "https://cdn.example.com/aws.png",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "LogoURL") || strings.Contains(string(payload), "cdn.example.com") {
		t.Fatalf("expected logo url to be omitted from notification JSON, got %s", payload)
	}
}
