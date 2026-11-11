package main

// ai_provider_endpoint.go 收敛 AI provider 的 base URL、鉴权头和模型列表端点。
//
// 前端、Go SDK client、Cloudflare Worker 共享同一 provider 语义；这里不能让用户传入的历史 protocol 字段
// 改变 canonical transport，否则 Docker 与 Worker 会请求不同第三方接口。
import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const (
	aiProviderTypeOpenAI            = "openai"
	aiProviderTypeAnthropic         = "anthropic"
	aiProviderTypeGemini            = "gemini"
	aiProviderTypeOpenAICompatible  = "openai-compatible"
	aiProtocolOpenAIResponses       = "openai-responses"
	aiProtocolOpenAIChat            = "openai-chat"
	aiProtocolAnthropicMessages     = "anthropic-messages"
	aiProtocolGeminiGenerateContent = "gemini-generate-content"
)

var aiProviderVersionSegmentPattern = regexp.MustCompile(`(?i)(^|/)v\d+(alpha|beta)?(/|$)`)
var aiProviderTrailingVersionSegmentPattern = regexp.MustCompile(`(?i)/v\d+(alpha|beta)?$`)

type aiProviderEndpoint struct {
	ProviderType        string
	TransportProtocol   string
	RuntimeBaseURL      string
	ModelsURL           string
	ModelListShape      string
	Headers             http.Header
	BaseURLRequired     bool
	APIKeyRequired      bool
	AutoVersionDisabled bool
}

func canonicalAIRecognitionTransportProtocol(providerType string) string {
	switch providerType {
	case aiProviderTypeAnthropic:
		return aiProtocolAnthropicMessages
	case aiProviderTypeGemini:
		return aiProtocolGeminiGenerateContent
	case aiProviderTypeOpenAICompatible:
		return aiProtocolOpenAIChat
	case aiProviderTypeOpenAI:
		return aiProtocolOpenAIResponses
	default:
		return aiProtocolOpenAIResponses
	}
}

func resolveAIProviderEndpoint(settings aiRecognitionSettings) aiProviderEndpoint {
	settings = sanitizeAIRecognitionSettings(settings)
	baseURL := strings.TrimSpace(settings.BaseURL)
	defaultBaseURL := defaultAIProviderBaseURL(settings.ProviderType)
	runtimeBaseURL := normalizeAIProviderBaseURL(settings.TransportProtocol, firstNonBlank(baseURL, defaultBaseURL))
	return aiProviderEndpoint{
		ProviderType:        settings.ProviderType,
		TransportProtocol:   settings.TransportProtocol,
		RuntimeBaseURL:      runtimeBaseURL,
		ModelsURL:           appendAIProviderPath(runtimeBaseURL, "/models"),
		ModelListShape:      aiModelListShapeForProtocol(settings.TransportProtocol),
		Headers:             aiProviderAuthHeaders(settings.TransportProtocol, strings.TrimSpace(settings.APIKey)),
		BaseURLRequired:     defaultBaseURL == "",
		APIKeyRequired:      settings.ProviderType != aiProviderTypeOpenAICompatible,
		AutoVersionDisabled: strings.HasSuffix(baseURL, "#"),
	}
}

func defaultAIProviderBaseURL(providerType string) string {
	if providerType == aiProviderTypeOpenAI {
		return "https://api.openai.com/v1"
	}
	if providerType == aiProviderTypeAnthropic {
		return "https://api.anthropic.com/v1"
	}
	if providerType == aiProviderTypeGemini {
		return "https://generativelanguage.googleapis.com/v1beta"
	}
	return ""
}

func aiModelListShapeForProtocol(transportProtocol string) string {
	switch transportProtocol {
	case aiProtocolAnthropicMessages:
		return "anthropic"
	case aiProtocolGeminiGenerateContent:
		return "gemini"
	default:
		return "openai"
	}
}

func aiProviderAuthHeaders(transportProtocol string, apiKey string) http.Header {
	headers := http.Header{}
	// 鉴权头由 canonical 协议决定；OpenAI-compatible 在 Renewlet 内固定走 OpenAI Chat，不再混发其它平台 header。
	switch transportProtocol {
	case aiProtocolAnthropicMessages:
		if apiKey != "" {
			headers.Set("x-api-key", apiKey)
		}
		headers.Set("anthropic-version", "2023-06-01")
	case aiProtocolGeminiGenerateContent:
		if apiKey != "" {
			headers.Set("x-goog-api-key", apiKey)
		}
	default:
		if apiKey != "" {
			headers.Set("Authorization", "Bearer "+apiKey)
		}
	}
	return headers
}

func normalizeAIProviderBaseURL(transportProtocol string, baseURL string) string {
	// base URL 规范化必须按 canonical transport 分派；OpenAI-compatible 固定复用 OpenAI Chat 路径规则。
	switch transportProtocol {
	case aiProtocolAnthropicMessages:
		return normalizeVersionedAIProviderBaseURL(baseURL, "v1", []string{"/messages", "/models"})
	case aiProtocolGeminiGenerateContent:
		return normalizeGeminiAIProviderBaseURL(baseURL, "v1beta")
	default:
		return normalizeVersionedAIProviderBaseURL(baseURL, "v1", []string{"/chat/completions", "/responses", "/models", "/embeddings", "/images/generations", "/images/edits"})
	}
}

func normalizeVersionedAIProviderBaseURL(baseURL string, version string, endpointSuffixes []string) string {
	raw := strings.TrimSpace(baseURL)
	if raw == "" {
		return ""
	}
	noAutoVersion := strings.HasSuffix(raw, "#")
	// 末尾 # 是设置页的显式逃生阀：保留用户自定义路径，但只移除具体 endpoint 后缀。
	if noAutoVersion {
		raw = strings.TrimSuffix(raw, "#")
	}
	stripped := stripAIProviderEndpointSuffix(raw, endpointSuffixes)
	return formatAIProviderVersionedBaseURL(stripped, version, !noAutoVersion)
}

func normalizeGeminiAIProviderBaseURL(baseURL string, version string) string {
	raw := strings.TrimSpace(baseURL)
	if raw == "" {
		return ""
	}
	noAutoVersion := strings.HasSuffix(raw, "#")
	// Gemini 网关常用自定义根路径；# 禁用自动补 /v1beta，避免把私有路由拼坏。
	if noAutoVersion {
		raw = strings.TrimSuffix(raw, "#")
	}
	stripped := stripGeminiModelsPath(raw)
	if noAutoVersion {
		return trimAIProviderSlash(stripped)
	}
	withoutVersion := aiProviderTrailingVersionSegmentPattern.ReplaceAllString(trimAIProviderSlash(stripped), "")
	return formatAIProviderVersionedBaseURL(withoutVersion, version, true)
}

func formatAIProviderVersionedBaseURL(baseURL string, version string, autoVersion bool) string {
	baseURL = trimAIProviderSlash(strings.TrimSpace(baseURL))
	if baseURL == "" {
		return ""
	}
	if !autoVersion || aiProviderVersionSegmentPattern.MatchString(aiProviderPathname(baseURL)) {
		return baseURL
	}
	return baseURL + "/" + version
}

func stripAIProviderEndpointSuffix(baseURL string, endpointSuffixes []string) string {
	input := trimAIProviderSlash(strings.TrimSpace(baseURL))
	if input == "" {
		return ""
	}
	if parsed, err := url.Parse(input); err == nil && parsed.Scheme != "" {
		path := trimAIProviderSlash(parsed.Path)
		lowerPath := strings.ToLower(path)
		for _, suffix := range endpointSuffixes {
			if strings.HasSuffix(lowerPath, suffix) {
				nextPath := path[:len(path)-len(suffix)]
				if nextPath == "" {
					nextPath = "/"
				}
				parsed.Path = nextPath
				parsed.RawQuery = ""
				parsed.Fragment = ""
				return trimAIProviderSlash(parsed.String())
			}
		}
		parsed.Path = firstNonBlank(path, "/")
		parsed.RawQuery = ""
		parsed.Fragment = ""
		return trimAIProviderSlash(parsed.String())
	}
	lower := strings.ToLower(input)
	for _, suffix := range endpointSuffixes {
		if strings.HasSuffix(lower, suffix) {
			return input[:len(input)-len(suffix)]
		}
	}
	return input
}

func stripGeminiModelsPath(baseURL string) string {
	input := trimAIProviderSlash(strings.TrimSpace(baseURL))
	if input == "" {
		return ""
	}
	if parsed, err := url.Parse(input); err == nil && parsed.Scheme != "" {
		path := trimAIProviderSlash(parsed.Path)
		index := strings.Index(strings.ToLower(path), "/models")
		if index >= 0 {
			path = path[:index]
		}
		parsed.Path = firstNonBlank(path, "/")
		parsed.RawQuery = ""
		parsed.Fragment = ""
		return trimAIProviderSlash(parsed.String())
	}
	index := strings.Index(strings.ToLower(input), "/models")
	if index >= 0 {
		return input[:index]
	}
	return input
}

func appendAIProviderPath(baseURL string, path string) string {
	if parsed, err := url.Parse(baseURL); err == nil && parsed.Scheme != "" {
		parsed.Path = trimAIProviderSlash(parsed.Path) + path
		parsed.RawQuery = ""
		parsed.Fragment = ""
		return parsed.String()
	}
	return trimAIProviderSlash(baseURL) + path
}

func aiProviderPathname(value string) string {
	if parsed, err := url.Parse(value); err == nil && parsed.Scheme != "" {
		return parsed.Path
	}
	return value
}

func trimAIProviderSlash(value string) string {
	return strings.TrimRight(value, "/")
}
