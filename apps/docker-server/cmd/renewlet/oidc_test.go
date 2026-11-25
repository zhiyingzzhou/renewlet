package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/pocketbase/pocketbase/core"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOIDCSignedCodeExchange(t *testing.T) {
	const issuer = "https://1.1.1.1/application/o/fixture/"
	config := oidcConfig{Issuer: issuer, ClientID: "client", Secret: "fixture-secret", Callback: "https://renewlet.example" + oidcCallbackPath}
	f := oidcFlow{Config: config, State: "fixture-state", Verifier: strings.Repeat("a", 43), Nonce: "fixture-nonce"}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	claims, err := json.Marshal(map[string]any{"iss": issuer, "aud": config.ClientID, "sub": "external-user", "nonce": f.Nonce, "iat": now, "exp": now + 60})
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signer.Sign(claims)
	if err != nil {
		t.Fatal(err)
	}
	jwt, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	old := oidcClient
	oidcClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		response := httptest.NewRecorder()
		response.Header().Set("Content-Type", "application/json")
		var body any
		switch r.URL.String() {
		case issuer + ".well-known/openid-configuration":
			body = map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "authorize", "token_endpoint": issuer + "token", "jwks_uri": issuer + "keys"}
		case issuer + "keys":
			body = jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, Algorithm: "RS256", Use: "sig"}}}
		case issuer + "token":
			if r.FormValue("code_verifier") != f.Verifier || r.FormValue("redirect_uri") != config.Callback {
				t.Error("token exchange lost PKCE or callback")
			}
			body = map[string]string{"access_token": "fixture", "token_type": "Bearer", "id_token": jwt}
		default:
			t.Errorf("unexpected endpoint %v", r.URL)
		}
		if err := json.NewEncoder(response).Encode(body); err != nil {
			return nil, err
		}
		return response.Result(), nil
	})}
	t.Cleanup(func() {
		oidcClient = old
		oidcDiscovery.Lock()
		oidcDiscovery.provider = nil
		oidcDiscovery.until = time.Time{}
		oidcDiscovery.Unlock()
	})
	target, err := oidcAuthorization(t.Context(), f)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	challenge := sha256.Sum256([]byte(f.Verifier))
	if u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) {
		t.Fatal("invalid authorization request")
	}
	if sub, err := oidcSubject(t.Context(), f, "code", issuer); err != nil || sub != "external-user" {
		t.Fatal(sub, err)
	}
	f.Nonce = "changed"
	if _, err := oidcSubject(t.Context(), f, "code", issuer); err == nil {
		t.Fatal("accepted a mismatched nonce")
	}
	f.Nonce = "fixture-nonce"
	parts := strings.Split(jwt, ".")
	parts[2] = base64.RawURLEncoding.EncodeToString(make([]byte, 256))
	jwt = strings.Join(parts, ".")
	if _, err := oidcSubject(t.Context(), f, "code", issuer); err == nil {
		t.Fatal("accepted a mismatched signature")
	}
}

func TestOIDCLinkAndLoginUseExistingAccountAndRequireLocalMFA(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, admin := createRouteTestUser(t, app, "admin")
	config := oidcConfig{Issuer: "https://issuer.example/application/o/test/", ClientID: "renewlet", Secret: "fixture-client-secret", Callback: "https://example.com" + oidcCallbackPath}
	req := func(path, token, flow string) *httptest.ResponseRecorder {
		return serveTestRequestWithHeaders(t, app, http.MethodPost, path, "{}", token, map[string]string{"cookie": oidcCookie + "=" + flow})
	}
	request := httptest.NewRequest("GET", "/", nil)
	applyRouteTestAuth(request, admin)
	session := tokenHash(sessionTokenFromRequest(request))
	verified := func(purpose, session, sub string) string {
		t.Helper()
		site, err := readOIDCSite(app)
		if err != nil {
			t.Fatal(err)
		}
		token, err := storeOIDCFlow(app, oidcFlow{Purpose: purpose, Session: session, Subject: sub, Revision: site.Revision, Config: config})
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	cancelFlow, err := storeOIDCFlow(app, oidcFlow{Purpose: "test", Session: session, State: "fixture-state", Config: config})
	if err != nil {
		t.Fatal(err)
	}
	target := config.Callback + "?state=fixture-state&error=access_denied"
	cancelled := serveTestRequestWithHeaders(t, app, http.MethodGet, target, "", admin, map[string]string{"cookie": oidcCookie + "=" + cancelFlow})
	if cancelled.Code != 303 || cancelled.Header().Get("Location") != "/settings?oidc=cancelled#settings-access-security" || cancelled.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal(cancelled.Code, cancelled.Header().Get("Location"))
	}
	replayed := serveTestRequestWithHeaders(t, app, http.MethodGet, target, "", admin, map[string]string{"cookie": oidcCookie + "=" + cancelFlow})
	if replayed.Header().Get("Location") != "/login?oidc=error" {
		t.Fatal("callback replayed")
	}
	test := verified("test", session, "admin-sub")
	if got := req("/api/app/admin/auth-security/oidc/enable", admin, test); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	site, err := authSecurityRecord(app)
	if err != nil || !site.GetBool("oidcEnabled") || strings.Contains(site.GetString("oidcConfig"), config.Secret) {
		t.Fatal("configuration not sealed")
	}
	status := serveTestRequest(t, app, "GET", "/api/app/auth/options", "", "")
	if status.Code != 200 || !strings.Contains(status.Body.String(), `"oidc":true`) || strings.Contains(status.Body.String(), config.Issuer) {
		t.Fatal(status.Body.String())
	}
	if got := req("/api/app/admin/auth-security/oidc/enable", admin, test); got.Code == 200 {
		t.Fatal("replayed configuration")
	}
	emptySession := tokenHash("")
	if got := req("/api/app/auth/oidc/finish", "", verified("login", emptySession, user.Email())); !strings.Contains(got.Body.String(), "OIDC_UNLINKED") {
		t.Fatal(got.Body.String())
	}
	linked := req("/api/app/auth/oidc/link/confirm", admin, verified("link", session, "bound-sub"))
	if linked.Code != 200 {
		t.Fatal(linked.Code, linked.Body.String())
	}
	if got := serveTestRequest(t, app, "GET", "/api/app/auth/session", "", admin); got.Code != 401 {
		t.Fatal("old session still active")
	}
	login := verified("login", emptySession, "bound-sub")
	got := req("/api/app/auth/oidc/finish", "", login)
	if got.Code != 200 || !strings.Contains(got.Body.String(), user.Id) {
		t.Fatal(got.Code, got.Body.String())
	}
	if again := req("/api/app/auth/oidc/finish", "", login); again.Code == 200 {
		t.Fatal("replayed login")
	}
	c, err := app.FindCollectionByNameOrId("mfa_totp_credentials")
	if err != nil {
		t.Fatal(err)
	}
	seed := core.NewRecord(c)
	seed.Set("user", user.Id)
	seed.Set("secretCiphertext", "test-ciphertext")
	if err := app.Save(seed); err != nil {
		t.Fatal(err)
	}
	got = req("/api/app/auth/oidc/finish", "", verified("login", emptySession, "bound-sub"))
	if got.Code != 200 || !strings.Contains(got.Body.String(), "mfa_required") {
		t.Fatal(got.Code, got.Body.String())
	}
	for _, cookie := range got.Result().Cookies() {
		if cookie.Name == appSessionCookieName {
			t.Fatal("MFA issued an early session")
		}
	}
}
