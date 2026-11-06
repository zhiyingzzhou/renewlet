package main

// ai_recognition_input.go 负责读取 AI 识别 multipart 输入。
//
// 文本、图片和 thinking control 都是用户会直接发往第三方 provider 的敏感输入；这里先做总量限制、
// 图片类型白名单和 strict JSON control 校验，避免服务端代理成为大文件或未知配置入口。
import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

func readAIRecognitionMultipart(e *core.RequestEvent, locale appLocale) (aiRecognitionInput, error) {
	// MaxBytesReader 覆盖 multipart 头部开销，单个 part 仍单独限额；两层限制共同防止绕过图片数量预算。
	maxBodyBytes := int64(aiRecognitionMaxTextChars*4 + aiRecognitionMaxImages*aiRecognitionMaxImageBytes + aiRecognitionMultipartOverhead)
	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, maxBodyBytes)
	reader, err := e.Request.MultipartReader()
	if err != nil {
		return aiRecognitionInput{}, err
	}
	var input aiRecognitionInput
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if strings.Contains(err.Error(), "request body too large") {
				return aiRecognitionInput{}, errAIRecognitionBodyTooLarge
			}
			return aiRecognitionInput{}, err
		}
		if err := readAIRecognitionPart(part, &input, locale); err != nil {
			return aiRecognitionInput{}, err
		}
	}
	input.Text = strings.TrimSpace(input.Text)
	if len([]rune(input.Text)) > aiRecognitionMaxTextChars {
		return aiRecognitionInput{}, errAIRecognitionBodyTooLarge
	}
	if input.Text == "" && len(input.Images) == 0 {
		return aiRecognitionInput{}, errAIRecognitionInputEmpty
	}
	return input, nil
}

func readAIRecognitionPart(part *multipart.Part, input *aiRecognitionInput, locale appLocale) error {
	defer func() { _ = part.Close() }()
	switch part.FormName() {
	case "text":
		data, err := readLimitedPartBytes(part, aiRecognitionMaxTextChars*4)
		if err != nil {
			return err
		}
		input.Text = string(data)
	case "thinkingControl":
		input.ThinkingControlProvided = true
		data, err := readLimitedPartBytes(part, aiRecognitionThinkingControlMax)
		if err != nil {
			return err
		}
		control, err := parseAIThinkingControl(data, locale)
		if err != nil {
			return err
		}
		input.ThinkingControl = control
	case "images", "images[]":
		if len(input.Images) >= aiRecognitionMaxImages {
			return errAIRecognitionBodyTooLarge
		}
		data, err := readLimitedPartBytes(part, aiRecognitionMaxImageBytes)
		if err != nil {
			return err
		}
		if len(data) == 0 {
			return nil
		}
		mediaType, err := normalizeAIRecognitionImageType(part.Header.Get("Content-Type"), data)
		if err != nil {
			return err
		}
		input.Images = append(input.Images, aiRecognitionImage{
			MediaType: mediaType,
			DataURL:   fmt.Sprintf("data:%s;base64,%s", mediaType, base64.StdEncoding.EncodeToString(data)),
			SizeBytes: len(data),
		})
	case "":
		return errors.New("AI_RECOGNITION_MULTIPART_FIELD_INVALID")
	default:
		return errors.New("AI_RECOGNITION_MULTIPART_FIELD_INVALID")
	}
	return nil
}

func readLimitedPartBytes(reader io.Reader, maxBytes int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, int64(maxBytes)+1))
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return nil, errAIRecognitionBodyTooLarge
		}
		return nil, err
	}
	if len(data) > maxBytes {
		return nil, errAIRecognitionBodyTooLarge
	}
	return data, nil
}

func normalizeAIRecognitionImageType(header string, data []byte) (string, error) {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	if isAllowedAIRecognitionImageType(contentType) {
		return contentType, nil
	}
	detected := strings.ToLower(http.DetectContentType(data[:minInt(len(data), 512)]))
	if isAllowedAIRecognitionImageType(detected) {
		return detected, nil
	}
	return "", errors.New("AI_RECOGNITION_IMAGE_TYPE_INVALID")
}

func isAllowedAIRecognitionImageType(value string) bool {
	return value == "image/png" || value == "image/jpeg" || value == "image/webp"
}

func parseAIThinkingControl(data []byte, locale appLocale) (*aiThinkingControl, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	control, err := decodeStrictJSONFromBytes[aiThinkingControl]([]byte(trimmed), locale, false)
	if err != nil {
		return nil, err
	}
	if err := validateAIThinkingControl(&control); err != nil {
		return nil, err
	}
	return &control, nil
}

func (settings *aiRecognitionSettings) UnmarshalJSON(data []byte) error {
	// settings 来自持久化用户配置；手写 allowed map 保留严格未知字段边界，同时兼容历史 provider 字段。
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	allowed := map[string]struct{}{
		"provider":               {},
		"providerType":           {},
		"transportProtocol":      {},
		"model":                  {},
		"modelInputMode":         {},
		"baseUrl":                {},
		"apiKey":                 {},
		"defaultThinkingControl": {},
	}
	for key := range raw {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("json: unknown field %q", key)
		}
	}

	// 这是设置 patch 的反序列化边界：只覆盖实际出现的字段，省略 apiKey/baseUrl 等字段时必须保留
	// 当前内存设置。否则用户只改模型，下一次保存就会把历史凭据清空，违背旧配置无感迁移。
	current := *settings
	providerType := current.ProviderType
	providerTypeCandidates := []string{}
	if value, ok := raw["providerType"]; ok {
		var candidate string
		if err := json.Unmarshal(value, &candidate); err != nil {
			return err
		}
		providerTypeCandidates = append(providerTypeCandidates, candidate)
	}
	if value, ok := raw["provider"]; ok {
		var candidate string
		if err := json.Unmarshal(value, &candidate); err != nil {
			return err
		}
		providerTypeCandidates = append(providerTypeCandidates, candidate)
	}
	if len(providerTypeCandidates) > 0 {
		providerType = firstValidAIRecognitionProviderType(providerTypeCandidates...)
	}
	if !isValidAIRecognitionProviderType(providerType) {
		providerType = aiProviderTypeOpenAI
	}
	decodeString := func(key string, target *string) error {
		value, ok := raw[key]
		if !ok {
			return nil
		}
		return json.Unmarshal(value, target)
	}
	if err := decodeString("model", &current.Model); err != nil {
		return err
	}
	if err := decodeString("modelInputMode", &current.ModelInputMode); err != nil {
		return err
	}
	if err := decodeString("baseUrl", &current.BaseURL); err != nil {
		return err
	}
	if err := decodeString("apiKey", &current.APIKey); err != nil {
		return err
	}
	// transportProtocol 是历史派生字段，只校验形状后由 providerType 重算，避免旧值改变运行协议。
	if err := decodeString("transportProtocol", &current.TransportProtocol); err != nil {
		return err
	}
	if value, ok := raw["defaultThinkingControl"]; ok {
		control, err := parsePersistedAIThinkingControl(value)
		if err != nil {
			return err
		}
		current.DefaultThinkingControl = control
	}
	*settings = aiRecognitionSettings{
		ProviderType:           providerType,
		TransportProtocol:      canonicalAIRecognitionTransportProtocol(providerType),
		Model:                  current.Model,
		ModelInputMode:         current.ModelInputMode,
		BaseURL:                current.BaseURL,
		APIKey:                 current.APIKey,
		DefaultThinkingControl: current.DefaultThinkingControl,
	}
	return nil
}

// 历史 settings 的 thinking control 允许坏 effort 在读取边界降为模型默认，但嵌套未知字段仍是契约漂移，必须报错。
func parsePersistedAIThinkingControl(data []byte) (*aiThinkingControl, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] != '{' {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return nil, nil
	}
	allowed := map[string]struct{}{"provider": {}, "effort": {}, "mode": {}, "budget": {}, "level": {}, "budgetTokens": {}}
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return nil, fmt.Errorf("json: unknown field %q", key)
		}
	}
	var provider string
	if value, ok := fields["provider"]; !ok || json.Unmarshal(value, &provider) != nil {
		return nil, nil
	}
	switch provider {
	case "openai":
		if !hasExactJSONKeys(fields, "provider", "effort") {
			return nil, nil
		}
		var effort string
		if json.Unmarshal(fields["effort"], &effort) != nil || !slices.Contains([]string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}, effort) {
			return nil, nil
		}
		return &aiThinkingControl{Provider: provider, Effort: effort}, nil
	case "gemini":
		var mode string
		if value, ok := fields["mode"]; !ok || json.Unmarshal(value, &mode) != nil {
			return nil, nil
		}
		switch mode {
		case "off", "dynamic":
			if !hasExactJSONKeys(fields, "provider", "mode") {
				return nil, nil
			}
			return &aiThinkingControl{Provider: provider, Mode: mode}, nil
		case "budget":
			if !hasExactJSONKeys(fields, "provider", "mode", "budget") {
				return nil, nil
			}
			var budget int
			if json.Unmarshal(fields["budget"], &budget) != nil || budget < 1 || budget > 32768 {
				return nil, nil
			}
			return &aiThinkingControl{Provider: provider, Mode: mode, Budget: &budget}, nil
		case "level":
			if !hasExactJSONKeys(fields, "provider", "mode", "level") {
				return nil, nil
			}
			var level string
			if json.Unmarshal(fields["level"], &level) != nil || !slices.Contains([]string{"minimal", "low", "medium", "high"}, level) {
				return nil, nil
			}
			return &aiThinkingControl{Provider: provider, Mode: mode, Level: level}, nil
		default:
			return nil, nil
		}
	case "anthropic":
		var mode string
		if value, ok := fields["mode"]; !ok || json.Unmarshal(value, &mode) != nil {
			return nil, nil
		}
		switch mode {
		case "effort":
			if !hasExactJSONKeys(fields, "provider", "mode", "effort") {
				return nil, nil
			}
			var effort string
			if json.Unmarshal(fields["effort"], &effort) != nil || !slices.Contains([]string{"low", "medium", "high", "xhigh", "max"}, effort) {
				return nil, nil
			}
			return &aiThinkingControl{Provider: provider, Mode: mode, Effort: effort}, nil
		case "budget":
			if !hasExactJSONKeys(fields, "provider", "mode", "budgetTokens") {
				return nil, nil
			}
			var budgetTokens int
			if json.Unmarshal(fields["budgetTokens"], &budgetTokens) != nil || budgetTokens < 1024 || budgetTokens > 64000 {
				return nil, nil
			}
			return &aiThinkingControl{Provider: provider, Mode: mode, BudgetTokens: &budgetTokens}, nil
		default:
			return nil, nil
		}
	default:
		return nil, nil
	}
}

func hasExactJSONKeys(fields map[string]json.RawMessage, expected ...string) bool {
	if len(fields) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func firstValidAIRecognitionProviderType(candidates ...string) string {
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if isValidAIRecognitionProviderType(candidate) {
			return candidate
		}
	}
	return aiProviderTypeOpenAI
}

func validateAIThinkingControl(control *aiThinkingControl) error {
	if control == nil {
		return nil
	}
	switch control.Provider {
	case "openai":
		if !slices.Contains([]string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}, control.Effort) {
			return errors.New("AI_THINKING_CONTROL_INVALID")
		}
	case "gemini":
		switch control.Mode {
		case "off", "dynamic":
			return nil
		case "budget":
			if control.Budget == nil || *control.Budget < 1 || *control.Budget > 32768 {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		case "level":
			if !slices.Contains([]string{"minimal", "low", "medium", "high"}, control.Level) {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		default:
			return errors.New("AI_THINKING_CONTROL_INVALID")
		}
	case "anthropic":
		switch control.Mode {
		case "effort":
			if !slices.Contains([]string{"low", "medium", "high", "xhigh", "max"}, control.Effort) {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		case "budget":
			if control.BudgetTokens == nil || *control.BudgetTokens < 1024 || *control.BudgetTokens > 64000 {
				return errors.New("AI_THINKING_CONTROL_INVALID")
			}
		default:
			return errors.New("AI_THINKING_CONTROL_INVALID")
		}
	default:
		return errors.New("AI_THINKING_CONTROL_INVALID")
	}
	return nil
}

func sanitizeAIRecognitionSettings(settings aiRecognitionSettings) aiRecognitionSettings {
	settings.ProviderType = strings.TrimSpace(settings.ProviderType)
	if !isValidAIRecognitionProviderType(settings.ProviderType) {
		settings.ProviderType = aiProviderTypeOpenAI
	}
	settings.TransportProtocol = canonicalAIRecognitionTransportProtocol(settings.ProviderType)
	settings.Model = strings.TrimSpace(settings.Model)
	settings.ModelInputMode = strings.TrimSpace(settings.ModelInputMode)
	if settings.ModelInputMode != "manual" {
		settings.ModelInputMode = "select"
	}
	settings.BaseURL = sanitizeAIRecognitionBaseURL(settings.BaseURL)
	settings.APIKey = strings.TrimSpace(settings.APIKey)
	if settings.DefaultThinkingControl != nil {
		if err := validateAIThinkingControl(settings.DefaultThinkingControl); err != nil || !aiThinkingControlMatchesSettings(settings, settings.DefaultThinkingControl) || !aiThinkingControlCompatibleWithModel(settings.Model, settings.DefaultThinkingControl) {
			// 设置页保存的是“上次可用控制项”；provider/model 切换后不兼容值必须在读取边界丢弃。
			settings.DefaultThinkingControl = nil
		}
	}
	return settings
}

func isValidAIRecognitionProviderType(value string) bool {
	return value == aiProviderTypeOpenAI || value == aiProviderTypeGemini || value == aiProviderTypeAnthropic || value == aiProviderTypeOpenAICompatible
}

func aiThinkingControlMatchesSettings(settings aiRecognitionSettings, control *aiThinkingControl) bool {
	if control == nil {
		return true
	}
	switch settings.TransportProtocol {
	case aiProtocolOpenAIResponses:
		return settings.ProviderType == aiProviderTypeOpenAI && control.Provider == aiProviderTypeOpenAI
	case aiProtocolOpenAIChat:
		// openai-chat 只属于 OpenAI-compatible；原生 OpenAI 的 thinking control 必须走 Responses。
		return false
	case aiProtocolAnthropicMessages:
		return settings.ProviderType == aiProviderTypeAnthropic && control.Provider == aiProviderTypeAnthropic
	case aiProtocolGeminiGenerateContent:
		return settings.ProviderType == aiProviderTypeGemini && control.Provider == aiProviderTypeGemini
	default:
		return false
	}
}

func aiThinkingControlCompatibleWithModel(model string, control *aiThinkingControl) bool {
	if control == nil || control.Provider != aiProviderTypeOpenAI {
		return true
	}
	return slices.Contains(aiOpenAIReasoningEffortsForModel(model), control.Effort)
}

// OpenAI reasoning 档位按模型系列协议归一化；同一代新增模型只要遵循命名约定就自动获得能力。
// 未知系列返回空集合，设置读取会清掉旧 effort，让 provider 使用模型默认值而不是发送猜测参数。
func aiOpenAIReasoningEffortsForModel(model string) []string {
	model = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(model, "models/")))
	if model == "" || strings.Contains(model, "chat") || strings.Contains(model, "instruct") {
		return nil
	}
	if strings.HasPrefix(model, "o") {
		index := 1
		for index < len(model) && model[index] >= '0' && model[index] <= '9' {
			index++
		}
		if index > 1 && (index == len(model) || model[index] == '-') {
			return []string{"none", "minimal", "low", "medium", "high", "xhigh"}
		}
	}
	if !strings.HasPrefix(model, "gpt-") {
		return nil
	}
	version := model[len("gpt-"):]
	if separator := strings.IndexAny(version, ".-"); separator >= 0 {
		version = version[:separator]
	}
	major, err := strconv.Atoi(version)
	if err != nil || major < 5 {
		return nil
	}
	if major >= 6 {
		return []string{"low", "medium", "high", "xhigh", "max"}
	}
	return []string{"none", "minimal", "low", "medium", "high", "xhigh"}
}

func sanitizeAIRecognitionBaseURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return ""
	}
	return value
}

func validateAIRecognitionSettings(settings aiRecognitionSettings, locale appLocale) error {
	settings = sanitizeAIRecognitionSettings(settings)
	if settings.Model == "" {
		return errors.New(serverText(locale, "aiRecognition.modelRequired"))
	}
	endpoint := resolveAIProviderEndpoint(settings)
	if endpoint.BaseURLRequired {
		if settings.BaseURL == "" {
			return errors.New(serverText(locale, "aiRecognition.baseUrlRequired"))
		}
	}
	if endpoint.APIKeyRequired && settings.APIKey == "" {
		return errors.New(serverText(locale, "aiRecognition.apiKeyRequired"))
	}
	return nil
}
