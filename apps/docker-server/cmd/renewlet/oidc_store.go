package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const oidcCookie = "__Host-renewlet_oidc"
const oidcCallbackPath = "/api/app/auth/oidc/callback"
const oidcFlowTTL = 5 * time.Minute

type oidcConfig struct {
	Issuer   string `json:"issuer"`
	ClientID string `json:"clientId"`
	Secret   string `json:"secret"`
	Callback string `json:"callback"`
}
type oidcFlow struct {
	Purpose  string
	Config   oidcConfig
	Revision string
	State    string
	Nonce    string
	Verifier string
	Session  string
	Next     string
	Subject  string
}
type oidcSite struct {
	Enabled  bool
	Revision string
	Config   oidcConfig
}

func ensureOIDCCollections(app core.App, users *core.Collection) error {
	if err := ensureCollection(app, "oidc_links", func(c *core.Collection) error {
		secretCollectionRules(c)
		for _, f := range []core.Field{userRelation(users), &core.TextField{Name: "issuer", Required: true, Max: 2048}, &core.TextField{Name: "subject", Required: true, Max: 255}} {
			if err := upsertField(c, f); err != nil {
				return err
			}
		}
		c.AddIndex("idx_oidc_links_user", true, "user", "")
		c.AddIndex("idx_oidc_links_identity", true, "issuer,subject", "")
		return nil
	}); err != nil {
		return err
	}
	return ensureCollection(app, "oidc_flows", func(c *core.Collection) error {
		secretCollectionRules(c)
		for _, f := range []core.Field{&core.TextField{Name: "tokenHash", Required: true, Max: 128}, &core.NumberField{Name: "expires", OnlyInt: true}, &core.TextField{Name: "payload", Required: true, Max: 65536}} {
			if err := upsertField(c, f); err != nil {
				return err
			}
		}
		c.AddIndex("idx_oidc_flows_token", true, "tokenHash", "")
		c.AddIndex("idx_oidc_flows_expiry", false, "expires", "")
		return nil
	})
}

func oidcSeal(app core.App, value any) (string, error) {
	key, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return sealSecurityText(key.oidc, string(data))
}
func oidcOpen(app core.App, value string, target any) error {
	key, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return err
	}
	data, err := openSecurityText(key.oidc, value)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(data), target)
}
func readOIDCSite(app core.App) (oidcSite, error) {
	var site oidcSite
	row, err := authSecurityRecord(app)
	if err != nil || row == nil {
		return site, err
	}
	site.Enabled = row.GetBool("oidcEnabled")
	site.Revision = row.GetString("oidcRevision")
	if blob := row.GetString("oidcConfig"); blob != "" {
		err = oidcOpen(app, blob, &site.Config)
	}
	return site, err
}
func saveOIDCSite(app core.App, config oidcConfig, revision string, enabled bool) error {
	row, err := authSecurityRecordForWrite(app)
	if err != nil {
		return err
	}
	if row.GetString("oidcRevision") != revision {
		return errors.New("stale OIDC revision")
	}
	blob, err := oidcSeal(app, config)
	if err != nil {
		return err
	}
	row.Set("oidcConfig", blob)
	row.Set("oidcEnabled", enabled)
	row.Set("oidcRevision", randomURLToken(24))
	return app.Save(row)
}
func storeOIDCFlow(app core.App, flow oidcFlow) (string, error) {
	blob, err := oidcSeal(app, flow)
	if err != nil {
		return "", err
	}
	token := randomURLToken(32)
	c, err := app.FindCollectionByNameOrId("oidc_flows")
	if err != nil {
		return "", err
	}
	row := core.NewRecord(c)
	row.Set("tokenHash", tokenHash(token))
	row.Set("expires", time.Now().Add(oidcFlowTTL).Unix())
	row.Set("payload", blob)
	_, err = app.DB().NewQuery("DELETE FROM oidc_flows WHERE id IN (SELECT id FROM oidc_flows WHERE expires <= {:now} ORDER BY expires LIMIT 32)").Bind(dbx.Params{"now": time.Now().Unix()}).Execute()
	if err != nil {
		return "", err
	}
	return token, app.Save(row)
}
func readOIDCFlow(app core.App, r *http.Request) (*core.Record, oidcFlow, error) {
	var flow oidcFlow
	cookie, err := r.Cookie(oidcCookie)
	if err != nil {
		return nil, flow, err
	}
	row, err := app.FindFirstRecordByFilter("oidc_flows", "tokenHash = {:hash} && expires > {:now}", dbx.Params{"hash": tokenHash(cookie.Value), "now": time.Now().Unix()})
	if err != nil {
		return nil, flow, err
	}
	err = oidcOpen(app, row.GetString("payload"), &flow)
	return row, flow, err
}
func oidcSetCookie(e *core.RequestEvent, token string) {
	age := int(oidcFlowTTL.Seconds())
	if token == "" {
		age = -1
	}
	appendResponseCookie(e, &http.Cookie{Name: oidcCookie, Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: age})
}
