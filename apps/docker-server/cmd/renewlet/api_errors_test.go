package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	pbrouter "github.com/pocketbase/pocketbase/tools/router"
)

type interruptedResponseWriter struct {
	*httptest.ResponseRecorder
	cancel  context.CancelFunc
	failure error
}

func TestCanceledReadBeforeResponseIsStillAnAPIError(t *testing.T) {
	requestContext, cancel := context.WithCancel(context.Background())
	cancel()
	writer := httptest.NewRecorder()
	event := &core.RequestEvent{Event: pbrouter.Event{
		Request:  httptest.NewRequest(http.MethodGet, "/api/app/custom-config", nil).WithContext(requestContext),
		Response: &pbrouter.ResponseWriter{ResponseWriter: writer},
	}}
	pipeline := &hook.Hook[*core.RequestEvent]{}
	pipeline.BindFunc(apiErrorMiddleware)
	err := pipeline.Trigger(event, func(*core.RequestEvent) error {
		return &net.OpError{Op: "write", Err: syscall.EPIPE}
	})
	if err != nil || event.Status() != http.StatusBadRequest || event.Get(apis.RequestEventKeyLogMeta) != nil {
		t.Fatalf("failure before response must retain API error semantics: status=%d err=%v", event.Status(), err)
	}
}

func TestReadDeliveryDeadlineRemainsFailure(t *testing.T) {
	requestContext, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	failure := &net.OpError{Op: "write", Err: syscall.EPIPE}
	writer := &interruptedResponseWriter{ResponseRecorder: httptest.NewRecorder(), failure: failure}
	event := &core.RequestEvent{Event: pbrouter.Event{
		Request:  httptest.NewRequest(http.MethodGet, "/api/app/custom-config", nil).WithContext(requestContext),
		Response: &pbrouter.ResponseWriter{ResponseWriter: writer},
	}}
	pipeline := &hook.Hook[*core.RequestEvent]{}
	pipeline.BindFunc(apiErrorMiddleware)
	err := pipeline.Trigger(event, func(event *core.RequestEvent) error {
		return event.JSON(http.StatusOK, map[string]string{"value": "fixture"})
	})
	if !errors.Is(err, failure) || event.Get(apis.RequestEventKeyLogMeta) != nil {
		t.Fatalf("deadline must not be classified as client disconnect: %v", err)
	}
}

func TestReadDeliveryRealConnectionReset(t *testing.T) {
	type deliveryResult struct {
		err        error
		writeError error
		meta       any
	}
	result := make(chan deliveryResult, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		event := &core.RequestEvent{Event: pbrouter.Event{
			Request: request, Response: &pbrouter.ResponseWriter{ResponseWriter: writer},
		}}
		pipeline := &hook.Hook[*core.RequestEvent]{}
		pipeline.BindFunc(apiErrorMiddleware)
		var writeError error
		err := pipeline.Trigger(event, func(event *core.RequestEvent) error {
			event.Response.WriteHeader(http.StatusOK)
			if err := http.NewResponseController(writer).Flush(); err != nil {
				return err
			}
			// 等真实客户端断连后再交付正文，不靠 sleep 猜测内核何时取消上下文。
			select {
			case <-request.Context().Done():
			case <-time.After(5 * time.Second):
				return errors.New("client did not disconnect")
			}
			writeError = event.JSON(http.StatusOK, strings.Repeat("fixture", 100_000))
			return writeError
		})
		result <- deliveryResult{err: err, writeError: writeError, meta: event.Get(apis.RequestEventKeyLogMeta)}
	}))
	defer server.Close()
	connection, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(connection, "GET /api/app/custom-config HTTP/1.1\r\nHost: localhost\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case delivery := <-result:
		meta, ok := delivery.meta.(map[string]string)
		if delivery.writeError == nil || delivery.err != nil || !ok || meta["responseDelivery"] != "client_disconnected" {
			t.Fatalf("unexpected real disconnect result: %+v", delivery)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("response delivery did not settle")
	}
}

func (writer *interruptedResponseWriter) Write(_ []byte) (int, error) {
	if writer.cancel != nil {
		writer.cancel()
	}
	return 0, writer.failure
}

func TestAPIReadResponseDisconnectClassification(t *testing.T) {
	brokenPipe := &net.OpError{Op: "write", Net: "tcp", Err: os.NewSyscallError("write", syscall.EPIPE)}
	resetConnection := &net.OpError{Op: "write", Net: "tcp", Err: os.NewSyscallError("write", syscall.ECONNRESET)}
	for _, scenario := range []struct {
		name         string
		method       string
		status       int
		canceled     bool
		failure      error
		wantCanceled bool
	}{
		{"canceled GET broken pipe", http.MethodGet, http.StatusOK, true, brokenPipe, true},
		{"canceled HEAD reset", http.MethodHead, http.StatusOK, true, resetConnection, true},
		{"live GET write failure", http.MethodGet, http.StatusOK, false, brokenPipe, false},
		{"canceled mutation", http.MethodPut, http.StatusOK, true, brokenPipe, false},
		{"canceled server failure", http.MethodGet, http.StatusInternalServerError, true, brokenPipe, false},
		{"canceled auth failure", http.MethodGet, http.StatusUnauthorized, true, brokenPipe, false},
		{"unrelated write failure", http.MethodGet, http.StatusOK, true, io.ErrShortWrite, false},
		{"upstream read failure", http.MethodGet, http.StatusOK, true, &net.OpError{Op: "read", Err: syscall.ECONNRESET}, false},
		{"uncorroborated syscall", http.MethodGet, http.StatusOK, true, syscall.EPIPE, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			requestContext, cancel := context.WithCancel(context.Background())
			defer cancel()
			writer := &interruptedResponseWriter{ResponseRecorder: httptest.NewRecorder(), failure: scenario.failure}
			if scenario.canceled {
				// net/http 的连接写入失败会先取消 request context，再把写错误交还 handler。
				writer.cancel = cancel
			}
			event := &core.RequestEvent{Event: pbrouter.Event{
				Request:  httptest.NewRequest(scenario.method, "/api/app/custom-config", nil).WithContext(requestContext),
				Response: &pbrouter.ResponseWriter{ResponseWriter: writer},
			}}
			pipeline := &hook.Hook[*core.RequestEvent]{}
			pipeline.BindFunc(apiErrorMiddleware)
			err := pipeline.Trigger(event, func(event *core.RequestEvent) error {
				return event.JSON(scenario.status, map[string]string{"value": "fixture"})
			})
			if scenario.wantCanceled {
				if err != nil {
					t.Fatalf("expected canceled response delivery, got %v", err)
				}
				meta, ok := event.Get(apis.RequestEventKeyLogMeta).(map[string]string)
				if !ok || meta["responseDelivery"] != "client_disconnected" {
					t.Fatalf("missing request audit outcome: %v", meta)
				}
			} else if !errors.Is(err, scenario.failure) {
				t.Fatalf("real failure must propagate, got %v, want %v", err, scenario.failure)
			}
			if !scenario.wantCanceled && event.Get(apis.RequestEventKeyLogMeta) != nil {
				t.Fatal("real failure was marked as a canceled response")
			}
			if event.Status() != scenario.status {
				t.Fatalf("HTTP status changed: %d", event.Status())
			}
		})
	}
}
