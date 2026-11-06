package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/zendev-sh/goai"
	"github.com/zendev-sh/goai/provider"
	"github.com/zendev-sh/goai/provider/anthropic"
	"github.com/zendev-sh/goai/provider/compat"
	"github.com/zendev-sh/goai/provider/google"
	"github.com/zendev-sh/goai/provider/openai"
)

type aiRecognitionGeneration struct {
	result  *goai.ObjectResult[aiGeneratedRecognizeResponse]
	capture aiRecognitionCapture
}

const aiRecognitionNetworkRetryDelay = 150 * time.Millisecond

var generateAIRecognitionObjectForRunner = generateAIRecognitionObject
var streamAIRecognitionObjectForRunner = streamAIRecognitionObject
var newAIRecognitionModelForConnection = newAIRecognitionModel

func (goaiRecognitionRunner) Recognize(
	ctx context.Context,
	settings aiRecognitionSettings,
	input aiRecognitionInput,
	locale appLocale,
	timezone string,
	configContext aiRecognitionConfigContext,
) (aiRecognizeResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, aiRecognitionProviderTimeout)
	defer cancel()
	if len(input.Images) > 0 {
		return goaiRecognitionRunner{}.recognizeSingle(ctx, settings, input, locale, timezone, configContext)
	}
	chunks := splitAIRecognitionText(input.Text)
	if len(chunks) == 1 {
		return goaiRecognitionRunner{}.recognizeSingle(ctx, settings, input, locale, timezone, configContext)
	}
	responses := make([]aiRecognizeResponse, len(chunks))
	completed := make([]bool, len(chunks))
	errorsByChunk := make([]error, len(chunks))
	for start := 0; start < len(chunks); start += 2 {
		end := minInt(start+2, len(chunks))
		type chunkResult struct {
			index    int
			response aiRecognizeResponse
			err      error
		}
		results := make(chan chunkResult, end-start)
		for index := start; index < end; index++ {
			go func(index int) {
				chunkInput := input
				chunkInput.Text = chunks[index]
				response, err := goaiRecognitionRunner{}.recognizeSingle(ctx, settings, chunkInput, locale, timezone, configContext)
				results <- chunkResult{index: index, response: response, err: err}
			}(index)
		}
		for index := start; index < end; index++ {
			result := <-results
			if result.err != nil {
				if ctx.Err() != nil {
					return aiRecognizeResponse{}, ctx.Err()
				}
				errorsByChunk[result.index] = result.err
				continue
			}
			responses[result.index] = result.response
			completed[result.index] = true
		}
	}
	orderedResponses := make([]aiRecognizeResponse, 0, len(chunks))
	for index, response := range responses {
		if completed[index] {
			orderedResponses = append(orderedResponses, response)
		}
	}
	if len(orderedResponses) == 0 {
		for _, chunkErr := range errorsByChunk {
			if chunkErr != nil {
				return aiRecognizeResponse{}, chunkErr
			}
		}
		return aiRecognizeResponse{}, errAIRecognitionNoSubscriptions
	}
	merged := mergeAIRecognizeResponses(orderedResponses)
	if hasAIRecognitionChunkError(errorsByChunk) {
		merged.Warnings = appendAIRecognitionWarning(merged.Warnings, "AI_WARNING_BATCH_PARTIAL")
	}
	return merged, nil
}

func (goaiRecognitionRunner) recognizeSingle(
	ctx context.Context,
	settings aiRecognitionSettings,
	input aiRecognitionInput,
	locale appLocale,
	timezone string,
	configContext aiRecognitionConfigContext,
) (aiRecognizeResponse, error) {
	if err := validateAIRecognitionSettings(settings, locale); err != nil {
		return aiRecognizeResponse{}, err
	}
	model, err := newAIRecognitionModel(settings)
	if err != nil {
		return aiRecognizeResponse{}, err
	}
	systemPrompt := buildAIRecognitionSystemPrompt(locale)
	userPrompt := buildAIRecognitionUserPrompt(input.Text, timezone, len(input.Images), locale, configContext)
	generateForPrompt := func(nextUserPrompt string) (aiRecognitionGeneration, error) {
		return generateAIRecognitionObjectForRunner(ctx, model, input, systemPrompt, nextUserPrompt)
	}
	generation, err := generateForPrompt(userPrompt)
	if err != nil {
		// 总 deadline 或客户端断开后不再从截断 raw text 恢复草稿，避免取消请求越过运行预算继续收敛。
		if ctx.Err() != nil {
			return aiRecognizeResponse{}, ctx.Err()
		}
		if generation.capture.rawModelText == "" {
			generation.capture.rawModelText = aiRecognitionRawTextFromError(err)
		}
		if recovered, ok := recoverAIRecognitionGenerationFromRawText(generation.capture.rawModelText, generation.capture); ok {
			generation = recovered
		} else {
			diagnostics := buildAIRecognitionDiagnostics(settings, input, systemPrompt, userPrompt, generation.capture.rawModelText, nil, generation.capture.usage, generation.capture.finishReason, generation.capture.providerMetadata)
			return aiRecognizeResponse{}, &aiRecognitionRunError{cause: err, diagnostics: diagnostics}
		}
	}
	return finalizeAIRecognitionGeneration(settings, input, locale, configContext, systemPrompt, userPrompt, generation, todayDateOnly(time.Now().UTC(), timezone), nil, generateForPrompt)
}

func (goaiRecognitionRunner) Stream(
	ctx context.Context,
	settings aiRecognitionSettings,
	input aiRecognitionInput,
	locale appLocale,
	timezone string,
	configContext aiRecognitionConfigContext,
	sink aiRecognitionStreamSink,
) error {
	ctx, cancel := context.WithTimeout(ctx, aiRecognitionProviderTimeout)
	defer cancel()
	if len(input.Images) > 0 {
		response, err := goaiRecognitionRunner{}.streamSingle(ctx, settings, input, locale, timezone, configContext, sink)
		if err != nil {
			return err
		}
		return sink.Final(response)
	}
	chunks := splitAIRecognitionText(input.Text)
	if len(chunks) == 1 {
		response, err := goaiRecognitionRunner{}.streamSingle(ctx, settings, input, locale, timezone, configContext, sink)
		if err != nil {
			return err
		}
		return sink.Final(response)
	}
	errorsByChunk := make([]error, len(chunks))
	responsesByChunk := make([]aiRecognizeResponse, len(chunks))
	completed := make([]bool, len(chunks))
	subscriptionOffset := 0
	warningOffset := 0
	// 分块 provider 请求最多两块并发；事件先按块缓存再按原始顺序刷出，避免 partial 计数倒退或交错。
	for start := 0; start < len(chunks); start += 2 {
		end := minInt(start+2, len(chunks))
		type chunkResult struct {
			index    int
			response aiRecognizeResponse
			events   aiRecognitionBufferedStreamEvents
			err      error
		}
		results := make(chan chunkResult, end-start)
		for index := start; index < end; index++ {
			go func(index int) {
				chunkInput := input
				chunkInput.Text = chunks[index]
				buffer := aiRecognitionBufferedStreamEvents{}
				response, err := goaiRecognitionRunner{}.streamSingle(ctx, settings, chunkInput, locale, timezone, configContext, &buffer)
				results <- chunkResult{index: index, response: response, events: buffer, err: err}
			}(index)
		}
		batchResults := make([]chunkResult, 0, end-start)
		for index := start; index < end; index++ {
			batchResults = append(batchResults, <-results)
		}
		slices.SortFunc(batchResults, func(left, right chunkResult) int { return left.index - right.index })
		for _, result := range batchResults {
			if err := ctx.Err(); err != nil {
				return err
			}
			if result.err != nil {
				errorsByChunk[result.index] = result.err
				continue
			}
			if err := flushAIRecognitionBufferedStreamEvents(result.events, sink, subscriptionOffset, warningOffset); err != nil {
				return err
			}
			responsesByChunk[result.index] = result.response
			completed[result.index] = true
			subscriptionOffset += len(result.response.Subscriptions)
			warningOffset = minInt(20, warningOffset+len(result.response.Warnings))
		}
	}
	responses := make([]aiRecognizeResponse, 0, len(chunks))
	for index, response := range responsesByChunk {
		if completed[index] {
			responses = append(responses, response)
		}
	}
	if len(responses) == 0 {
		for _, chunkErr := range errorsByChunk {
			if chunkErr != nil {
				return chunkErr
			}
		}
		return errAIRecognitionNoSubscriptions
	}
	merged := mergeAIRecognizeResponses(responses)
	if hasAIRecognitionChunkError(errorsByChunk) {
		merged.Warnings = appendAIRecognitionWarning(merged.Warnings, "AI_WARNING_BATCH_PARTIAL")
	}
	return sink.Final(merged)
}

func hasAIRecognitionChunkError(errorsByChunk []error) bool {
	for _, chunkErr := range errorsByChunk {
		if chunkErr != nil {
			return true
		}
	}
	return false
}

func (goaiRecognitionRunner) streamSingle(
	ctx context.Context,
	settings aiRecognitionSettings,
	input aiRecognitionInput,
	locale appLocale,
	timezone string,
	configContext aiRecognitionConfigContext,
	sink aiRecognitionStreamSink,
) (aiRecognizeResponse, error) {
	if err := validateAIRecognitionSettings(settings, locale); err != nil {
		return aiRecognizeResponse{}, err
	}
	model, err := newAIRecognitionModel(settings)
	if err != nil {
		return aiRecognizeResponse{}, err
	}
	systemPrompt := buildAIRecognitionSystemPrompt(locale)
	userPrompt := buildAIRecognitionUserPrompt(input.Text, timezone, len(input.Images), locale, configContext)
	if err := sink.Progress(aiRecognitionStreamStageModelStart); err != nil {
		return aiRecognizeResponse{}, err
	}
	generateForPrompt := func(nextUserPrompt string) (aiRecognitionGeneration, error) {
		return streamAIRecognitionObjectForRunner(ctx, model, input, systemPrompt, nextUserPrompt, sink)
	}
	generation, err := generateForPrompt(userPrompt)
	if err != nil {
		// SSE 断开或总 deadline 触发时，raw text 恢复也必须停止，不能在请求已取消后发送 final。
		if ctx.Err() != nil {
			return aiRecognizeResponse{}, ctx.Err()
		}
		if generation.capture.rawModelText == "" {
			generation.capture.rawModelText = aiRecognitionRawTextFromError(err)
		}
		if recovered, ok := recoverAIRecognitionGenerationFromRawText(generation.capture.rawModelText, generation.capture); ok {
			generation = recovered
		} else {
			diagnostics := buildAIRecognitionDiagnostics(settings, input, systemPrompt, userPrompt, generation.capture.rawModelText, nil, generation.capture.usage, generation.capture.finishReason, generation.capture.providerMetadata)
			return aiRecognizeResponse{}, &aiRecognitionRunError{cause: err, diagnostics: diagnostics}
		}
	}
	response, err := finalizeAIRecognitionGeneration(settings, input, locale, configContext, systemPrompt, userPrompt, generation, todayDateOnly(time.Now().UTC(), timezone), sink.Progress, generateForPrompt)
	if err != nil {
		return aiRecognizeResponse{}, err
	}
	return response, nil
}

func finalizeAIRecognitionGeneration(settings aiRecognitionSettings, input aiRecognitionInput, locale appLocale, configContext aiRecognitionConfigContext, systemPrompt string, userPrompt string, generation aiRecognitionGeneration, currentDate string, progress func(string) error, generateForPrompt func(string) (aiRecognitionGeneration, error)) (aiRecognizeResponse, error) {
	if progress != nil {
		if err := progress(aiRecognitionStreamStageValidating); err != nil {
			return aiRecognizeResponse{}, err
		}
	}
	diagnostics := buildAIRecognitionDiagnosticsForGeneration(settings, input, systemPrompt, userPrompt, generation)
	response, err := normalizeAIGeneratedRecognizeResponse(generation.result.Object, settings.ProviderType, settings.TransportProtocol, settings.Model, diagnostics, configContext, currentDate)
	if err != nil {
		return aiRecognizeResponse{}, &aiRecognitionRunError{cause: err, diagnostics: diagnostics}
	}
	missingNames := missingDescribableAINoteNames(response.Subscriptions)
	if len(missingNames) > 0 {
		repairPrompt := buildAIRecognitionRepairUserPrompt(userPrompt, generation.result.Object, missingNames, locale)
		if repairedGeneration, repairErr := generateForPrompt(repairPrompt); repairErr == nil {
			repairDiagnostics := buildAIRecognitionDiagnosticsForGeneration(settings, input, systemPrompt, repairPrompt, repairedGeneration)
			if repairedResponse, normalizeErr := normalizeAIGeneratedRecognizeResponse(repairedGeneration.result.Object, settings.ProviderType, settings.TransportProtocol, settings.Model, repairDiagnostics, configContext, currentDate); normalizeErr == nil {
				response = mergeAIRecognitionNotes(response, repairedResponse)
				response.Diagnostics = repairDiagnostics
			}
		}
	}
	if progress != nil {
		if err := progress(aiRecognitionStreamStageFinalizing); err != nil {
			return aiRecognizeResponse{}, err
		}
	}
	return response, nil
}

func generateAIRecognitionObject(ctx context.Context, model provider.LanguageModel, input aiRecognitionInput, systemPrompt string, userPrompt string) (aiRecognitionGeneration, error) {
	capture := aiRecognitionCapture{}
	result, err := goai.GenerateObject[aiGeneratedRecognizeResponse](ctx, model, aiRecognitionObjectOptions(model, input, systemPrompt, userPrompt, &capture)...)
	if err == nil && result == nil {
		err = errAIRecognitionEmptyObject
	}
	return aiRecognitionGeneration{result: result, capture: capture}, err
}

func streamAIRecognitionObject(ctx context.Context, model provider.LanguageModel, input aiRecognitionInput, systemPrompt string, userPrompt string, sink aiRecognitionStreamSink) (aiRecognitionGeneration, error) {
	capture := aiRecognitionCapture{}
	stream, err := goai.StreamObject[aiGeneratedRecognizeResponse](ctx, model, aiRecognitionObjectOptions(model, input, systemPrompt, userPrompt, &capture)...)
	if err != nil {
		return aiRecognitionGeneration{capture: capture}, err
	}
	streamStarted := false
	lastPartial := aiRecognitionStreamPartialEvent{}
	for partial := range stream.PartialObjectStream() {
		if partial == nil {
			continue
		}
		if !streamStarted {
			streamStarted = true
			if err := sink.Progress(aiRecognitionStreamStageModelStream); err != nil {
				return aiRecognitionGeneration{capture: capture}, err
			}
		}
		subscriptionsSeen := len(partial.Subscriptions)
		warningsSeen := len(partial.Warnings)
		if err := emitAIRecognitionPartialIfChanged(sink, &lastPartial, subscriptionsSeen, warningsSeen); err != nil {
			return aiRecognitionGeneration{capture: capture}, err
		}
	}
	result, err := stream.Result()
	if err == nil && result == nil {
		err = errAIRecognitionEmptyObject
	}
	return aiRecognitionGeneration{result: result, capture: capture}, err
}

func emitAIRecognitionPartialIfChanged(sink aiRecognitionStreamSink, last *aiRecognitionStreamPartialEvent, subscriptionsSeen int, warningsSeen int) error {
	if subscriptionsSeen == 0 && warningsSeen == 0 {
		return nil
	}
	if last.SubscriptionsSeen == subscriptionsSeen && last.WarningsSeen == warningsSeen {
		return nil
	}
	// StreamObject 的 partial 只是进度提示，去重避免 UI 被半成品重复刷屏；最终草稿仍只从 Final 写出。
	last.SubscriptionsSeen = subscriptionsSeen
	last.WarningsSeen = warningsSeen
	return sink.Partial(subscriptionsSeen, warningsSeen)
}

func recoverAIRecognitionGenerationFromRawText(rawModelText string, capture aiRecognitionCapture) (aiRecognitionGeneration, bool) {
	jsonText := extractFirstAIRecognitionJSONObjectText(rawModelText)
	if jsonText == "" {
		return aiRecognitionGeneration{}, false
	}
	var object aiGeneratedRecognizeResponse
	decoder := json.NewDecoder(strings.NewReader(jsonText))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&object); err != nil {
		return aiRecognitionGeneration{}, false
	}
	capture.rawModelText = rawModelText
	// 生成侧恢复只把 AI SDK 拒收的完整 JSON 拉回 normalize；最终 response schema 仍是唯一可信边界。
	return aiRecognitionGeneration{result: &goai.ObjectResult[aiGeneratedRecognizeResponse]{Object: object}, capture: capture}, true
}

func extractFirstAIRecognitionJSONObjectText(text string) string {
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escaped := false
	for index := start; index < len(text); index++ {
		char := text[index]
		if inString {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[start : index+1]
			}
		}
	}
	return ""
}

func aiRecognitionObjectOptions(model provider.LanguageModel, input aiRecognitionInput, systemPrompt string, userPrompt string, capture *aiRecognitionCapture) []goai.Option {
	userParts := []provider.Part{{
		Type: provider.PartText,
		Text: userPrompt,
	}}
	for _, image := range input.Images {
		userParts = append(userParts, provider.Part{
			Type:      provider.PartImage,
			URL:       image.DataURL,
			MediaType: image.MediaType,
			Detail:    "high",
		})
	}
	options := []goai.Option{
		goai.WithSystem(systemPrompt),
		goai.WithMessages(provider.Message{Role: provider.RoleUser, Content: userParts}),
		goai.WithMaxOutputTokens(aiRecognitionOutputTokenLimit(input)),
		// SDK 默认会重试两次；识别链只允许 runtime transport 做一次短网络级重试，
		// 结构化错误、拒绝、4xx 和截断必须在同一总 deadline 内立即返回。
		goai.WithMaxRetries(0),
		goai.WithExplicitSchema(aiRecognitionGeneratedSchema),
		goai.WithSchemaName(aiRecognitionPrompt.SchemaName),
		goai.WithOnStepFinish(func(step goai.StepResult) {
			if capture != nil {
				capture.rawModelText = step.Text
				capture.usage = step.Usage
				capture.finishReason = string(step.FinishReason)
				capture.providerMetadata = step.ProviderMetadata
			}
		}),
	}
	if providerOptions := aiRecognitionProviderOptions(modelProviderType(model), modelTransportProtocol(model), input.ThinkingControl); len(providerOptions) > 0 {
		options = append(options, goai.WithProviderOptions(providerOptions))
	}
	if modelProviderType(model) == aiProviderTypeOpenAI && modelTransportProtocol(model) == aiProtocolOpenAIResponses {
		// 原生 Responses 才能使用 provider 执行的官方站搜索；最多允许一次 search step，
		// compatible Chat 不注入伪造工具，避免第三方把未知 tool 当成业务字段。
		webSearch := openai.Tools.WebSearch(openai.WithSearchContextSize("low"))
		options = append(options,
			goai.WithTools(goai.Tool{
				Name:                   webSearch.Name,
				ProviderDefinedType:    webSearch.ProviderDefinedType,
				ProviderDefinedOptions: webSearch.ProviderDefinedOptions,
			}),
			goai.WithMaxSteps(2),
		)
	}
	return options
}

func buildAIRecognitionDiagnosticsForGeneration(settings aiRecognitionSettings, input aiRecognitionInput, systemPrompt string, userPrompt string, generation aiRecognitionGeneration) aiRecognitionDiagnostics {
	usage := interface{}(generation.result.Usage)
	if generation.capture.usage != nil {
		usage = generation.capture.usage
	}
	finishReason := firstNonBlank(generation.capture.finishReason, string(generation.result.FinishReason))
	providerMetadata := interface{}(generation.result.ProviderMetadata)
	if generation.capture.providerMetadata != nil {
		providerMetadata = generation.capture.providerMetadata
	}
	return buildAIRecognitionDiagnostics(
		settings,
		input,
		systemPrompt,
		userPrompt,
		firstNonBlank(generation.capture.rawModelText, resultStringFromAIObject(generation.result.Object)),
		generation.result.Object,
		usage,
		finishReason,
		providerMetadata,
	)
}

func newAIRecognitionModel(settings aiRecognitionSettings) (provider.LanguageModel, error) {
	settings = sanitizeAIRecognitionSettings(settings)
	endpoint := resolveAIProviderEndpoint(settings)
	switch settings.TransportProtocol {
	case aiProtocolOpenAIResponses:
		if settings.ProviderType != aiProviderTypeOpenAI {
			return nil, errAIRecognitionProviderInvalid
		}
		httpClient := aiProviderRuntimeHTTPClient(endpoint, "")
		options := []openai.Option{openai.WithAPIKey(settings.APIKey), openai.WithHTTPClient(httpClient)}
		if endpoint.RuntimeBaseURL != "" {
			options = append(options, openai.WithBaseURL(endpoint.RuntimeBaseURL))
		}
		return aiRecognitionRuntimeModel{LanguageModel: openai.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
	case aiProtocolOpenAIChat:
		httpClient := aiProviderRuntimeHTTPClient(endpoint, "")
		if settings.ProviderType != aiProviderTypeOpenAICompatible {
			return nil, errAIRecognitionProviderInvalid
		}
		options := []compat.Option{compat.WithBaseURL(endpoint.RuntimeBaseURL), compat.WithHTTPClient(httpClient)}
		if settings.APIKey != "" {
			options = append(options, compat.WithAPIKey(settings.APIKey))
		}
		return aiRecognitionRuntimeModel{LanguageModel: compat.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
	case aiProtocolGeminiGenerateContent:
		options := []google.Option{google.WithAPIKey(settings.APIKey), google.WithHTTPClient(aiProviderRuntimeHTTPClient(endpoint, "v1beta"))}
		if baseURL := goAIBaseURLForEndpoint(endpoint); baseURL != "" {
			options = append(options, google.WithBaseURL(baseURL))
		}
		return aiRecognitionRuntimeModel{LanguageModel: google.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
	case aiProtocolAnthropicMessages:
		options := []anthropic.Option{anthropic.WithAPIKey(settings.APIKey), anthropic.WithHTTPClient(aiProviderRuntimeHTTPClient(endpoint, "v1"))}
		if baseURL := goAIBaseURLForEndpoint(endpoint); baseURL != "" {
			options = append(options, anthropic.WithBaseURL(baseURL))
		}
		return aiRecognitionRuntimeModel{LanguageModel: anthropic.Chat(settings.Model, options...), providerType: settings.ProviderType, transportProtocol: settings.TransportProtocol}, nil
	default:
		return nil, errAIRecognitionProviderInvalid
	}
}

func testAIRecognitionConnection(ctx context.Context, settings aiRecognitionSettings) error {
	settings = sanitizeAIRecognitionSettings(settings)
	model, err := newAIRecognitionModelForConnection(settings)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, aiRecognitionProviderTimeout)
	defer cancel()
	options := []goai.Option{
		goai.WithPrompt(aiRecognitionTestPrompt),
		goai.WithMaxOutputTokens(aiRecognitionTestProviderTokens),
		goai.WithMaxRetries(0),
	}
	if providerOptions := aiRecognitionProviderOptions(settings.ProviderType, settings.TransportProtocol, settings.DefaultThinkingControl); len(providerOptions) > 0 {
		options = append(options, goai.WithProviderOptions(providerOptions))
	}
	_, err = goai.GenerateText(ctx, model, options...)
	return err
}

type aiRecognitionRuntimeModel struct {
	provider.LanguageModel
	providerType      string
	transportProtocol string
}

func (model aiRecognitionRuntimeModel) ProviderType() string {
	return model.providerType
}

func (model aiRecognitionRuntimeModel) TransportProtocol() string {
	return model.transportProtocol
}

func modelProviderType(model provider.LanguageModel) string {
	if typed, ok := model.(interface{ ProviderType() string }); ok {
		return typed.ProviderType()
	}
	return ""
}

func modelTransportProtocol(model provider.LanguageModel) string {
	if typed, ok := model.(interface{ TransportProtocol() string }); ok {
		return typed.TransportProtocol()
	}
	return ""
}

func aiRecognitionProviderOptions(providerType string, transportProtocol string, control *aiThinkingControl) map[string]any {
	var options map[string]any
	if control == nil {
		return options
	}
	switch control.Provider {
	case "openai":
		if providerType != aiProviderTypeOpenAI || transportProtocol != aiProtocolOpenAIResponses {
			return options
		}
		if options == nil {
			options = map[string]any{}
		}
		options["reasoning_effort"] = control.Effort
		return options
	case "gemini":
		if providerType != aiProviderTypeGemini || transportProtocol != aiProtocolGeminiGenerateContent {
			return options
		}
		switch control.Mode {
		case "off":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": 0}}}
		case "dynamic":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": -1}}}
		case "budget":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": *control.Budget}}}
		case "level":
			return map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingLevel": control.Level}}}
		}
	case "anthropic":
		if providerType != aiProviderTypeAnthropic || transportProtocol != aiProtocolAnthropicMessages {
			return options
		}
		if control.Mode == "effort" {
			return map[string]any{"effort": control.Effort}
		}
		if control.Mode == "budget" {
			return map[string]any{"thinking": map[string]any{"type": "enabled", "budgetTokens": *control.BudgetTokens}}
		}
	}
	return options
}

func goAIBaseURLForEndpoint(endpoint aiProviderEndpoint) string {
	if endpoint.TransportProtocol == aiProtocolAnthropicMessages || endpoint.TransportProtocol == aiProtocolGeminiGenerateContent {
		// GoAI 的 Anthropic/Gemini provider 会自己插入版本段；shared/Worker runtimeBaseURL 保留官方版本段，Docker 侧必须在 SDK 边界去掉。
		if endpoint.AutoVersionDisabled {
			return endpoint.RuntimeBaseURL
		}
		return aiProviderTrailingVersionSegmentPattern.ReplaceAllString(endpoint.RuntimeBaseURL, "")
	}
	return endpoint.RuntimeBaseURL
}

func aiProviderRuntimeHTTPClient(endpoint aiProviderEndpoint, version string) *http.Client {
	// GoAI provider 内部负责组装协议请求；这里仅替换网络边界，让模型调用共享环境代理、TLS 下限和脱敏诊断。
	return &http.Client{Timeout: aiRecognitionProviderTimeout, Transport: aiProviderRuntimeTransport{
		baseURL:                endpoint.RuntimeBaseURL,
		provider:               endpoint.ProviderType + " provider",
		version:                version,
		rewriteInsertedVersion: endpoint.AutoVersionDisabled,
		inner:                  defaultUpstreamHTTPTransport(),
	}}
}

type aiProviderRuntimeTransport struct {
	baseURL                string
	provider               string
	version                string
	rewriteInsertedVersion bool
	inner                  http.RoundTripper
}

func (transport aiProviderRuntimeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	inner := transport.inner
	if inner == nil {
		inner = http.DefaultTransport
	}
	if !transport.rewriteInsertedVersion || strings.TrimSpace(transport.version) == "" {
		return transport.roundTripWithDiagnostics(inner, request)
	}
	parsed, err := url.Parse(transport.baseURL)
	if err != nil {
		return transport.roundTripWithDiagnostics(inner, request)
	}
	prefix := strings.TrimRight(parsed.Path, "/")
	insertedVersionPath := prefix + "/" + transport.version
	if strings.HasPrefix(request.URL.Path, insertedVersionPath+"/") || request.URL.Path == insertedVersionPath {
		// GoAI 对部分 provider 会再次插入版本段；只在 SDK 边界修正 URL，避免 shared endpoint 契约为 Docker 分叉。
		clone := request.Clone(request.Context())
		nextURL := *request.URL
		nextURL.Path = prefix + strings.TrimPrefix(request.URL.Path, insertedVersionPath)
		if nextURL.Path == "" {
			nextURL.Path = "/"
		}
		clone.URL = &nextURL
		return transport.roundTripWithDiagnostics(inner, clone)
	}
	return transport.roundTripWithDiagnostics(inner, request)
}

func (transport aiProviderRuntimeTransport) roundTripWithDiagnostics(inner http.RoundTripper, request *http.Request) (*http.Response, error) {
	response, err := inner.RoundTrip(request)
	if err != nil && isAIRecognitionRetryableNetworkError(err) && request.Context().Err() == nil {
		if retryRequest, ok := replayAIRecognitionRequest(request); ok {
			timer := time.NewTimer(aiRecognitionNetworkRetryDelay)
			select {
			case <-request.Context().Done():
				timer.Stop()
			case <-timer.C:
				response, err = inner.RoundTrip(retryRequest)
			}
		}
	}
	if err == nil {
		return response, nil
	}
	provider := strings.TrimSpace(transport.provider)
	if provider == "" {
		provider = "AI provider"
	}
	timedOut := upstreamNetErrorTimedOut(err) || errors.Is(request.Context().Err(), context.DeadlineExceeded)
	return response, newUpstreamTransportError(upstreamTransportDiagnosticMessage(request, upstreamHTTPRequestOptions{
		Provider: provider,
		Timeout:  aiRecognitionProviderTimeout,
	}, err, aiRecognitionProviderTimeout, timedOut), timedOut)
}

func isAIRecognitionRetryableNetworkError(err error) bool {
	var networkErr net.Error
	return errors.As(err, &networkErr) && networkErr.Temporary() && !networkErr.Timeout()
}

func replayAIRecognitionRequest(request *http.Request) (*http.Request, bool) {
	if request == nil {
		return nil, false
	}
	retryRequest := request.Clone(request.Context())
	if request.Body == nil {
		return retryRequest, true
	}
	if request.GetBody == nil {
		return nil, false
	}
	body, err := request.GetBody()
	if err != nil {
		return nil, false
	}
	retryRequest.Body = body
	return retryRequest, true
}

func aiRecognitionOutputTokenLimit(input aiRecognitionInput) int {
	lines := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(input.Text, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	rows := len(lines)
	if detectAIRecognitionDelimitedHeader(lines) != "" {
		rows--
	}
	if rows < 1 {
		rows = 1
	}
	imageRows := len(input.Images) * aiRecognitionEstimatedRecordsPerImage
	if imageRows > rows {
		rows = imageRows
	}
	if rows > aiRecognitionBatchMaxRows {
		rows = aiRecognitionBatchMaxRows
	}
	limit := 512 + rows*220
	if rows >= aiRecognitionBatchMaxRows {
		limit = 7000
	}
	if limit < 1024 {
		limit = 1024
	}
	if limit > 7000 {
		limit = 7000
	}
	// 显式 thinking 会消耗 max_output_tokens 中的推理 token；与 Worker 保持同一最低预算，
	// 避免 high/max 只得到截断 JSON 而模型默认档位正常。
	if input.ThinkingControl != nil && limit < 4096 {
		limit = 4096
	}
	return limit
}

func resultStringFromAIObject(value interface{}) string {
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(data)
}
