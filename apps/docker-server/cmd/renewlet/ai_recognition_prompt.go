package main

// ai_recognition_prompt.go 从 shared prompt JSON 生成 Go 运行面的提示词。
//
// shared/data/ai-recognition-prompt.json 是 Docker 与 Cloudflare 的事实源；Go 只读取 embedded 副本，
// 不能在运行面里手写另一套输出规则或字段解释。
import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"

	appstatic "github.com/zhiyingzzhou/renewlet/apps/docker-server/internal/static"
)

type aiRecognitionPromptSpec struct {
	Version         string                                 `json:"version"`
	SchemaName      string                                 `json:"schemaName"`
	System          []string                               `json:"system"`
	OutputContract  []string                               `json:"outputContract"`
	FieldRules      []string                               `json:"fieldRules"`
	OutputLanguages map[string]aiRecognitionOutputLanguage `json:"outputLanguages"`
	Examples        []aiRecognitionPromptExample           `json:"examples"`
}

type aiRecognitionPromptExample struct {
	Input  string          `json:"input"`
	Output json.RawMessage `json:"output"`
}

type aiRecognitionConfigOption struct {
	Value string
	Label string
	ZhCN  string
	EnUS  string
}

type aiRecognitionConfigContext struct {
	Categories     []aiRecognitionConfigOption
	PaymentMethods []aiRecognitionConfigOption
	Tags           []string
}

type aiRecognitionOutputLanguage struct {
	Label             string `json:"label"`
	NativeInstruction string `json:"nativeInstruction"`
}

var aiRecognitionPrompt = mustLoadAIRecognitionPrompt()

func mustLoadAIRecognitionPrompt() aiRecognitionPromptSpec {
	var spec aiRecognitionPromptSpec
	if err := json.Unmarshal(appstatic.AIRecognitionPrompt, &spec); err != nil {
		panic(fmt.Sprintf("load AI recognition prompt: %v", err))
	}
	if spec.Version == "" || spec.SchemaName == "" || len(spec.System) == 0 || len(spec.OutputContract) == 0 || len(spec.FieldRules) == 0 || len(spec.OutputLanguages) == 0 || spec.OutputLanguages["en-US"].Label == "" || spec.OutputLanguages["en-US"].NativeInstruction == "" {
		panic("load AI recognition prompt: incomplete prompt spec")
	}
	return spec
}

func buildAIRecognitionSystemPrompt(locales ...appLocale) string {
	locale := localeEnUS
	if len(locales) > 0 {
		locale = locales[0]
	}
	sections := append([]string{}, aiRecognitionPrompt.System...)
	sections = append(sections, aiRecognitionOutputLanguageRules(locale)...)
	sections = append(sections, "Output contract:")
	sections = append(sections, prefixAIPromptRules(aiRecognitionPrompt.OutputContract)...)
	sections = append(sections, "Field rules:")
	sections = append(sections, prefixAIPromptRules(aiRecognitionPrompt.FieldRules)...)
	examples := make([]string, 0, len(aiRecognitionPrompt.Examples))
	for index, example := range aiRecognitionPrompt.Examples {
		examples = append(examples, strings.Join([]string{
			fmt.Sprintf("Example %d input:", index+1),
			example.Input,
			fmt.Sprintf("Example %d JSON output:", index+1),
			formatAIRecognitionPromptJSON(example.Output),
		}, "\n"))
	}
	sections = append(sections, "Examples:", strings.Join(examples, "\n\n"))
	return strings.Join(sections, "\n")
}

func buildAIRecognitionUserPrompt(text string, timezone string, imageCount int, locale appLocale, configContext aiRecognitionConfigContext) string {
	userInput := strings.TrimSpace(text)
	if userInput == "" {
		userInput = "(no text input; use attached images)"
	}
	lines := []string{
		"Runtime context:",
		fmt.Sprintf("- Current date in user's timezone: %s", todayDateOnly(time.Now().UTC(), timezone)),
		fmt.Sprintf("- User timezone: %s", timezone),
		fmt.Sprintf("- User locale: %s", locale),
		fmt.Sprintf("- Attached image count: %d", imageCount),
		"",
	}
	lines = append(lines, aiRecognitionOutputLanguageRules(locale)...)
	lines = append(lines,
		"- Keep service names, URLs, explicit source=input text, existing labels, and existing tags in their original form; do not translate evidence.",
		"",
		"User context:",
		"Existing user tags:",
	)
	lines = append(lines, formatAIRecognitionTags(configContext.Tags)...)
	lines = append(lines,
		"",
		"Available Renewlet configuration options:",
		"Categories:",
	)
	lines = append(lines, formatAIRecognitionConfigOptions(configContext.Categories)...)
	lines = append(lines, "Payment methods:")
	lines = append(lines, formatAIRecognitionConfigOptions(configContext.PaymentMethods)...)
	lines = append(lines,
		"",
		"Task:",
		"- Extract subscriptions from the delimited user input below and any attached images.",
		"- Treat the dynamic user context as preferences and available options, not as subscription evidence.",
		"",
		"User input:",
		"<<<renewlet-user-input",
		userInput,
		">>>",
	)
	return strings.Join(lines, "\n")
}

func buildAIRecognitionRepairUserPrompt(originalUserPrompt string, previousObject interface{}, missingNoteNames []string, locale appLocale) string {
	lines := []string{
		"Repair task:",
		"- The previous JSON object is structurally valid, but some recognizable subscriptions have missing or unusable notes.",
		"- Regenerate the complete JSON object with the same output contract and preserve every existing billing fact exactly.",
		"- Only fill notes for the listed subscriptions; do not change price, currency, cycle, dates, status, category, payment method, website, tags, or warnings.",
		"- For each listed subscription, notes.value must be a concise neutral description of the official service, site, or product. Use source=suggested for that description.",
	}
	lines = append(lines, aiRecognitionOutputLanguageRules(locale)...)
	lines = append(lines,
		"- Keep service names, URLs, explicit source=input text, existing labels, and existing tags in their original form; do not translate evidence.",
		"- Use the original input/images, one official web search when the provider supports it, high-confidence public knowledge, and the existing service name/website.",
		"- Do not use a hardcoded service table, local fallback, plan, price, region, route, specification, date, duration, promotion, import advice, confirmation reminder, or AI process text.",
	)
	for _, name := range missingNoteNames {
		lines = append(lines, "  - "+name)
	}
	lines = append(lines,
		"",
		"Original recognition prompt:",
		"<<<renewlet-original-prompt",
		originalUserPrompt,
		">>>",
		"",
		"Previous JSON object:",
		"<<<renewlet-previous-json",
		aiRecognitionJSONText(previousObject),
		">>>",
	)
	return strings.Join(lines, "\n")
}

func aiRecognitionOutputLanguageRules(locale appLocale) []string {
	language, ok := aiRecognitionPrompt.OutputLanguages[string(locale)]
	if !ok {
		language = aiRecognitionPrompt.OutputLanguages["en-US"]
	}
	return []string{
		"Output language (authoritative):",
		fmt.Sprintf("- Generated user-facing metadata must use %s.", language.Label),
		"- " + language.NativeInstruction,
	}
}

func formatAIRecognitionTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, tag := range tags {
		value := sanitizeAIPromptContextText(tag)
		key := aiRecognitionConfigMatchKey(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, "- "+value)
		if len(out) >= 50 {
			// 标签上下文只提供偏好提示；过多用户历史标签会稀释订阅证据并放大 prompt 成本。
			break
		}
	}
	if len(out) == 0 {
		return []string{"- (none)"}
	}
	return out
}

func formatAIRecognitionConfigOptions(options []aiRecognitionConfigOption) []string {
	if len(options) == 0 {
		return []string{"- (none)"}
	}
	limit := len(options)
	if limit > 50 {
		limit = 50
	}
	out := make([]string, 0, limit)
	for _, option := range options[:limit] {
		out = append(out, fmt.Sprintf("- value=%s | label=%s | zh-CN=%s | en-US=%s",
			sanitizeAIPromptContextText(option.Value),
			sanitizeAIPromptContextText(option.Label),
			sanitizeAIPromptContextText(option.ZhCN),
			sanitizeAIPromptContextText(option.EnUS),
		))
	}
	return out
}

func sanitizeAIPromptContextText(value string) string {
	// 配置标签和历史标签是用户可写数据；压平成单行，避免换行把不可信文本伪装成新的 prompt 指令。
	var builder strings.Builder
	pendingSpace := false
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			if builder.Len() > 0 {
				pendingSpace = true
			}
			continue
		}
		if pendingSpace {
			builder.WriteByte(' ')
			pendingSpace = false
		}
		builder.WriteRune(r)
	}
	return trimMax(builder.String(), 160)
}

func prefixAIPromptRules(rules []string) []string {
	out := make([]string, 0, len(rules))
	for _, rule := range rules {
		out = append(out, "- "+rule)
	}
	return out
}

func formatAIRecognitionPromptJSON(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err == nil {
		return buf.String()
	}
	return string(raw)
}
