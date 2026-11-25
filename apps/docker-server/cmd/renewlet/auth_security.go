package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const (
	authSecurityCollectionName = "auth_security_settings"
	// 访问安全是站点级策略，固定 singleton 避免把 Turnstile 凭据误建成用户 settings 或可导出的多租户数据。
	authSecurityRecordKey     = "global"
	turnstileSiteverifyURL    = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	turnstileVerifyTimeout    = 5 * time.Second
	turnstileResponseMaxBytes = 32 * 1024
)

var (
	errTurnstileRequired         = errors.New("TURNSTILE_REQUIRED")
	errTurnstileFailed           = errors.New("TURNSTILE_FAILED")
	errTurnstileConfigIncomplete = errors.New("TURNSTILE_CONFIG_INCOMPLETE")
	turnstileHTTPClient          = &http.Client{Timeout: turnstileVerifyTimeout}
	verifyTurnstileToken         = verifyCloudflareTurnstileToken
)

type turnstilePublicConfig struct {
	Enabled bool   `json:"enabled"`
	SiteKey string `json:"siteKey"`
}

type authSecurityTurnstileSettings struct {
	Enabled          bool   `json:"enabled"`
	SiteKey          string `json:"siteKey"`
	SecretConfigured bool   `json:"secretConfigured"`
}

type authSecurityResponse struct {
	Turnstile authSecurityTurnstileSettings `json:"turnstile"`
}

type authSecurityTurnstileUpdate struct {
	Enabled bool   `json:"enabled"`
	SiteKey string `json:"siteKey"`
	// nil 表示保留旧 secret，空字符串表示清空；PUT 响应永远只回 secretConfigured。
	Secret *string `json:"secret,omitempty"`
}

type authSecurityUpdateRequest struct {
	Turnstile authSecurityTurnstileUpdate `json:"turnstile"`
}

// 测试接口沿用管理端 write-only secret 语义：secret 非空测草稿，空/省略回退已保存密钥，响应只给布尔结果。
type authSecurityTurnstileTestRequest struct {
	Turnstile authSecurityTurnstileTestInput `json:"turnstile"`
}

type authSecurityTurnstileTestInput struct {
	SiteKey        string `json:"siteKey"`
	Secret         string `json:"secret,omitempty"`
	TurnstileToken string `json:"turnstileToken,omitempty"`
}

type authSecurityTurnstileTestResponse struct {
	Verified bool `json:"verified"`
}

type authSecurityStoredSettings struct {
	TurnstileEnabled bool
	TurnstileSiteKey string
	TurnstileSecret  string
}

type turnstileSiteverifyResponse struct {
	Success bool `json:"success"`
}

func (r *authSecurityUpdateRequest) Validate(locale appLocale) error {
	r.Turnstile.SiteKey = strings.TrimSpace(r.Turnstile.SiteKey)
	if len(r.Turnstile.SiteKey) > 256 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.Turnstile.Secret != nil {
		secret := strings.TrimSpace(*r.Turnstile.Secret)
		if len(secret) > 4096 {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
		r.Turnstile.Secret = &secret
	}
	return nil
}

func (r *authSecurityTurnstileTestRequest) Validate(locale appLocale) error {
	r.Turnstile.SiteKey = strings.TrimSpace(r.Turnstile.SiteKey)
	r.Turnstile.Secret = strings.TrimSpace(r.Turnstile.Secret)
	r.Turnstile.TurnstileToken = strings.TrimSpace(r.Turnstile.TurnstileToken)
	// 这里只做边界归一和尺寸限制；“是否具备 token/secret”由 route 返回稳定业务 code。
	if len(r.Turnstile.SiteKey) > 256 || len(r.Turnstile.Secret) > 4096 || len(r.Turnstile.TurnstileToken) > 2048 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

func handleAuthSecurityRead(app core.App, e *core.RequestEvent) error {
	settings, err := readAuthSecuritySettings(app)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, authSecurityResponseFromStored(settings))
}

func handleAuthSecurityUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[authSecurityUpdateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	current, err := readAuthSecuritySettings(app)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	next := current
	next.TurnstileEnabled = body.Turnstile.Enabled
	next.TurnstileSiteKey = body.Turnstile.SiteKey
	if body.Turnstile.Secret != nil {
		next.TurnstileSecret = *body.Turnstile.Secret
	}
	if next.TurnstileEnabled && !next.turnstileComplete() {
		// 启用必须同时具备 site key 和 secret；半配置状态只能保存为关闭，不能让登录页拿到无效挑战。
		return apiErrorJSON(e, http.StatusBadRequest, "TURNSTILE_CONFIG_INCOMPLETE", serverText(locale, "auth.turnstileConfigIncomplete"), nil)
	}
	if err := saveAuthSecuritySettings(app, next); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, authSecurityResponseFromStored(next))
}

func handleAuthSecurityTurnstileTest(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[authSecurityTurnstileTestRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if body.Turnstile.SiteKey == "" {
		return apiErrorJSON(e, http.StatusBadRequest, "TURNSTILE_CONFIG_INCOMPLETE", serverText(locale, "auth.turnstileConfigIncomplete"), nil)
	}
	secret := body.Turnstile.Secret
	if secret == "" {
		// 测试里的空 secret 不是“清空”，只表示沿用服务端已保存密钥，避免管理员必须重新粘贴密钥才能验配置。
		current, err := readAuthSecuritySettings(app)
		if err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		secret = current.TurnstileSecret
	}
	if secret == "" {
		return apiErrorJSON(e, http.StatusBadRequest, "TURNSTILE_CONFIG_INCOMPLETE", serverText(locale, "auth.turnstileConfigIncomplete"), nil)
	}
	if body.Turnstile.TurnstileToken == "" {
		return apiErrorJSON(e, http.StatusBadRequest, "TURNSTILE_REQUIRED", serverText(locale, "auth.turnstileRequired"), nil)
	}
	// 配置测试只消费当前草稿 token 和候选 secret，不落库；成功后管理员仍要显式保存/启用。
	if err := verifyTurnstileToken(e.Request.Context(), secret, body.Turnstile.TurnstileToken, turnstileClientIP(e.Request)); err != nil {
		// 测试接口同样失败关闭，但用独立 code，避免前端把配置错误展示成登录失败。
		return apiErrorJSON(e, http.StatusBadRequest, "TURNSTILE_TEST_FAILED", serverText(locale, "auth.turnstileTestFailed"), nil)
	}
	return apiSuccessJSON(e, http.StatusOK, authSecurityTurnstileTestResponse{Verified: true})
}

func publicTurnstileConfig(app core.App) (turnstilePublicConfig, error) {
	settings, err := readAuthSecuritySettings(app)
	if err != nil {
		return turnstilePublicConfig{}, err
	}
	return settings.publicTurnstile(), nil
}

func (settings authSecurityStoredSettings) publicTurnstile() turnstilePublicConfig {
	if !settings.turnstileComplete() {
		return turnstilePublicConfig{}
	}
	// 认证前 status 只能公开浏览器渲染 widget 所需的 siteKey；secretConfigured 也只属于管理员配置面。
	return turnstilePublicConfig{Enabled: true, SiteKey: settings.TurnstileSiteKey}
}

func requireTurnstileForPasswordLogin(app core.App, request *http.Request, token string) error {
	settings, err := readAuthSecuritySettings(app)
	if err != nil {
		return err
	}
	if !settings.turnstileComplete() {
		return nil
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return errTurnstileRequired
	}
	// Turnstile 必须在密码哈希校验前完成，避免爆破请求把成本推到用户查询和 password verify 热路径。
	if err := verifyTurnstileToken(request.Context(), settings.TurnstileSecret, token, turnstileClientIP(request)); err != nil {
		return errTurnstileFailed
	}
	return nil
}

func turnstileAPIError(e *core.RequestEvent, err error) error {
	locale := requestLocale(e.Request)
	switch {
	case errors.Is(err, errTurnstileRequired):
		return apiErrorJSON(e, http.StatusBadRequest, "TURNSTILE_REQUIRED", serverText(locale, "auth.turnstileRequired"), nil)
	case errors.Is(err, errTurnstileFailed):
		// Siteverify 网络失败和挑战失败都失败关闭；响应不透出 Cloudflare 原始错误，避免泄露配置和验证细节。
		return apiErrorJSON(e, http.StatusBadRequest, "TURNSTILE_FAILED", serverText(locale, "auth.turnstileFailed"), nil)
	default:
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
}

func (s authSecurityStoredSettings) turnstileComplete() bool {
	return s.TurnstileEnabled && s.TurnstileSiteKey != "" && s.TurnstileSecret != ""
}

func authSecurityResponseFromStored(settings authSecurityStoredSettings) authSecurityResponse {
	return authSecurityResponse{
		Turnstile: authSecurityTurnstileSettings{
			Enabled:          settings.TurnstileEnabled,
			SiteKey:          settings.TurnstileSiteKey,
			SecretConfigured: settings.TurnstileSecret != "",
		},
	}
}

func authSecurityRecord(app core.App) (*core.Record, error) {
	row, err := app.FindFirstRecordByData(authSecurityCollectionName, "key", authSecurityRecordKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}
func readAuthSecuritySettings(app core.App) (authSecurityStoredSettings, error) {
	record, err := authSecurityRecord(app)
	return authSecuritySettingsFromRecord(record), err
}

func authSecurityRecordForWrite(app core.App) (*core.Record, error) {
	record, err := authSecurityRecord(app)
	if err != nil || record != nil {
		return record, err
	}
	collection, err := app.FindCollectionByNameOrId(authSecurityCollectionName)
	if err != nil {
		return nil, err
	}
	record = core.NewRecord(collection)
	record.Set("key", authSecurityRecordKey)
	return record, nil
}

func saveAuthSecuritySettings(app core.App, settings authSecurityStoredSettings) error {
	// 两种登录策略共享同一行，把读取和保存放进同一事务，避免一方覆盖另一方刚生效的配置。
	return app.RunInTransaction(func(tx core.App) error {
		record, err := authSecurityRecordForWrite(tx)
		if err != nil {
			return err
		}
		record.Set("turnstileEnabled", settings.TurnstileEnabled)
		record.Set("turnstileSiteKey", strings.TrimSpace(settings.TurnstileSiteKey))
		record.Set("turnstileSecret", strings.TrimSpace(settings.TurnstileSecret))
		return tx.Save(record)
	})
}

func authSecuritySettingsFromRecord(record *core.Record) authSecurityStoredSettings {
	if record == nil {
		return authSecurityStoredSettings{}
	}
	return authSecurityStoredSettings{
		TurnstileEnabled: record.GetBool("turnstileEnabled"),
		TurnstileSiteKey: strings.TrimSpace(record.GetString("turnstileSiteKey")),
		TurnstileSecret:  strings.TrimSpace(record.GetString("turnstileSecret")),
	}
}

func normalizeAuthSecuritySettingsRecord(record *core.Record) error {
	key := strings.TrimSpace(record.GetString("key"))
	if key == "" {
		key = authSecurityRecordKey
	}
	if key != authSecurityRecordKey {
		return errors.New("AUTH_SECURITY_KEY_INVALID")
	}
	siteKey := strings.TrimSpace(record.GetString("turnstileSiteKey"))
	secret := strings.TrimSpace(record.GetString("turnstileSecret"))
	if record.GetBool("turnstileEnabled") && (siteKey == "" || secret == "") {
		return errTurnstileConfigIncomplete
	}
	// secret 所在 collection 不开放 REST rules；hook 仍负责覆盖 SDK/Admin UI 写入，防止半配置状态启用人机验证。
	record.Set("key", key)
	record.Set("turnstileSiteKey", siteKey)
	record.Set("turnstileSecret", secret)
	return nil
}

func verifyCloudflareTurnstileToken(ctx context.Context, secret string, token string, remoteIP string) error {
	ctx, cancel := context.WithTimeout(ctx, turnstileVerifyTimeout)
	defer cancel()

	form := url.Values{}
	form.Set("secret", secret)
	form.Set("response", token)
	if remoteIP != "" {
		// remoteip 只是 Cloudflare 风险辅助信号，不参与 Renewlet 鉴权；拿不到可信客户端 IP 时宁可省略。
		form.Set("remoteip", remoteIP)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, turnstileSiteverifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")

	response, err := turnstileHTTPClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return errTurnstileFailed
	}
	var payload turnstileSiteverifyResponse
	// Siteverify 原始响应只服务本次布尔判定；限长解析后丢弃，避免第三方 body 进入日志、错误详情或持久层。
	if err := json.NewDecoder(io.LimitReader(response.Body, turnstileResponseMaxBytes)).Decode(&payload); err != nil {
		return err
	}
	if !payload.Success {
		return errTurnstileFailed
	}
	return nil
}

func turnstileClientIP(request *http.Request) string {
	candidates := []string{
		request.Header.Get("CF-Connecting-IP"),
		request.Header.Get("True-Client-IP"),
	}
	if forwarded := strings.TrimSpace(request.Header.Get("X-Forwarded-For")); forwarded != "" {
		candidates = append(candidates, strings.Split(forwarded, ",")[0])
	}
	if host, _, err := net.SplitHostPort(request.RemoteAddr); err == nil {
		candidates = append(candidates, host)
	} else {
		candidates = append(candidates, request.RemoteAddr)
	}
	for _, candidate := range candidates {
		value := strings.TrimSpace(candidate)
		if ip := net.ParseIP(value); ip != nil {
			return ip.String()
		}
	}
	return ""
}
