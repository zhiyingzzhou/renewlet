package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
)

func TestParseCustomHeadScriptAcceptsSingleExternalScript(t *testing.T) {
	raw := `<script defer src="https://cdn.example.com/widget.js" data-widget-id="00000000-0000-4000-8000-000000000000"></script>`

	script, err := parseCustomHeadScript(raw)
	if err != nil {
		t.Fatal(err)
	}
	if script.Markup != raw {
		t.Fatalf("custom script markup changed: %q", script.Markup)
	}
	if script.ScriptOrigin != "https://cdn.example.com" {
		t.Fatalf("ScriptOrigin = %q", script.ScriptOrigin)
	}
	if len(script.ConnectOrigins) != 1 || script.ConnectOrigins[0] != "https://cdn.example.com" {
		t.Fatalf("ConnectOrigins = %#v", script.ConnectOrigins)
	}
}

func TestParseCustomHeadScriptAddsHostURLConnectOrigin(t *testing.T) {
	raw := `<script defer src="https://cdn.example.com/widget.js" data-host-url="https://api.example.com/widget"></script>`

	script, err := parseCustomHeadScript(raw)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(script.ConnectOrigins, ",") != "https://cdn.example.com,https://api.example.com" {
		t.Fatalf("ConnectOrigins = %#v", script.ConnectOrigins)
	}
}

func TestParseCustomHeadScriptRejectsUnsafeMarkup(t *testing.T) {
	cases := []string{
		`<script>alert(1)</script>`,
		`<script src="https://example.com/a.js"></script><script src="https://example.com/b.js"></script>`,
		`<div></div>`,
		`<script defer></script>`,
		`<script src="javascript:alert(1)"></script>`,
		`<script src="https://user:pass@example.com/a.js"></script>`,
		`<script src="https://example.com/a.js" onload="alert(1)"></script>`,
		`<script src="https://example.com/a.js" SRC="https://example.com/b.js"></script>`,
		`<script src="https://example.com/a.js">`,
		`<script src="https://example.com/a.js" />`,
	}

	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if _, err := parseCustomHeadScript(raw); err == nil {
				t.Fatal("expected custom script to be rejected")
			}
		})
	}
}

func TestCustomHeadScriptFSInjectsOnlyIndex(t *testing.T) {
	raw := `<script defer src="https://cdn.example.com/widget.js" data-widget-id="widget-id"></script>`
	t.Setenv(customHeadScriptEnvName, raw)

	fsys := customHeadScriptFS{FS: fstest.MapFS{
		"index.html":            {Data: []byte("<html><head><title>Renewlet</title></head><body></body></html>")},
		"renewlet-theme.js":     {Data: []byte("console.log('theme')")},
		"assets/application.js": {Data: []byte("console.log('app')")},
	}}

	indexFile, err := fsys.Open("index.html")
	if err != nil {
		t.Fatal(err)
	}
	indexHTML, err := io.ReadAll(indexFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(indexHTML), raw+"\n  </head>") {
		t.Fatalf("expected injected script before </head>, got %s", string(indexHTML))
	}

	assetFile, err := fsys.Open("assets/application.js")
	if err != nil {
		t.Fatal(err)
	}
	asset, err := io.ReadAll(assetFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(asset), raw) {
		t.Fatalf("custom script leaked into asset: %s", string(asset))
	}
}

func TestCustomHeadScriptFSLeavesIndexUnchangedWithoutEnv(t *testing.T) {
	t.Setenv(customHeadScriptEnvName, "")

	index := "<html><head><title>Renewlet</title></head><body></body></html>"
	fsys := customHeadScriptFS{FS: fstest.MapFS{
		"index.html": {Data: []byte(index)},
	}}

	indexFile, err := fsys.Open("index.html")
	if err != nil {
		t.Fatal(err)
	}
	indexHTML, err := io.ReadAll(indexFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(indexHTML) != index {
		t.Fatalf("index.html changed without custom script env: %s", string(indexHTML))
	}
}

func TestInjectCustomHeadScriptIsIdempotent(t *testing.T) {
	script, err := parseCustomHeadScript(`<script defer src="https://cdn.example.com/widget.js"></script>`)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("<html><head><title>Renewlet</title></head><body></body></html>")

	once := injectCustomHeadScript(content, script)
	twice := injectCustomHeadScript(once, script)

	if string(twice) != string(once) {
		t.Fatalf("custom script injected twice:\nonce: %s\ntwice: %s", string(once), string(twice))
	}
}

func TestStaticContentSecurityPolicyAllowsCustomHeadScriptOrigin(t *testing.T) {
	t.Setenv(customHeadScriptEnvName, `<script defer src="https://cdn.example.com/widget.js" data-host-url="https://api.example.com/widget"></script>`)

	request, err := http.NewRequest(http.MethodGet, "http://renewlet.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	policy := staticContentSecurityPolicy(request)
	if !strings.Contains(policy, "script-src 'self' 'wasm-unsafe-eval' https://cdn.example.com") {
		t.Fatalf("expected script-src to include custom script origin, got %q", policy)
	}
	if !strings.Contains(policy, "connect-src 'self' https://cdn.jsdelivr.net https://latest.currency-api.pages.dev https://www.floatrates.com https://cdn.example.com https://api.example.com") {
		t.Fatalf("expected connect-src to include custom connect origins, got %q", policy)
	}
}
