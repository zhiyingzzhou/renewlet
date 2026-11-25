package main

import (
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type loginOptionsResponse struct {
	appStatusResponse
	PasswordReset bool `json:"passwordReset"`
	OIDC          bool `json:"oidc"`
}

type oidcStartBody struct {
	Next string `json:"next"`
}
type oidcTestBody struct {
	Issuer   string `json:"issuer"`
	ClientID string `json:"clientId"`
	Secret   string `json:"secret"`
	Revision string `json:"revision"`
}
type oidcRevisionBody struct {
	Revision string `json:"revision"`
}
type oidcPasswordBody struct {
	CurrentPassword string `json:"currentPassword"`
}

func oidcFail(e *core.RequestEvent, status int, code string) error {
	return apiErrorJSON(e, status, code, serverText(requestLocale(e.Request), "common.invalidRequestParameters"), nil)
}
func oidcCallbackURL(e *core.RequestEvent) string {
	return externalRequestURL(e.Request, oidcCallbackPath, nil)
}
func oidcSessionKey(e *core.RequestEvent) string {
	return tokenHash(sessionTokenFromRequest(e.Request))
}
func registerOIDCRoutes(app core.App, api, admin, auth *productRouteGroup) {
	api.GET("/api/app/auth/options", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-store")
		row, err := authSecurityRecord(app)
		if err != nil {
			return err
		}
		s := authSecuritySettingsFromRecord(row)
		initialized := hasEnabledAdmin(app)
		return apiSuccessJSON(e, 200, loginOptionsResponse{
			appStatusResponse: appStatusResponse{SetupRequired: !initialized, SetupEnabled: demoModePolicy.SetupEnabled(), DemoMode: demoModePolicy.Enabled(), Turnstile: s.publicTurnstile()},
			PasswordReset:     app.Settings().SMTP.Enabled, OIDC: initialized && !demoModePolicy.Enabled() && row != nil && row.GetBool("oidcEnabled"),
		})
	})
	admin.GET("/auth-security/oidc", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-store")
		s, err := readOIDCSite(app)
		if err != nil {
			return err
		}
		return apiSuccessJSON(e, 200, map[string]any{"enabled": s.Enabled, "issuer": s.Config.Issuer, "clientId": s.Config.ClientID, "secretConfigured": s.Config.Secret != "", "revision": s.Revision, "callback": oidcCallbackURL(e)})
	})
	api.POST("/api/app/auth/oidc/start", func(e *core.RequestEvent) error { return startOIDC(app, e, "login") })
	auth.POST("/auth/oidc/link/start", func(e *core.RequestEvent) error { return startOIDC(app, e, "link") })
	admin.POST("/auth-security/oidc/test", func(e *core.RequestEvent) error { return startOIDC(app, e, "test") })
	api.GET(oidcCallbackPath, func(e *core.RequestEvent) error { return callbackOIDC(app, e) })
	api.POST("/api/app/auth/oidc/finish", func(e *core.RequestEvent) error { return finishOIDC(app, e, "login") })
	auth.POST("/auth/oidc/link/confirm", func(e *core.RequestEvent) error { return finishOIDC(app, e, "link") })
	admin.POST("/auth-security/oidc/enable", func(e *core.RequestEvent) error { return finishOIDC(app, e, "test") })
	auth.GET("/auth/oidc/review", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-store")
		_, f, err := readOIDCFlow(app, e.Request)
		if err != nil || f.Subject == "" || f.Session != oidcSessionKey(e) || (f.Purpose != "link" && f.Purpose != "test") {
			return oidcFail(e, 400, "OIDC_EXPIRED")
		}
		return apiSuccessJSON(e, 200, map[string]string{"purpose": f.Purpose, "issuer": f.Config.Issuer, "clientId": f.Config.ClientID, "subject": f.Subject})
	})
	admin.POST("/auth-security/oidc/disable", func(e *core.RequestEvent) error {
		if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
			return err
		}
		body, err := decodeStrictJSON[oidcRevisionBody](e.Request, requestLocale(e.Request))
		if err != nil {
			return oidcFail(e, 400, "OIDC_INVALID")
		}
		err = app.RunInTransaction(func(tx core.App) error {
			if err := oidcValidateSession(tx, e, true); err != nil {
				return err
			}
			s, err := readOIDCSite(tx)
			if err != nil {
				return err
			}
			return saveOIDCSite(tx, s.Config, body.Revision, false)
		})
		if err != nil {
			return oidcFail(e, 409, "OIDC_CHANGED")
		}
		return apiEmptySuccessJSON(e, 200)
	})
	auth.GET("/auth/oidc/link", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-store")
		row, err := app.FindFirstRecordByData("oidc_links", "user", e.Auth.Id)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		issuer := ""
		if row != nil {
			issuer = row.GetString("issuer")
		}
		return apiSuccessJSON(e, 200, map[string]string{"issuer": issuer})
	})
	auth.POST("/auth/oidc/unlink", func(e *core.RequestEvent) error {
		if err := demoModePolicy.RejectAccountMutation(e); err != nil {
			return err
		}
		if !oidcCheckPassword(e) {
			return oidcFail(e, 400, "OIDC_PASSWORD")
		}
		var response sessionResponse
		err := app.RunInTransaction(func(tx core.App) error {
			if err := oidcValidateSession(tx, e, false); err != nil {
				return err
			}
			row, err := tx.FindFirstRecordByData("oidc_links", "user", e.Auth.Id)
			if err != nil {
				return err
			}
			if err = tx.Delete(row); err != nil {
				return err
			}
			response, err = renewAccountSecuritySession(tx, e.Auth.Id)
			return err
		})
		if err != nil {
			return oidcFail(e, 409, "OIDC_CHANGED")
		}
		return sendAppSessionResponse(e, response)
	})
}

// 中间件检查后可能发生并行解绑或权限回收，写绑定/配置的事务必须再确认原会话。
func oidcValidateSession(app core.App, e *core.RequestEvent, admin bool) error {
	user, _, err := appAuthRecordByToken(app, sessionTokenFromRequest(e.Request))
	if err != nil {
		return err
	}
	if user.Id != e.Auth.Id || user.GetBool("banned") || admin && user.GetString("role") != "admin" {
		return errors.New("session changed")
	}
	return nil
}
func oidcCheckPassword(e *core.RequestEvent) bool {
	b, err := decodeStrictJSON[oidcPasswordBody](e.Request, requestLocale(e.Request))
	return err == nil && e.Auth != nil && e.Auth.ValidatePassword(b.CurrentPassword)
}
func startOIDC(app core.App, e *core.RequestEvent, purpose string) error {
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return err
	}
	site, err := readOIDCSite(app)
	if err != nil {
		return err
	}
	f := oidcFlow{Purpose: purpose, Config: site.Config, Revision: site.Revision, State: randomURLToken(32), Nonce: randomURLToken(32), Verifier: randomURLToken(32)}
	if purpose != "test" && !site.Enabled {
		return oidcFail(e, 400, "OIDC_DISABLED")
	}
	switch purpose {
	case "test":
		b, err := decodeStrictJSON[oidcTestBody](e.Request, requestLocale(e.Request))
		if err != nil || len(b.Issuer) > 2048 || len(b.ClientID) > 512 || len(b.Secret) > 4096 || b.Revision != site.Revision {
			return oidcFail(e, 400, "OIDC_INVALID")
		}
		f.Config = oidcConfig{Issuer: strings.TrimSpace(b.Issuer), ClientID: strings.TrimSpace(b.ClientID), Secret: b.Secret, Callback: oidcCallbackURL(e)}
		// 旧密钥只可沿用到原 issuer/client；草稿验证成功后仍需原管理员会话显式提交。
		if f.Config.Secret == "" && f.Config.Issuer == site.Config.Issuer && f.Config.ClientID == site.Config.ClientID {
			f.Config.Secret = site.Config.Secret
		}
		if f.Config.ClientID == "" || f.Config.Secret == "" {
			return oidcFail(e, 400, "OIDC_INVALID")
		}
		f.Session = oidcSessionKey(e)
	case "link":
		if !oidcCheckPassword(e) {
			return oidcFail(e, 400, "OIDC_PASSWORD")
		}
		f.Session = oidcSessionKey(e)
	case "login":
		f.Session = oidcSessionKey(e)
		b, err := decodeStrictJSON[oidcStartBody](e.Request, requestLocale(e.Request))
		if err != nil || len(b.Next) > 2048 {
			return oidcFail(e, 400, "OIDC_INVALID")
		}
		f.Next = oidcNext(b.Next)
	}
	if !strings.HasPrefix(f.Config.Callback, "https://") || oidcCallbackURL(e) != f.Config.Callback {
		return oidcFail(e, 400, "OIDC_ORIGIN")
	}
	target, err := oidcAuthorization(e.Request.Context(), f)
	if err != nil {
		return oidcFail(e, 400, "OIDC_PROVIDER")
	}
	token, err := storeOIDCFlow(app, f)
	if err != nil {
		return err
	}
	oidcSetCookie(e, token)
	e.Response.Header().Set("Cache-Control", "no-store")
	return apiSuccessJSON(e, 200, map[string]string{"url": target})
}
func callbackOIDC(app core.App, e *core.RequestEvent) error {
	q := e.Request.URL.Query()
	// PocketBase 在 handler 返回后记录 URL 与 Referer；只给协议层保留授权响应参数。
	e.Request.URL.RawQuery = ""
	e.Request.RequestURI = e.Request.URL.Path
	e.Request.Header.Del("Referer")
	var f oidcFlow
	e.Response.Header().Set("Cache-Control", "no-store")
	e.Response.Header().Set("Referrer-Policy", "no-referrer")
	err := app.RunInTransaction(func(tx core.App) error {
		row, flow, err := readOIDCFlow(tx, e.Request)
		if err != nil {
			return err
		}
		if flow.Subject != "" || flow.State == "" || len(q["state"]) != 1 || q.Get("state") != flow.State || flow.Config.Callback != oidcCallbackURL(e) {
			return errors.New("invalid state")
		}
		if flow.Session != "" && flow.Session != oidcSessionKey(e) {
			return errors.New("session changed")
		}
		f = flow
		return tx.Delete(row)
	})
	dest := "/login"
	if f.Purpose == "test" || f.Purpose == "link" {
		dest = "/settings"
	}
	params := url.Values{"oidc": []string{"error"}}
	if f.Next != "" {
		params.Set("next", f.Next)
	}
	if err == nil {
		nextToken := ""
		if q.Get("error") == "access_denied" {
			params.Set("oidc", "cancelled")
		} else if len(q["code"]) == 1 && q.Get("code") != "" && !q.Has("error") && len(q["iss"]) <= 1 {
			sub, exchangeErr := oidcSubject(e.Request.Context(), f, q.Get("code"), q.Get("iss"))
			if exchangeErr == nil {
				f.Subject = sub
				f.State = ""
				f.Nonce = ""
				f.Verifier = ""
				token, err := storeOIDCFlow(app, f)
				if err != nil {
					return err
				}
				nextToken = token
				params.Set("oidc", f.Purpose)
			}
		}
		oidcSetCookie(e, nextToken)
	}
	if f.Purpose == "test" {
		dest += "?" + params.Encode() + "#settings-access-security"
	} else if f.Purpose == "link" {
		dest += "?" + params.Encode() + "#settings-account"
	} else {
		dest += "?" + params.Encode()
	}
	return e.Redirect(http.StatusSeeOther, dest)
}
func finishOIDC(app core.App, e *core.RequestEvent, purpose string) error {
	if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
		return err
	}
	var session sessionResponse
	var login primaryLoginResult
	code := "OIDC_EXPIRED"
	unlinked := false
	err := app.RunInTransaction(func(tx core.App) error {
		row, f, err := readOIDCFlow(tx, e.Request)
		if err != nil {
			return err
		}
		if f.Subject == "" || f.Purpose != purpose || f.Session != oidcSessionKey(e) {
			return errors.New("flow mismatch")
		}
		if purpose != "login" {
			if err := oidcValidateSession(tx, e, purpose == "test"); err != nil {
				return err
			}
		}
		site, err := readOIDCSite(tx)
		if err != nil {
			return err
		}
		if site.Revision != f.Revision || purpose != "test" && !site.Enabled {
			code = "OIDC_CHANGED"
			return errors.New("site changed")
		}
		if err = tx.Delete(row); err != nil {
			return err
		}
		switch purpose {
		case "test":
			return saveOIDCSite(tx, f.Config, f.Revision, true)
		case "link":
			c, err := tx.FindCollectionByNameOrId("oidc_links")
			if err != nil {
				return err
			}
			r := core.NewRecord(c)
			r.Set("user", e.Auth.Id)
			r.Set("issuer", f.Config.Issuer)
			r.Set("subject", f.Subject)
			if err = tx.Save(r); err != nil {
				code = "OIDC_CONFLICT"
				return err
			}
			session, err = renewAccountSecuritySession(tx, e.Auth.Id)
			return err
		default:
			link, err := tx.FindFirstRecordByFilter("oidc_links", "issuer = {:iss} && subject = {:sub}", dbx.Params{"iss": f.Config.Issuer, "sub": f.Subject})
			if errors.Is(err, sql.ErrNoRows) {
				unlinked = true
				return nil
			}
			if err != nil {
				return err
			}
			user, err := tx.FindRecordById("users", link.GetString("user"))
			if err != nil {
				return err
			}
			login, err = preparePrimaryLogin(tx, e, user)
			return err
		}
	})
	if err != nil {
		return oidcFail(e, 400, code)
	}
	oidcSetCookie(e, "")
	if unlinked {
		return oidcFail(e, 400, "OIDC_UNLINKED")
	}
	if purpose == "test" {
		return apiEmptySuccessJSON(e, 200)
	}
	if purpose == "link" {
		return sendAppSessionResponse(e, session)
	}
	return login.send(e)
}
