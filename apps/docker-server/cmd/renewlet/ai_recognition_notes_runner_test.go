package main

import (
	"context"
	"testing"
)

func TestGoAIRecognitionRunnerRepairsMissingNotesWithoutReplacingBillingFacts(t *testing.T) {
	first := aiGeneratedDraftForTest(
		"DMIT",
		aiGeneratedNotesField{Value: nil, Source: "none"},
		[]string{"VPS", "云服务器"},
	)
	first.Price = "159.88"
	first.Currency = stringRef("USD")
	first.BillingCycle = stringRef("one-time")
	first.Status = nil
	first.OneTimeTermCount = "2"
	first.OneTimeTermUnit = stringRef("year")
	first.StartDate = stringRef("2026-01-06")
	first.NextBillingDate = nil
	first.Website = nil
	first.Tags = []string{}
	first.Confidence = "low"

	repaired := aiGeneratedDraftForTest(
		"DMIT",
		aiGeneratedNotesField{Value: stringRef("DMIT provides VPS and cloud hosting services."), Source: "suggested"},
		[]string{},
	)
	repaired.Price = "1"
	repaired.BillingCycle = stringRef("monthly")
	repaired.Status = stringRef("cancelled")
	repaired.Website = nil

	restore := stubAIRecognitionGeneration(t, []aiGeneratedRecognizeResponse{
		aiGeneratedResponseForTest(first),
		aiGeneratedResponseForTest(repaired),
	})
	defer restore()

	response, err := goaiRecognitionRunner{}.Recognize(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "DMIT 159.88 USD purchased 2026-01-06 valid for 2 years"},
		localeZhCN,
		"Asia/Shanghai",
		aiRecognitionConfigContext{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Subscriptions) != 1 {
		t.Fatalf("expected one repaired subscription, got %#v", response.Subscriptions)
	}
	draft := response.Subscriptions[0]
	if draft.Notes == nil || draft.Notes.Value != "DMIT provides VPS and cloud hosting services." {
		t.Fatalf("missing service description after repair: %#v", draft.Notes)
	}
	if draft.Price == nil || *draft.Price != "159.88" || draft.BillingCycle == nil || *draft.BillingCycle != "one-time" {
		t.Fatalf("repair must preserve first-pass billing facts: %#v", draft)
	}
	if draft.Status == nil || *draft.Status != "active" || draft.NextBillingDate == nil || *draft.NextBillingDate != "2028-01-06" {
		t.Fatalf("fixed-term status/date should be derived from first-pass facts: %#v", draft)
	}
}

func TestGoAIRecognitionRunnerStreamRepairsMissingNotesWithoutReplacingBillingFacts(t *testing.T) {
	first := aiGeneratedDraftForTest(
		"DMIT",
		aiGeneratedNotesField{Value: nil, Source: "none"},
		[]string{"VPS"},
	)
	first.Price = "159.88"
	first.Currency = stringRef("USD")
	first.BillingCycle = stringRef("one-time")
	first.Status = nil
	first.OneTimeTermCount = "2"
	first.OneTimeTermUnit = stringRef("year")
	first.StartDate = stringRef("2026-01-06")
	first.NextBillingDate = nil

	repaired := aiGeneratedDraftForTest(
		"DMIT",
		aiGeneratedNotesField{Value: stringRef("DMIT provides VPS and cloud hosting services."), Source: "suggested"},
		[]string{},
	)
	repaired.Price = "1"
	repaired.BillingCycle = stringRef("monthly")
	repaired.Status = stringRef("cancelled")

	restore := stubAIRecognitionStreamGeneration(t, []aiGeneratedRecognizeResponse{
		aiGeneratedResponseForTest(first),
		aiGeneratedResponseForTest(repaired),
	})
	defer restore()
	sink := &recordingAIRecognitionStreamSink{}

	err := goaiRecognitionRunner{}.Stream(
		context.Background(),
		aiRecognitionSettings{ProviderType: aiProviderTypeOpenAI, TransportProtocol: aiProtocolOpenAIResponses, Model: "gpt-5.1", APIKey: "sk-test"},
		aiRecognitionInput{Text: "DMIT 159.88 USD purchased 2026-01-06 valid for 2 years"},
		localeZhCN,
		"Asia/Shanghai",
		aiRecognitionConfigContext{},
		sink,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sink.final == nil || len(sink.final.Subscriptions) != 1 {
		t.Fatalf("expected repaired stream final response, got %#v", sink.final)
	}
	draft := sink.final.Subscriptions[0]
	if draft.Notes == nil || draft.Notes.Value != "DMIT provides VPS and cloud hosting services." {
		t.Fatalf("missing service description after stream repair: %#v", draft.Notes)
	}
	if draft.Price == nil || *draft.Price != "159.88" || draft.BillingCycle == nil || *draft.BillingCycle != "one-time" || draft.Status == nil || *draft.Status != "active" {
		t.Fatalf("stream repair must preserve first-pass facts: %#v", draft)
	}
}
