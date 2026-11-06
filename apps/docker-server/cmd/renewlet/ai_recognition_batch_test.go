package main

import (
	"strings"
	"testing"
)

func TestSplitAIRecognitionTextKeepsDelimitedHeaderAndUnicodeBudget(t *testing.T) {
	rows := []string{"name,price,currency", "服务,1,CNY"}
	for index := 0; index < 30; index++ {
		rows = append(rows, "服务"+strings.Repeat("😀", 500)+",1,CNY")
	}
	chunks := splitAIRecognitionText(strings.Join(rows, "\n"))
	if len(chunks) < 2 {
		t.Fatalf("expected text to split into multiple chunks, got %d", len(chunks))
	}
	for index, chunk := range chunks {
		if !strings.HasPrefix(chunk, "name,price,currency\n") {
			t.Fatalf("chunk %d lost delimited header: %q", index, chunk[:minInt(len(chunk), 80)])
		}
	}
}

func TestAIRecognitionOutputTokenLimitMatchesDynamicBudget(t *testing.T) {
	if got := aiRecognitionOutputTokenLimit(aiRecognitionInput{Text: "one\n  \ntwo"}); got != 1024 {
		t.Fatalf("expected two non-empty rows to use the 1024-token floor, got %d", got)
	}
	if got := aiRecognitionOutputTokenLimit(aiRecognitionInput{Images: []aiRecognitionImage{{}, {}}}); got != 2272 {
		t.Fatalf("expected two images to reserve four estimated records each, got %d", got)
	}
	if got := aiRecognitionOutputTokenLimit(aiRecognitionInput{
		Images:          []aiRecognitionImage{{}},
		ThinkingControl: &aiThinkingControl{Provider: "openai", Effort: "high"},
	}); got != 4096 {
		t.Fatalf("expected explicit thinking to reserve a larger output budget, got %d", got)
	}
	if got := aiRecognitionOutputTokenLimit(aiRecognitionInput{Text: strings.Repeat("row\n", 40)}); got != 7000 {
		t.Fatalf("expected output budget cap, got %d", got)
	}
}

func TestMergeAIRecognizeResponsesDeduplicatesBatchWarnings(t *testing.T) {
	first := aiRecognizeResponse{Warnings: []string{"AI_WARNING_BATCH_PARTIAL"}, Subscriptions: make([]aiRecognizedSubscriptionDraft, 60)}
	second := aiRecognizeResponse{Warnings: []string{"AI_WARNING_BATCH_PARTIAL"}, Subscriptions: make([]aiRecognizedSubscriptionDraft, 60)}
	merged := mergeAIRecognizeResponses([]aiRecognizeResponse{first, second})
	if len(merged.Subscriptions) != aiRecognitionMaxSubscriptions {
		t.Fatalf("expected subscription cap %d, got %d", aiRecognitionMaxSubscriptions, len(merged.Subscriptions))
	}
	count := 0
	for _, warning := range merged.Warnings {
		if warning == "AI_WARNING_TOO_MANY_SUBSCRIPTIONS_TRUNCATED" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected one truncation warning, got %d: %#v", count, merged.Warnings)
	}
}
