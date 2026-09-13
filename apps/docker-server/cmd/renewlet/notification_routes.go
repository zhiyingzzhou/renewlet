package main

// notification_routes.go 暴露通知测试、手动运行和历史查询 API。
//
// 架构位置：route 只负责认证上下文、严格请求解码和 response struct 组装；
// 设置合并、消息构建、发送和历史分页分别委托给领域函数，避免 API 层吞掉边界错误。
//
// 请求流转：
//   认证用户 -> 严格 body/query -> settings/subscriptions -> 发送或概览 -> 类型化 response
//
// 注意： sent=false 是合法业务结果，不是 HTTP 错误；前端依赖该判别字段展示空提醒状态。
import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// handleNotificationCron 为外部平台 Cron 执行一次全用户通知调度。
// 该入口面向无人值守调度器，必须使用 Authorization: Bearer <CRON_SECRET> 鉴权。
func handleNotificationCron(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	expectedSecret := envString("CRON_SECRET", "")
	if expectedSecret == "" {
		return apiErrorJSON(e, http.StatusInternalServerError, "CRON_SECRET_MISSING", serverText(locale, "notification.cronMissingSecret"), nil)
	}
	if !cronBearerSecretMatches(expectedSecret, e.Request.Header.Get("Authorization")) {
		return e.UnauthorizedError(serverText(locale, "notification.cronAuthFailed"), nil)
	}

	query := e.Request.URL.Query()
	result, err := runNotificationCron(app, notificationCronOptions{
		Force:  query.Get("force") == "1",
		DryRun: query.Get("dryRun") == "1" || query.Get("dry-run") == "1",
	})
	if err != nil {
		return e.InternalServerError(serverText(locale, "notification.cronRunFailed"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, result)
}

func cronBearerSecretMatches(expected string, authorization string) bool {
	authorization = strings.TrimSpace(authorization)
	if !strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		return false
	}
	provided := strings.TrimSpace(authorization[len("Bearer "):])
	if provided == "" || len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

// handleNotificationTest 发送单个渠道的测试通知。
// 注意： settings patch 只在本次请求内生效，不会写回 settings collection。
// 测试正文跟随当前请求语言，不能借临时 patch 改写账号 localePreference。
func handleNotificationTest(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[notificationTestRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}

	settings, err := currentUserSettingsWithPatch(app, e.Auth, body.Settings, locale)
	if err != nil {
		return e.BadRequestError(serverText(locale, "notification.settingsInvalid"), err)
	}
	message := buildTestNotification(time.Now(), settings, locale)
	if err := sendToChannel(app, body.Channel, settings, message, locale); err != nil {
		return apiErrorJSON(e, http.StatusBadRequest, "NOTIFICATION_TEST_FAILED", serverFormat(locale, "notification.testFailed", map[string]interface{}{"error": err.Error()}), notificationChannelErrorDetails(err))
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

// handleNotificationRun 为当前用户手动触发一次通知。
// sent=false 是“没有应发送内容”的正常业务结果，不应当作为错误处理。
// 手动正文跟随当前请求语言；后台 Cron 才读取账号内容语言。
func handleNotificationRun(app core.App, e *core.RequestEvent) error {
	startedAt := time.Now()
	locale := requestLocale(e.Request)
	body, err := decodeOptionalStrictJSON[notificationRunRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}

	settings, err := currentUserSettingsWithPatch(app, e.Auth, body.Settings, locale)
	if err != nil {
		return e.BadRequestError(serverText(locale, "notification.settingsInvalid"), err)
	}
	if _, err := renewAutoSubscriptionsForUser(app, e.Auth.Id, settings.Timezone, time.Now()); err != nil {
		return e.InternalServerError(serverText(locale, "notification.loadSubscriptionsFailed"), err)
	}
	subscriptions, err := listNotificationSubscriptions(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "notification.loadSubscriptionsFailed"), err)
	}
	message := buildDueNotification(time.Now(), settings, subscriptions, true, locale)
	batchCount := 0
	if message.HasPayload {
		batchCount = 1
	}
	defer func() {
		slog.Info("notification manual run resources",
			"subscriptions", len(subscriptions),
			"batches", batchCount,
			"duration", time.Since(startedAt),
		)
	}()
	if !message.HasPayload && !body.Force {
		// 手动运行需要给前端一个可判别的 skipped 响应，避免 UI 通过 message 文案猜测结果。
		return apiSuccessJSON(e, http.StatusOK, notificationRunSkippedResponse{Sent: false, Reason: "no_due_items"})
	}
	if len(settings.EnabledChannels) == 0 {
		return e.BadRequestError(serverText(locale, "notification.noEnabledChannels"), nil)
	}

	summary := sendToChannels(app, settings.EnabledChannels, settings, message, locale)
	return apiSuccessJSON(e, http.StatusOK, notificationRunSentResponse{Sent: true, Summary: summary})
}

// handleNotificationOverview 单独计算当前调度概览；自动续订和订阅全量读取只允许出现在这个入口。
func handleNotificationOverview(app core.App, e *core.RequestEvent) error {
	startedAt := time.Now()
	locale := requestLocale(e.Request)
	settings, err := currentUserSettings(app, e.Auth)
	if err != nil {
		return e.BadRequestError(serverText(locale, "notification.settingsInvalid"), err)
	}
	if _, err := renewAutoSubscriptionsForUser(app, e.Auth.Id, settings.Timezone, time.Now()); err != nil {
		return e.InternalServerError(serverText(locale, "notification.loadSubscriptionsFailed"), err)
	}
	subscriptions, err := listNotificationSubscriptions(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "notification.loadSubscriptionsFailed"), err)
	}
	overview := buildNotificationOverview(time.Now(), settings, subscriptions, 30)
	slog.Info("notification overview resources",
		"subscriptions", len(subscriptions),
		"batches", len(overview.UpcomingBatches),
		"duration", time.Since(startedAt),
	)
	latestJob, err := latestNotificationHistoryJob(app, e.Auth.Id, "all")
	if err != nil {
		return e.InternalServerError(serverText(locale, "notification.loadHistoryFailed"), err)
	}
	latestFailedJob, err := latestNotificationHistoryJob(app, e.Auth.Id, notificationStatusFailed)
	if err != nil {
		return e.InternalServerError(serverText(locale, "notification.loadHistoryFailed"), err)
	}

	return apiSuccessJSON(e, http.StatusOK, notificationOverviewResponse{
		Summary: notificationHistorySummaryResponse{
			NextCheck:        overview.NextCheck,
			NextContentBatch: overview.NextContentBatch,
			Blockers:         overview.Blockers,
			EnabledChannels:  overview.EnabledChannels,
			UpcomingDays:     overview.UpcomingDays,
			LatestJob:        latestJob,
			LatestFailedJob:  latestFailedJob,
		},
		Upcoming: overview.UpcomingBatches,
	})
}

// handleNotificationHistory 只返回分页审计行；limit+1 判断 hasMore，翻页不得读取 subscriptions。
func handleNotificationHistory(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	query := e.Request.URL.Query()
	status := query.Get("status")
	if status == "" {
		status = "all"
	}
	if status != "all" && status != notificationStatusSent && status != notificationStatusFailed && status != notificationStatusSkipped && status != notificationStatusSending {
		return e.BadRequestError(serverText(locale, "notification.historyStatusInvalid"), nil)
	}
	limit := clampInt(parseInt(query.Get("limit"), 20), 1, 50)
	offset := maxInt(parseInt(query.Get("offset"), 0), 0)

	rows, err := loadNotificationHistoryJobs(app, e.Auth.Id, status, limit+1, offset)
	if err != nil {
		return e.InternalServerError(serverText(locale, "notification.loadHistoryFailed"), err)
	}
	jobs := rows
	hasMore := false
	if len(rows) > limit {
		// 多取一条只用于判断下一页，返回给前端前必须截断。
		jobs = rows[:limit]
		hasMore = true
	}
	return apiSuccessJSON(e, http.StatusOK, notificationHistoryPageResponse{
		Jobs:    jobs,
		Status:  status,
		Limit:   limit,
		Offset:  offset,
		HasMore: hasMore,
	})
}
