package main

// routes.go 集中注册 Renewlet 自定义 HTTP API。
//
// 架构位置：
//   - 公共 route 暴露 health/setup/password-reset 状态。
//   - 认证 route 只签发 Renewlet 产品 session，并把请求体交给严格 decoder 和命名 request struct。
//   - route 返回的 response struct 是前端 Zod schema 的运行时契约。
//
// 请求流转：
//   fetch -> PocketBase auth/locale -> 严格 JSON 解码 -> Validate -> handler -> response struct
//
// 注意： 这里拒绝未知字段和多余 JSON token；新增 API 字段时必须同步前端 schema 与测试 fixture。
import (
	"errors"
	"net/http"
	"sort"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

func registerRoutes(app core.App, router *router.Router[*core.RequestEvent]) []apiRouteContract {
	registry := newProductRouteRegistry()
	api := newProductRouteGroup(router.Group(""), "", registry).BindFunc(apiErrorMiddleware).BindFunc(appSameOriginUnsafeMiddleware)

	// 公共状态接口不要求认证，但响应仍使用命名 struct，避免前端在登录前信任松散 JSON。
	api.GET("/api/app/health", func(e *core.RequestEvent) error {
		return apiSuccessJSON(e, http.StatusOK, newHealthResponse())
	})
	api.GET("/api/app/ready", func(e *core.RequestEvent) error {
		ready, err := newReadyResponse(app)
		if err != nil {
			return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
		}
		return apiSuccessJSON(e, http.StatusOK, ready)
	})

	api.GET("/api/app/status", func(e *core.RequestEvent) error {
		turnstile, err := publicTurnstileConfig(app)
		if err != nil {
			return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
		}
		// app status 是认证前 capability 源；前端置灰和 setup 可见性都只读这一处，不再从页面里猜部署模式。
		return apiSuccessJSON(e, http.StatusOK, appStatusResponse{
			SetupRequired: !hasEnabledAdmin(app),
			SetupEnabled:  demoModePolicy.SetupEnabled(),
			DemoMode:      demoModePolicy.Enabled(),
			Turnstile:     turnstile,
		})
	})
	api.GET("/api/app/setup", func(e *core.RequestEvent) error {
		return apiSuccessJSON(e, http.StatusOK, setupStatusResponse{
			SetupRequired: !hasEnabledAdmin(app),
			SetupEnabled:  demoModePolicy.SetupEnabled(),
		})
	})
	api.GET("/api/public/status/{token}", func(e *core.RequestEvent) error { return handlePublicStatusRead(app, e) })
	api.GET("/api/public/status/{token}/assets/{assetId}", func(e *core.RequestEvent) error { return handlePublicStatusAssetRead(app, e) })
	api.GET("/api/public/v1/me", func(e *core.RequestEvent) error { return handlePublicAPIMe(app, e) })
	api.GET("/api/public/v1/subscriptions", func(e *core.RequestEvent) error { return handlePublicAPISubscriptionsList(app, e) })
	api.GET("/api/public/v1/subscriptions/{id}", func(e *core.RequestEvent) error { return handlePublicAPISubscriptionDetail(app, e) })
	api.GET("/api/public/v1/status", func(e *core.RequestEvent) error { return handlePublicAPIStatus(app, e) })
	api.GET("/api/public/v1/due", func(e *core.RequestEvent) error { return handlePublicAPIDue(app, e) })
	api.POST("/api/telegram/webhook/{bindingId}", func(e *core.RequestEvent) error { return handleTelegramWebhook(app, e) })
	api.GET("/calendar/renewals.ics", func(e *core.RequestEvent) error { return handleCalendarFeedICS(app, e) })
	api.GET("/api/cron/notifications", func(e *core.RequestEvent) error { return handleNotificationCron(app, e) })
	api.POST("/api/app/setup", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		if !demoModePolicy.SetupEnabled() {
			return e.ForbiddenError(serverText(locale, "auth.setupDisabled"), nil)
		}
		if hasEnabledAdmin(app) {
			return e.ForbiddenError(serverText(locale, "auth.setupAlreadyInitialized"), nil)
		}
		// setup 是认证前入口，必须用严格 decoder 拒绝未知字段和多余 token。
		body, err := decodeStrictJSON[setupCreateRequest](e.Request, locale)
		if err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		if err := createInitialAdmin(app, body.Name, body.Email, body.Password); err != nil {
			if errors.Is(err, errSetupAlreadyInitialized) {
				return e.ForbiddenError(serverText(locale, "auth.setupAlreadyInitialized"), nil)
			}
			return e.BadRequestError(serverText(locale, "admin.createFailed"), err)
		}
		return apiEmptySuccessJSON(e, http.StatusCreated)
	})

	api.POST("/api/app/auth/login", func(e *core.RequestEvent) error { return handleAuthLogin(app, e) })
	api.GET("/api/app/auth/session", func(e *core.RequestEvent) error { return handleAuthSession(app, e) })
	api.POST("/api/app/auth/logout", func(e *core.RequestEvent) error { return handleAuthLogout(app, e) })
	api.POST("/api/app/auth/mfa/verify", func(e *core.RequestEvent) error { return handleMFAVerify(app, e) })
	api.POST("/api/app/auth/passkeys/authenticate/options", func(e *core.RequestEvent) error {
		return handlePasskeyAuthenticateOptions(app, e)
	})
	api.POST("/api/app/auth/passkeys/authenticate/verify", func(e *core.RequestEvent) error {
		return handlePasskeyAuthenticateVerify(app, e)
	})

	admin := api.Group("/api/app/admin").Bind(appAuthMiddleware(app)).BindFunc(requireAdmin)
	// 访问安全是站点级管理员策略；不要挂到账号 settings route，避免 secret 进入用户导出/备份链路。
	admin.GET("/auth-security", func(e *core.RequestEvent) error { return handleAuthSecurityRead(app, e) })
	admin.PUT("/auth-security", func(e *core.RequestEvent) error { return handleAuthSecurityUpdate(app, e) })
	admin.POST("/auth-security/turnstile/test", func(e *core.RequestEvent) error { return handleAuthSecurityTurnstileTest(app, e) })
	admin.GET("/users", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		users, err := app.FindAllRecords("users")
		if err != nil {
			return e.InternalServerError(serverText(locale, "admin.loadUsersFailed"), err)
		}
		sort.Slice(users, func(i, j int) bool {
			return users[i].GetDateTime("created").Time().After(users[j].GetDateTime("created").Time())
		})
		out := make([]userDTO, 0, len(users))
		for _, user := range users {
			out = append(out, toUserDTO(app, user))
		}
		return apiSuccessJSON(e, http.StatusOK, adminUsersResponse{Users: out})
	})
	admin.POST("/users", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		body, err := decodeStrictJSON[adminCreateUserRequest](e.Request, locale)
		if err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		role := normalizeRole(body.Role)
		user, err := createUser(app, body.Name, body.Email, body.Password, role)
		if err != nil {
			return e.BadRequestError(serverText(locale, "admin.createUserFailed"), err)
		}
		return apiSuccessJSON(e, http.StatusCreated, adminUserResponse{User: toUserDTO(app, user)})
	})
	admin.PATCH("/users/{id}", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		id := e.Request.PathValue("id")
		user, err := app.FindRecordById("users", id)
		if err != nil {
			return e.NotFoundError(serverText(locale, "auth.userNotFound"), err)
		}
		if err := demoModePolicy.RejectTargetUserMutation(e, user); err != nil {
			return err
		}
		body, err := decodeStrictJSON[adminPatchUserRequest](e.Request, locale)
		if err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestParameters", err), err)
		}
		if body.Role != nil {
			user.Set("role", normalizeRole(*body.Role))
		}
		if body.Banned != nil {
			user.Set("banned", *body.Banned)
			if *body.Banned {
				user.Set("banReason", serverText(locale, "auth.accountDisabledByAdmin"))
			} else {
				user.Set("banReason", "")
			}
		}
		if body.NewPassword != nil {
			if e.Auth != nil && e.Auth.Id == user.Id {
				// 自己改密码必须走 /account/password 校验当前密码，不能让管理员 patch 成为弱认证入口。
				return e.BadRequestError(serverText(locale, "auth.selfPasswordResetForbidden"), nil)
			}
			user.SetPassword(*body.NewPassword)
		}
		// 防自锁保护放在 Save 前，避免当前管理员把自己降级/禁用后无法恢复系统。
		if err := preventLastAdminMutation(app, e.Auth, user); err != nil {
			return e.BadRequestError(localizeAdminMutationError(locale, err), nil)
		}
		if err := app.Save(user); err != nil {
			return e.BadRequestError(serverText(locale, "admin.updateUserFailed"), err)
		}
		if body.NewPassword != nil || user.GetBool("banned") {
			// 管理员重置密码或禁用账号后旧产品 session 必须立即失效，不能等前端下次刷新才发现。
			if err := deleteAppSessionsForUser(app, user.Id); err != nil {
				return e.InternalServerError(serverText(locale, "common.internalError"), err)
			}
		}
		return apiEmptySuccessJSON(e, http.StatusOK)
	})
	admin.POST("/users/{id}/mfa/reset", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		id := e.Request.PathValue("id")
		user, err := app.FindRecordById("users", id)
		if err != nil {
			return e.NotFoundError(serverText(locale, "auth.userNotFound"), err)
		}
		if e.Auth != nil && e.Auth.Id == user.Id {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		if err := demoModePolicy.RejectTargetUserMutation(e, user); err != nil {
			return err
		}
		if err := disableAuthenticatorMFAForUser(app, user.Id); err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		return apiEmptySuccessJSON(e, http.StatusOK)
	})
	admin.POST("/users/{id}/passkeys/reset", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		id := e.Request.PathValue("id")
		user, err := app.FindRecordById("users", id)
		if err != nil {
			return e.NotFoundError(serverText(locale, "auth.userNotFound"), err)
		}
		if e.Auth != nil && e.Auth.Id == user.Id {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		if err := demoModePolicy.RejectTargetUserMutation(e, user); err != nil {
			return err
		}
		if err := deletePasskeysForUser(app, user.Id); err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		return apiEmptySuccessJSON(e, http.StatusOK)
	})
	admin.DELETE("/users/{id}", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		id := e.Request.PathValue("id")
		user, err := app.FindRecordById("users", id)
		if err != nil {
			return e.NotFoundError(serverText(locale, "auth.userNotFound"), err)
		}
		if err := demoModePolicy.RejectTargetUserMutation(e, user); err != nil {
			return err
		}
		if err := preventUserDelete(app, e.Auth, user); err != nil {
			return e.BadRequestError(localizeAdminMutationError(locale, err), nil)
		}
		if err := app.Delete(user); err != nil {
			return e.BadRequestError(serverText(locale, "admin.deleteUserFailed"), err)
		}
		return apiEmptySuccessJSON(e, http.StatusOK)
	})
	// route 只接受任务并暴露内存快照；后台执行不得重新绑定请求 context，也不能把长下载塞回 HTTP 响应周期。
	admin.POST("/system/update", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		if _, err := decodeStrictJSON[systemUpdateRequest](e.Request, locale); err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		operation, err := defaultSystemUpdateService.StartUpdate(locale)
		if err != nil {
			switch {
			case errors.Is(err, errSystemUpdateUnsupported):
				return e.BadRequestError(err.Error(), nil)
			default:
				return apiErrorJSON(e, http.StatusInternalServerError, "SYSTEM_UPDATE_FAILED", serverText(locale, "system.updateFailed"), nil)
			}
		}
		e.Response.Header().Set("Location", "/api/app/admin/system/update/status")
		e.Response.Header().Set("Retry-After", "1")
		e.Response.Header().Set("Cache-Control", "no-store")
		return apiSuccessJSON(e, http.StatusAccepted, systemUpdateOperationResponse{Operation: operation})
	})
	admin.GET("/system/update/status", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-store")
		return apiSuccessJSON(e, http.StatusOK, systemUpdateOperationResponse{Operation: defaultSystemUpdateService.CurrentOperation(requestLocale(e.Request))})
	})
	admin.POST("/system/restart", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		if _, err := decodeStrictJSON[systemRestartRequest](e.Request, locale); err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		if err := defaultSystemUpdateService.ReserveRestart(locale); err != nil {
			return e.BadRequestError(err.Error(), nil)
		}
		if err := apiEmptySuccessJSON(e, http.StatusOK); err != nil {
			defaultSystemUpdateService.RollbackRestart()
			return err
		}
		// 只在管理员显式确认后退出，确保前端能先展示“更新完成”并开始等待健康检查恢复。
		defaultSystemUpdateService.ScheduleRestart()
		return nil
	})
	admin.GET("/media/icon-index", func(e *core.RequestEvent) error {
		return handleBuiltInIconIndexStatus(app, e)
	})
	admin.POST("/media/icon-index/providers/{provider}/check", func(e *core.RequestEvent) error {
		return handleBuiltInIconIndexProviderCheck(app, e)
	})
	admin.POST("/media/icon-index/providers/{provider}/refresh", func(e *core.RequestEvent) error {
		return handleBuiltInIconIndexProviderRefresh(app, e)
	})

	auth := api.Group("/api/app").Bind(appAuthMiddleware(app))
	auth.GET("/system/version", func(e *core.RequestEvent) error { return handleSystemVersion(e) })
	auth.PUT("/account/password", func(e *core.RequestEvent) error {
		locale := requestLocale(e.Request)
		if err := demoModePolicy.RejectAccountMutation(e); err != nil {
			return err
		}
		body, err := decodeStrictJSON[accountPasswordRequest](e.Request, locale)
		if err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		if !e.Auth.ValidatePassword(body.CurrentPassword) {
			return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
		}
		e.Auth.SetPassword(body.NewPassword)
		if err := app.Save(e.Auth); err != nil {
			return e.BadRequestError(serverText(locale, "auth.passwordUpdateFailed"), err)
		}
		_, currentSession, _ := appAuthRecordByToken(app, sessionTokenFromRequest(e.Request))
		keepSessionID := ""
		if currentSession != nil {
			keepSessionID = currentSession.Id
		}
		// 改密后保留当前产品 session，踢掉其它设备；账号安全自助操作会另行续签当前 cookie session。
		if err := deleteAppSessionsForUserExcept(app, e.Auth.Id, keepSessionID); err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		return apiEmptySuccessJSON(e, http.StatusOK)
	})
	auth.GET("/auth/mfa/status", func(e *core.RequestEvent) error { return handleMFAStatus(app, e) })
	auth.POST("/auth/mfa/totp/setup", func(e *core.RequestEvent) error { return handleMFATOTPSetup(app, e) })
	auth.POST("/auth/mfa/totp/enable", func(e *core.RequestEvent) error { return handleMFATOTPEnable(app, e) })
	auth.POST("/auth/mfa/recovery/regenerate", func(e *core.RequestEvent) error { return handleMFARecoveryRegenerate(app, e) })
	auth.POST("/auth/mfa/disable", func(e *core.RequestEvent) error { return handleMFADisable(app, e) })
	auth.GET("/auth/passkeys", func(e *core.RequestEvent) error { return handlePasskeys(app, e) })
	auth.POST("/auth/passkeys/register/options", func(e *core.RequestEvent) error { return handlePasskeyRegisterOptions(app, e) })
	auth.POST("/auth/passkeys/register/verify", func(e *core.RequestEvent) error { return handlePasskeyRegisterVerify(app, e) })
	auth.POST("/auth/passkeys/{id}/delete", func(e *core.RequestEvent) error { return handlePasskeyDelete(app, e) })
	auth.POST("/notifications/test", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleNotificationTest(app, e) }))
	auth.GET("/notifications/overview", func(e *core.RequestEvent) error { return handleNotificationOverview(app, e) })
	auth.GET("/notifications/history", func(e *core.RequestEvent) error { return handleNotificationHistory(app, e) })
	auth.POST("/notifications/run", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleNotificationRun(app, e) }))
	// 导入预览和应用都要求登录态；冲突判断只在当前用户数据内完成，避免备份里的来源 ID 探测他人订阅。
	auth.POST("/import/preview", func(e *core.RequestEvent) error { return handleImportPreview(app, e) })
	auth.POST("/import/apply", func(e *core.RequestEvent) error { return handleImportApply(app, e) })
	// 云同步与备份只生成可恢复快照；恢复下载后仍必须进入前端 import preview/apply，不直接覆盖数据库。
	auth.GET("/cloud-backup/config", func(e *core.RequestEvent) error { return handleCloudBackupConfigRead(app, e) })
	auth.PUT("/cloud-backup/config", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleCloudBackupConfigUpdate(app, e) }))
	auth.POST("/cloud-backup/test", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleCloudBackupTest(app, e) }))
	auth.GET("/cloud-backups", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleCloudBackupsList(app, e) }))
	auth.POST("/cloud-backups", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleCloudBackupsCreate(app, e) }))
	auth.GET("/cloud-backups/{id}/download", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleCloudBackupsDownload(app, e) }))
	auth.DELETE("/cloud-backups/{id}", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleCloudBackupsDelete(app, e) }))
	// AI 识别只生成导入草稿，不直接写 subscriptions；最终仍必须走 import preview/apply 的用户确认链路。
	auth.POST("/ai/subscriptions/recognize/stream", func(e *core.RequestEvent) error { return handleAIRecognizeSubscriptionsStream(app, e) })
	auth.POST("/ai/subscriptions/recognize", func(e *core.RequestEvent) error { return handleAIRecognizeSubscriptions(app, e) })
	auth.POST("/ai/subscriptions/test", func(e *core.RequestEvent) error { return handleAIRecognitionTestConnection(app, e) })
	auth.POST("/ai/models/list", func(e *core.RequestEvent) error { return handleAIModelsList(app, e) })
	// 业务数据统一经 Renewlet 产品 API；前端不得再直连 PocketBase collection REST，以免 Docker/Cloudflare 运行面漂移。
	auth.GET("/api-tokens", func(e *core.RequestEvent) error { return handleAPITokensList(app, e) })
	auth.POST("/api-tokens", func(e *core.RequestEvent) error { return handleAPITokenCreate(app, e) })
	auth.DELETE("/api-tokens/{id}", func(e *core.RequestEvent) error { return handleAPITokenDelete(app, e) })
	auth.GET("/telegram-bot/commands", func(e *core.RequestEvent) error { return handleTelegramBotCommandsStatus(app, e) })
	auth.POST("/telegram-bot/commands", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleTelegramBotCommandsInstall(app, e) }))
	auth.DELETE("/telegram-bot/commands", demoModeExternalSideEffectGuard(func(e *core.RequestEvent) error { return handleTelegramBotCommandsDelete(app, e) }))
	auth.GET("/settings", func(e *core.RequestEvent) error { return handleSettingsRead(app, e) })
	auth.PUT("/settings", func(e *core.RequestEvent) error { return handleSettingsUpdate(app, e) })
	auth.GET("/custom-config", func(e *core.RequestEvent) error { return handleCustomConfigRead(app, e) })
	auth.PUT("/custom-config", func(e *core.RequestEvent) error { return handleCustomConfigUpdate(app, e) })
	// 汇率快照是登录态报表口径 API；Public API token 不读取也不能写入这组用户级私有报表状态。
	auth.GET("/exchange-rate-snapshots", func(e *core.RequestEvent) error { return handleExchangeRateSnapshotsList(app, e) })
	auth.PUT("/exchange-rate-snapshots/{month}", func(e *core.RequestEvent) error { return handleExchangeRateSnapshotPut(app, e) })
	auth.GET("/subscriptions", func(e *core.RequestEvent) error { return handleSubscriptionsList(app, e) })
	auth.POST("/subscriptions", func(e *core.RequestEvent) error { return handleSubscriptionCreate(app, e) })
	auth.POST("/subscriptions/bulk-public-visibility", func(e *core.RequestEvent) error { return handleBulkPublicVisibility(app, e) })
	// 静态集合路由必须先于 {id} 详情路由注册，防止 index/analytics/calendar-feeds/facets/export 被解释成订阅 ID。
	auth.GET("/subscriptions/index", func(e *core.RequestEvent) error { return handleSubscriptionsIndex(app, e) })
	auth.GET("/subscriptions/analytics", func(e *core.RequestEvent) error { return handleSubscriptionsAnalytics(app, e) })
	auth.GET("/subscriptions/calendar", func(e *core.RequestEvent) error { return handleSubscriptionsCalendar(app, e) })
	auth.GET("/subscriptions/calendar-feeds", func(e *core.RequestEvent) error { return handleSubscriptionCalendarFeedsList(app, e) })
	auth.GET("/subscriptions/facets", func(e *core.RequestEvent) error { return handleSubscriptionsFacets(app, e) })
	auth.GET("/subscriptions/export", func(e *core.RequestEvent) error { return handleSubscriptionsExport(app, e) })
	auth.GET("/subscriptions/{id}", func(e *core.RequestEvent) error { return handleSubscriptionRead(app, e) })
	auth.PATCH("/subscriptions/{id}", func(e *core.RequestEvent) error { return handleSubscriptionUpdate(app, e) })
	auth.DELETE("/subscriptions/{id}", func(e *core.RequestEvent) error { return handleSubscriptionDelete(app, e) })
	auth.GET("/assets", func(e *core.RequestEvent) error { return handleAssetsList(app, e) })
	auth.POST("/assets", func(e *core.RequestEvent) error { return handleAssetUpload(app, e) })
	// 私有资产读取必须经过 handler 的 record.user 校验，不能直接暴露 PocketBase protected file URL。
	auth.GET("/assets/{id}", func(e *core.RequestEvent) error { return handleAssetRead(app, e) })
	auth.DELETE("/assets/{id}", func(e *core.RequestEvent) error { return handleAssetDelete(app, e) })
	// Feed 管理 API 只服务登录用户；公开 ICS route 另走 token bearer secret，不复用 session。
	auth.GET("/calendar-feed", func(e *core.RequestEvent) error { return handleCalendarFeedStatus(app, e) })
	auth.POST("/calendar-feed", func(e *core.RequestEvent) error { return handleCalendarFeedCreate(app, e) })
	auth.POST("/calendar-feed/rotate", func(e *core.RequestEvent) error { return handleCalendarFeedRotate(app, e) })
	auth.DELETE("/calendar-feed", func(e *core.RequestEvent) error { return handleCalendarFeedDelete(app, e) })
	auth.GET("/public-status-page", func(e *core.RequestEvent) error { return handlePublicStatusPageStatus(app, e) })
	auth.POST("/public-status-page", func(e *core.RequestEvent) error { return handlePublicStatusPageCreate(app, e) })
	auth.PATCH("/public-status-page", func(e *core.RequestEvent) error { return handlePublicStatusPageUpdate(app, e) })
	auth.DELETE("/public-status-page", func(e *core.RequestEvent) error { return handlePublicStatusPageDelete(app, e) })
	auth.POST("/subscriptions/{id}/renew", func(e *core.RequestEvent) error { return handleSubscriptionRenew(app, e) })
	auth.GET("/subscriptions/{id}/calendar.ics", func(e *core.RequestEvent) error { return handleSubscriptionCalendarICSDownload(app, e) })
	auth.GET("/subscriptions/{id}/calendar-feed", func(e *core.RequestEvent) error { return handleSubscriptionCalendarFeedStatus(app, e) })
	auth.POST("/subscriptions/{id}/calendar-feed", func(e *core.RequestEvent) error { return handleSubscriptionCalendarFeedCreate(app, e) })
	auth.POST("/subscriptions/{id}/calendar-feed/rotate", func(e *core.RequestEvent) error { return handleSubscriptionCalendarFeedRotate(app, e) })
	auth.DELETE("/subscriptions/{id}/calendar-feed", func(e *core.RequestEvent) error { return handleSubscriptionCalendarFeedDelete(app, e) })
	// 媒体候选统一入口承接 favicon 与内置 provider，前端不再拼旧 favicon-search/图标 provider 路径。
	auth.POST("/media/candidates", mediaCandidates)

	api.GET("/api/app/account/password-reset/status", func(e *core.RequestEvent) error {
		return apiSuccessJSON(e, http.StatusOK, passwordResetStatusResponse{Enabled: app.Settings().SMTP.Enabled})
	})

	registerAPIFallbacks(api.Raw(), registry)
	return registry.Contracts()
}

func handleSystemVersion(e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if !canReadSystemVersion(e.Auth) {
		return e.ForbiddenError(serverText(locale, "auth.adminRequiredShort"), nil)
	}
	force := e.Request.URL.Query().Get("force") == "true"
	info, err := defaultSystemUpdateService.CheckVersion(e.Request.Context(), locale, force)
	if err != nil {
		return e.InternalServerError(serverText(locale, "system.checkVersionFailed"), err)
	}
	if !canPerformSystemUpdate(e.Auth) {
		info = readOnlySystemVersionResponse(info, locale)
	}
	return apiSuccessJSON(e, http.StatusOK, info)
}

func canReadSystemVersion(user *core.Record) bool {
	return user != nil && !user.GetBool("banned")
}

func canPerformSystemUpdate(user *core.Record) bool {
	return user != nil && user.GetString("role") == "admin" && !user.GetBool("banned")
}

func readOnlySystemVersionResponse(response *systemVersionResponse, locale appLocale) *systemVersionResponse {
	clone := cloneSystemVersionResponse(response, response != nil && response.Cached)
	if clone == nil {
		return nil
	}
	// 版本 badge 面向所有登录用户；执行更新和上游 raw details 仍只属于管理员排障/运维边界。
	clone.UpdateSupported = false
	clone.UnsupportedReason = serverText(locale, "auth.adminRequiredShort")
	clone.ErrorDetails = nil
	return clone
}
