package main

// AI 识别归一化测试保护模型宽松输出进入标准草稿契约前的清洗层。
// 重点覆盖 nullable website、备注去过程化、标签复用和 schema mismatch，避免 AI 文本直接污染长期订阅字段。
import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"slices"
	"testing"
)

type aiRecognitionNormalizationFixture struct {
	Name     string                           `json:"name"`
	Input    aiGeneratedRecognizeResponse     `json:"input"`
	Config   aiRecognitionNormalizationConfig `json:"config"`
	Expected json.RawMessage                  `json:"expected"`
}

type aiRecognitionNormalizationConfig struct {
	Categories     []aiRecognitionNormalizationOption `json:"categories"`
	PaymentMethods []aiRecognitionNormalizationOption `json:"paymentMethods"`
	Tags           []string                           `json:"tags"`
}

type aiRecognitionNormalizationOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
	ZhCN  string `json:"zhCN"`
	EnUS  string `json:"enUS"`
}

func (config aiRecognitionNormalizationConfig) context() aiRecognitionConfigContext {
	categories := make([]aiRecognitionConfigOption, 0, len(config.Categories))
	for _, option := range config.Categories {
		categories = append(categories, aiRecognitionConfigOption{Value: option.Value, Label: option.Label, ZhCN: option.ZhCN, EnUS: option.EnUS})
	}
	paymentMethods := make([]aiRecognitionConfigOption, 0, len(config.PaymentMethods))
	for _, option := range config.PaymentMethods {
		paymentMethods = append(paymentMethods, aiRecognitionConfigOption{Value: option.Value, Label: option.Label, ZhCN: option.ZhCN, EnUS: option.EnUS})
	}
	return aiRecognitionConfigContext{Categories: categories, PaymentMethods: paymentMethods, Tags: config.Tags}
}

func TestAIRecognitionConfigAndTagMatchingUsesUnicodeEvidenceRules(t *testing.T) {
	if got := aiRecognitionConfigMatchKey("Ａｃｔｉｖｅ"); got != "active" {
		t.Fatalf("config matching should apply NFKC normalization, got %q", got)
	}
	if isUsefulAIGeneratedTag("方案２０２６", "方案２０２６", "service") {
		t.Fatal("generated tags containing Unicode numbers must be rejected")
	}
}

func TestNormalizeAIRecognizeResponse(t *testing.T) {
	price := "-1"
	currency := "usd"
	billingCycle := "bad"
	date := "2026-99-99"
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:            "  Netflix  ",
			Price:           &price,
			Currency:        &currency,
			BillingCycle:    &billingCycle,
			StartDate:       &date,
			NextBillingDate: &date,
			Confidence:      "unknown",
			Warnings:        []string{"", "manual warning", "manual warning"},
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if response.ProviderType != aiProviderTypeOpenAI || response.TransportProtocol != aiProtocolOpenAIResponses || response.Model != "gpt-5.1" {
		t.Fatalf("provider/protocol/model not attached: %#v", response)
	}
	if draft.Name != "Netflix" || draft.Price != nil || draft.BillingCycle != nil || draft.Confidence != "low" {
		t.Fatalf("draft was not normalized: %#v", draft)
	}
	if draft.Currency == nil || *draft.Currency != "USD" {
		t.Fatalf("currency should normalize to USD: %#v", draft.Currency)
	}
	if !slices.Contains(draft.Warnings, "AI_WARNING_PRICE_INVALID") || !slices.Contains(draft.Warnings, "AI_WARNING_DATE_INVALID:startDate") {
		t.Fatalf("expected validation warnings, got %#v", draft.Warnings)
	}
}

func TestNormalizeAIRecognizeResponseInfersFixedTermStatus(t *testing.T) {
	billingCycle := "one-time"
	startDate := "2026-01-06"
	termCount := 2
	termUnit := "year"
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:             "DMIT",
			BillingCycle:     &billingCycle,
			StartDate:        &startDate,
			OneTimeTermCount: &termCount,
			OneTimeTermUnit:  &termUnit,
		}},
		Warnings:    []string{"AI_WARNING_STATUS_UNCERTAIN"},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{}, "2026-11-05")
	if err != nil {
		t.Fatal(err)
	}
	if got := response.Subscriptions[0].Status; got == nil || *got != "active" {
		t.Fatalf("fixed term covering current date should be active, got %#v", got)
	}
	if got := response.Subscriptions[0].NextBillingDate; got == nil || *got != "2028-01-06" {
		t.Fatalf("fixed term end date should be derived from purchase date and term, got %#v", got)
	}
	if slices.Contains(response.Subscriptions[0].Warnings, "AI_WARNING_STATUS_UNCERTAIN") {
		t.Fatalf("inferred fixed term status must not require confirmation: %#v", response.Subscriptions[0].Warnings)
	}
	if slices.Contains(response.Warnings, "AI_WARNING_STATUS_UNCERTAIN") {
		t.Fatalf("global status uncertainty must be cleared when all drafts are inferred: %#v", response.Warnings)
	}
}

func TestNormalizeAIRecognizeResponseDoesNotInferFutureFixedTerm(t *testing.T) {
	billingCycle := "one-time"
	startDate := "2027-01-06"
	termCount := 2
	termUnit := "year"
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:             "DMIT",
			BillingCycle:     &billingCycle,
			StartDate:        &startDate,
			OneTimeTermCount: &termCount,
			OneTimeTermUnit:  &termUnit,
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{}, "2026-11-05")
	if err != nil {
		t.Fatal(err)
	}
	if response.Subscriptions[0].Status != nil {
		t.Fatalf("future fixed term must not be marked active before its start date: %#v", response.Subscriptions[0].Status)
	}
}

func TestNormalizeAIGeneratedRecognizeResponse(t *testing.T) {
	currency := "元"
	billingCycle := "1个月"
	category := "数字服务"
	paymentMethod := "Crypto"
	websiteValue := "https://www.apple.com/"
	website := aiGeneratedSuggestedTextField{Value: &websiteValue, Source: "suggested"}
	notesValue := "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。"
	notes := aiGeneratedNotesField{Value: &notesValue, Source: "suggested"}
	configContext := aiRecognitionConfigContext{
		Categories: []aiRecognitionConfigOption{{
			Value: "digital_services",
			Label: "数字服务",
			ZhCN:  "数字服务",
			EnUS:  "Digital services",
		}},
		PaymentMethods: []aiRecognitionConfigOption{{
			Value: "crypto",
			Label: "加密货币",
			ZhCN:  "加密货币",
			EnUS:  "Crypto",
		}},
		Tags: []string{"数字服务", "云服务"},
	}
	response, err := normalizeAIGeneratedRecognizeResponse(aiGeneratedRecognizeResponse{
		Subscriptions: []aiGeneratedSubscriptionDraft{{
			Name:          "dmit",
			Price:         "15元",
			Currency:      &currency,
			BillingCycle:  &billingCycle,
			Category:      &category,
			PaymentMethod: &paymentMethod,
			Website:       &website,
			Notes:         &notes,
			Tags:          []string{"数字服务", "数字服务", "  云服务  "},
		}},
		Warnings: []string{},
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", testAIRecognitionDiagnostics(), configContext)
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if response.ProviderType != aiProviderTypeOpenAI || response.TransportProtocol != aiProtocolOpenAIResponses || response.Model != "gpt-5.1" {
		t.Fatalf("provider/protocol/model not attached: %#v", response)
	}
	if draft.Name != "dmit" || draft.Price == nil || *draft.Price != "15" {
		t.Fatalf("generated draft price not normalized: %#v", draft)
	}
	if draft.Currency == nil || *draft.Currency != "CNY" {
		t.Fatalf("currency should normalize to CNY: %#v", draft.Currency)
	}
	if draft.BillingCycle == nil || *draft.BillingCycle != "monthly" {
		t.Fatalf("billing cycle should normalize to monthly: %#v", draft.BillingCycle)
	}
	if draft.Category == nil || *draft.Category != "digital_services" || draft.PaymentMethod == nil || *draft.PaymentMethod != "crypto" || draft.Website == nil || draft.Website.Source != "suggested" || draft.Notes == nil || draft.Notes.Source != "suggested" {
		t.Fatalf("suggested metadata should be preserved: %#v", draft)
	}
	if !reflect.DeepEqual(draft.Tags, []string{"数字服务", "云服务"}) {
		t.Fatalf("tags should be compacted: %#v", draft.Tags)
	}
}

func TestNormalizeAIGeneratedRecognizeResponseMatchesSharedFixtures(t *testing.T) {
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/ai-recognition-normalization-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []aiRecognitionNormalizationFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			response, err := normalizeAIGeneratedRecognizeResponse(
				fixture.Input,
				aiProviderTypeOpenAI,
				aiProtocolOpenAIChat,
				"gpt-5.1",
				testAIRecognitionDiagnostics(),
				fixture.Config.context(),
			)
			if err != nil {
				t.Fatal(err)
			}
			actualBytes, err := json.Marshal(map[string]any{
				"providerType":      response.ProviderType,
				"transportProtocol": response.TransportProtocol,
				"model":             response.Model,
				"subscriptions":     response.Subscriptions,
				"warnings":          response.Warnings,
			})
			if err != nil {
				t.Fatal(err)
			}
			var actual, expected map[string]any
			if err := json.Unmarshal(actualBytes, &actual); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(fixture.Expected, &expected); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("normalized output drifted: got %#v, want %#v", actual, expected)
			}
		})
	}
}

func TestNormalizeAIGeneratedRecognizeResponseCleansNullableWebsiteValue(t *testing.T) {
	notesValue := "LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。"
	response, err := normalizeAIGeneratedRecognizeResponse(aiGeneratedRecognizeResponse{
		Subscriptions: []aiGeneratedSubscriptionDraft{{
			Name:       "LocVPS",
			Website:    &aiGeneratedSuggestedTextField{Value: nil, Source: "suggested"},
			Notes:      &aiGeneratedNotesField{Value: &notesValue, Source: "suggested"},
			Tags:       []string{"VPS"},
			Confidence: "high",
			Warnings:   []string{},
		}},
		Warnings: []string{},
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", testAIRecognitionDiagnostics(), aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if response.Subscriptions[0].Website != nil {
		t.Fatalf("nullable generated website value should be normalized away: %#v", response.Subscriptions[0].Website)
	}
	if response.Subscriptions[0].Notes == nil || response.Subscriptions[0].Notes.Value != notesValue {
		t.Fatalf("provider-generated service description should survive without a website field: %#v", response.Subscriptions[0].Notes)
	}
}

func TestNormalizeAITagsReusesExistingAndKeepsStableGeneratedTags(t *testing.T) {
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "HostDZire IN CloudVPS #5 (FAT32 Special)",
			Tags:       []string{"vps", "孟买", "Debian 12"},
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{Tags: []string{"VPS", "云服务器"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(response.Subscriptions[0].Tags, []string{"VPS"}) {
		t.Fatalf("expected existing tag reuse and one-off attribute filtering, got %#v", response.Subscriptions[0].Tags)
	}

	response, err = normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "DMIT",
			Tags:       []string{"VPS", "云服务器", "Debian 12"},
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(response.Subscriptions[0].Tags, []string{"VPS", "云服务器"}) {
		t.Fatalf("expected stable generated tags to remain, got %#v", response.Subscriptions[0].Tags)
	}

	response, err = normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "HostDZire IN CloudVPS #5 (FAT32 Special)",
			Tags:       []string{"孟买", "Debian 12", "FAT32 Special"},
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Subscriptions[0].Tags) != 0 {
		t.Fatalf("expected one-off generated attributes to be dropped, got %#v", response.Subscriptions[0].Tags)
	}
}

func TestNormalizeAINotesDropsRecognitionProcessText(t *testing.T) {
	notes := aiSuggestedTextField{Value: "输入没有提供官网或更多上下文，AI 未能高置信识别该服务。", Source: "suggested"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "unknown app",
			Notes:      &notes,
			Warnings:   []string{"AI_WARNING_WEBSITE_UNCERTAIN"},
			Confidence: "low",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if draft.Notes != nil {
		t.Fatalf("process note should be dropped: %#v", draft.Notes)
	}
	if !slices.Contains(draft.Warnings, "AI_WARNING_WEBSITE_UNCERTAIN") {
		t.Fatalf("warning should be preserved: %#v", draft.Warnings)
	}
}

func TestNormalizeAINotesDropsInferredInputPurpose(t *testing.T) {
	notes := aiSuggestedTextField{Value: "HKG Tier1 - 1C1G - NetBird节点/Docker测试", Source: "input"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "LAX Pro",
			Notes:      &notes,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if draft := response.Subscriptions[0]; draft.Notes != nil {
		t.Fatalf("inferred input purpose should be dropped: %#v", draft.Notes)
	}
}

func TestNormalizeAINotesDropsInferredSuggestedPurpose(t *testing.T) {
	notes := aiSuggestedTextField{Value: "DMIT 提供 VPS 和云服务器服务，用于 Docker 测试和 NetBird 节点部署。", Source: "suggested"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "DMIT",
			Notes:      &notes,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if draft := response.Subscriptions[0]; draft.Notes == nil || draft.Notes.Value != "DMIT 提供 VPS 和云服务器服务" {
		t.Fatalf("inferred suggested purpose should be removed: %#v", draft.Notes)
	}
}

func TestNormalizeAINotesDropsInputBillingFieldSummary(t *testing.T) {
	notes := aiSuggestedTextField{Value: "DMIT-w4vnZS2F21 - Debian 12 x64 - 2026-01-06至2028-01-05 - $159.88 USD", Source: "input"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "DMIT",
			Notes:      &notes,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if draft := response.Subscriptions[0]; draft.Notes != nil {
		t.Fatalf("billing-field summary should not become a long-term note: %#v", draft.Notes)
	}
}

func TestNormalizeAINotesRemovesRenewletAdvice(t *testing.T) {
	notes := aiSuggestedTextField{Value: "LOCVPS 提供 VPS、云服务器和服务器托管相关服务，适合记录主机或服务器套餐订阅。", Source: "suggested"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "locvps",
			Notes:      &notes,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	draft := response.Subscriptions[0]
	if draft.Notes == nil || draft.Notes.Value != "LOCVPS 提供 VPS、云服务器和服务器托管服务" {
		t.Fatalf("service note should remove Renewlet-facing advice: %#v", draft.Notes)
	}
}

func TestNormalizeAINotesKeepsConcreteServiceDescriptionWithMarketingAdjective(t *testing.T) {
	notes := aiSuggestedTextField{Value: "DMIT 提供稳定的 VPS、云服务器和网络线路服务。", Source: "suggested"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "DMIT",
			Notes:      &notes,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if draft := response.Subscriptions[0]; draft.Notes == nil || draft.Notes.Value != notes.Value {
		t.Fatalf("concrete service description should survive marketing-word filtering: %#v", draft.Notes)
	}
}

func TestNormalizeAINotesKeepsEnglishProductDescriptionFromInput(t *testing.T) {
	notes := aiSuggestedTextField{Value: "ChatGPT is an AI assistant for conversation and writing.", Source: "input"}
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "ChatGPT",
			Notes:      &notes,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{})
	if err != nil {
		t.Fatal(err)
	}
	if draft := response.Subscriptions[0]; draft.Notes == nil || draft.Notes.Value != notes.Value {
		t.Fatalf("product description should survive input-note filtering: %#v", draft.Notes)
	}
}

func TestNormalizeAIConfigValueKeepsUnknownNamesForImportCreation(t *testing.T) {
	category := "Cloud lab"
	response, err := normalizeAIRecognizeResponse(aiRecognizeResponse{
		Subscriptions: []aiRecognizedSubscriptionDraft{{
			Name:       "Lab",
			Category:   &category,
			Confidence: "high",
		}},
		Diagnostics: testAIRecognitionDiagnostics(),
	}, aiProviderTypeOpenAI, aiProtocolOpenAIResponses, "gpt-5.1", aiRecognitionConfigContext{
		Categories: []aiRecognitionConfigOption{{
			Value: "hosting_domains",
			Label: "域名与托管",
			ZhCN:  "域名与托管",
			EnUS:  "Domains & Hosting",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := response.Subscriptions[0].Category; got == nil || *got != "Cloud lab" {
		t.Fatalf("unknown category should be preserved for import config creation, got %#v", got)
	}
}

func TestAIRecognitionSchemaMismatchError(t *testing.T) {
	for _, err := range []error{
		errors.New("No object generated: response did not match schema."),
		errors.New("parsing structured output: invalid character 'o' looking for beginning of value (raw: ok)"),
	} {
		if !isAIRecognitionSchemaMismatchError(err) {
			t.Fatalf("expected schema mismatch error for %q", err.Error())
		}
	}
}
