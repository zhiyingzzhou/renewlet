package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"golang.org/x/sync/singleflight"
)

type oidcTransport struct{ base *http.Transport }

func (t oidcTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || r.URL.User != nil {
		return nil, errors.New("invalid OIDC endpoint")
	}
	resp, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	// discovery、JWKS 和令牌都是小 JSON；库读取正文前限制大小。
	resp.Body = struct {
		io.Reader
		io.Closer
	}{io.LimitReader(resp.Body, 256*1024), resp.Body}
	return resp, nil
}
func oidcHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(ips) == 0 {
			return nil, errors.New("OIDC DNS unavailable")
		}
		// 只连接本次检查过的公网 IP，TLS 仍验证原主机名，避免校验与建连之间二次解析。
		for _, ip := range ips {
			if isUnsafeOutboundIP(ip.IP) {
				return nil, errors.New("private OIDC endpoint")
			}
		}
		var dial net.Dialer
		for _, ip := range ips {
			conn, e := dial.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if e == nil {
				return conn, nil
			}
			err = e
		}
		return nil, err
	}
	return &http.Client{Transport: oidcTransport{tr}, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

var oidcClient = oidcHTTPClient()
var oidcDiscovery struct {
	sync.Mutex
	issuer   string
	until    time.Time
	provider *oidc.Provider
	group    singleflight.Group
}

func oidcProvider(ctx context.Context, issuer string) (*oidc.Provider, error) {
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid issuer")
	}
	oidcDiscovery.Lock()
	p := oidcDiscovery.provider
	valid := issuer == oidcDiscovery.issuer && time.Now().Before(oidcDiscovery.until)
	oidcDiscovery.Unlock()
	if valid {
		return p, nil
	}
	v, err, _ := oidcDiscovery.group.Do(issuer, func() (any, error) {
		provider, err := oidc.NewProvider(oidc.ClientContext(ctx, oidcClient), issuer)
		if err != nil {
			return nil, err
		}
		for _, endpoint := range []string{provider.Endpoint().AuthURL, provider.Endpoint().TokenURL} {
			if _, err = assertSafeOutboundURL(endpoint, "OIDC", appLocale("en-US")); err != nil {
				return nil, err
			}
		}
		oidcDiscovery.Lock()
		oidcDiscovery.provider = provider
		oidcDiscovery.issuer = issuer
		oidcDiscovery.until = time.Now().Add(5 * time.Minute)
		oidcDiscovery.Unlock()
		return provider, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*oidc.Provider), nil
}
func oidcOAuth(p *oidc.Provider, c oidcConfig) oauth2.Config {
	ep := p.Endpoint()
	var metadata struct {
		AuthMethods []string `json:"token_endpoint_auth_methods_supported"`
	}
	_ = p.Claims(&metadata)
	ep.AuthStyle = oauth2.AuthStyleInHeader
	if slices.Contains(metadata.AuthMethods, "client_secret_post") && !slices.Contains(metadata.AuthMethods, "client_secret_basic") {
		ep.AuthStyle = oauth2.AuthStyleInParams
	}
	return oauth2.Config{Endpoint: ep, ClientID: c.ClientID, ClientSecret: c.Secret, RedirectURL: c.Callback, Scopes: []string{"openid"}}
}
func oidcAuthorization(ctx context.Context, f oidcFlow) (string, error) {
	p, err := oidcProvider(ctx, f.Config.Issuer)
	if err != nil {
		return "", err
	}
	c := oidcOAuth(p, f.Config)
	return c.AuthCodeURL(f.State, oidc.Nonce(f.Nonce), oauth2.S256ChallengeOption(f.Verifier)), nil
}

var oidcSubjectPattern = regexp.MustCompile(`^[ -~]{1,255}$`)

func oidcSubject(ctx context.Context, f oidcFlow, code, responseIssuer string) (string, error) {
	p, err := oidcProvider(ctx, f.Config.Issuer)
	if err != nil {
		return "", err
	}
	var metadata struct {
		RequireIssuer bool `json:"authorization_response_iss_parameter_supported"`
	}
	if err = p.Claims(&metadata); err != nil {
		return "", err
	}
	if (responseIssuer != "" || metadata.RequireIssuer) && responseIssuer != f.Config.Issuer {
		return "", errors.New("invalid authorization issuer")
	}
	c := oidcOAuth(p, f.Config)
	token, err := c.Exchange(oidc.ClientContext(ctx, oidcClient), code, oauth2.VerifierOption(f.Verifier))
	if err != nil {
		return "", err
	}
	raw, _ := token.Extra("id_token").(string)
	id, err := p.Verifier(&oidc.Config{ClientID: c.ClientID, SupportedSigningAlgs: []string{"RS256"}}).Verify(ctx, raw)
	if err != nil {
		return "", err
	}
	var claims struct {
		AZP string `json:"azp"`
	}
	if err = id.Claims(&claims); err != nil {
		return "", err
	}
	if id.Issuer != f.Config.Issuer || id.Nonce != f.Nonce || id.IssuedAt.IsZero() || !oidcSubjectPattern.MatchString(id.Subject) || (len(id.Audience) > 1 || claims.AZP != "") && claims.AZP != c.ClientID {
		return "", fmt.Errorf("OIDC claims invalid")
	}
	return id.Subject, nil
}
func oidcNext(raw string) string {
	u, err := url.ParseRequestURI(raw)
	if err != nil || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.Contains(raw, "\\") || u.Host != "" || u.Path == "/login" {
		return "/"
	}
	return raw
}
