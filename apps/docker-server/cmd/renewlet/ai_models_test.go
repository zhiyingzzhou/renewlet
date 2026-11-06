package main

// AI 模型列表测试保护 Go 代理对 OpenAI/Gemini/Anthropic 三类响应的归一化、超时和原始错误回显契约。
// 这些断言要和 Cloudflare Worker 的模型列表测试保持语义一致，避免两端设置页候选行为漂移。
import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func withAIModelListTestServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	previousClient := aiModelListHTTPClient
	aiModelListHTTPClient = server.Client()
	t.Cleanup(func() {
		aiModelListHTTPClient = previousClient
		server.Close()
	})
	return server
}

func TestAIModelListOpenAIShape(t *testing.T) {
	server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test-secret" {
			t.Fatalf("unexpected authorization header: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-5.1","created":1780000000,"owned_by":"openai"},{"id":"gpt-5.1"}]}`))
	})

	response, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeOpenAI,
		BaseURL:        server.URL + "/v1",
		ResolvedAPIKey: "sk-test-secret",
	}, localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Models) != 1 || response.Models[0].ID != "gpt-5.1" {
		t.Fatalf("unexpected models: %#v", response.Models)
	}
	if response.ProviderType != aiProviderTypeOpenAI || response.TransportProtocol != aiProtocolOpenAIResponses {
		t.Fatalf("provider/protocol not preserved: %#v", response)
	}
	if response.Models[0].OwnedBy == nil || *response.Models[0].OwnedBy != "openai" {
		t.Fatalf("owner not parsed: %#v", response.Models[0])
	}
}

func TestAIModelListGeminiShape(t *testing.T) {
	server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-goog-api-key"); got != "AIza-test-secret" {
			t.Fatalf("unexpected Gemini key header: %q", got)
		}
		_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-2.5-pro","baseModelId":"gemini-2.5-pro","displayName":"Gemini 2.5 Pro","inputTokenLimit":1048576,"outputTokenLimit":65536,"supportedGenerationMethods":["generateContent"],"thinking":true},{"name":"models/text-embedding","supportedGenerationMethods":["embedContent"]}]}`))
	})

	response, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeGemini,
		BaseURL:        server.URL + "/v1beta",
		ResolvedAPIKey: "AIza-test-secret",
	}, localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Models) != 1 || response.Models[0].ID != "gemini-2.5-pro" {
		t.Fatalf("unexpected Gemini models: %#v", response.Models)
	}
	if response.Models[0].Capabilities.Thinking == nil || !*response.Models[0].Capabilities.Thinking {
		t.Fatalf("thinking capability not parsed: %#v", response.Models[0].Capabilities)
	}
}

func TestAIModelListAnthropicShape(t *testing.T) {
	server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("x-api-key"); got != "sk-ant-test-secret" {
			t.Fatalf("unexpected Anthropic key header: %q", got)
		}
		if got := r.Header.Get("anthropic-version"); got != "2023-06-01" {
			t.Fatalf("unexpected Anthropic version header: %q", got)
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-sonnet-4-6","display_name":"Claude Sonnet 4.6","created_at":"2026-01-01T00:00:00Z","type":"model"}]}`))
	})

	response, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeAnthropic,
		BaseURL:        server.URL + "/v1",
		ResolvedAPIKey: "sk-ant-test-secret",
	}, localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Models) != 1 || response.Models[0].ID != "claude-sonnet-4-6" {
		t.Fatalf("unexpected Anthropic models: %#v", response.Models)
	}
	if response.Models[0].DisplayName == nil || *response.Models[0].DisplayName != "Claude Sonnet 4.6" {
		t.Fatalf("display name not parsed: %#v", response.Models[0])
	}
}

func TestAIModelListCompatibleWithoutAPIKey(t *testing.T) {
	server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" {
			t.Fatalf("compatible request should not send empty auth header")
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"custom-model"}]}`))
	})

	response, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeOpenAICompatible,
		BaseURL:        server.URL + "/v1/",
		ResolvedAPIKey: "",
	}, localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Models) != 1 || response.Models[0].ID != "custom-model" {
		t.Fatalf("unexpected compatible models: %#v", response.Models)
	}
}

func TestAIModelListProviderErrorReturnsRawProviderResponse(t *testing.T) {
	server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`invalid sk-test-secret`))
	})

	_, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeOpenAI,
		BaseURL:        server.URL + "/v1",
		ResolvedAPIKey: "sk-test-secret",
	}, localeZhCN)
	var httpErr *aiModelListHTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("expected aiModelListHTTPError, got %#v", err)
	}
	if httpErr.status != http.StatusUnauthorized || httpErr.reason != "http_401" {
		t.Fatalf("provider 401 should pass through with reason http_401, got status=%d reason=%q", httpErr.status, httpErr.reason)
	}
	if httpErr.message == nil || *httpErr.message != "invalid [redacted]" {
		t.Fatalf("provider message should keep redacted raw body: %#v", httpErr.message)
	}
	if httpErr.providerResponse == nil || httpErr.providerResponse.Body == nil || *httpErr.providerResponse.Body != "invalid [redacted]" {
		t.Fatalf("provider response body should keep redacted raw body: %#v", httpErr.providerResponse)
	}
	if httpErr.providerResponse.Status == nil || *httpErr.providerResponse.Status != http.StatusUnauthorized {
		t.Fatalf("provider status not captured: %#v", httpErr.providerResponse)
	}
	if httpErr.providerResponse.StatusText == nil || *httpErr.providerResponse.StatusText != "Unauthorized" {
		t.Fatalf("provider status text not captured: %#v", httpErr.providerResponse)
	}
	if got := httpErr.providerResponse.Headers["Content-Type"]; !strings.Contains(got, "text/plain") {
		t.Fatalf("provider response headers not captured: %#v", httpErr.providerResponse.Headers)
	}
}

func TestAIModelListProviderStatusPassthrough(t *testing.T) {
	cases := []struct {
		name           string
		providerStatus int
		wantReason     string
		wantStatus     int
	}{
		{name: "forbidden provider credentials", providerStatus: http.StatusForbidden, wantReason: "http_403", wantStatus: http.StatusForbidden},
		{name: "missing provider endpoint", providerStatus: http.StatusNotFound, wantReason: "http_404", wantStatus: http.StatusNotFound},
		{name: "provider validation error", providerStatus: http.StatusUnprocessableEntity, wantReason: "http_422", wantStatus: http.StatusUnprocessableEntity},
		{name: "provider rate limit", providerStatus: http.StatusTooManyRequests, wantReason: "http_429", wantStatus: http.StatusTooManyRequests},
		{name: "provider server error", providerStatus: http.StatusServiceUnavailable, wantReason: "http_503", wantStatus: http.StatusServiceUnavailable},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.providerStatus)
				_, _ = w.Write([]byte(`provider failed`))
			})

			_, err := listAIModels(context.Background(), aiModelListRequest{
				ProviderType:   aiProviderTypeOpenAI,
				BaseURL:        server.URL + "/v1",
				ResolvedAPIKey: "sk-test-secret",
			}, localeZhCN)
			var httpErr *aiModelListHTTPError
			if !errors.As(err, &httpErr) {
				t.Fatalf("expected aiModelListHTTPError, got %#v", err)
			}
			if httpErr.status != tc.wantStatus || httpErr.reason != tc.wantReason {
				t.Fatalf("unexpected mapped error: status=%d reason=%q", httpErr.status, httpErr.reason)
			}
			if httpErr.providerResponse == nil || httpErr.providerResponse.Body == nil || *httpErr.providerResponse.Body != "provider failed" {
				t.Fatalf("provider response body not captured: %#v", httpErr.providerResponse)
			}
		})
	}
}

func TestAIModelListInvalidJSONReturnsBadRequest(t *testing.T) {
	server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not-json`))
	})

	_, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeOpenAI,
		BaseURL:        server.URL + "/v1",
		ResolvedAPIKey: "sk-test-secret",
	}, localeZhCN)
	var httpErr *aiModelListHTTPError
	if !errors.As(err, &httpErr) || httpErr.status != http.StatusBadRequest || httpErr.code != "AI_MODEL_LIST_INVALID_JSON" {
		t.Fatalf("expected invalid JSON to map to 400, got %#v", err)
	}
	if httpErr.providerResponse == nil || httpErr.providerResponse.Body == nil || *httpErr.providerResponse.Body != "not-json" {
		t.Fatalf("invalid JSON should include raw provider body: %#v", httpErr.providerResponse)
	}
}

func TestAIModelListLargeProviderResponseReturnsPayloadTooLarge(t *testing.T) {
	server := withAIModelListTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", aiModelListResponseBytes+1)))
	})

	_, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeOpenAI,
		BaseURL:        server.URL + "/v1",
		ResolvedAPIKey: "sk-test-secret",
	}, localeZhCN)
	var httpErr *aiModelListHTTPError
	if !errors.As(err, &httpErr) || httpErr.status != http.StatusRequestEntityTooLarge || httpErr.code != "AI_MODEL_LIST_RESPONSE_TOO_LARGE" {
		t.Fatalf("expected large provider response to return 413, got %#v", err)
	}
	if httpErr.providerResponse != nil {
		t.Fatalf("oversized response must not return partial provider body: %#v", httpErr.providerResponse)
	}
}

func TestAIModelListTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
	}))
	previousClient := aiModelListHTTPClient
	aiModelListHTTPClient = &http.Client{Timeout: time.Millisecond}
	t.Cleanup(func() {
		aiModelListHTTPClient = previousClient
		server.Close()
	})

	_, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeOpenAI,
		BaseURL:        server.URL + "/v1",
		ResolvedAPIKey: "sk-test-secret",
	}, localeZhCN)
	var httpErr *aiModelListHTTPError
	if !errors.As(err, &httpErr) || httpErr.status != http.StatusRequestTimeout || httpErr.code != "AI_MODEL_LIST_TIMEOUT" {
		t.Fatalf("expected timeout error, got %#v", err)
	}
	if httpErr.message == nil || !strings.Contains(*httpErr.message, "openai models GET request to "+server.URL+"/v1/models timed out after 1ms before response headers") {
		t.Fatalf("expected timeout diagnostic with target, got %#v", httpErr.message)
	}
	if strings.Contains(optionalStringValue(httpErr.message), "sk-test-secret") {
		t.Fatalf("timeout diagnostic leaked API key: %q", optionalStringValue(httpErr.message))
	}
}

func TestAIModelListTransportErrorUsesFullRedactedRequestContext(t *testing.T) {
	previousClient := aiModelListHTTPClient
	aiModelListHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, errors.New("Network connection lost for " + request.URL.String() + " with sk-test-secret")
	})}
	t.Cleanup(func() {
		aiModelListHTTPClient = previousClient
	})

	_, err := listAIModels(context.Background(), aiModelListRequest{
		ProviderType:   aiProviderTypeOpenAI,
		ResolvedAPIKey: "sk-test-secret",
	}, localeZhCN)
	var httpErr *aiModelListHTTPError
	if !errors.As(err, &httpErr) || httpErr.status != http.StatusBadRequest || httpErr.code != "AI_MODEL_LIST_FAILED" {
		t.Fatalf("expected transport failure, got %#v", err)
	}
	message := optionalStringValue(httpErr.message)
	for _, want := range []string{
		"openai models GET request to https://api.openai.com/v1/models failed before response headers",
		"Network connection lost for https://api.openai.com/v1/models with [redacted]",
		`"authorization":"[redacted]"`,
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("expected transport diagnostic to contain %q, got %q", want, message)
		}
	}
	if strings.Contains(message, "sk-test-secret") {
		t.Fatalf("transport diagnostic leaked API key: %q", message)
	}
}
