package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"syscall"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	pbrouter "github.com/pocketbase/pocketbase/tools/router"
)

type apiErrorEnvelope struct {
	Error apiErrorBody `json:"error"`
}

type apiErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Details   any    `json:"details,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// apiErrorMiddleware 只挂在 Renewlet 产品 API 上；PocketBase Admin UI 和静态资源继续使用平台原生响应。
func apiErrorMiddleware(e *core.RequestEvent) error {
	err := e.Next()
	if isCanceledReadDelivery(e, err) {
		// 保留原请求审计并标记交付取消；不能把业务错误、写请求或未取消的网络故障归为正常离开。
		e.Set(apis.RequestEventKeyLogMeta, map[string]string{"responseDelivery": "client_disconnected"})
		return nil
	}
	if err == nil || e.Written() {
		return err
	}
	apiErr := pbrouter.ToApiError(err)
	var details any
	if len(apiErr.Data) > 0 {
		details = apiErr.Data
	}
	return apiErrorJSON(e, apiErr.Status, defaultAPIErrorCode(apiErr.Status), apiErr.Message, details)
}

func isCanceledReadDelivery(e *core.RequestEvent, err error) bool {
	if err == nil || (e.Request.Method != http.MethodGet && e.Request.Method != http.MethodHead) {
		return false
	}
	if !e.Written() || e.Status() < http.StatusOK || e.Status() >= http.StatusMultipleChoices {
		return false
	}
	// net/http 写连接失败时先取消请求上下文；仅凭 canceled 或错误文本不能判断响应交付已被客户端中止。
	var networkError *net.OpError
	return errors.Is(e.Request.Context().Err(), context.Canceled) &&
		errors.As(err, &networkError) && networkError.Op == "write" &&
		(errors.Is(networkError, syscall.EPIPE) || errors.Is(networkError, syscall.ECONNRESET))
}

// apiErrorJSON 是 Docker/Go 产品 API 的唯一错误 envelope 出口；route 不应手写 map 或扁平 message/code。
func apiErrorJSON(e *core.RequestEvent, status int, code string, message string, details any) error {
	if code == "" {
		code = defaultAPIErrorCode(status)
	}
	return e.JSON(status, apiErrorEnvelope{
		Error: apiErrorBody{
			Code:    code,
			Message: message,
			Details: details,
		},
	})
}

func defaultAPIErrorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "INVALID_PAYLOAD"
	case http.StatusUnauthorized:
		return "UNAUTHORIZED"
	case http.StatusForbidden:
		return "FORBIDDEN"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusMethodNotAllowed:
		return "METHOD_NOT_ALLOWED"
	case http.StatusConflict:
		return "CONFLICT"
	case http.StatusRequestEntityTooLarge:
		return "BODY_TOO_LARGE"
	case http.StatusUnprocessableEntity:
		return "VALIDATION_ERROR"
	case http.StatusTooManyRequests:
		return "RATE_LIMITED"
	case http.StatusBadGateway:
		return "UPSTREAM_FAILED"
	default:
		return "INTERNAL_ERROR"
	}
}

type apiRouteContract struct {
	Path    string
	Methods []string
}

// API catch-all 只覆盖 Renewlet 产品 API 前缀和公开 feed，不接管 PocketBase Admin UI 或嵌入式静态资源。
func registerAPIFallbacks(api *pbrouter.RouterGroup[*core.RequestEvent], registry *productRouteRegistry) {
	api.Any("/api/app", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/api/app/{path...}", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/api/public", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/api/public/{path...}", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/api/telegram", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/api/telegram/{path...}", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/api/cron", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/api/cron/{path...}", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
	api.Any("/calendar/renewals.ics", func(e *core.RequestEvent) error { return apiFallbackError(registry, e) })
}

func apiFallbackError(registry *productRouteRegistry, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if registry.PathAllowsDifferentMethod(e.Request.URL.Path, e.Request.Method) {
		return apiErrorJSON(e, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", serverText(locale, "common.methodNotAllowed"), nil)
	}
	return apiErrorJSON(e, http.StatusNotFound, "NOT_FOUND", serverText(locale, "common.notFound"), nil)
}

func apiPathMatches(pattern string, path string) bool {
	patternSegments := apiPathSegments(pattern)
	pathSegments := apiPathSegments(path)
	if len(patternSegments) != len(pathSegments) {
		return false
	}
	for i, segment := range patternSegments {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			continue
		}
		if segment != pathSegments[i] {
			return false
		}
	}
	return true
}

func apiPathSegments(path string) []string {
	return strings.Split(strings.Trim(path, "/"), "/")
}
