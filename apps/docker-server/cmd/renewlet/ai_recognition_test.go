package main

// AI 识别端到端单测保护 Go provider runner、SSE contract、multipart 输入和 diagnostics 脱敏。
// 测试里的 fake model 只模拟第三方 SDK 边界，不替代 shared schema 与 Cloudflare Worker 的契约覆盖。
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/zendev-sh/goai"
	"github.com/zendev-sh/goai/provider"
)

func TestAIRecognitionProviderOptions(t *testing.T) {
	budget := 4096
	budgetTokens := 8192
	tests := []struct {
		name              string
		providerType      string
		transportProtocol string
		control           *aiThinkingControl
		want              map[string]any
	}{
		{
			name:              "openai responses with reasoning effort",
			providerType:      aiProviderTypeOpenAI,
			transportProtocol: aiProtocolOpenAIResponses,
			control:           &aiThinkingControl{Provider: "openai", Effort: "high"},
			want:              map[string]any{"reasoning_effort": "high"},
		},
		{
			name:              "openai responses without thinking",
			providerType:      aiProviderTypeOpenAI,
			transportProtocol: aiProtocolOpenAIResponses,
			want:              nil,
		},
		{
			name:              "compatible openai chat does not receive official openai options",
			providerType:      aiProviderTypeOpenAICompatible,
			transportProtocol: aiProtocolOpenAIChat,
			control:           &aiThinkingControl{Provider: "openai", Effort: "high"},
			want:              nil,
		},
		{
			name:              "gemini off thinking budget",
			providerType:      aiProviderTypeGemini,
			transportProtocol: aiProtocolGeminiGenerateContent,
			control:           &aiThinkingControl{Provider: "gemini", Mode: "off"},
			want:              map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": 0}}},
		},
		{
			name:              "gemini fixed thinking budget",
			providerType:      aiProviderTypeGemini,
			transportProtocol: aiProtocolGeminiGenerateContent,
			control:           &aiThinkingControl{Provider: "gemini", Mode: "budget", Budget: &budget},
			want:              map[string]any{"google": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": 4096}}},
		},
		{
			name:              "anthropic effort",
			providerType:      aiProviderTypeAnthropic,
			transportProtocol: aiProtocolAnthropicMessages,
			control:           &aiThinkingControl{Provider: "anthropic", Mode: "effort", Effort: "xhigh"},
			want:              map[string]any{"effort": "xhigh"},
		},
		{
			name:              "anthropic legacy budget tokens",
			providerType:      aiProviderTypeAnthropic,
			transportProtocol: aiProtocolAnthropicMessages,
			control:           &aiThinkingControl{Provider: "anthropic", Mode: "budget", BudgetTokens: &budgetTokens},
			want:              map[string]any{"thinking": map[string]any{"type": "enabled", "budgetTokens": 8192}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := aiRecognitionProviderOptions(tt.providerType, tt.transportProtocol, tt.control)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("provider options mismatch: got %#v want %#v", got, tt.want)
			}
		})
	}
}

func TestAIThinkingControlKeepsGPT5VersionedEfforts(t *testing.T) {
	for _, model := range []string{"gpt-5.1", "gpt-5-mini"} {
		if !aiThinkingControlCompatibleWithModel(model, &aiThinkingControl{Provider: aiProviderTypeOpenAI, Effort: "high"}) {
			t.Fatalf("expected GPT-5 model %q to keep high effort", model)
		}
	}
	for _, model := range []string{"gpt-6.1-terra", "gpt-7.0-future", "models/gpt-6.9-new-model"} {
		if !aiThinkingControlCompatibleWithModel(model, &aiThinkingControl{Provider: aiProviderTypeOpenAI, Effort: "max"}) {
			t.Fatalf("expected modern GPT model %q to keep max effort", model)
		}
		if aiThinkingControlCompatibleWithModel(model, &aiThinkingControl{Provider: aiProviderTypeOpenAI, Effort: "minimal"}) {
			t.Fatalf("modern GPT model %q must reject legacy minimal effort", model)
		}
	}
	if aiThinkingControlCompatibleWithModel("gpt-4.1", &aiThinkingControl{Provider: aiProviderTypeOpenAI, Effort: "high"}) {
		t.Fatal("unknown/non-reasoning GPT family must not receive reasoning effort")
	}
}

func TestAIRecognitionConnectionUsesMinimalTextGeneration(t *testing.T) {
	fake := &aiConnectionTestModel{
		err: &goai.APIError{
			Message:         "rate limited",
			StatusCode:      http.StatusTooManyRequests,
			IsRetryable:     true,
			ResponseBody:    `{"error":"invalid sk-test-secret"}`,
			ResponseHeaders: map[string]string{"retry-after": "5"},
		},
	}
	previousModelFactory := newAIRecognitionModelForConnection
	newAIRecognitionModelForConnection = func(settings aiRecognitionSettings) (provider.LanguageModel, error) {
		return fake, nil
	}
	t.Cleanup(func() {
		newAIRecognitionModelForConnection = previousModelFactory
	})

	err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
		ProviderType:           aiProviderTypeOpenAI,
		TransportProtocol:      aiProtocolOpenAIResponses,
		Model:                  "gpt-5.1",
		APIKey:                 "sk-test",
		DefaultThinkingControl: &aiThinkingControl{Provider: "openai", Effort: "high"},
	})
	var apiErr *goai.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected raw API error from zero-retry connection test, got %#v", err)
	}
	providerResponse := aiProviderResponseFromError(err)
	if providerResponse == nil || providerResponse.Body == nil || *providerResponse.Body != `{"error":"invalid [redacted]"}` {
		t.Fatalf("provider response body not captured: %#v", providerResponse)
	}
	if providerResponse.Status == nil || *providerResponse.Status != http.StatusTooManyRequests {
		t.Fatalf("provider response status not captured: %#v", providerResponse)
	}
	if providerResponse.Headers["retry-after"] != "5" {
		t.Fatalf("provider response headers not captured: %#v", providerResponse.Headers)
	}
	if fake.calls != 1 {
		t.Fatalf("connection test should disable retries, got %d model calls", fake.calls)
	}
	if fake.params.MaxOutputTokens != aiRecognitionTestProviderTokens || fake.params.ResponseFormat != nil || len(fake.params.Tools) != 0 {
		t.Fatalf("connection test should be a small text-only call, got %#v", fake.params)
	}
	if got := fake.params.ProviderOptions["reasoning_effort"]; got != "high" {
		t.Fatalf("OpenAI connection test should preserve selected effort, got %#v", fake.params.ProviderOptions)
	}
	if len(fake.params.Messages) != 1 || len(fake.params.Messages[0].Content) != 1 || fake.params.Messages[0].Content[0].Text != aiRecognitionTestPrompt {
		t.Fatalf("connection test prompt mismatch: %#v", fake.params.Messages)
	}
}

func TestAIProviderResponseFromWrappedAPIError(t *testing.T) {
	err := fmt.Errorf("stream result: %w", &goai.APIError{
		Message:         "provider failed",
		StatusCode:      http.StatusUnauthorized,
		ResponseBody:    `{"code":"INVALID_API_KEY","message":"bad key"}`,
		ResponseHeaders: map[string]string{"content-type": "application/json"},
	})
	providerResponse := aiProviderResponseFromError(err)
	if providerResponse == nil || providerResponse.Body == nil || *providerResponse.Body != `{"code":"INVALID_API_KEY","message":"bad key"}` {
		t.Fatalf("wrapped provider body not captured: %#v", providerResponse)
	}
	if providerResponse.Status == nil || *providerResponse.Status != http.StatusUnauthorized {
		t.Fatalf("wrapped provider status not captured: %#v", providerResponse)
	}
	if providerResponse.Headers["content-type"] != "application/json" {
		t.Fatalf("wrapped provider headers not captured: %#v", providerResponse.Headers)
	}
}

func TestAIRecognitionProviderRetriesOneTemporaryNetworkFailure(t *testing.T) {
	attempts := 0
	transport := aiProviderRuntimeTransport{
		provider: "test provider",
		inner: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			attempts++
			if attempts == 1 {
				return nil, temporaryAIRecognitionNetworkError{}
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("{}")),
				Header:     make(http.Header),
				Request:    request,
			}, nil
		}),
	}
	request, err := http.NewRequest(http.MethodPost, "https://provider.test/v1/chat", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	if response == nil || response.StatusCode != http.StatusOK || attempts != 2 {
		t.Fatalf("temporary network retry mismatch: response=%#v attempts=%d", response, attempts)
	}
}

type temporaryAIRecognitionNetworkError struct{}

func (temporaryAIRecognitionNetworkError) Error() string   { return "temporary network failure" }
func (temporaryAIRecognitionNetworkError) Timeout() bool   { return false }
func (temporaryAIRecognitionNetworkError) Temporary() bool { return true }

func TestGoAIRecognitionRunnerRecoversRawJSONWhenStructuredObjectRejected(t *testing.T) {
	raw := aiGeneratedResponseForTest(aiGeneratedDraftForTest(
		"LocVPS",
		aiGeneratedNotesField{Value: stringRef("LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"), Source: "suggested"},
		[]string{"VPS", "云主机"},
	))
	raw.Subscriptions[0].Website = &aiGeneratedSuggestedTextField{Value: nil, Source: "suggested"}
	previous := generateAIRecognitionObjectForRunner
	generateAIRecognitionObjectForRunner = func(context.Context, provider.LanguageModel, aiRecognitionInput, string, string) (aiRecognitionGeneration, error) {
		return aiRecognitionGeneration{
			capture: aiRecognitionCapture{
				rawModelText: "```json\n" + resultStringFromAIObject(raw) + "\n```",
				finishReason: "stop",
			},
		}, errors.New("No object generated: response did not match schema.")
	}
	defer func() {
		generateAIRecognitionObjectForRunner = previous
	}()

	response, err := goaiRecognitionRunner{}.Recognize(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "locvps 20元 1个月"},
		localeZhCN,
		"Asia/Shanghai",
		aiRecognitionConfigContext{},
	)
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if draft.Name != "LocVPS" || draft.Website != nil {
		t.Fatalf("raw JSON recovery should keep draft and clean nullable website: %#v", draft)
	}
	if response.Diagnostics.Output.RawModelText == nil || !strings.Contains(response.Diagnostics.Output.RawModelText.Value, "LocVPS") {
		t.Fatalf("diagnostics should keep sanitized raw text for recovered object: %#v", response.Diagnostics.Output.RawModelText)
	}
}

func TestGoAIRecognitionRunnerStreamsProgressPartialAndFinal(t *testing.T) {
	restore := stubAIRecognitionStreamGeneration(t, []aiGeneratedRecognizeResponse{
		aiGeneratedResponseForTest(aiGeneratedDraftForTest(
			"HostDZire CloudVPS",
			aiGeneratedNotesField{Value: stringRef("HostDZire CloudVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"), Source: "suggested"},
			[]string{"VPS", "云主机"},
		)),
	})
	defer restore()
	sink := &recordingAIRecognitionStreamSink{}

	err := goaiRecognitionRunner{}.Stream(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "HostDZire CloudVPS 15元 1个月"},
		localeZhCN,
		"Asia/Shanghai",
		aiRecognitionConfigContext{},
		sink,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sink.progress, []string{
		aiRecognitionStreamStageModelStart,
		aiRecognitionStreamStageModelStream,
		aiRecognitionStreamStageValidating,
		aiRecognitionStreamStageFinalizing,
	}) {
		t.Fatalf("stream progress mismatch: %#v", sink.progress)
	}
	if !reflect.DeepEqual(sink.partials, []aiRecognitionStreamPartialEvent{{Type: "recognition/partial", SubscriptionsSeen: 1, WarningsSeen: 0}}) {
		t.Fatalf("stream partials mismatch: %#v", sink.partials)
	}
	if sink.final == nil || sink.final.Subscriptions[0].Name != "HostDZire CloudVPS" {
		t.Fatalf("stream final response missing: %#v", sink.final)
	}
}

func TestGoAIRecognitionRunnerStreamsRecoveredRawJSONFinal(t *testing.T) {
	raw := aiGeneratedResponseForTest(aiGeneratedDraftForTest(
		"LocVPS",
		aiGeneratedNotesField{Value: stringRef("LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"), Source: "suggested"},
		[]string{"VPS", "云主机"},
	))
	raw.Subscriptions[0].Website = &aiGeneratedSuggestedTextField{Value: nil, Source: "suggested"}
	previous := streamAIRecognitionObjectForRunner
	streamAIRecognitionObjectForRunner = func(context.Context, provider.LanguageModel, aiRecognitionInput, string, string, aiRecognitionStreamSink) (aiRecognitionGeneration, error) {
		return aiRecognitionGeneration{
			capture: aiRecognitionCapture{
				rawModelText: resultStringFromAIObject(raw),
				finishReason: "stop",
			},
		}, errors.New("No object generated: response did not match schema.")
	}
	defer func() {
		streamAIRecognitionObjectForRunner = previous
	}()
	sink := &recordingAIRecognitionStreamSink{}

	err := goaiRecognitionRunner{}.Stream(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "locvps 20元 1个月"},
		localeZhCN,
		"Asia/Shanghai",
		aiRecognitionConfigContext{},
		sink,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sink.progress, []string{
		aiRecognitionStreamStageModelStart,
		aiRecognitionStreamStageValidating,
		aiRecognitionStreamStageFinalizing,
	}) {
		t.Fatalf("recovered stream progress mismatch: %#v", sink.progress)
	}
	if sink.final == nil || sink.final.Subscriptions[0].Website != nil {
		t.Fatalf("recovered stream final should clean nullable website: %#v", sink.final)
	}
}

func TestAIRecognitionPartialProgressDedupe(t *testing.T) {
	sink := &recordingAIRecognitionStreamSink{}
	last := aiRecognitionStreamPartialEvent{}
	for _, item := range []aiRecognitionStreamPartialEvent{
		{SubscriptionsSeen: 0, WarningsSeen: 0},
		{SubscriptionsSeen: 1, WarningsSeen: 0},
		{SubscriptionsSeen: 1, WarningsSeen: 0},
		{SubscriptionsSeen: 1, WarningsSeen: 1},
	} {
		if err := emitAIRecognitionPartialIfChanged(sink, &last, item.SubscriptionsSeen, item.WarningsSeen); err != nil {
			t.Fatal(err)
		}
	}
	want := []aiRecognitionStreamPartialEvent{
		{Type: "recognition/partial", SubscriptionsSeen: 1, WarningsSeen: 0},
		{Type: "recognition/partial", SubscriptionsSeen: 1, WarningsSeen: 1},
	}
	if !reflect.DeepEqual(sink.partials, want) {
		t.Fatalf("partial dedupe mismatch: %#v", sink.partials)
	}
}

func TestAIRecognitionSSEWriterHeadersEventsAndSanitizedError(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := aiRecognitionSSEWriter{
		response:   recorder,
		controller: http.NewResponseController(recorder),
	}
	writer.prepareHeaders()
	if err := writer.Progress(aiRecognitionStreamStageInputRead); err != nil {
		t.Fatal(err)
	}
	if err := writer.Partial(2, 1); err != nil {
		t.Fatal(err)
	}
	if err := writer.Comment("keep-alive"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Final(aiRecognizeResponse{
		ProviderType:      aiProviderTypeOpenAI,
		TransportProtocol: aiProtocolOpenAIResponses,
		Model:             "gpt-5.1",
		Subscriptions:     []aiRecognizedSubscriptionDraft{{Name: "dmit", Confidence: "high"}},
		Warnings:          []string{},
		Diagnostics:       testAIRecognitionDiagnostics(),
	}); err != nil {
		t.Fatal(err)
	}
	streamErr := aiRecognitionStreamErrorForError(localeZhCN, &aiRecognitionRunError{
		cause:       errors.New("provider failed sk-stream-secret123"),
		diagnostics: testAIRecognitionDiagnostics(),
	})
	if err := writer.Error(streamErr); err != nil {
		t.Fatal(err)
	}

	if contentType := recorder.Header().Get("content-type"); !strings.Contains(contentType, "text/event-stream") {
		t.Fatalf("content-type should be SSE, got %q", contentType)
	}
	if recorder.Header().Get("x-content-type-options") != "nosniff" || recorder.Header().Get("cache-control") != "no-store" {
		t.Fatalf("SSE safety headers missing: %#v", recorder.Header())
	}
	body := recorder.Body.String()
	for _, want := range []string{
		"event: recognition/progress",
		`"stage":"input-read"`,
		"event: recognition/partial",
		`"subscriptionsSeen":2`,
		": keep-alive",
		"event: recognition/final",
		"event: recognition/error",
		"[redacted]",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("SSE body missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "sk-stream-secret123") {
		t.Fatalf("SSE error leaked provider secret:\n%s", body)
	}
}

func TestAIRecognitionSSEWriterCancelsOnFlushFailure(t *testing.T) {
	flushErr := errors.New("client disconnected")
	recorder := &flushErrorResponseRecorder{ResponseRecorder: *httptest.NewRecorder(), err: flushErr}
	cancelled := false
	writer := aiRecognitionSSEWriter{
		response:   recorder,
		controller: http.NewResponseController(recorder),
		cancel:     func() { cancelled = true },
	}
	if err := writer.writeFrame(": keep-alive\n\n"); !errors.Is(err, flushErr) {
		t.Fatalf("expected flush error, got %v", err)
	}
	if !cancelled {
		t.Fatal("flush failure should cancel the provider context")
	}
}

type flushErrorResponseRecorder struct {
	httptest.ResponseRecorder
	err error
}

func (writer *flushErrorResponseRecorder) FlushError() error {
	return writer.err
}

func TestAIRecognitionStreamErrorCodeForTimeout(t *testing.T) {
	streamErr := aiRecognitionStreamErrorForError(localeZhCN, context.DeadlineExceeded)
	if streamErr.Code != "AI_RECOGNITION_TIMEOUT" {
		t.Fatalf("timeout code mismatch: %#v", streamErr)
	}
}

func TestAIRecognitionStreamErrorIncludesRawResponseText(t *testing.T) {
	streamErr := aiRecognitionStreamErrorForError(localeZhCN, &aiRecognitionRunError{
		cause: fmt.Errorf("stream result: %w", &goai.APIError{
			Message:         "provider failed",
			StatusCode:      http.StatusUnauthorized,
			ResponseBody:    `{"code":"INVALID_API_KEY","message":"bad sk-testsecret123"}`,
			ResponseHeaders: map[string]string{"content-type": "application/json"},
		}),
		diagnostics: testAIRecognitionDiagnostics(),
	})
	if streamErr.Details == nil || streamErr.Details.RawResponseText == nil {
		t.Fatalf("stream error should include raw response text: %#v", streamErr)
	}
	if *streamErr.Details.RawResponseText != `{"code":"INVALID_API_KEY","message":"bad [redacted]"}` {
		t.Fatalf("raw response mismatch: %#v", streamErr.Details.RawResponseText)
	}
	if streamErr.Message != `{"code":"INVALID_API_KEY","message":"bad [redacted]"}` {
		t.Fatalf("stream error should preserve provider body as message: %q", streamErr.Message)
	}
}

func TestAIRecognitionStreamErrorBoundsRawResponseToSharedContract(t *testing.T) {
	raw := strings.Repeat("上游", upstreamProviderResponseCaptureBodyMaxBytes)
	streamErr := aiRecognitionStreamErrorForError(localeZhCN, newUpstreamOperationError(
		"provider failed",
		&upstreamErrorDetails{RawResponseText: &raw},
	))
	if got := len([]rune(streamErr.Message)); got != upstreamProviderResponseCaptureBodyMaxBytes {
		t.Fatalf("stream message length mismatch: got %d want %d", got, upstreamProviderResponseCaptureBodyMaxBytes)
	}
	if streamErr.Details == nil || streamErr.Details.RawResponseText == nil {
		t.Fatal("bounded upstream response should remain available in details")
	}
	if got := len([]rune(*streamErr.Details.RawResponseText)); got != upstreamProviderResponseCaptureBodyMaxBytes {
		t.Fatalf("stream details length mismatch: got %d want %d", got, upstreamProviderResponseCaptureBodyMaxBytes)
	}
}

func TestReadAIRecognitionMultipartThinkingControl(t *testing.T) {
	missing := readAIRecognitionMultipartForTest(t, map[string]string{"text": "dmit 15元 1个月"})
	if missing.ThinkingControl != nil || missing.ThinkingControlProvided {
		t.Fatalf("missing thinkingControl field should remain absent, got %#v provided=%v", missing.ThinkingControl, missing.ThinkingControlProvided)
	}

	explicitNull := readAIRecognitionMultipartForTest(t, map[string]string{
		"text":            "dmit 15元 1个月",
		"thinkingControl": "null",
	})
	if explicitNull.ThinkingControl != nil {
		t.Fatalf("explicit null thinkingControl should stay nil, got %#v", explicitNull.ThinkingControl)
	}

	explicitControl := readAIRecognitionMultipartForTest(t, map[string]string{
		"text":            "dmit 15元 1个月",
		"thinkingControl": `{"provider":"openai","effort":"high"}`,
	})
	if explicitControl.ThinkingControl == nil || explicitControl.ThinkingControl.Provider != "openai" || explicitControl.ThinkingControl.Effort != "high" {
		t.Fatalf("explicit thinkingControl was not parsed: %#v", explicitControl.ThinkingControl)
	}
}

func TestReadAIRecognitionMultipartImageLimit(t *testing.T) {
	fiveImages, err := readAIRecognitionMultipartImagesForTest(5)
	if err != nil {
		t.Fatal(err)
	}
	if len(fiveImages.Images) != 5 {
		t.Fatalf("expected five images, got %#v", fiveImages.Images)
	}

	if _, err := readAIRecognitionMultipartImagesForTest(6); !errors.Is(err, errAIRecognitionBodyTooLarge) {
		t.Fatalf("expected body too large for sixth image, got %v", err)
	}
}

func TestSanitizeAIRecognitionSettingsModelInputMode(t *testing.T) {
	if got := sanitizeAIRecognitionSettings(aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, ModelInputMode: ""}).ModelInputMode; got != "select" {
		t.Fatalf("empty model input mode should default to select, got %q", got)
	}
	if got := sanitizeAIRecognitionSettings(aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, ModelInputMode: "manual"}).ModelInputMode; got != "manual" {
		t.Fatalf("manual model input mode should be preserved, got %q", got)
	}
	if got := sanitizeAIRecognitionSettings(aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, ModelInputMode: "unknown"}).ModelInputMode; got != "select" {
		t.Fatalf("invalid model input mode should fall back to select, got %q", got)
	}
}

func TestSanitizeAIRecognitionSettingsCanonicalizesProtocol(t *testing.T) {
	settings := sanitizeAIRecognitionSettings(aiRecognitionSettings{
		ProviderType:      aiProviderTypeOpenAICompatible,
		TransportProtocol: aiProtocolAnthropicMessages,
		ModelInputMode:    "manual",
		DefaultThinkingControl: &aiThinkingControl{
			Provider: aiProviderTypeAnthropic,
			Mode:     "effort",
			Effort:   "high",
		},
	})
	if settings.TransportProtocol != aiProtocolOpenAIChat {
		t.Fatalf("compatible provider should use openai chat, got %q", settings.TransportProtocol)
	}
	if settings.DefaultThinkingControl != nil {
		t.Fatalf("mismatched thinking control should be cleared: %#v", settings.DefaultThinkingControl)
	}
}

func TestAIRecognitionSettingsLegacyJSONKeepsSecretsAndCanonicalizesThinking(t *testing.T) {
	var settings aiRecognitionSettings
	if err := json.Unmarshal([]byte(`{"provider":"openai","transportProtocol":"openai-chat","model":"gpt-6.1-sol","modelInputMode":"manual","baseUrl":"https://gateway.example.com/v1","apiKey":"sk-legacy","defaultThinkingControl":{"provider":"openai","effort":"minimal"}}`), &settings); err != nil {
		t.Fatal(err)
	}
	settings = sanitizeAIRecognitionSettings(settings)
	if settings.ProviderType != aiProviderTypeOpenAI || settings.TransportProtocol != aiProtocolOpenAIResponses {
		t.Fatalf("legacy OpenAI settings should canonicalize to Responses: %#v", settings)
	}
	if settings.Model != "gpt-6.1-sol" || settings.ModelInputMode != "manual" || settings.BaseURL != "https://gateway.example.com/v1" || settings.APIKey != "sk-legacy" {
		t.Fatalf("legacy credentials/model settings were not preserved: %#v", settings)
	}
	if settings.DefaultThinkingControl != nil {
		t.Fatalf("GPT-6.1-sol must drop incompatible legacy effort: %#v", settings.DefaultThinkingControl)
	}
}

func TestSafeAIRecognitionErrorRedactsSecrets(t *testing.T) {
	err := safeAIRecognitionError(errors.New("provider failed sk-testsecret123 AIza123456789 sk-ant-secret123 Bearer abc.def.ghi eyJabc.def.ghi authorization: secret-token-12345"))
	message := err.Error()
	for _, secret := range []string{"sk-testsecret123", "AIza123456789", "sk-ant-secret123", "Bearer abc.def.ghi", "eyJabc.def.ghi", "secret-token-12345"} {
		if strings.Contains(message, secret) {
			t.Fatalf("secret %q leaked in %q", secret, message)
		}
	}
	if got := strings.Count(message, "[redacted]"); got != 6 {
		t.Fatalf("redaction count mismatch: got %d in %q", got, message)
	}
}

func TestAIRecognitionExistingTagsForUser(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, _ := createRouteTestUser(t, app, "ai-tags")
	other, _ := createRouteTestUser(t, app, "ai-tags-other")
	saveSubscriptionRecord(t, app, user.Id, []string{" VPS ", "云服务器", "vps"}, "Host")
	saveSubscriptionRecord(t, app, other.Id, []string{"Other"}, "Other Host")

	tags, err := aiRecognitionExistingTagsForUser(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tags, []string{"vps", "云服务器"}) {
		t.Fatalf("expected current user tags with case-insensitive prompt dedupe, got %#v", tags)
	}
}

func TestAIRecognitionDiagnosticsRedactsSecretsAndImageData(t *testing.T) {
	diagnostics := buildAIRecognitionDiagnostics(
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, Model: "gpt-5.1"},
		aiRecognitionInput{
			Text: "dmit 15元 1个月 sk-testsecret123",
			Images: []aiRecognitionImage{{
				MediaType: "image/png",
				DataURL:   "data:image/png;base64,SHOULD_NOT_LEAK",
				SizeBytes: 12,
			}},
		},
		"Return JSON only",
		"authorization: secret-token-12345",
		`{"subscriptions":[],"warnings":[],"apiKey":"sk-testsecret123"}`,
		map[string]any{"subscriptions": []any{}, "warnings": []any{}},
		map[string]any{"inputTokens": 1},
		"stop",
		map[string]any{"openai": map[string]any{"authorization": "Bearer abc.def.ghi"}},
	)
	data, err := json.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, leaked := range []string{"sk-testsecret123", "secret-token-12345", "Bearer abc.def.ghi", "SHOULD_NOT_LEAK", "data:image/png;base64"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("diagnostics leaked %q in %s", leaked, text)
		}
	}
	if diagnostics.Request.Images[0].SizeBytes != 12 || diagnostics.Request.Images[0].MediaType != "image/png" {
		t.Fatalf("image metadata not preserved: %#v", diagnostics.Request.Images)
	}
	if diagnostics.Output.RawModelText == nil || !strings.Contains(diagnostics.Output.RawModelText.Value, "[redacted]") {
		t.Fatalf("raw model text was not redacted: %#v", diagnostics.Output.RawModelText)
	}
}
