package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAIRecognitionNativeProviderTokenParametersOnWire(t *testing.T) {
	requests := make(chan struct {
		path string
		body map[string]any
	}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode provider request: %v", err)
			return
		}
		requests <- struct {
			path string
			body map[string]any
		}{path: r.URL.Path, body: body}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/messages":
			_, _ = fmt.Fprint(w, `{"id":"msg_test","type":"message","role":"assistant","content":[{"type":"text","text":"OK"}],"model":"claude-sonnet-4-6","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
		case "/v1beta/models/gemini-3-flash:generateContent":
			_, _ = fmt.Fprint(w, `{"candidates":[{"content":{"parts":[{"text":"OK"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}`)
		default:
			t.Errorf("unexpected provider path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	t.Run("anthropic Claude keeps max_tokens", func(t *testing.T) {
		err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
			ProviderType:      aiProviderTypeAnthropic,
			TransportProtocol: aiProtocolAnthropicMessages,
			Model:             "claude-sonnet-4-6",
			BaseURL:           server.URL,
			APIKey:            "sk-ant-test",
		})
		if err != nil {
			t.Fatalf("Anthropic connection test failed: %v", err)
		}
		request := <-requests
		if request.path != "/v1/messages" {
			t.Fatalf("Anthropic request path = %q", request.path)
		}
		if _, ok := request.body["max_tokens"]; !ok {
			t.Fatalf("Anthropic request should contain max_tokens: %#v", request.body)
		}
		if _, ok := request.body["max_completion_tokens"]; ok {
			t.Fatalf("Anthropic request must not contain max_completion_tokens: %#v", request.body)
		}
	})

	t.Run("Gemini keeps native generationConfig", func(t *testing.T) {
		err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
			ProviderType:      aiProviderTypeGemini,
			TransportProtocol: aiProtocolGeminiGenerateContent,
			Model:             "gemini-3-flash",
			BaseURL:           server.URL,
			APIKey:            "AIza-test",
		})
		if err != nil {
			t.Fatalf("Gemini connection test failed: %v", err)
		}
		request := <-requests
		if request.path != "/v1beta/models/gemini-3-flash:generateContent" {
			t.Fatalf("Gemini request path = %q", request.path)
		}
		generationConfig, ok := request.body["generationConfig"].(map[string]any)
		if !ok {
			t.Fatalf("Gemini request missing generationConfig: %#v", request.body)
		}
		if _, ok := generationConfig["maxOutputTokens"]; !ok {
			t.Fatalf("Gemini generationConfig should contain maxOutputTokens: %#v", generationConfig)
		}
		if _, ok := request.body["max_tokens"]; ok {
			t.Fatalf("Gemini request must not contain max_tokens: %#v", request.body)
		}
	})
}

func TestAIRecognitionTokenParameterSelectionOnWire(t *testing.T) {
	requests := make(chan map[string]any, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
			return
		}
		requests <- body
		switch r.URL.Path {
		case "/v1/responses":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"id":"resp-test","model":"gpt-6.1-sol","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}],"usage":{"input_tokens":1,"output_tokens":1}}`)
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"id":"chatcmpl-test","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}`)
		default:
			t.Errorf("unexpected provider path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	tests := []struct {
		name         string
		providerType string
		transport    string
		model        string
		want         string
	}{
		{name: "official GPT-6.1-sol uses Responses", providerType: aiProviderTypeOpenAI, transport: aiProtocolOpenAIResponses, model: "gpt-6.1-sol", want: "max_output_tokens"},
		{name: "OpenAI-compatible keeps Chat", providerType: aiProviderTypeOpenAICompatible, transport: aiProtocolOpenAIChat, model: "gpt-6.1-sol", want: "max_tokens"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := testAIRecognitionConnection(context.Background(), aiRecognitionSettings{
				ProviderType:      tt.providerType,
				TransportProtocol: tt.transport,
				Model:             tt.model,
				BaseURL:           server.URL,
				APIKey:            "sk-test",
			})
			if err != nil {
				t.Fatalf("connection test failed: %v", err)
			}
			body := <-requests
			if _, ok := body[tt.want]; !ok {
				t.Fatalf("request should contain %q: %#v", tt.want, body)
			}
			unexpected := "max_tokens"
			if tt.want == unexpected {
				unexpected = "max_output_tokens"
			}
			if _, ok := body[unexpected]; ok {
				t.Fatalf("request should not contain %q: %#v", unexpected, body)
			}
		})
	}
}
