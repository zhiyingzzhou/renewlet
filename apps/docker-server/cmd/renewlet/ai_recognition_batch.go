package main

import (
	"strings"
	"unicode/utf8"
)

type aiRecognitionBufferedStreamEvent struct {
	stage             string
	subscriptionsSeen int
	warningsSeen      int
	isPartial         bool
}

type aiRecognitionBufferedStreamEvents []aiRecognitionBufferedStreamEvent

func (events *aiRecognitionBufferedStreamEvents) Progress(stage string) error {
	*events = append(*events, aiRecognitionBufferedStreamEvent{stage: stage})
	return nil
}

func (events *aiRecognitionBufferedStreamEvents) Partial(subscriptionsSeen int, warningsSeen int) error {
	*events = append(*events, aiRecognitionBufferedStreamEvent{
		subscriptionsSeen: subscriptionsSeen,
		warningsSeen:      warningsSeen,
		isPartial:         true,
	})
	return nil
}

func (events *aiRecognitionBufferedStreamEvents) Final(aiRecognizeResponse) error {
	return nil
}

func flushAIRecognitionBufferedStreamEvents(events aiRecognitionBufferedStreamEvents, sink aiRecognitionStreamSink, subscriptionOffset int, warningOffset int) error {
	for _, event := range events {
		if event.isPartial {
			if err := sink.Partial(
				minInt(aiRecognitionMaxSubscriptions, subscriptionOffset+event.subscriptionsSeen),
				minInt(20, warningOffset+event.warningsSeen),
			); err != nil {
				return err
			}
			continue
		}
		if err := sink.Progress(event.stage); err != nil {
			return err
		}
	}
	return nil
}

const (
	aiRecognitionBatchMaxRows  = 25
	aiRecognitionBatchMaxChars = 12000
)

// 文本批量按稳定行边界拆分；图片请求保持单次，避免重复发送图片造成成本和语义漂移。
func splitAIRecognitionText(text string) []string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	nonEmpty := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			nonEmpty = append(nonEmpty, line)
		}
	}
	if len(nonEmpty) <= aiRecognitionBatchMaxRows && aiRecognitionTextLength(text) <= aiRecognitionBatchMaxChars {
		return []string{text}
	}
	header := ""
	if detected := detectAIRecognitionDelimitedHeader(nonEmpty); detected != "" {
		header = detected
	}
	chunks := make([]string, 0, (len(nonEmpty)/aiRecognitionBatchMaxRows)+1)
	current := make([]string, 0, aiRecognitionBatchMaxRows)
	currentChars := aiRecognitionTextLength(header)
	headerSkipped := header == ""
	currentRows := 0
	for _, line := range lines {
		// CSV/TSV 头部只复制到每个块；头部前的空行属于输入噪声，不伪造为首条记录。
		if !headerSkipped {
			if strings.TrimSpace(line) == "" {
				continue
			}
			headerSkipped = true
			continue
		}
		nextChars := currentChars + aiRecognitionTextLength(line) + 1
		if strings.TrimSpace(line) != "" && (currentRows >= aiRecognitionBatchMaxRows || (currentRows > 0 && nextChars > aiRecognitionBatchMaxChars)) {
			chunks = append(chunks, header+strings.Join(current, "\n"))
			current = current[:0]
			currentChars = aiRecognitionTextLength(header)
			currentRows = 0
		}
		// 单行可能本身超过字符预算；保留完整记录，避免把自然语言或 CSV 行切成两个伪订阅。
		current = append(current, line)
		currentChars += aiRecognitionTextLength(line) + 1
		if strings.TrimSpace(line) != "" {
			currentRows++
		}
	}
	if len(current) > 0 || len(chunks) == 0 {
		chunks = append(chunks, header+strings.Join(current, "\n"))
	}
	return chunks
}

func aiRecognitionTextLength(value string) int {
	return utf8.RuneCountInString(value)
}

func detectAIRecognitionDelimitedHeader(lines []string) string {
	if len(lines) < 2 {
		return ""
	}
	first, second := lines[0], lines[1]
	for _, delimiter := range []string{"\t", ",", ";"} {
		if strings.Count(first, delimiter) > 0 && strings.Count(first, delimiter) == strings.Count(second, delimiter) && (delimiter == "\t" || isLikelyAIRecognitionDelimitedHeader(first)) {
			return first + "\n"
		}
	}
	return ""
}

func isLikelyAIRecognitionDelimitedHeader(line string) bool {
	value := strings.ToLower(line)
	for _, fragment := range []string{"name", "service", "product", "price", "amount", "currency", "cycle", "date", "名称", "服务", "产品", "价格", "金额", "币种", "周期", "日期"} {
		if strings.Contains(value, fragment) {
			return true
		}
	}
	return false
}

func mergeAIRecognizeResponses(responses []aiRecognizeResponse) aiRecognizeResponse {
	merged := responses[0]
	// 不能复用首块的底层数组：后面的 append 会覆盖首块响应，导致批量合并时首块订阅消失。
	merged.Subscriptions = make([]aiRecognizedSubscriptionDraft, 0, minInt(aiRecognitionMaxSubscriptions, totalAIRecognitionSubscriptions(responses)))
	seenWarnings := map[string]bool{}
	merged.Warnings = make([]string, 0, 20)
	for _, response := range responses {
		merged.Subscriptions = append(merged.Subscriptions, response.Subscriptions...)
		for _, warning := range response.Warnings {
			if !seenWarnings[warning] && len(merged.Warnings) < 20 {
				seenWarnings[warning] = true
				merged.Warnings = append(merged.Warnings, warning)
			}
		}
	}
	if len(merged.Subscriptions) > aiRecognitionMaxSubscriptions {
		merged.Subscriptions = merged.Subscriptions[:aiRecognitionMaxSubscriptions]
		merged.Warnings = appendAIRecognitionWarning(merged.Warnings, "AI_WARNING_TOO_MANY_SUBSCRIPTIONS_TRUNCATED")
	}
	return merged
}

func totalAIRecognitionSubscriptions(responses []aiRecognizeResponse) int {
	total := 0
	for _, response := range responses {
		total += len(response.Subscriptions)
		if total >= aiRecognitionMaxSubscriptions {
			return aiRecognitionMaxSubscriptions
		}
	}
	return total
}

func appendAIRecognitionWarning(warnings []string, warning string) []string {
	for _, existing := range warnings {
		if existing == warning {
			return warnings
		}
	}
	if len(warnings) >= 20 {
		warnings = warnings[:19]
	}
	return append(warnings, warning)
}
