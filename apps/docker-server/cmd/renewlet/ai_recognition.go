package main

// ai_recognition.go 定义 Docker/Go 运行面的 AI 识别 API 边界。
//
// 路由只返回结构化草稿和脱敏 diagnostics，不直接写 subscriptions；前端必须继续走 import preview/apply，
// 让冲突处理、Logo 分配和服务端持久层校验复用同一条导入链路。
import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	aiRecognitionMaxTextChars             = 30000
	aiRecognitionMaxImages                = 5
	aiRecognitionMaxImageBytes            = 5 * 1024 * 1024
	aiRecognitionMaxSubscriptions         = 100
	aiRecognitionMultipartOverhead        = 1 << 20
	aiRecognitionThinkingControlMax       = 8 << 10
	aiRecognitionProviderTimeout          = 90 * time.Second
	aiRecognitionTestProviderTokens       = 16
	aiRecognitionTestPrompt               = "Reply with OK."
	aiRecognitionMaxPromptTags            = 50
	aiRecognitionEstimatedRecordsPerImage = 4
)

var (
	errAIRecognitionBodyTooLarge    = errors.New("AI_RECOGNITION_BODY_TOO_LARGE")
	errAIRecognitionInputEmpty      = errors.New("AI_RECOGNITION_INPUT_EMPTY")
	errAIRecognitionNoSubscriptions = errors.New("AI_RECOGNITION_NO_SUBSCRIPTIONS")
	errAIRecognitionProviderInvalid = errors.New("AI_PROVIDER_INVALID")
	errAIRecognitionEmptyObject     = errors.New("AI_RECOGNITION_EMPTY_OBJECT")
)

type aiRecognitionSettings struct {
	ProviderType           string             `json:"providerType"`
	TransportProtocol      string             `json:"transportProtocol"`
	Model                  string             `json:"model"`
	ModelInputMode         string             `json:"modelInputMode"`
	BaseURL                string             `json:"baseUrl"`
	APIKey                 string             `json:"apiKey"`
	DefaultThinkingControl *aiThinkingControl `json:"defaultThinkingControl"`
}

type aiThinkingControl struct {
	Provider     string `json:"provider"`
	Effort       string `json:"effort,omitempty"`
	Mode         string `json:"mode,omitempty"`
	Budget       *int   `json:"budget,omitempty"`
	Level        string `json:"level,omitempty"`
	BudgetTokens *int   `json:"budgetTokens,omitempty"`
}

type aiRecognitionInput struct {
	Text                    string
	Images                  []aiRecognitionImage
	ThinkingControl         *aiThinkingControl
	ThinkingControlProvided bool
}

type aiRecognitionImage struct {
	MediaType string
	DataURL   string
	SizeBytes int
}

type aiRecognizeResponse struct {
	ProviderType      string                          `json:"providerType"`
	TransportProtocol string                          `json:"transportProtocol"`
	Model             string                          `json:"model"`
	Subscriptions     []aiRecognizedSubscriptionDraft `json:"subscriptions"`
	Warnings          []string                        `json:"warnings"`
	Diagnostics       aiRecognitionDiagnostics        `json:"diagnostics"`
}

type aiRecognizedSubscriptionDraft struct {
	Name                         string                `json:"name"`
	Price                        *string               `json:"price"`
	Currency                     *string               `json:"currency"`
	BillingCycle                 *string               `json:"billingCycle"`
	CustomDays                   *int                  `json:"customDays"`
	CustomCycleUnit              *string               `json:"customCycleUnit"`
	OneTimeTermCount             *int                  `json:"oneTimeTermCount"`
	OneTimeTermUnit              *string               `json:"oneTimeTermUnit"`
	Category                     *string               `json:"category"`
	Status                       *string               `json:"status"`
	PaymentMethod                *string               `json:"paymentMethod"`
	StartDate                    *string               `json:"startDate"`
	NextBillingDate              *string               `json:"nextBillingDate"`
	AutoCalculateNextBillingDate *bool                 `json:"autoCalculateNextBillingDate"`
	TrialEndDate                 *string               `json:"trialEndDate"`
	Website                      *aiSuggestedTextField `json:"website"`
	Notes                        *aiSuggestedTextField `json:"notes"`
	Tags                         []string              `json:"tags"`
	ReminderDays                 *int                  `json:"reminderDays"`
	RepeatReminderEnabled        *bool                 `json:"repeatReminderEnabled"`
	RepeatReminderInterval       *string               `json:"repeatReminderInterval"`
	RepeatReminderWindow         *string               `json:"repeatReminderWindow"`
	Confidence                   string                `json:"confidence"`
	Warnings                     []string              `json:"warnings"`
}

type aiSuggestedTextField struct {
	Value  string `json:"value"`
	Source string `json:"source"`
}

type aiRecognitionPublicSettings struct {
	ProviderType           string             `json:"providerType"`
	TransportProtocol      string             `json:"transportProtocol"`
	Model                  string             `json:"model"`
	ModelInputMode         string             `json:"modelInputMode"`
	BaseURL                string             `json:"baseUrl"`
	DefaultThinkingControl *aiThinkingControl `json:"defaultThinkingControl"`
}

type aiRecognitionTestRequest struct {
	Settings aiRecognitionPublicSettings `json:"settings"`
	APIKey   settingsSecretMutation      `json:"apiKey"`
}

func (r *aiRecognitionTestRequest) Validate(locale appLocale) error {
	r.Settings.ProviderType = strings.TrimSpace(r.Settings.ProviderType)
	if !isValidAIRecognitionProviderType(r.Settings.ProviderType) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.Settings.BaseURL != "" && sanitizeAIRecognitionBaseURL(r.Settings.BaseURL) == "" {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.Settings.DefaultThinkingControl != nil {
		if err := validateAIThinkingControl(r.Settings.DefaultThinkingControl); err != nil {
			return err
		}
	}
	return r.APIKey.Validate(locale)
}

type aiRecognitionTestResponse struct {
	ProviderType      string `json:"providerType"`
	TransportProtocol string `json:"transportProtocol"`
	Model             string `json:"model"`
}

type aiRecognitionErrorDetails struct {
	RawResponseText *string `json:"rawResponseText,omitempty"`
}

type aiRecognitionRunner interface {
	Recognize(ctx context.Context, settings aiRecognitionSettings, input aiRecognitionInput, locale appLocale, timezone string, configContext aiRecognitionConfigContext) (aiRecognizeResponse, error)
	Stream(ctx context.Context, settings aiRecognitionSettings, input aiRecognitionInput, locale appLocale, timezone string, configContext aiRecognitionConfigContext, sink aiRecognitionStreamSink) error
}

type goaiRecognitionRunner struct{}

var defaultAIRecognitionRunner aiRecognitionRunner = goaiRecognitionRunner{}

type aiRecognitionRunContext struct {
	Locale        appLocale
	Settings      appSettings
	AISettings    aiRecognitionSettings
	Input         aiRecognitionInput
	ConfigContext aiRecognitionConfigContext
}

func prepareAIRecognitionRunContext(app core.App, e *core.RequestEvent) (aiRecognitionRunContext, error) {
	locale := requestLocale(e.Request)
	if e.Auth == nil {
		return aiRecognitionRunContext{}, e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
	}
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return aiRecognitionRunContext{}, err
	}
	settings, err := currentUserSettings(app, e.Auth)
	if err != nil {
		return aiRecognitionRunContext{}, e.BadRequestError(validationErrorMessage(locale, "notification.settingsInvalid", err), err)
	}
	input, err := readAIRecognitionMultipart(e, locale)
	if err != nil {
		if errors.Is(err, errAIRecognitionBodyTooLarge) {
			return aiRecognitionRunContext{}, apiErrorJSON(e, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", serverText(locale, "common.requestBodyTooLarge"), nil)
		}
		if errors.Is(err, errAIRecognitionInputEmpty) {
			return aiRecognitionRunContext{}, e.BadRequestError(serverText(locale, "aiRecognition.inputRequired"), err)
		}
		if strings.Contains(err.Error(), "AI_RECOGNITION_IMAGE_TYPE_INVALID") {
			return aiRecognitionRunContext{}, e.BadRequestError(serverText(locale, "aiRecognition.imageTypeInvalid"), err)
		}
		return aiRecognitionRunContext{}, e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	aiSettings := sanitizeAIRecognitionSettings(settings.AIRecognition)
	// 设置页保存的 control 是本次识别的默认运行参数；multipart 明确携带的 control 只覆盖当前一次。
	if !input.ThinkingControlProvided {
		input.ThinkingControl = aiSettings.DefaultThinkingControl
	}
	if input.ThinkingControl != nil && !aiThinkingControlMatchesSettings(aiSettings, input.ThinkingControl) {
		// thinking control 绑定 provider；切换模型后旧 control 不能继续沿用，否则第三方会拒绝请求。
		return aiRecognitionRunContext{}, e.BadRequestError(serverText(locale, "aiRecognition.thinkingProviderMismatch"), nil)
	}
	// 临时请求也必须按当前模型能力收敛；旧客户端可能仍发送 GPT-5 不支持的 effort，清空后交给模型默认值。
	if !aiThinkingControlCompatibleWithModel(aiSettings.Model, input.ThinkingControl) {
		input.ThinkingControl = nil
	}
	if err := validateAIRecognitionSettings(aiSettings, locale); err != nil {
		return aiRecognitionRunContext{}, e.BadRequestError(err.Error(), err)
	}
	// 配置项只作为模型上下文和响应归一化依据；新增分类/支付方式仍必须走 import preview/apply 用户确认链路。
	configContext, err := aiRecognitionConfigContextForUser(app, e.Auth.Id, locale)
	if err != nil {
		return aiRecognitionRunContext{}, e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return aiRecognitionRunContext{Locale: locale, Settings: settings, AISettings: aiSettings, Input: input, ConfigContext: configContext}, nil
}

func handleAIRecognizeSubscriptions(app core.App, e *core.RequestEvent) error {
	runContext, err := prepareAIRecognitionRunContext(app, e)
	if err != nil {
		return err
	}
	response, err := defaultAIRecognitionRunner.Recognize(
		e.Request.Context(),
		runContext.AISettings,
		runContext.Input,
		runContext.Locale,
		runContext.Settings.Timezone,
		runContext.ConfigContext,
	)
	if err != nil {
		if diagnostics := aiRecognitionDiagnosticsFromError(err); diagnostics != nil {
			// 错误响应只回显 provider raw 文本；成功态 diagnostics 仍由正常响应返回，不混入错误详情。
			if errors.Is(err, errAIRecognitionNoSubscriptions) {
				return aiRecognitionJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.noSubscriptions"), "AI_RECOGNITION_EMPTY", "empty", nil, diagnostics)
			}
			if isAIRecognitionSchemaMismatchError(err) {
				return aiRecognitionJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.schemaMismatch"), "AI_RECOGNITION_SCHEMA_MISMATCH", "schema_mismatch", aiRecognitionCauseError(err), diagnostics)
			}
			return aiRecognitionJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.failed"), "AI_RECOGNITION_FAILED", "provider_failed", aiRecognitionCauseError(err), diagnostics)
		}
		if errors.Is(err, errAIRecognitionNoSubscriptions) {
			return e.BadRequestError(serverText(runContext.Locale, "aiRecognition.noSubscriptions"), nil)
		}
		if providerResponse := aiProviderResponseFromError(err); providerResponse != nil || upstreamRawResponseTextFromError(err) != "" {
			return aiRecognitionProviderResponseJSONError(e, http.StatusBadRequest, serverText(runContext.Locale, "aiRecognition.failed"), "AI_RECOGNITION_FAILED", "provider_failed", err, providerResponse)
		}
		if isAIRecognitionSchemaMismatchError(err) {
			return e.BadRequestError(serverText(runContext.Locale, "aiRecognition.schemaMismatch"), nil)
		}
		return e.BadRequestError(serverText(runContext.Locale, "aiRecognition.failed"), safeAIRecognitionError(err))
	}
	return apiSuccessJSON(e, http.StatusOK, response)
}

func handleAIRecognitionTestConnection(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if e.Auth == nil {
		return e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
	}
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return err
	}
	body, err := decodeStrictJSON[aiRecognitionTestRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := body.Validate(locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidPayload", err), err)
	}
	current, err := currentUserSettings(app, e.Auth)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	apiKey, err := resolveSettingsSecretMutation(body.APIKey, current.AIRecognition.APIKey, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	settings := sanitizeAIRecognitionSettings(aiRecognitionSettings{
		ProviderType:           body.Settings.ProviderType,
		TransportProtocol:      body.Settings.TransportProtocol,
		Model:                  body.Settings.Model,
		ModelInputMode:         body.Settings.ModelInputMode,
		BaseURL:                body.Settings.BaseURL,
		APIKey:                 apiKey,
		DefaultThinkingControl: body.Settings.DefaultThinkingControl,
	})
	if err := validateAIRecognitionSettings(settings, locale); err != nil {
		return e.BadRequestError(err.Error(), err)
	}
	err = testAIRecognitionConnection(e.Request.Context(), settings)
	if err != nil {
		// 连接测试只做一次最小文本生成；SDK 暴露的 provider body 只进入本次错误响应的 rawResponseText。
		return aiRecognitionProviderResponseJSONError(e, http.StatusBadRequest, serverText(locale, "aiRecognition.testFailed"), "AI_RECOGNITION_TEST_FAILED", "provider_failed", err, aiProviderResponseFromError(err))
	}
	return apiSuccessJSON(e, http.StatusOK, aiRecognitionTestResponse{ProviderType: settings.ProviderType, TransportProtocol: settings.TransportProtocol, Model: settings.Model})
}

func aiRecognitionConfigContextForUser(app core.App, userID string, locale appLocale) (aiRecognitionConfigContext, error) {
	tags, err := aiRecognitionExistingTagsForUser(app, userID)
	if err != nil {
		return aiRecognitionConfigContext{}, err
	}
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return aiRecognitionConfigContext{Tags: tags}, nil
		}
		return aiRecognitionConfigContext{}, err
	}
	if record == nil {
		return aiRecognitionConfigContext{Tags: tags}, nil
	}
	config, err := customConfigFromValue(record.Get("config"))
	if err != nil {
		return aiRecognitionConfigContext{}, err
	}
	if err := normalizeCustomConfigPayload(&config); err != nil {
		return aiRecognitionConfigContext{}, err
	}
	return aiRecognitionConfigContext{
		Categories:     aiRecognitionConfigOptions(config.Categories, locale, calendarFeedBuiltInCategoryLabelKey),
		PaymentMethods: aiRecognitionConfigOptions(config.PaymentMethods, locale, calendarFeedBuiltInPaymentMethodLabelKey),
		Tags:           tags,
	}, nil
}

func aiRecognitionExistingTagsForUser(app core.App, userID string) ([]string, error) {
	// 这些标签名会进入第三方 AI prompt；只传用户已经持久化的标签文本，不带历史订阅名称、金额或备注。
	// 派生表已经在启动时幂等建立；这里按与 Worker 相同的候选选择和排序读取，避免 SQLite
	// GROUP BY 对非聚合 tag 的任意取值，也避免两个运行面把同一用户标签送成不同 prompt 上下文。
	rows := []struct {
		Tag string `db:"tag"`
	}{}
	err := app.DB().NewQuery(`
		SELECT tag_row.tag
		FROM subscription_tags AS tag_row
		WHERE tag_row.user_id = {:user}
		  AND NOT EXISTS (
			SELECT 1
			FROM subscription_tags AS candidate
			WHERE candidate.user_id = tag_row.user_id
			  AND candidate.tag_norm = tag_row.tag_norm
			  AND (
				candidate.updated_at > tag_row.updated_at
				OR (candidate.updated_at = tag_row.updated_at AND candidate.subscription_id > tag_row.subscription_id)
				OR (
					candidate.updated_at = tag_row.updated_at
					AND candidate.subscription_id = tag_row.subscription_id
					AND candidate.tag > tag_row.tag
				)
			  )
		  )
		ORDER BY tag_row.updated_at DESC, tag_row.subscription_id DESC, tag_row.tag_norm ASC
		LIMIT {:limit}
	`).Bind(dbx.Params{"user": userID, "limit": aiRecognitionMaxPromptTags}).All(&rows)
	if err != nil {
		return nil, err
	}
	tags := make([]string, 0, len(rows))
	for _, row := range rows {
		if strings.TrimSpace(row.Tag) != "" {
			tags = append(tags, row.Tag)
		}
	}
	return tags, nil
}

func aiRecognitionConfigOptions(items []customConfigItem, locale appLocale, builtInLabelKey func(string) (string, bool)) []aiRecognitionConfigOption {
	out := make([]aiRecognitionConfigOption, 0, len(items))
	for _, item := range items {
		key, _ := builtInLabelKey(item.Value)
		out = append(out, aiRecognitionConfigOption{
			Value: item.Value,
			Label: localizedCustomConfigLabel(item.Labels, locale, key),
			ZhCN:  item.Labels.ZhCN,
			EnUS:  item.Labels.EnUS,
		})
	}
	return out
}

func aiRecognitionJSONError(e *core.RequestEvent, status int, message string, code string, reason string, err error, _ *aiRecognitionDiagnostics) error {
	if providerResponse := aiProviderResponseFromError(err); providerResponse != nil && providerResponse.Status != nil {
		return writeAIRecognitionUpstreamResponse(e, providerResponse)
	}
	raw := aiRecognitionUpstreamRawText(err)
	if raw != "" {
		message = raw
	}
	return apiErrorJSON(e, status, code, message, aiRecognitionErrorDetails{
		RawResponseText: optionalUpstreamBody(firstNonBlank(raw, optionalStringValue(safeAIRecognitionProviderMessage(err)), reason)),
	})
}

func aiRecognitionProviderResponseJSONError(e *core.RequestEvent, status int, message string, code string, reason string, err error, providerResponse *aiProviderResponse) error {
	if providerResponse != nil && providerResponse.Status != nil {
		return writeAIRecognitionUpstreamResponse(e, providerResponse)
	}
	raw := aiRecognitionUpstreamRawText(err)
	if raw == "" {
		raw = truncateAIRecognitionProviderText(aiProviderResponseBody(providerResponse))
	}
	if raw != "" {
		message = raw
	}
	return apiErrorJSON(e, status, code, message, map[string]interface{}{
		"rawResponseText": firstNonBlank(raw, optionalStringValue(safeAIRecognitionProviderMessage(err)), reason),
	})
}

// HTTP 响应已经来自 provider 时直接交付 status/body；只有没有上游 HTTP 响应的本地错误才进入产品 envelope。
func writeAIRecognitionUpstreamResponse(e *core.RequestEvent, providerResponse *aiProviderResponse) error {
	if providerResponse == nil || providerResponse.Status == nil {
		return nil
	}
	for name, value := range providerResponse.Headers {
		if safeUpstreamHeaderName(name) {
			e.Response.Header().Set(name, value)
		}
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	e.Response.Header().Set("X-Content-Type-Options", "nosniff")
	e.Response.WriteHeader(*providerResponse.Status)
	if providerResponse.Body == nil {
		return nil
	}
	_, err := e.Response.Write([]byte(*providerResponse.Body))
	return err
}

// provider/upstream 已经给出正文时，当前 API 的 message 也使用同一正文；调用方再决定是否附带本地错误码。
func aiRecognitionUpstreamRawText(err error) string {
	return truncateAIRecognitionProviderText(firstNonBlank(upstreamRawResponseTextFromError(err), aiProviderResponseBody(aiProviderResponseFromError(err))))
}

func truncateAIRecognitionProviderText(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= upstreamProviderResponseCaptureBodyMaxBytes {
		return value
	}
	// SSE message 与 Worker shared schema 共用 64KiB 上限；截断只保护协议边界，保留 provider 原文前缀，不拼本地错误说明。
	return string(runes[:upstreamProviderResponseCaptureBodyMaxBytes])
}
