package main

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	upstreamProviderResponseSchemaBodyMaxChars  = 1 << 20
	upstreamProviderResponseCaptureBodyMaxBytes = 64 * 1024
)

// upstreamProviderResponse 是 Go 侧的统一采集形状；普通错误只透出 rawResponseText，AI SSE
// error 事件额外带有有界的 status/header/body 元数据，因为 SSE 建立后无法再修改 HTTP status。
type upstreamProviderResponse struct {
	Status        *int              `json:"status"`
	StatusText    *string           `json:"statusText"`
	Headers       map[string]string `json:"headers"`
	Body          *string           `json:"body"`
	BodyTruncated bool              `json:"bodyTruncated"`
}

// upstreamErrorDetails 随当前请求一次性返回给操作者；cron history、last_error、缓存和导出都不能保存这个 raw body。
type upstreamErrorDetails struct {
	RawResponseText *string `json:"rawResponseText,omitempty"`
}

// upstreamOperationError 让 AI、GitHub、图标和通知等不同调用点共享同一错误传播通道，同时保留普通 error message。
type upstreamOperationError struct {
	message  string
	details  *upstreamErrorDetails
	timedOut bool
}

var upstreamSignedQueryValueRe = regexp.MustCompile(`(?i)([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|AWSAccessKeyId|Signature|sign|Expires|access_key|accessKey|api_key|apikey|token|sendkey|sendKey|key)=)[^&\s"'<>]+`)

func (err *upstreamOperationError) Error() string {
	if err == nil {
		return ""
	}
	return err.message
}

func newUpstreamOperationError(message string, details *upstreamErrorDetails) error {
	return &upstreamOperationError{message: message, details: details}
}

func newUpstreamTransportError(message string, timedOut bool) error {
	return &upstreamOperationError{message: message, details: createUpstreamErrorDetails(nil, message), timedOut: timedOut}
}

func upstreamErrorDetailsFromError(err error) *upstreamErrorDetails {
	var upstreamErr *upstreamOperationError
	if errors.As(err, &upstreamErr) {
		return upstreamErr.details
	}
	return nil
}

func upstreamRawResponseTextFromError(err error) string {
	details := upstreamErrorDetailsFromError(err)
	if details == nil || details.RawResponseText == nil {
		return ""
	}
	return *details.RawResponseText
}

func upstreamOperationTimedOut(err error) bool {
	var upstreamErr *upstreamOperationError
	return errors.As(err, &upstreamErr) && upstreamErr.timedOut
}

func persistentUpstreamErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	var upstreamErr *upstreamOperationError
	if errors.As(err, &upstreamErr) && upstreamErr.details != nil && upstreamErr.details.RawResponseText != nil {
		// 持久化状态只保存摘要；raw body 可能含 HTML、第三方 secret 或用户内容，只能随当前请求回显。
		raw := strings.TrimSpace(*upstreamErr.details.RawResponseText)
		if raw != "" {
			message = strings.ReplaceAll(message, raw, "")
			message = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(message), ":"))
		}
	}
	return message
}

func captureUpstreamProviderResponse(resp *http.Response, secrets []string) (*upstreamProviderResponse, string, error) {
	if resp == nil {
		return nil, "", nil
	}
	// 外部错误页可能是 HTML 或超大 JSON；Go 路由也必须有界读取，和 Worker 64KiB 默认采集保持同一安全口径。
	body, truncated, err := readUpstreamResponseBody(resp.Body, upstreamProviderResponseCaptureBodyMaxBytes)
	if resp.Body != nil {
		_ = resp.Body.Close()
	}
	raw := string(body)
	return upstreamProviderResponseFromBody(resp, raw, truncated, secrets), raw, err
}

func upstreamProviderResponseFromBody(resp *http.Response, body string, bodyTruncated bool, secrets []string) *upstreamProviderResponse {
	if resp == nil {
		return nil
	}
	status := resp.StatusCode
	return &upstreamProviderResponse{
		Status:        &status,
		StatusText:    upstreamHTTPStatusText(resp),
		Headers:       upstreamHeadersToObject(resp.Header, secrets),
		Body:          optionalUpstreamBody(redactUpstreamSecrets(body, secrets)),
		BodyTruncated: bodyTruncated,
	}
}

func createUpstreamErrorDetails(providerResponse *upstreamProviderResponse, fallbackText string) *upstreamErrorDetails {
	rawResponseText := fallbackText
	if providerResponse != nil && providerResponse.Body != nil && strings.TrimSpace(*providerResponse.Body) != "" {
		rawResponseText = *providerResponse.Body
	}
	if strings.TrimSpace(rawResponseText) == "" {
		return nil
	}
	// 前端详情弹窗只消费 rawResponseText；错误 code/message 仍由标准 API envelope 负责。
	return &upstreamErrorDetails{RawResponseText: optionalUpstreamBody(rawResponseText)}
}

func createUpstreamHTTPError(provider string, resp *http.Response, providerResponse *upstreamProviderResponse, providerMessage string) error {
	statusCode := 0
	if providerResponse != nil && providerResponse.Status != nil {
		statusCode = *providerResponse.Status
	} else if resp != nil {
		statusCode = resp.StatusCode
	}
	if strings.TrimSpace(providerMessage) == "" {
		providerMessage = upstreamProviderMessage(providerResponse)
	}
	message := strings.TrimSpace(provider + " HTTP " + strconv.Itoa(statusCode))
	if strings.TrimSpace(providerMessage) != "" {
		message += ": " + providerMessage
	}
	return newUpstreamOperationError(message, createUpstreamErrorDetails(providerResponse, providerMessage))
}

func upstreamProviderMessage(response *upstreamProviderResponse) string {
	if response == nil {
		return ""
	}
	if response.Body != nil && strings.TrimSpace(*response.Body) != "" {
		return *response.Body
	}
	if response.StatusText != nil {
		return *response.StatusText
	}
	return ""
}

func readUpstreamResponseBody(body io.Reader, limitBytes int64) ([]byte, bool, error) {
	if body == nil {
		return nil, false, nil
	}
	limited := io.LimitReader(body, limitBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, false, err
	}
	if int64(len(data)) <= limitBytes {
		return data, false, nil
	}
	return data[:limitBytes], true, nil
}

func upstreamHeadersToObject(headers http.Header, secrets []string) map[string]string {
	if len(headers) == 0 {
		return nil
	}
	out := make(map[string]string, len(headers))
	for key, values := range headers {
		name := strings.TrimSpace(key)
		// Set-Cookie/Authorization/签名类 header 一律不回显；其它 header 也要按请求侧 secret 再脱敏。
		if !safeUpstreamHeaderName(name) {
			continue
		}
		value := redactUpstreamSecrets(strings.TrimSpace(strings.Join(values, ", ")), secrets)
		if value == "" {
			continue
		}
		out[name] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func upstreamHeaderMapToObject(headers map[string]string, secrets []string) map[string]string {
	if len(headers) == 0 {
		return nil
	}
	out := make(map[string]string, len(headers))
	for key, value := range headers {
		name := strings.TrimSpace(key)
		if !safeUpstreamHeaderName(name) {
			continue
		}
		text := redactUpstreamSecrets(strings.TrimSpace(value), secrets)
		if text == "" {
			continue
		}
		out[name] = text
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func safeUpstreamHeaderName(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	if normalized == "" {
		return false
	}
	if normalized == "authorization" || normalized == "proxy-authorization" || normalized == "cookie" || normalized == "set-cookie" || normalized == "content-length" || normalized == "content-encoding" || normalized == "transfer-encoding" || normalized == "connection" || normalized == "keep-alive" || normalized == "trailer" || normalized == "upgrade" {
		return false
	}
	for _, marker := range []string{"secret", "token", "signature", "credential", "accesskey", "access-key", "api-key", "apikey", "auth-key", "authkey"} {
		if strings.Contains(normalized, marker) {
			return false
		}
	}
	return true
}

func redactUpstreamSecrets(value string, secrets []string) string {
	out := value
	for _, secret := range normalizedUpstreamSecrets(secrets) {
		// 同时处理原文、query escape 和 path escape，覆盖 SendKey、API key、S3 签名和 WebDAV 密码出现在不同上下文的情况。
		out = strings.ReplaceAll(out, secret, "[redacted]")
		out = strings.ReplaceAll(out, url.QueryEscape(secret), "[redacted]")
		out = strings.ReplaceAll(out, url.PathEscape(secret), "[redacted]")
	}
	return upstreamSignedQueryValueRe.ReplaceAllString(out, `${1}[redacted]`)
}

func normalizedUpstreamSecrets(secrets []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, secret := range secrets {
		trimmed := strings.TrimSpace(secret)
		if len(trimmed) < 4 {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func upstreamHTTPStatusText(resp *http.Response) *string {
	if resp == nil {
		return nil
	}
	text := strings.TrimSpace(resp.Status)
	prefix := strings.TrimSpace(resp.Status[:min(len(resp.Status), 3)])
	if prefix == strconv.Itoa(resp.StatusCode) {
		if len(resp.Status) > 3 {
			text = strings.TrimSpace(resp.Status[3:])
		} else {
			text = ""
		}
	}
	if text == "" {
		text = http.StatusText(resp.StatusCode)
	}
	return optionalUpstreamString(text)
}

func optionalUpstreamBody(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if len(value) > upstreamProviderResponseSchemaBodyMaxChars {
		value = value[:upstreamProviderResponseSchemaBodyMaxChars]
	}
	return &value
}

func optionalUpstreamString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
