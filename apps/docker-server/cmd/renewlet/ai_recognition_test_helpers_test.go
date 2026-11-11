package main

// AI 识别测试 helper 复刻第三方 provider 的最小行为，用来稳定触发 raw JSON 恢复、批量和 SSE 事件流。
// helper 不能引入真实网络或本地品牌知识，否则会掩盖生产 runner 的脱敏和 schema 修复边界。
import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/zendev-sh/goai"
	"github.com/zendev-sh/goai/provider"
)

func testAIRecognitionDiagnostics() aiRecognitionDiagnostics {
	return buildAIRecognitionDiagnostics(
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, Model: "gpt-5.1"},
		aiRecognitionInput{Text: "dmit 15元 1个月"},
		"Return JSON only",
		"Extract subscriptions",
		`{"subscriptions":[],"warnings":[]}`,
		map[string]any{"subscriptions": []any{}, "warnings": []any{}},
		map[string]any{"inputTokens": 1, "outputTokens": 1},
		"stop",
		map[string]any{"openai": map[string]any{"id": "resp_1"}},
	)
}

type aiConnectionTestModel struct {
	calls  int
	params provider.GenerateParams
	err    error
}

func (model *aiConnectionTestModel) ModelID() string {
	return "connection-test"
}

func (model *aiConnectionTestModel) DoGenerate(_ context.Context, params provider.GenerateParams) (*provider.GenerateResult, error) {
	model.calls += 1
	model.params = params
	if model.err != nil {
		return nil, model.err
	}
	return &provider.GenerateResult{Text: "OK"}, nil
}

func (model *aiConnectionTestModel) DoStream(context.Context, provider.GenerateParams) (*provider.StreamResult, error) {
	return nil, errors.New("stream not used in connection test")
}

func readAIRecognitionMultipartForTest(t *testing.T, fields map[string]string) aiRecognitionInput {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/app/ai/subscriptions/recognize", &body)
	req.Header.Set("content-type", writer.FormDataContentType())
	input, err := readAIRecognitionMultipart(&core.RequestEvent{
		Event: router.Event{
			Request:  req,
			Response: httptest.NewRecorder(),
		},
	}, localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	return input
}

func readAIRecognitionMultipartImagesForTest(count int) (aiRecognitionInput, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for index := 0; index < count; index++ {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="images[]"; filename="image.png"`)
		header.Set("Content-Type", "image/png")
		part, err := writer.CreatePart(header)
		if err != nil {
			return aiRecognitionInput{}, err
		}
		if _, err := part.Write([]byte{0x89, 0x50, 0x4e, 0x47}); err != nil {
			return aiRecognitionInput{}, err
		}
	}
	if err := writer.Close(); err != nil {
		return aiRecognitionInput{}, err
	}
	req := httptest.NewRequest(http.MethodPost, "/api/app/ai/subscriptions/recognize", &body)
	req.Header.Set("content-type", writer.FormDataContentType())
	return readAIRecognitionMultipart(&core.RequestEvent{
		Event: router.Event{
			Request:  req,
			Response: httptest.NewRecorder(),
		},
	}, localeZhCN)
}

func stubAIRecognitionGeneration(t *testing.T, responses []aiGeneratedRecognizeResponse) func() {
	t.Helper()
	previous := generateAIRecognitionObjectForRunner
	index := 0
	generateAIRecognitionObjectForRunner = func(_ context.Context, _ provider.LanguageModel, _ aiRecognitionInput, _ string, _ string) (aiRecognitionGeneration, error) {
		t.Helper()
		if index >= len(responses) {
			t.Fatalf("unexpected AI generation call %d", index+1)
		}
		response := responses[index]
		index++
		return aiRecognitionGeneration{
			result: &goai.ObjectResult[aiGeneratedRecognizeResponse]{Object: response},
			capture: aiRecognitionCapture{
				rawModelText: resultStringFromAIObject(response),
				finishReason: "stop",
			},
		}, nil
	}
	return func() {
		generateAIRecognitionObjectForRunner = previous
	}
}

func stubAIRecognitionStreamGeneration(t *testing.T, responses []aiGeneratedRecognizeResponse) func() {
	t.Helper()
	previous := streamAIRecognitionObjectForRunner
	index := 0
	streamAIRecognitionObjectForRunner = func(_ context.Context, _ provider.LanguageModel, _ aiRecognitionInput, _ string, _ string, sink aiRecognitionStreamSink) (aiRecognitionGeneration, error) {
		t.Helper()
		if index >= len(responses) {
			t.Fatalf("unexpected AI stream generation call %d", index+1)
		}
		response := responses[index]
		index++
		if err := sink.Progress(aiRecognitionStreamStageModelStream); err != nil {
			return aiRecognitionGeneration{}, err
		}
		if err := sink.Partial(len(response.Subscriptions), len(response.Warnings)); err != nil {
			return aiRecognitionGeneration{}, err
		}
		return aiRecognitionGeneration{
			result: &goai.ObjectResult[aiGeneratedRecognizeResponse]{Object: response},
			capture: aiRecognitionCapture{
				rawModelText: resultStringFromAIObject(response),
				finishReason: "stop",
			},
		}, nil
	}
	return func() {
		streamAIRecognitionObjectForRunner = previous
	}
}

type recordingAIRecognitionStreamSink struct {
	progress []string
	partials []aiRecognitionStreamPartialEvent
	final    *aiRecognizeResponse
}

func (sink *recordingAIRecognitionStreamSink) Progress(stage string) error {
	sink.progress = append(sink.progress, stage)
	return nil
}

func (sink *recordingAIRecognitionStreamSink) Partial(subscriptionsSeen int, warningsSeen int) error {
	sink.partials = append(sink.partials, aiRecognitionStreamPartialEvent{
		Type:              "recognition/partial",
		SubscriptionsSeen: subscriptionsSeen,
		WarningsSeen:      warningsSeen,
	})
	return nil
}

func (sink *recordingAIRecognitionStreamSink) Final(response aiRecognizeResponse) error {
	sink.final = &response
	return nil
}

func aiGeneratedResponseForTest(draft aiGeneratedSubscriptionDraft) aiGeneratedRecognizeResponse {
	return aiGeneratedRecognizeResponse{
		Subscriptions: []aiGeneratedSubscriptionDraft{draft},
		Warnings:      []string{},
	}
}

func aiGeneratedDraftForTest(name string, notes aiGeneratedNotesField, tags []string) aiGeneratedSubscriptionDraft {
	currency := "CNY"
	billingCycle := "monthly"
	status := "active"
	return aiGeneratedSubscriptionDraft{
		Name:                         name,
		Price:                        "15",
		Currency:                     &currency,
		BillingCycle:                 &billingCycle,
		CustomDays:                   nil,
		CustomCycleUnit:              nil,
		OneTimeTermCount:             nil,
		OneTimeTermUnit:              nil,
		Category:                     nil,
		Status:                       &status,
		PaymentMethod:                nil,
		StartDate:                    nil,
		NextBillingDate:              nil,
		AutoCalculateNextBillingDate: boolRef(true),
		TrialEndDate:                 nil,
		Website:                      &aiGeneratedSuggestedTextField{Value: stringRef("https://hostdzire.com/"), Source: "suggested"},
		Notes:                        &notes,
		Tags:                         tags,
		ReminderDays:                 nil,
		RepeatReminderEnabled:        nil,
		RepeatReminderInterval:       nil,
		RepeatReminderWindow:         nil,
		Confidence:                   "high",
		Warnings:                     []string{},
	}
}

func stringRef(value string) *string {
	return &value
}

func boolRef(value bool) *bool {
	return &value
}
