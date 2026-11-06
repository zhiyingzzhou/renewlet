package main

import (
	"archive/zip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestCloudBackupExportSettingsStripsExternalNotificationSecrets(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "cloud-backup-export")
	settings := defaultAppSettings()
	settings.DiscordWebhookURL = "https://discord.com/api/webhooks/123/secret"
	settings.DiscordBotUsername = "Renewlet"
	settings.DiscordBotAvatarURL = "https://cdn.example.com/avatar.png"
	settings.PushPlusToken = "push-token"
	settings.DingTalkWebhookURL = "https://oapi.dingtalk.com/robot/send?access_token=ding-token"
	settings.DingTalkSecret = "SECsecret"
	settings.DingTalkKeyword = "自定义关键词"
	settings.DingTalkTitleTemplate = "自定义标题"
	settings.DingTalkContentTemplate = "自定义正文"
	if _, err := createSettingsRecord(app, user.Id, settings); err != nil {
		t.Fatal(err)
	}

	exportedSettings, ok, err := cloudBackupExportSettings(app, user)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected settings to be exported")
	}
	exported := jsonObjectForTest(t, exportedSettings)
	for _, key := range []string{"discordWebhookUrl", "discordBotUsername", "discordBotAvatarUrl", "pushplusToken", "dingtalkWebhookUrl", "dingtalkSecret", "dingtalkKeyword", "dingtalkTitleTemplate", "dingtalkContentTemplate"} {
		if _, exists := exported[key]; exists {
			t.Fatalf("expected %s to be stripped from cloud backup settings: %#v", key, exported)
		}
	}
	for _, forbidden := range []string{"ding-token", "SECsecret", "自定义关键词", "自定义标题", "自定义正文"} {
		if strings.Contains(jsonStringForTest(exported), forbidden) {
			t.Fatalf("cloud backup settings leaked %q: %#v", forbidden, exported)
		}
	}
}

func TestCloudBackupExportSettingsMapsLocalePreferenceToV1(t *testing.T) {
	for _, test := range []struct {
		preference string
		wantLocale string
	}{
		{preference: string(autoLocalePreference)},
		{preference: string(preferenceZhCN), wantLocale: string(preferenceZhCN)},
		{preference: string(preferenceEnUS), wantLocale: string(preferenceEnUS)},
		{preference: string(preferenceRuRU), wantLocale: string(preferenceRuRU)},
	} {
		t.Run(test.preference, func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			user, _ := createRouteTestUser(t, app, "cloud-backup-locale-"+test.preference)
			settings := defaultAppSettings()
			settings.LocalePreference = test.preference
			if _, err := createSettingsRecord(app, user.Id, settings); err != nil {
				t.Fatal(err)
			}

			exportedSettings, ok, err := cloudBackupExportSettings(app, user)
			if err != nil || !ok {
				t.Fatalf("expected settings export, ok=%v err=%v", ok, err)
			}
			exported := jsonObjectForTest(t, exportedSettings)
			if _, exists := exported["localePreference"]; exists {
				t.Fatalf("v1 export must not contain localePreference: %#v", exported)
			}
			locale, exists := exported["locale"]
			if test.wantLocale == "" && exists {
				t.Fatalf("auto must omit v1 locale: %#v", exported)
			}
			if test.wantLocale != "" && (!exists || locale != test.wantLocale) {
				t.Fatalf("locale = %#v, want %q", locale, test.wantLocale)
			}
		})
	}
}

func TestCloudBackupExportZipAuditsMissingPrivateAssets(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "cloud-backup-missing-assets")
	logoID, logoURL := uploadCloudBackupExportAssetForTest(t, app, token, "logo", "missing-logo.svg")
	iconID, iconURL := uploadCloudBackupExportAssetForTest(t, app, token, "icon", "missing-icon.svg")
	removeCloudBackupExportAssetFileForTest(t, app, logoID)
	removeCloudBackupExportAssetFileForTest(t, app, iconID)
	subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"logo": logoURL})
	createCalendarFeedTestCustomConfig(t, app, user.Id, func(config *customConfigPayload) {
		config.PaymentMethods = []customConfigItem{{
			ID:     "pm_card",
			Value:  "card",
			Labels: customConfigLabels{ZhCN: "银行卡", EnUS: "Card"},
			Icon:   iconURL,
		}}
	})

	source, _, err := buildCloudBackupExportZip(app, user)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Cleanup()
	data := cloudBackupExportZipJSONForTest(t, source, "data.json")
	payload := data["data"].(map[string]interface{})
	subscriptions := payload["subscriptions"].([]interface{})
	exportedSubscription := subscriptions[0].(map[string]interface{})
	if _, exists := exportedSubscription["logo"]; exists {
		t.Fatalf("missing logo path must not stay in data.json: %#v", exportedSubscription)
	}
	config := payload["customConfig"].(map[string]interface{})
	paymentMethods := config["paymentMethods"].([]interface{})
	exportedPaymentMethod := paymentMethods[0].(map[string]interface{})
	if _, exists := exportedPaymentMethod["icon"]; exists {
		t.Fatalf("missing payment method icon must not stay in data.json: %#v", exportedPaymentMethod)
	}

	manifest := cloudBackupExportZipJSONForTest(t, source, "manifest.json")
	missingAssets := manifest["missingAssets"].([]interface{})
	if len(missingAssets) != 2 {
		t.Fatalf("expected two missing asset audit entries, got %#v", missingAssets)
	}
	assertCloudBackupMissingAssetForTest(t, missingAssets[0], logoID, logoURL, "subscription.logo", subscription.Id, "file_missing")
	assertCloudBackupMissingAssetForTest(t, missingAssets[1], iconID, iconURL, "customConfig.paymentMethods.icon", "pm_card", "file_missing")
}

func TestCloudBackupExportZipDeduplicatesSharedPrivateAssets(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "cloud-backup-dedupe-assets")
	assetID, assetURL := uploadCloudBackupExportAssetForTest(t, app, token, "logo", "shared-logo.svg")
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "First", "logo": assetURL})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Second", "logo": assetURL})

	source, _, err := buildCloudBackupExportZip(app, user)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Cleanup()
	data := cloudBackupExportZipJSONForTest(t, source, "data.json")
	payload := data["data"].(map[string]interface{})
	subscriptions := payload["subscriptions"].([]interface{})
	if len(subscriptions) != 2 {
		t.Fatalf("expected two subscriptions, got %#v", subscriptions)
	}
	expectedPath := "assets/" + assetID + ".svg"
	for _, item := range subscriptions {
		subscription := item.(map[string]interface{})
		if subscription["logo"] != expectedPath {
			t.Fatalf("expected shared logo to point at %q, got %#v", expectedPath, subscription)
		}
	}
	manifest := cloudBackupExportZipJSONForTest(t, source, "manifest.json")
	if manifest["assets"] != float64(1) {
		t.Fatalf("expected one ZIP asset in manifest, got %#v", manifest)
	}
	if len(manifest["missingAssets"].([]interface{})) != 0 {
		t.Fatalf("expected no missing assets, got %#v", manifest["missingAssets"])
	}
	if !cloudBackupExportZipHasEntryForTest(t, source, expectedPath) {
		t.Fatalf("expected ZIP to contain %s", expectedPath)
	}
}

func TestCloudBackupExportZipIncludesExchangeRateSnapshots(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, _ := createRouteTestUser(t, app, "cloud-backup-rate-snapshots")
	if err := upsertExchangeRateSnapshot(app, user.Id, exchangeRateSnapshotDTO{
		SchemaVersion:     1,
		Month:             "2026-08",
		Base:              "USD",
		Rates:             map[string]float64{"USD": 1, "CNY": 7},
		RequestedProvider: "frankfurter",
		Provider:          "frankfurter",
		SourceDate:        "2026-08-01",
		CapturedAt:        "2026-08-06T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}

	source, _, err := buildCloudBackupExportZip(app, user)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Cleanup()
	data := cloudBackupExportZipJSONForTest(t, source, "data.json")
	payload := data["data"].(map[string]interface{})
	snapshots := payload["exchangeRateSnapshots"].([]interface{})
	if len(snapshots) != 1 {
		t.Fatalf("expected one exchange rate snapshot, got %#v", snapshots)
	}
	snapshot := snapshots[0].(map[string]interface{})
	if snapshot["month"] != "2026-08" || snapshot["base"] != "USD" || snapshot["provider"] != "frankfurter" {
		t.Fatalf("unexpected exchange rate snapshot export: %#v", snapshot)
	}
}

func jsonStringForTest(value interface{}) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func uploadCloudBackupExportAssetForTest(t *testing.T, app core.App, token string, kind string, filename string) (string, string) {
	t.Helper()
	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": kind},
		"file",
		filename,
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected asset upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	id := strings.TrimPrefix(uploaded.URL, "/api/app/assets/")
	return id, uploaded.URL
}

func removeCloudBackupExportAssetFileForTest(t *testing.T, app core.App, id string) {
	t.Helper()
	record, err := app.FindRecordById("assets", id)
	if err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(app.DataDir(), "storage", record.Collection().Id, record.Id, record.GetString("file"))
	if err := os.Remove(filePath); err != nil {
		t.Fatal(err)
	}
}

func cloudBackupExportZipJSONForTest(t *testing.T, source cloudBackupSnapshotSource, name string) map[string]interface{} {
	t.Helper()
	file, err := source.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := zip.NewReader(file, source.Size())
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range reader.File {
		if file.Name != name {
			continue
		}
		opened, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		defer opened.Close()
		data, err := io.ReadAll(opened)
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]interface{}
		if err := json.Unmarshal(data, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	t.Fatalf("missing ZIP entry %s", name)
	return nil
}

func cloudBackupExportZipHasEntryForTest(t *testing.T, source cloudBackupSnapshotSource, name string) bool {
	t.Helper()
	file, err := source.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := zip.NewReader(file, source.Size())
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range reader.File {
		if file.Name == name {
			return true
		}
	}
	return false
}

func assertCloudBackupMissingAssetForTest(t *testing.T, value interface{}, assetID string, path string, reference string, referenceID string, reason string) {
	t.Helper()
	entry := value.(map[string]interface{})
	if entry["assetId"] != assetID || entry["path"] != path || entry["reference"] != reference || entry["referenceId"] != referenceID || entry["reason"] != reason {
		t.Fatalf("unexpected missing asset entry: %#v", entry)
	}
}

func jsonObjectForTest(t *testing.T, value interface{}) map[string]interface{} {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]interface{}
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	return object
}

func TestCloudBackupExportTypedSettingsPreserveV1Projection(t *testing.T) {
	settings := defaultAppSettings()
	settings.MonthlyBudget = "123456789.012345"
	settings.AIRecognition.BaseURL = "https://private.example.test"
	settings.AIRecognition.APIKey = "private-api-key"
	settings.LocalePreference = "ru-RU"
	expected := jsonObjectForTest(t, settings)
	for _, key := range strings.Fields(`testPhone telegramBotToken telegramChatId notifyxApiKey webhookUrl webhookHeaders webhookPayload dingtalkWebhookUrl dingtalkSecret dingtalkKeyword dingtalkTitleTemplate dingtalkContentTemplate wechatWebhookUrl wechatAtPhones smtpHost smtpPort smtpSecure smtpUser smtpPassword smtpFrom smtpReplyTo recipientEmail barkServerUrl barkDeviceKey serverchanSendKey discordWebhookUrl discordBotUsername discordBotAvatarUrl pushplusToken localePreference`) {
		delete(expected, key)
	}
	expected["locale"] = "ru-RU"
	ai := expected["aiRecognition"].(map[string]interface{})
	ai["baseUrl"], ai["apiKey"] = "", ""
	actual := jsonObjectForTest(t, projectCloudBackupExportSettings(settings))
	if jsonStringForTest(actual) != jsonStringForTest(expected) {
		t.Fatalf("v1 projection drift:\ngot %s\nwant %s", jsonStringForTest(actual), jsonStringForTest(expected))
	}
	if settings.AIRecognition.APIKey != "private-api-key" {
		t.Fatal("projection changed source settings")
	}
}

func TestCloudBackupExportTypedPayloadPreservesOmissionAndMoney(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "export-typed")
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"price": "123456789.012345", "balance": "0.000001", "balanceCurrency": "EUR"})
	bundle, err := buildCloudBackupExportBundle(app, user, time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	payload := jsonObjectForTest(t, bundle.Payload)
	data := payload["data"].(map[string]interface{})
	for _, key := range []string{"settings", "customConfig", "assets", "exchangeRateSnapshots"} {
		if _, exists := data[key]; exists {
			t.Fatalf("absent %s must stay omitted", key)
		}
	}
	sub := data["subscriptions"].([]interface{})[0].(map[string]interface{})
	if sub["balance"] != "0.000001" || sub["balanceCurrency"] != "EUR" {
		t.Fatalf("backup lost balance: %#v", sub)
	}
	if sub["price"] != "123456789.012345" {
		t.Fatalf("money lost precision: %v", sub["price"])
	}
	if payload["schemaVersion"] != float64(1) || payload["kind"] != "renewlet-export" {
		t.Fatalf("export contract changed: %v", payload)
	}
}
