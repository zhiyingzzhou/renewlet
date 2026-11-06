package main

// AI provider endpoint 测试保护 base URL 规范化、no-auto-version 逃生阀和 SDK transport 改写。
// 私有网关经常使用非官方路径；这些样例是避免后续“自动补 /v1”把网关拼坏的回归网。
import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResolveAIProviderEndpointNormalizesProtocolURLs(t *testing.T) {
	tests := []struct {
		name               string
		settings           aiRecognitionSettings
		wantRuntimeBaseURL string
		wantModelsURL      string
		wantShape          string
		wantHeader         string
		wantHeaderValue    string
	}{
		{
			name: "openai responses endpoint",
			settings: aiRecognitionSettings{
				ProviderType:      aiProviderTypeOpenAI,
				TransportProtocol: aiProtocolOpenAIChat,
				BaseURL:           "https://api.example.com/openai/v1/chat/completions",
				APIKey:            "sk-test",
			},
			wantRuntimeBaseURL: "https://api.example.com/openai/v1",
			wantModelsURL:      "https://api.example.com/openai/v1/models",
			wantShape:          "openai",
			wantHeader:         "Authorization",
			wantHeaderValue:    "Bearer sk-test",
		},
		{
			name: "anthropic messages endpoint",
			settings: aiRecognitionSettings{
				ProviderType:      aiProviderTypeAnthropic,
				TransportProtocol: aiProtocolAnthropicMessages,
				BaseURL:           "https://claude.example.com/messages",
				APIKey:            "sk-ant-test",
			},
			wantRuntimeBaseURL: "https://claude.example.com/v1",
			wantModelsURL:      "https://claude.example.com/v1/models",
			wantShape:          "anthropic",
			wantHeader:         "x-api-key",
			wantHeaderValue:    "sk-ant-test",
		},
		{
			name: "gemini generate content endpoint",
			settings: aiRecognitionSettings{
				ProviderType:      aiProviderTypeGemini,
				TransportProtocol: aiProtocolGeminiGenerateContent,
				BaseURL:           "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=bad",
				APIKey:            "AIza-test",
			},
			wantRuntimeBaseURL: "https://generativelanguage.googleapis.com/v1beta",
			wantModelsURL:      "https://generativelanguage.googleapis.com/v1beta/models",
			wantShape:          "gemini",
			wantHeader:         "x-goog-api-key",
			wantHeaderValue:    "AIza-test",
		},
		{
			name: "compatible mismatched protocol is canonical openai chat",
			settings: aiRecognitionSettings{
				ProviderType:      aiProviderTypeOpenAICompatible,
				TransportProtocol: aiProtocolGeminiGenerateContent,
				BaseURL:           "https://gateway.example.com/v1/chat/completions",
				APIKey:            "custom-key",
			},
			wantRuntimeBaseURL: "https://gateway.example.com/v1",
			wantModelsURL:      "https://gateway.example.com/v1/models",
			wantShape:          "openai",
			wantHeader:         "Authorization",
			wantHeaderValue:    "Bearer custom-key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			endpoint := resolveAIProviderEndpoint(tt.settings)
			if endpoint.RuntimeBaseURL != tt.wantRuntimeBaseURL || endpoint.ModelsURL != tt.wantModelsURL || endpoint.ModelListShape != tt.wantShape {
				t.Fatalf("endpoint mismatch: %#v", endpoint)
			}
			if got := endpoint.Headers.Get(tt.wantHeader); got != tt.wantHeaderValue {
				t.Fatalf("header %s = %q, want %q", tt.wantHeader, got, tt.wantHeaderValue)
			}
		})
	}
}

func TestResolveAIProviderEndpointNoAutoVersionMarker(t *testing.T) {
	endpoint := resolveAIProviderEndpoint(aiRecognitionSettings{
		ProviderType: aiProviderTypeOpenAICompatible,
		BaseURL:      "https://gateway.example.com/custom/api#",
	})
	if endpoint.RuntimeBaseURL != "https://gateway.example.com/custom/api" || endpoint.ModelsURL != "https://gateway.example.com/custom/api/models" {
		t.Fatalf("marker should preserve custom base path: %#v", endpoint)
	}
	if !endpoint.AutoVersionDisabled {
		t.Fatalf("marker should be exposed to runtime factory: %#v", endpoint)
	}
	if !endpoint.BaseURLRequired || endpoint.APIKeyRequired {
		t.Fatalf("compatible endpoint required flags mismatch: %#v", endpoint)
	}
}

func TestGoAIBaseURLForEndpointMatchesSDKExpectations(t *testing.T) {
	anthropicEndpoint := resolveAIProviderEndpoint(aiRecognitionSettings{
		ProviderType:      aiProviderTypeAnthropic,
		TransportProtocol: aiProtocolAnthropicMessages,
		BaseURL:           "https://gateway.example.com/anthropic/v1/messages",
		APIKey:            "sk-ant-test",
	})
	if got := goAIBaseURLForEndpoint(anthropicEndpoint); got != "https://gateway.example.com/anthropic" {
		t.Fatalf("anthropic GoAI base URL = %q", got)
	}

	geminiEndpoint := resolveAIProviderEndpoint(aiRecognitionSettings{
		ProviderType:      aiProviderTypeGemini,
		TransportProtocol: aiProtocolGeminiGenerateContent,
		BaseURL:           "https://gateway.example.com/gemini/v1beta/models/gemini-2.5-pro:generateContent",
		APIKey:            "AIza-test",
	})
	if got := goAIBaseURLForEndpoint(geminiEndpoint); got != "https://gateway.example.com/gemini" {
		t.Fatalf("gemini GoAI base URL = %q", got)
	}

	customEndpoint := resolveAIProviderEndpoint(aiRecognitionSettings{
		ProviderType:      aiProviderTypeGemini,
		TransportProtocol: aiProtocolGeminiGenerateContent,
		BaseURL:           "https://gateway.example.com/custom/api#",
		APIKey:            "AIza-test",
	})
	if got := goAIBaseURLForEndpoint(customEndpoint); got != "https://gateway.example.com/custom/api" {
		t.Fatalf("custom marker GoAI base URL = %q", got)
	}
}

func TestAIProviderRuntimeHTTPClientRewritesNoAutoVersionPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/custom/api/models/gemini-2.5-pro:generateContent" {
			t.Fatalf("unexpected rewritten path: %s", r.URL.Path)
		}
		if got := r.Header.Get("x-goog-api-key"); got != "AIza-test" {
			t.Fatalf("unexpected Gemini key header: %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	endpoint := resolveAIProviderEndpoint(aiRecognitionSettings{
		ProviderType: aiProviderTypeGemini,
		BaseURL:      server.URL + "/custom/api#",
		APIKey:       "AIza-test",
	})
	client := aiProviderRuntimeHTTPClient(endpoint, "v1beta")
	if client == nil {
		t.Fatal("expected runtime HTTP client for # base URL")
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/custom/api/v1beta/models/gemini-2.5-pro:generateContent", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("x-goog-api-key", "AIza-test")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}
}
