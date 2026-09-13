package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func TestBuildDueNotificationCreatesCostSharingCollectionReminders(t *testing.T) {
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.Timezone = "UTC"
	settings.NotificationReminderDays = 3
	reminderDays := inheritReminderDays

	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 8, 0, 0, 0, time.UTC), settings, []notificationSubscription{
		{
			ID:              "family",
			Name:            "Family Plan",
			Price:           "30",
			Currency:        "USD",
			Status:          "active",
			BillingCycle:    "monthly",
			NextBillingDate: "2026-05-17",
			ReminderDays:    disabledReminderDays,
			CostSharing: costSharingPayload{
				Enabled:   true,
				SplitMode: "equal",
				CollectionReminder: &costSharingCollectionReminder{
					Enabled:      true,
					ReminderDays: &reminderDays,
				},
				Members: []costSharingMember{
					{ID: "partner", Name: "Partner", JoinedDate: "2026-04-17", Currency: "USD"},
					{ID: "friend", Name: "Friend", JoinedDate: "2026-04-17", Currency: "USD"},
				},
			},
		},
	}, true, accountContentLocale(settings))

	if !message.HasPayload || len(message.Items) != 2 {
		t.Fatalf("expected two collection reminders, got %#v", message.Items)
	}
	for _, item := range message.Items {
		if item.Type != "costSharing" || item.CostSharing == nil || item.CostSharing.Amount != "10" || item.CostSharing.Currency != "USD" {
			t.Fatalf("unexpected cost sharing item: %#v", item)
		}
	}
	if !strings.Contains(message.Content, "家庭共享收款") || strings.Contains(message.Content, "即将续费：") {
		t.Fatalf("expected only collection copy in content, got %q", message.Content)
	}
}

func TestBuildDueNotificationUsesCustomCostSharingCollectionCurrency(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	reminderDays := 1
	customAmount := "42"

	message := buildDueNotificationForLocalDate("2026-05-16", time.Date(2026, 5, 16, 8, 0, 0, 0, time.UTC), settings, []notificationSubscription{
		{
			ID:              "family-custom",
			Name:            "Family Custom",
			Price:           "30",
			Currency:        "USD",
			Status:          "active",
			BillingCycle:    "monthly",
			NextBillingDate: "2026-05-17",
			ReminderDays:    disabledReminderDays,
			CostSharing: costSharingPayload{
				Enabled:   true,
				SplitMode: "custom",
				CollectionReminder: &costSharingCollectionReminder{
					Enabled:      true,
					ReminderDays: &reminderDays,
				},
				Members: []costSharingMember{
					{ID: "partner", Name: "Partner", JoinedDate: "2026-04-17", Currency: "CNY", CustomAmount: &customAmount},
				},
			},
		},
	}, true, accountContentLocale(settings))

	if !message.HasPayload || len(message.Items) != 1 {
		t.Fatalf("expected one custom collection reminder, got %#v", message.Items)
	}
	payload := message.Items[0].CostSharing
	if payload == nil || payload.MemberName != "Partner" || payload.Amount != "42" || payload.Currency != "CNY" {
		t.Fatalf("expected custom member amount/currency, got %#v", payload)
	}
}

func TestBuildDueNotificationSkipsOneTimeBuyoutCostSharingCollection(t *testing.T) {
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	reminderDays := 0

	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 8, 0, 0, 0, time.UTC), settings, []notificationSubscription{
		{
			ID:              "lifetime-family",
			Name:            "Lifetime Family",
			Price:           "30",
			Currency:        "USD",
			Status:          "active",
			BillingCycle:    "one-time",
			NextBillingDate: "2026-05-14",
			ReminderDays:    disabledReminderDays,
			CostSharing: costSharingPayload{
				Enabled:   true,
				SplitMode: "equal",
				CollectionReminder: &costSharingCollectionReminder{
					Enabled:      true,
					ReminderDays: &reminderDays,
				},
				Members: []costSharingMember{{ID: "partner", Name: "Partner", JoinedDate: "2026-04-14", Currency: "USD"}},
			},
		},
	}, true, accountContentLocale(settings))

	if message.HasPayload || len(message.Items) != 0 {
		t.Fatalf("expected one-time buyout collection reminder to be skipped, got %#v", message.Items)
	}
}

func TestNotificationScheduleCandidateSubscriptionsMatchFullFiltering(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "notification-candidates")
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	settings.NotificationReminderDays = 5
	settings.ShowExpired = true
	schedule := localScheduleOccurrence{
		ScheduledLocalDate:  "2026-05-14",
		ScheduledLocalTime:  "08:00",
		TimeZone:            "UTC",
		ScheduledInstantUTC: "2026-05-14T08:00:00Z",
	}

	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Renewal", "nextBillingDate": "2026-05-17", "reminderDays": 3})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Inherited", "nextBillingDate": "2026-05-19", "reminderDays": inheritReminderDays})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Trial", "status": "trial", "nextBillingDate": "2026-06-01", "trialEndDate": "2026-05-15", "reminderDays": 1})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Expired", "nextBillingDate": "2026-05-01", "reminderDays": 7})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Fixed Term", "billingCycle": "one-time", "oneTimeTermCount": 6, "oneTimeTermUnit": "month", "nextBillingDate": "2026-05-17", "reminderDays": 3})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Lifetime", "billingCycle": "one-time", "nextBillingDate": "2026-05-14", "reminderDays": 0})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Quiet", "nextBillingDate": "2026-05-17", "reminderDays": disabledReminderDays})
	familyCostSharing := types.JSONRaw(`{"enabled":true,"splitMode":"equal","collectionReminder":{"enabled":true,"reminderDays":3},"members":[{"id":"partner","name":"Partner","joinedDate":"2026-04-17","currency":"USD"}]}`)
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Family Collection", "price": "30", "nextBillingDate": "2026-05-17", "reminderDays": disabledReminderDays, "costSharingCollectionReminderEnabled": true, "costSharingNextCollectionReminderDate": "2026-05-14", "costSharing": familyCostSharing})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Future", "nextBillingDate": "2040-01-01", "reminderDays": 3})

	full, err := listNotificationSubscriptions(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := listNotificationScheduleCandidateSubscriptions(app, user.Id, settings, schedule, true)
	if err != nil {
		t.Fatal(err)
	}
	fullMessage := buildDueNotificationForSchedule(schedule, time.Date(2026, 5, 14, 8, 0, 0, 0, time.UTC), settings, full, true, accountContentLocale(settings))
	candidateMessage := buildDueNotificationForSchedule(schedule, time.Date(2026, 5, 14, 8, 0, 0, 0, time.UTC), settings, candidates, true, accountContentLocale(settings))

	if len(candidates) >= len(full) {
		t.Fatalf("expected cron candidates to avoid full subscription scan, got candidates=%d full=%d", len(candidates), len(full))
	}
	if got, want := notificationItemKeys(candidateMessage.Items), notificationItemKeys(fullMessage.Items); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("candidate items = %#v, want %#v", got, want)
	}
}

func TestNotificationCronSettlesExhaustedCostSharingFailedJob(t *testing.T) {
	for _, tc := range []struct {
		name       string
		attempts   int
		maxRetries string
		wantReason string
	}{
		{name: "max retries reached", attempts: 3, wantReason: "max_retries_reached"},
		{name: "retries disabled", attempts: 1, maxRetries: "0", wantReason: "retries_disabled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.maxRetries != "" {
				t.Setenv("NOTIFICATION_MAX_RETRIES", tc.maxRetries)
			}
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			user, _ := createRouteTestUser(t, app, "cost-sharing-exhausted-"+strings.ReplaceAll(tc.name, " ", "-"))
			settings := defaultAppSettings()
			settings.Timezone = "UTC"
			settings.NotificationTimeLocal = "08:00"
			settings.EnabledChannels = []string{"webhook"}
			createNotificationCronRouteTestSettings(t, app, user, settings)
			costSharing := types.JSONRaw(`{"enabled":true,"splitMode":"equal","collectionReminder":{"enabled":true,"reminderDays":3},"members":[{"id":"partner","name":"Partner","joinedDate":"2026-04-17","currency":"USD"}]}`)
			subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
				"name":                                  "Family Collection Exhausted",
				"price":                                 "30",
				"nextBillingDate":                       "2026-05-17",
				"reminderDays":                          disabledReminderDays,
				"costSharing":                           costSharing,
				"costSharingCollectionReminderEnabled":  true,
				"costSharingNextCollectionReminderDate": "2026-05-14",
			})
			now := time.Date(2026, 5, 14, 8, 0, 0, 0, time.UTC)
			refreshNotificationSchedulerForTest(t, app, user.Id, now)
			createFailedCronJobForTest(t, app, user.Id, settings, now, tc.attempts)

			sendCount := 0
			originalSender := notificationSenders["webhook"]
			notificationSenders["webhook"] = notificationSenderFunc(func(_ core.App, _ appSettings, _ notificationMessage, _ appLocale) error {
				sendCount++
				return errors.New("still failing")
			})
			t.Cleanup(func() {
				notificationSenders["webhook"] = originalSender
			})

			result, err := runNotificationCron(app, notificationCronOptions{Now: now, WindowMinutes: 2})
			if err != nil {
				t.Fatal(err)
			}
			if result.Skipped != 1 || len(result.Results) != 1 || result.Results[0].Reason != tc.wantReason {
				t.Fatalf("expected exhausted failed job to settle as %s, got %#v", tc.wantReason, result)
			}
			if sendCount != 0 {
				t.Fatalf("expected exhausted failed job not to send again, sent %d times", sendCount)
			}
			reloaded, err := app.FindRecordById("subscriptions", subscription.Id)
			if err != nil {
				t.Fatal(err)
			}
			if got := reloaded.GetString("costSharingNextCollectionReminderDate"); got != "2026-06-14" {
				t.Fatalf("expected collection reminder mirror to advance, got %q", got)
			}
			job, err := getNotificationJob(app, user.Id, "2026-05-14", "08:00", "UTC")
			if err != nil {
				t.Fatal(err)
			}
			if job.GetString("status") != notificationStatusFailed || job.GetInt("attempts") != tc.attempts {
				t.Fatalf("expected failed job history to remain unchanged, status=%q attempts=%d", job.GetString("status"), job.GetInt("attempts"))
			}
		})
	}
}

func TestUpcomingBatchKeepsSameDayCostSharingMembers(t *testing.T) {
	batches := map[string]*upcomingNotificationBatch{}
	occurrence := localScheduleOccurrence{
		ScheduledLocalDate:  "2026-05-14",
		ScheduledLocalTime:  "08:00",
		TimeZone:            "UTC",
		ScheduledInstantUTC: "2026-05-14T08:00:00Z",
	}
	sub := notificationSubscription{
		ID:              "sub_family",
		Name:            "Family Plan",
		Price:           "30",
		Currency:        "USD",
		Status:          "active",
		BillingCycle:    "monthly",
		NextBillingDate: "2026-05-17",
		ReminderDays:    3,
	}

	appendUpcomingBatch(batches, occurrence, []notificationContentItem{
		newCostSharingNotificationContentItem(sub, "Partner", "10", "USD", "2026-05-17", 3, 3),
		newCostSharingNotificationContentItem(sub, "Child", "10", "USD", "2026-05-17", 3, 3),
	})

	batch := batches["2026-05-14|08:00|UTC"]
	if batch == nil || len(batch.Items) != 2 {
		t.Fatalf("expected two member collection reminders, got %#v", batch)
	}
	if got := notificationItemKeys(batch.Items); strings.Join(got, "|") != "costSharing|Family Plan|2026-05-17||Child/10/USD|costSharing|Family Plan|2026-05-17||Partner/10/USD" {
		t.Fatalf("unexpected collection reminder keys: %#v", got)
	}
}

func createFailedCronJobForTest(t *testing.T, app core.App, userID string, settings appSettings, now time.Time, attempts int) {
	t.Helper()
	schedule := getLocalScheduleDecision(now, settings.Timezone, settings.NotificationTimeLocal, 2, false)
	job, _, err := createNotificationJob(app, userID, schedule, notificationStatusFailed, attempts)
	if err != nil {
		t.Fatal(err)
	}
	result := createJobResult(
		"some_channels_failed",
		schedule.localScheduleOccurrence,
		settings,
		accountContentLocale(settings),
		notificationMessage{
			Title:      "Renewlet",
			Content:    "failed",
			Timestamp:  "2026-05-14 08:00:00 UTC",
			HasPayload: true,
		},
		notificationCronOptions{Now: now, WindowMinutes: 2},
		jobChannels{
			Attempted: []string{"webhook"},
			Failed:    []channelFailure{{Channel: "webhook", Error: "still failing"}},
		},
	)
	if err := finalizeNotificationJob(app, job, userID, schedule, notificationStatusFailed, "webhook: still failing", result); err != nil {
		t.Fatal(err)
	}
}
