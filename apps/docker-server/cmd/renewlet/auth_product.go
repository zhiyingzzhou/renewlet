package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

const (
	appSessionTTL        = 30 * 24 * time.Hour
	mfaAuthTicketTTL     = 5 * time.Minute
	appSessionTokenN     = 32
	appSessionCSRFTokens = 32
	mfaTicketTokenN      = 32
	appSessionCookieName = "renewlet_session"
	appCSRFCookieName    = "renewlet_csrf"
	appCSRFHeaderName    = "X-Renewlet-CSRF"
	// Docker/Go 与 Worker 共享 15 分钟审计写入窗口；这些字段不参与授权，不能因为节流改变 session/token 有效性。
	auditTouchInterval = 15 * time.Minute
)

// 本文件只签发 Renewlet 产品 session；PocketBase 原生 JWT 仅作为账号事实源存在，不能恢复为浏览器 bearer。
// appAuthMiddleware 是 Renewlet 产品 API 的唯一登录态边界。
// 它把产品 session token 提升成 e.Auth，避免前端继续依赖 PocketBase 原生 JWT 绕过 MFA。
func appAuthMiddleware(app core.App) *hook.Handler[*core.RequestEvent] {
	return &hook.Handler[*core.RequestEvent]{
		Func: func(e *core.RequestEvent) error {
			locale := requestLocale(e.Request)
			token := sessionTokenFromRequest(e.Request)
			if token == "" {
				return e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
			}
			user, session, err := appAuthRecordByToken(app, token)
			if err != nil || user == nil || session == nil {
				return e.UnauthorizedError(serverText(locale, "auth.sessionExpired"), err)
			}
			if err := validateAppSessionCSRF(e.Request, session); err != nil {
				return e.ForbiddenError(serverText(locale, "auth.sessionExpired"), err)
			}
			if user.GetBool("banned") {
				return e.UnauthorizedError(localizedDisabledBanReason(locale), nil)
			}
			now := time.Now().UTC()
			if shouldTouchAuditTimestamp(session.GetString("lastSeenAt"), now) {
				// lastSeenAt 只是会话活跃审计，不参与授权或续期；节流写入避免所有只读 API 都放大成 SQLite write。
				session.Set("lastSeenAt", now.Format(time.RFC3339Nano))
				if err := app.Save(session); err != nil {
					return e.InternalServerError(serverText(locale, "common.internalError"), err)
				}
			}
			e.Auth = user
			return e.Next()
		},
	}
}

func handleAuthLogin(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[loginRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := requireTurnstileForPasswordLogin(app, e.Request, body.TurnstileToken); err != nil {
		return turnstileAPIError(e, err)
	}
	user, err := app.FindAuthRecordByEmail("users", body.Email)
	if err != nil || !user.ValidatePassword(body.Password) {
		return e.BadRequestError(serverText(locale, "auth.invalidEmailOrPassword"), err)
	}
	result, err := preparePrimaryLogin(app, e, user)
	if err != nil {
		return err
	}
	return result.send(e)
}

type primaryLoginResult struct {
	session   sessionResponse
	challenge *mfaRequiredResponse
}

func (result primaryLoginResult) send(e *core.RequestEvent) error {
	if result.challenge != nil {
		return apiSuccessJSON(e, 200, result.challenge)
	}
	return sendAppSessionResponse(e, result.session)
}

func sendAppSessionResponse(e *core.RequestEvent, s sessionResponse) error {
	setAppSessionCookies(e, s.token, s.csrfToken, s.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, s)
}

// 密码与外部身份共用同一个账号状态检查；OIDC 在绑定仍有效的事务内决定签会话还是 MFA 票据。
func preparePrimaryLogin(app core.App, e *core.RequestEvent, user *core.Record) (primaryLoginResult, error) {
	var result primaryLoginResult
	locale := requestLocale(e.Request)
	if user.GetBool("banned") {
		return result, e.ForbiddenError(localizedDisabledBanReason(locale), nil)
	}
	if _, _, err := ensureSettingsRecord(app, user.Id); err != nil {
		return result, err
	}
	methods, err := authenticatorMfaMethodsForUser(app, user.Id)
	if err != nil {
		return result, err
	}
	if len(methods) > 0 {
		ticket, expires, err := createMfaAuthTicket(app, user.Id, methods)
		if err != nil {
			return result, err
		}
		result.challenge = &mfaRequiredResponse{Type: "mfa_required", TicketID: ticket, ExpiresAt: expires, Methods: methods}
	} else {
		result.session, err = createAppSessionResponse(app, user)
	}
	return result, err
}

func handleAuthSession(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	token := sessionTokenFromRequest(e.Request)
	user, session, err := appAuthRecordByToken(app, token)
	if err != nil || user == nil || session == nil {
		return e.UnauthorizedError(serverText(locale, "auth.sessionExpired"), err)
	}
	if user.GetBool("banned") {
		return e.UnauthorizedError(localizedDisabledBanReason(locale), nil)
	}
	now := time.Now().UTC()
	if shouldTouchAuditTimestamp(session.GetString("lastSeenAt"), now) {
		// session restore 同样只写审计时间，不续期；和 appAuthMiddleware 共用节流口径，避免刷新页放大写库。
		session.Set("lastSeenAt", now.Format(time.RFC3339Nano))
		if err := app.Save(session); err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
	}
	return apiSuccessJSON(e, 200, sessionResponseFromRecord("", "", session.GetString("expiresAt"), user))
}

func handleAuthLogout(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	token := sessionTokenFromRequest(e.Request)
	if token != "" {
		if _, session, err := appAuthRecordByToken(app, token); err == nil && session != nil {
			if err := validateAppSessionCSRF(e.Request, session); err != nil {
				return e.ForbiddenError(serverText(locale, "auth.sessionExpired"), err)
			}
		}
		_ = deleteAppSessionByToken(app, token)
	}
	clearAppSessionCookies(e)
	return apiEmptySuccessJSON(e, 200)
}

func handleMFAVerify(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[mfaVerifyRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	response, err := verifyLoginMFA(app, body)
	if err != nil {
		// ticket 过期、方法不匹配和 OTP/恢复码错误统一为 sessionExpired，避免枚举认证器状态。
		return e.UnauthorizedError(serverText(locale, "auth.sessionExpired"), nil)
	}
	setAppSessionCookies(e, response.token, response.csrfToken, response.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, response)
}

func handleMFAStatus(app core.App, e *core.RequestEvent) error {
	status, err := mfaStatusForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, status)
}

func handleMFATOTPSetup(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	response, err := startTOTPSetup(app, e.Auth)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, response)
}

func handleMFATOTPEnable(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaTotpEnableRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := enableTOTP(app, e.Auth, body.SetupID, body.Code)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	setAppSessionCookies(e, response.token, response.csrfToken, response.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, response)
}

func handleMFARecoveryRegenerate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaCurrentPasswordRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	enabled, _, err := authenticatorMfaEnabledForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if !enabled {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	response, err := regenerateRecoveryCodesForCurrentUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setAppSessionCookies(e, response.token, response.csrfToken, response.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeys(app core.App, e *core.RequestEvent) error {
	response, err := listPasskeysForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyRegisterOptions(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[passkeyRegisterOptionsRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := startPasskeyRegistration(app, e.Request, e.Auth)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	// Passkey options 只创建 WebAuthn challenge；session 续签必须等 verify 成功，否则半成品凭据会改变登录态。
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyRegisterVerify(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[passkeyRegisterVerifyRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	response, err := finishPasskeyRegistration(app, e.Request, e.Auth, body.ChallengeID, body.Name, body.Response)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	setAppSessionCookies(e, response.token, response.csrfToken, response.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyAuthenticateOptions(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if _, err := decodeStrictJSON[passkeyAuthenticateOptionsRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	// Passkey options 只创建无用户认证前 challenge；这里失败说明 WebAuthn/账号安全初始化不可用，不是 session 过期。
	response, err := startPasskeyAuthentication(app, e.Request)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyAuthenticateVerify(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[passkeyAuthenticateVerifyRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	response, err := finishPasskeyAuthentication(app, e.Request, body.ChallengeID, body.Response)
	if err != nil {
		return e.UnauthorizedError(serverText(locale, "auth.sessionExpired"), nil)
	}
	setAppSessionCookies(e, response.token, response.csrfToken, response.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, response)
}

func handlePasskeyDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaCurrentPasswordRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := deletePasskeyCredential(app, e.Auth.Id, e.Request.PathValue("id"))
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	setAppSessionCookies(e, response.token, response.csrfToken, response.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, response)
}

func handleMFADisable(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectAccountMutation(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[mfaCurrentPasswordRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !e.Auth.ValidatePassword(body.CurrentPassword) {
		return e.BadRequestError(serverText(locale, "auth.currentPasswordIncorrect"), nil)
	}
	response, err := disableAuthenticatorMFAForCurrentUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setAppSessionCookies(e, response.token, response.csrfToken, response.Session.ExpiresAt)
	return apiSuccessJSON(e, 200, response)
}

func createAppSessionResponse(app core.App, user *core.Record) (sessionResponse, error) {
	token, csrfToken, session, err := createAppSession(app, user.Id)
	if err != nil {
		return sessionResponse{}, err
	}
	return sessionResponseFromRecord(token, csrfToken, session.GetString("expiresAt"), user), nil
}

func createAppSession(app core.App, userID string) (string, string, *core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("app_sessions")
	if err != nil {
		return "", "", nil, err
	}
	token := randomURLToken(appSessionTokenN)
	csrfToken := randomURLToken(appSessionCSRFTokens)
	now := time.Now().UTC()
	session := core.NewRecord(collection)
	session.Set("user", userID)
	// session token 只进 HttpOnly cookie；CSRF token 只进同站非 HttpOnly cookie，数据库两者都只保存 hash。
	session.Set("tokenHash", tokenHash(token))
	session.Set("csrfTokenHash", tokenHash(csrfToken))
	session.Set("expiresAt", now.Add(appSessionTTL).Format(time.RFC3339Nano))
	session.Set("lastSeenAt", now.Format(time.RFC3339Nano))
	if err := app.Save(session); err != nil {
		return "", "", nil, err
	}
	return token, csrfToken, session, nil
}

func renewAccountSecuritySession(app core.App, userID string) (sessionResponse, error) {
	user, err := app.FindRecordById("users", userID)
	if err != nil {
		return sessionResponse{}, err
	}
	// 自助账号安全操作采用“续签当前浏览器”：PB tokenKey 废掉原生 JWT，产品新 session 保留，其它 bearer 全部失效。
	user.RefreshTokenKey()
	if err := app.Save(user); err != nil {
		return sessionResponse{}, err
	}
	token, csrfToken, session, err := createAppSession(app, userID)
	if err != nil {
		return sessionResponse{}, err
	}
	if err := deleteAppSessionsForUserExcept(app, userID, session.Id); err != nil {
		return sessionResponse{}, err
	}
	if err := deleteRecordsByFilter(app, "mfa_auth_tickets", "user = {:user}", dbx.Params{"user": userID}); err != nil {
		return sessionResponse{}, err
	}
	return sessionResponseFromRecord(token, csrfToken, session.GetString("expiresAt"), user), nil
}

func appAuthRecordByToken(app core.App, token string) (*core.Record, *core.Record, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, nil, sql.ErrNoRows
	}
	session, err := app.FindFirstRecordByFilter(
		"app_sessions",
		"tokenHash = {:hash} && expiresAt > {:now}",
		dbx.Params{"hash": tokenHash(token), "now": nowString()},
	)
	if err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(session.GetString("csrfTokenHash")) == "" {
		return nil, nil, sql.ErrNoRows
	}
	user, err := app.FindRecordById("users", session.GetString("user"))
	if err != nil {
		return nil, nil, err
	}
	return user, session, nil
}

func deleteAppSessionByToken(app core.App, token string) error {
	session, err := app.FindFirstRecordByFilter("app_sessions", "tokenHash = {:hash}", dbx.Params{"hash": tokenHash(token)})
	if err != nil {
		return err
	}
	return app.Delete(session)
}

func deleteAppSessionsForUser(app core.App, userID string) error {
	return deleteAppSessionsForUserExcept(app, userID, "")
}

func deleteAppSessionsForUserExcept(app core.App, userID string, keepSessionID string) error {
	params := dbx.Params{"user": userID}
	filter := "user = {:user}"
	if strings.TrimSpace(keepSessionID) != "" {
		filter += " && id != {:keep}"
		params["keep"] = keepSessionID
	}
	for {
		sessions, err := app.FindRecordsByFilter("app_sessions", filter, "", 200, 0, params)
		if err != nil {
			return err
		}
		if len(sessions) == 0 {
			return nil
		}
		for _, session := range sessions {
			if err := app.Delete(session); err != nil {
				return err
			}
		}
	}
}

func sessionResponseFromRecord(token string, csrfToken string, expiresAt string, user *core.Record) sessionResponse {
	return sessionResponse{
		Type: "session",
		Session: appSessionTokenResponse{
			ExpiresAt: expiresAt,
		},
		User: authUserResponse{
			ID:     user.Id,
			Email:  user.Email(),
			Name:   user.GetString("name"),
			Role:   normalizeRole(user.GetString("role")),
			Banned: user.GetBool("banned"),
		},
		token:     token,
		csrfToken: csrfToken,
	}
}

func createMfaAuthTicket(app core.App, userID string, methods []string) (string, string, error) {
	return createMfaTicketRecord(app, userID, methods, "")
}

func appSameOriginUnsafeMiddleware(e *core.RequestEvent) error {
	if !strings.HasPrefix(e.Request.URL.Path, "/api/app/") || !isUnsafeHTTPMethod(e.Request.Method) {
		return e.Next()
	}
	if err := requireSameOriginRequest(e.Request); err != nil {
		return e.ForbiddenError(serverText(requestLocale(e.Request), "auth.sessionExpired"), err)
	}
	return e.Next()
}

func isUnsafeHTTPMethod(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func validateAppSessionCSRF(request *http.Request, session *core.Record) error {
	if !isUnsafeHTTPMethod(request.Method) {
		return nil
	}
	// CSRF cookie/header 只证明脚本运行在同站页面上下文；授权事实仍来自 HttpOnly session cookie 和服务端 hash。
	csrfToken := strings.TrimSpace(request.Header.Get(appCSRFHeaderName))
	csrfHash := strings.TrimSpace(session.GetString("csrfTokenHash"))
	if csrfToken == "" || csrfHash == "" {
		return errors.New("missing csrf token")
	}
	if subtle.ConstantTimeCompare([]byte(tokenHash(csrfToken)), []byte(csrfHash)) != 1 {
		return errors.New("invalid csrf token")
	}
	return nil
}

func requireSameOriginRequest(request *http.Request) error {
	// fnOS 内置浏览器经应用代理访问时，页面 Origin 与上游 Host 不同；浏览器生成的 same-origin 才反映它实际请求的同源关系。
	// same-site/none/cross-site 不能放行写请求；缺少 Fetch Metadata 时继续用 Origin/Referer 严格校验。
	switch request.Header.Get("Sec-Fetch-Site") {
	case "same-origin":
		return nil
	case "same-site", "cross-site", "none":
		return errors.New("fetch site mismatch")
	}
	expected := requestOrigin(request)
	if expected == "" {
		return errors.New("missing request origin")
	}
	if origin := strings.TrimSpace(request.Header.Get("Origin")); origin != "" {
		if sameOrigin(origin, expected) {
			return nil
		}
		return errors.New("origin mismatch")
	}
	if referer := strings.TrimSpace(request.Header.Get("Referer")); referer != "" {
		if sameOrigin(referer, expected) {
			return nil
		}
		return errors.New("referer mismatch")
	}
	return errors.New("missing origin")
}

func sameOrigin(value string, expected string) bool {
	parsed, err := urlParse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Scheme+"://"+parsed.Host, expected)
}

func urlParse(value string) (*url.URL, error) {
	return url.Parse(value)
}

func requestOrigin(request *http.Request) string {
	host := strings.TrimSpace(request.Host)
	if host == "" {
		return ""
	}
	proto := "http"
	if request.TLS != nil {
		proto = "https"
	}
	if forwarded := strings.ToLower(strings.TrimSpace(request.Header.Get("X-Forwarded-Proto"))); forwarded == "https" {
		proto = "https"
	}
	return proto + "://" + host
}

func sessionTokenFromRequest(request *http.Request) string {
	cookie, err := request.Cookie(appSessionCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

func setAppSessionCookies(e *core.RequestEvent, token string, csrfToken string, expiresAt string) {
	if strings.TrimSpace(token) == "" || strings.TrimSpace(csrfToken) == "" {
		return
	}
	secure := appSessionCookieSecure(e.Request)
	maxAge := int(appSessionTTL.Seconds())
	appendResponseCookie(e, &http.Cookie{
		Name:     appSessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge,
		Expires:  parseCookieExpiresAt(expiresAt),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	appendResponseCookie(e, &http.Cookie{
		Name:     appCSRFCookieName,
		Value:    csrfToken,
		Path:     "/",
		MaxAge:   maxAge,
		Expires:  parseCookieExpiresAt(expiresAt),
		HttpOnly: false,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

func clearAppSessionCookies(e *core.RequestEvent) {
	secure := appSessionCookieSecure(e.Request)
	for _, name := range []string{appSessionCookieName, appCSRFCookieName} {
		appendResponseCookie(e, &http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: name == appSessionCookieName,
			SameSite: http.SameSiteLaxMode,
			Secure:   secure,
		})
	}
}

func appendResponseCookie(e *core.RequestEvent, cookie *http.Cookie) {
	e.Response.Header().Add("Set-Cookie", cookie.String())
}

func appSessionCookieSecure(request *http.Request) bool {
	if request.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Forwarded-Proto")), "https")
}

func parseCookieExpiresAt(value string) time.Time {
	expiresAt, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Now().UTC().Add(appSessionTTL)
	}
	return expiresAt
}

func randomURLToken(size int) string {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func nowString() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// 审计时间戳缺失或损坏时必须修复；只有可信 RFC3339Nano 且仍新鲜的值才能跳过写库。
func shouldTouchAuditTimestamp(value string, now time.Time) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return true
	}
	lastTouchedAt, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return true
	}
	return now.UTC().Sub(lastTouchedAt.UTC()) >= auditTouchInterval
}
