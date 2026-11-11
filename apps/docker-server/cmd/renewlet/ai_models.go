package main

// ai_models.go 是 Docker/Go 运行面的 AI 模型列表代理。
//
// 该端点只在用户显式刷新时访问第三方 /models；Renewlet 发出的 API key 不入库、不回显，
// provider 原始响应只随当前认证错误返回，供设置页详情弹窗排查。
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const (
	aiModelListTimeout       = 15 * time.Second
	aiModelListResponseBytes = 1 << 20
	aiModelListMaxModels     = 300
)

type aiModelListRequest struct {
	ProviderType   string                 `json:"providerType"`
	BaseURL        string                 `json:"baseUrl"`
	APIKey         settingsSecretMutation `json:"apiKey"`
	ResolvedAPIKey string                 `json:"-"`
}

func (r *aiModelListRequest) Validate(locale appLocale) error {
	r.ProviderType = strings.TrimSpace(r.ProviderType)
	r.BaseURL = strings.TrimSpace(r.BaseURL)
	if err := r.APIKey.Validate(locale); err != nil {
		return err
	}
	if !isValidAIRecognitionProviderType(r.ProviderType) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.BaseURL != "" && sanitizeAIRecognitionBaseURL(r.BaseURL) == "" {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	endpoint := resolveAIProviderEndpoint(aiRecognitionSettings{
		ProviderType: r.ProviderType,
		BaseURL:      r.BaseURL,
		APIKey:       "",
	})
	if endpoint.BaseURLRequired && r.BaseURL == "" {
		return errors.New(serverText(locale, "aiRecognition.baseUrlRequired"))
	}
	return nil
}

type aiModelCapabilities struct {
	TextInput        *bool `json:"textInput"`
	ImageInput       *bool `json:"imageInput"`
	StructuredOutput *bool `json:"structuredOutput"`
	Thinking         *bool `json:"thinking"`
}

type aiModelListItem struct {
	ID               string              `json:"id"`
	DisplayName      *string             `json:"displayName"`
	CreatedAt        *string             `json:"createdAt"`
	OwnedBy          *string             `json:"ownedBy"`
	InputTokenLimit  *int                `json:"inputTokenLimit"`
	OutputTokenLimit *int                `json:"outputTokenLimit"`
	Capabilities     aiModelCapabilities `json:"capabilities"`
}

type aiModelListResponse struct {
	ProviderType      string            `json:"providerType"`
	TransportProtocol string            `json:"transportProtocol"`
	Models            []aiModelListItem `json:"models"`
	Truncated         bool              `json:"truncated"`
}

type aiModelListErrorDetails struct {
	RawResponseText *string `json:"rawResponseText,omitempty"`
}

type aiModelListEndpoint struct {
	URL               string
	Headers           http.Header
	Secrets           []string
	ModelListShape    string
	ProviderType      string
	TransportProtocol string
}

type aiModelListHTTPError struct {
	status           int
	code             string
	reason           string
	message          *string
	providerResponse *aiProviderResponse
}

func aiProviderResponseBody(response *aiProviderResponse) string {
	if response == nil {
		return ""
	}
	if response.Body != nil && strings.TrimSpace(*response.Body) != "" {
		return *response.Body
	}
	if response.StatusText != nil {
		return *response.StatusText
	}
	return ""
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (e *aiModelListHTTPError) Error() string {
	if e.message != nil {
		return *e.message
	}
	return e.reason
}

var aiModelListHTTPClient = defaultUpstreamHTTPClient(aiModelListTimeout)

func handleAIModelsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if e.Auth == nil {
		return e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
	}
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return err
	}
	// 请求体携带临时 provider 配置，必须保持严格 JSON，避免未知字段变成隐式模型代理配置。
	body, err := decodeStrictJSON[aiModelListRequest](e.Request, locale)
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
	body.ResolvedAPIKey, err = resolveSettingsSecretMutation(body.APIKey, current.AIRecognition.APIKey, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	endpoint := resolveAIProviderEndpoint(aiRecognitionSettings{ProviderType: body.ProviderType, BaseURL: body.BaseURL, APIKey: body.ResolvedAPIKey})
	if endpoint.APIKeyRequired && body.ResolvedAPIKey == "" {
		return e.BadRequestError(serverText(locale, "aiRecognition.apiKeyRequired"), nil)
	}
	response, err := listAIModels(e.Request.Context(), body, locale)
	if err != nil {
		var httpErr *aiModelListHTTPError
		if errors.As(err, &httpErr) {
			if httpErr.providerResponse != nil && httpErr.providerResponse.Status != nil {
				return writeAIRecognitionUpstreamResponse(e, httpErr.providerResponse)
			}
			message := firstNonBlank(aiProviderResponseBody(httpErr.providerResponse), optionalStringValue(httpErr.message), serverText(locale, "aiRecognition.modelListFailed"))
			return apiErrorJSON(e, httpErr.status, httpErr.code, message, aiModelListErrorDetails{
				RawResponseText: optionalUpstreamBody(message),
			})
		}
		return apiErrorJSON(e, http.StatusBadRequest, "AI_MODEL_LIST_FAILED", err.Error(), aiModelListErrorDetails{RawResponseText: optionalUpstreamBody(err.Error())})
	}
	return apiSuccessJSON(e, http.StatusOK, response)
}

func listAIModels(ctx context.Context, input aiModelListRequest, locale appLocale) (aiModelListResponse, error) {
	endpoint, err := buildAIModelListEndpoint(input)
	if err != nil {
		return aiModelListResponse{}, err
	}
	raw, err := fetchAIModelListJSON(ctx, endpoint, locale)
	if err != nil {
		return aiModelListResponse{}, err
	}
	models := normalizeAIModelList(endpoint.ModelListShape, raw)
	truncated := len(models) > aiModelListMaxModels
	if truncated {
		// 截断只影响下拉候选展示；用户仍可手动输入模型 ID，避免超大 provider 响应拖垮页面。
		models = models[:aiModelListMaxModels]
	}
	return aiModelListResponse{ProviderType: endpoint.ProviderType, TransportProtocol: endpoint.TransportProtocol, Models: models, Truncated: truncated}, nil
}

func buildAIModelListEndpoint(input aiModelListRequest) (aiModelListEndpoint, error) {
	headers := http.Header{"Accept": []string{"application/json"}}
	if !isValidAIRecognitionProviderType(input.ProviderType) {
		return aiModelListEndpoint{}, errAIRecognitionProviderInvalid
	}
	endpoint := resolveAIProviderEndpoint(aiRecognitionSettings{
		ProviderType: input.ProviderType,
		BaseURL:      input.BaseURL,
		APIKey:       input.ResolvedAPIKey,
	})
	for key, values := range endpoint.Headers {
		for _, value := range values {
			headers.Add(key, value)
		}
	}
	return aiModelListEndpoint{
		URL:               endpoint.ModelsURL,
		Headers:           headers,
		Secrets:           []string{input.ResolvedAPIKey},
		ModelListShape:    endpoint.ModelListShape,
		ProviderType:      endpoint.ProviderType,
		TransportProtocol: endpoint.TransportProtocol,
	}, nil
}

func fetchAIModelListJSON(ctx context.Context, endpoint aiModelListEndpoint, locale appLocale) (map[string]interface{}, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.URL, nil)
	if err != nil {
		return nil, err
	}
	for key, values := range endpoint.Headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	// 模型列表刷新是用户显式动作；第三方凭证只参与服务端代理请求，不写库、不回传浏览器。
	response, err := sendUpstreamHTTPRequest(request, upstreamHTTPRequestOptions{
		Provider: aiModelListProviderLabel(endpoint),
		Timeout:  aiModelListTimeout,
		Secrets:  endpoint.Secrets,
		Client:   aiModelListHTTPClient,
	})
	if err != nil {
		message := firstNonBlank(upstreamRawResponseTextFromError(err), err.Error())
		if upstreamOperationTimedOut(err) || errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			return nil, &aiModelListHTTPError{status: http.StatusRequestTimeout, code: "AI_MODEL_LIST_TIMEOUT", reason: "timeout", message: optionalUpstreamBody(message)}
		}
		return nil, &aiModelListHTTPError{status: http.StatusBadRequest, code: "AI_MODEL_LIST_FAILED", reason: "network", message: optionalUpstreamBody(message)}
	}
	defer func() { _ = response.Body.Close() }()
	body, err := readAIModelListResponseBody(response.Body, locale)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := redactAIModelListResponseText(string(body), endpoint.Secrets)
		return nil, &aiModelListHTTPError{
			status:           response.StatusCode,
			code:             "AI_MODEL_LIST_FAILED",
			reason:           fmt.Sprintf("http_%d", response.StatusCode),
			message:          optionalUpstreamBody(message),
			providerResponse: aiProviderResponseFromHTTPResponse(response, message, endpoint.Secrets...),
		}
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		message := redactAIModelListResponseText(string(body), endpoint.Secrets)
		return nil, &aiModelListHTTPError{
			status:           http.StatusBadRequest,
			code:             "AI_MODEL_LIST_INVALID_JSON",
			reason:           "invalid_json",
			message:          optionalUpstreamBody(message),
			providerResponse: aiProviderResponseFromHTTPResponse(response, message, endpoint.Secrets...),
		}
	}
	return raw, nil
}

func aiModelListProviderLabel(endpoint aiModelListEndpoint) string {
	if strings.TrimSpace(endpoint.ProviderType) == "" {
		return "AI models"
	}
	return endpoint.ProviderType + " models"
}

func readAIModelListResponseBody(reader io.Reader, locale appLocale) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, aiModelListResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > aiModelListResponseBytes {
		// 第三方错误页可能远大于正常模型列表；限制响应体能防止服务端代理变成内存放大器。
		return nil, &aiModelListHTTPError{
			status:  http.StatusRequestEntityTooLarge,
			code:    "AI_MODEL_LIST_RESPONSE_TOO_LARGE",
			reason:  "response_too_large",
			message: optionalUpstreamBody(serverText(locale, "common.requestBodyTooLarge")),
		}
	}
	return data, nil
}

func redactAIModelListResponseText(value string, secrets []string) string {
	return redactUpstreamSecrets(redactAIRecognitionSecrets(value), secrets)
}

func normalizeAIModelList(shape string, raw map[string]interface{}) []aiModelListItem {
	var models []aiModelListItem
	switch shape {
	case "gemini":
		models = normalizeGeminiModelList(raw)
	case "anthropic":
		models = normalizeAnthropicModelList(raw)
	default:
		models = normalizeOpenAIShapeModelList(raw)
	}
	return dedupeAIModelList(models)
}

func normalizeOpenAIShapeModelList(raw map[string]interface{}) []aiModelListItem {
	items := arrayFromMap(raw, "data")
	models := make([]aiModelListItem, 0, len(items))
	for _, item := range items {
		record := mapFromValue(item)
		id := stringFromMap(record, "id")
		if id == "" {
			continue
		}
		models = append(models, newAIModelListItem(aiModelListItem{
			ID:          id,
			DisplayName: optionalFirstNonBlank(stringFromMap(record, "display_name"), stringFromMap(record, "displayName")),
			CreatedAt:   optionalEpochSecondsISO(numberFromMap(record, "created")),
			OwnedBy:     optionalFirstNonBlank(stringFromMap(record, "owned_by"), stringFromMap(record, "ownedBy")),
		}))
	}
	return models
}

func normalizeGeminiModelList(raw map[string]interface{}) []aiModelListItem {
	items := arrayFromMap(raw, "models")
	models := make([]aiModelListItem, 0, len(items))
	for _, item := range items {
		record := mapFromValue(item)
		methods := stringSliceFromMap(record, "supportedGenerationMethods")
		if len(methods) > 0 && !containsString(methods, "generateContent") {
			continue
		}
		id := firstNonBlank(stringFromMap(record, "baseModelId"), strings.TrimPrefix(stringFromMap(record, "name"), "models/"))
		if id == "" {
			continue
		}
		textInput := true
		model := newAIModelListItem(aiModelListItem{
			ID:               id,
			DisplayName:      optionalFirstNonBlank(stringFromMap(record, "displayName")),
			InputTokenLimit:  optionalPositiveInt(numberFromMap(record, "inputTokenLimit")),
			OutputTokenLimit: optionalPositiveInt(numberFromMap(record, "outputTokenLimit")),
			Capabilities: aiModelCapabilities{
				TextInput: &textInput,
				Thinking:  optionalThinkingCapability(record["thinking"]),
			},
		})
		models = append(models, model)
	}
	return models
}

func normalizeAnthropicModelList(raw map[string]interface{}) []aiModelListItem {
	items := arrayFromMap(raw, "data")
	models := make([]aiModelListItem, 0, len(items))
	for _, item := range items {
		record := mapFromValue(item)
		id := stringFromMap(record, "id")
		if id == "" {
			continue
		}
		capabilities := mapFromValue(record["capabilities"])
		models = append(models, newAIModelListItem(aiModelListItem{
			ID:          id,
			DisplayName: optionalFirstNonBlank(stringFromMap(record, "display_name"), stringFromMap(record, "displayName")),
			CreatedAt:   optionalFirstNonBlank(stringFromMap(record, "created_at"), stringFromMap(record, "createdAt")),
			OwnedBy:     optionalFirstNonBlank(stringFromMap(record, "type")),
			Capabilities: aiModelCapabilities{
				TextInput:  optionalBoolFromMap(capabilities, "text"),
				ImageInput: optionalBoolFromMap(capabilities, "vision"),
				Thinking:   optionalBoolFromMap(capabilities, "thinking"),
			},
		}))
	}
	return models
}

func newAIModelListItem(item aiModelListItem) aiModelListItem {
	item.ID = strings.TrimSpace(item.ID)
	item.Capabilities = aiModelCapabilities{
		TextInput:        item.Capabilities.TextInput,
		ImageInput:       item.Capabilities.ImageInput,
		StructuredOutput: item.Capabilities.StructuredOutput,
		Thinking:         item.Capabilities.Thinking,
	}
	return item
}

func dedupeAIModelList(models []aiModelListItem) []aiModelListItem {
	out := make([]aiModelListItem, 0, len(models))
	seen := map[string]struct{}{}
	for _, model := range models {
		key := strings.ToLower(model.ID)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, model)
	}
	return out
}

func mapFromValue(value interface{}) map[string]interface{} {
	if data, ok := value.(map[string]interface{}); ok {
		return data
	}
	return map[string]interface{}{}
}

func arrayFromMap(value map[string]interface{}, key string) []interface{} {
	if data, ok := value[key].([]interface{}); ok {
		return data
	}
	return nil
}

func stringFromMap(value map[string]interface{}, key string) string {
	if data, ok := value[key].(string); ok {
		return strings.TrimSpace(data)
	}
	return ""
}

func numberFromMap(value map[string]interface{}, key string) float64 {
	if data, ok := value[key].(float64); ok {
		return data
	}
	return 0
}

func stringSliceFromMap(value map[string]interface{}, key string) []string {
	raw, ok := value[key].([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, strings.TrimSpace(text))
		}
	}
	return out
}

func optionalBoolFromMap(value map[string]interface{}, key string) *bool {
	if data, ok := value[key].(bool); ok {
		return &data
	}
	return nil
}

func optionalThinkingCapability(value interface{}) *bool {
	if data, ok := value.(bool); ok {
		return &data
	}
	if value != nil {
		data := true
		return &data
	}
	return nil
}

func optionalPositiveInt(value float64) *int {
	if value <= 0 {
		return nil
	}
	out := int(value)
	return &out
}

func optionalEpochSecondsISO(value float64) *string {
	if value <= 0 {
		return nil
	}
	text := time.Unix(int64(value), 0).UTC().Format(time.RFC3339)
	return &text
}

func optionalFirstNonBlank(values ...string) *string {
	value := firstNonBlank(values...)
	if value == "" {
		return nil
	}
	return &value
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
