package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestSettingsFromValueRejectsUnsupportedPersistedLocalePreference(t *testing.T) {
	if _, err := settingsFromValue(json.RawMessage(`{"localePreference":"fr-FR","monthlyBudget":"2333"}`)); err == nil {
		t.Fatal("expected unsupported persisted locale preference to fail")
	}
	if _, err := settingsFromValue(json.RawMessage(`{"monthlyBudget":"2333"}`)); err == nil {
		t.Fatal("expected missing persisted locale preference to fail")
	}
}

func TestTelegramMessageFormatDefaultsAndRecoversPersistedValue(t *testing.T) {
	if got := defaultAppSettings().TelegramMessageFormat; got != telegramMessageFormatPlain {
		t.Fatalf("expected plain Telegram message format default, got %q", got)
	}

	settings, err := settingsFromValue(json.RawMessage(`{"localePreference":"auto","telegramMessageFormat":"markdown","monthlyBudget":"2333"}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.TelegramMessageFormat != telegramMessageFormatPlain || settings.MonthlyBudget != "2333" {
		t.Fatalf("expected invalid stored Telegram format to recover only that field, got %#v", settings)
	}
}

func TestLunarCalendarSettingDefaultsAndRoundTrips(t *testing.T) {
	if defaultAppSettings().ShowLunarCalendar {
		t.Fatal("expected Chinese lunar calendar display to be disabled by default")
	}

	settings, err := settingsFromValue(json.RawMessage(`{"localePreference":"auto","showLunarCalendar":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if !settings.ShowLunarCalendar {
		t.Fatal("expected persisted lunar calendar preference to survive settings normalization")
	}

	settings, err = settingsFromValue(json.RawMessage(`{"localePreference":"auto"}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.ShowLunarCalendar {
		t.Fatal("expected historical settings without the field to use the false default")
	}
}

func TestSubscriptionPriceReferenceSettingsDefaultRecoverAndWriteValidation(t *testing.T) {
	defaults := defaultAppSettings()
	if defaults.SubscriptionPriceReferenceEnabled {
		t.Fatal("expected subscription price reference to be disabled by default")
	}
	if defaults.SubscriptionPriceReferenceCurrency != "default" {
		t.Fatalf("expected default subscription price reference currency, got %q", defaults.SubscriptionPriceReferenceCurrency)
	}

	settings, err := settingsFromValue(json.RawMessage(`{"localePreference":"auto","subscriptionPriceReferenceEnabled":true,"subscriptionPriceReferenceCurrency":"usd","monthlyBudget":"2333"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !settings.SubscriptionPriceReferenceEnabled || settings.SubscriptionPriceReferenceCurrency != "default" || settings.MonthlyBudget != "2333" {
		t.Fatalf("expected invalid stored subscription reference currency to recover only that field, got %#v", settings)
	}

	settings, err = mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"subscriptionPriceReferenceEnabled":true,"subscriptionPriceReferenceCurrency":"USD"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !settings.SubscriptionPriceReferenceEnabled || settings.SubscriptionPriceReferenceCurrency != "USD" {
		t.Fatalf("expected subscription reference settings write to survive, got %#v", settings)
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"subscriptionPriceReferenceCurrency":"usd"}`)); err == nil {
		t.Fatal("expected unsupported subscription reference currency write to fail")
	}
}

func TestMergeSettingsForWriteRejectsUnsupportedOrLegacyLocale(t *testing.T) {
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"localePreference":"fr-FR"}`)); err == nil {
		t.Fatal("expected unsupported locale preference write to fail")
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"locale":"zh-CN"}`)); err == nil {
		t.Fatal("expected legacy locale field write to fail")
	}
}

func TestMergeSettingsForWriteValidatesTelegramMessageFormat(t *testing.T) {
	settings, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"telegramMessageFormat":"html"}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.TelegramMessageFormat != telegramMessageFormatHTML {
		t.Fatalf("expected html Telegram format, got %q", settings.TelegramMessageFormat)
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"telegramMessageFormat":"markdown"}`)); err == nil {
		t.Fatal("expected unsupported Telegram message format write to fail")
	}
}

func TestSettingsOnlineIconSourcesDefaultAndPatch(t *testing.T) {
	defaults := defaultAppSettings()
	if got := defaults.OnlineIconSources[appStoreOnlineIconSource].Enabled; !got {
		t.Fatal("expected App Store online icon source to be enabled by default")
	}
	if got := defaults.OnlineIconSources[appStoreOnlineIconSource].Storefronts; !reflect.DeepEqual(got, []string{appStoreStorefrontUS}) {
		t.Fatalf("expected App Store storefront default to be US, got %#v", got)
	}
	settings, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"onlineIconSources":{"appStore":{"enabled":false}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.OnlineIconSources[appStoreOnlineIconSource].Enabled {
		t.Fatalf("expected App Store source disabled after patch, got %#v", settings.OnlineIconSources)
	}
	if got := settings.OnlineIconSources[appStoreOnlineIconSource].Storefronts; !reflect.DeepEqual(got, []string{appStoreStorefrontUS}) {
		t.Fatalf("expected enabled-only patch to preserve App Store storefronts, got %#v", got)
	}
	settings, err = mergeSettingsForWrite(settings, json.RawMessage(`{"onlineIconSources":{"appStore":{"storefronts":["cn"]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := settings.OnlineIconSources[appStoreOnlineIconSource].Storefronts; !reflect.DeepEqual(got, []string{appStoreStorefrontCN}) {
		t.Fatalf("expected CN storefront patch, got %#v", got)
	}
	settings, err = mergeSettingsForWrite(settings, json.RawMessage(`{"onlineIconSources":{"appStore":{"storefronts":["cn","us"]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := settings.OnlineIconSources[appStoreOnlineIconSource].Storefronts; !reflect.DeepEqual(got, []string{appStoreStorefrontUS, appStoreStorefrontCN}) {
		t.Fatalf("expected canonical US+CN storefronts, got %#v", got)
	}
	settings, err = mergeSettingsForWrite(settings, json.RawMessage(`{"onlineIconSources":{"appStore":{}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.OnlineIconSources[appStoreOnlineIconSource].Enabled {
		t.Fatalf("expected empty App Store patch to preserve disabled state, got %#v", settings.OnlineIconSources)
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"onlineIconSources":{"googlePlay":{"enabled":true}}}`)); err == nil {
		t.Fatal("expected unknown online icon source to fail")
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"onlineIconSources":{"appStore":{"variantsEnabled":true}}}`)); err == nil {
		t.Fatal("expected unknown App Store source field to fail")
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"onlineIconSources":{"appStore":{"storefronts":[]}}}`)); err == nil {
		t.Fatal("expected empty App Store storefronts to fail")
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"onlineIconSources":{"appStore":{"storefronts":["us","us"]}}}`)); err == nil {
		t.Fatal("expected duplicate App Store storefronts to fail")
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"onlineIconSources":{"appStore":{"storefronts":["jp"]}}}`)); err == nil {
		t.Fatal("expected unknown App Store storefront to fail")
	}
}

func TestDingTalkMessageTypeDefaultsAndWriteValidation(t *testing.T) {
	if got := defaultAppSettings().DingTalkMessageType; got != dingtalkMessageTypeMarkdown {
		t.Fatalf("expected markdown DingTalk message type default, got %q", got)
	}

	settings, err := settingsFromValue(json.RawMessage(`{"localePreference":"auto","dingtalkMessageType":"feedCard","monthlyBudget":"2333"}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.DingTalkMessageType != dingtalkMessageTypeMarkdown || settings.MonthlyBudget != "2333" {
		t.Fatalf("expected invalid stored DingTalk type to recover only that field, got %#v", settings)
	}

	settings, err = mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"dingtalkMessageType":"text"}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.DingTalkMessageType != dingtalkMessageTypeText {
		t.Fatalf("expected text DingTalk type, got %q", settings.DingTalkMessageType)
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"dingtalkMessageType":"actionCard"}`)); err == nil {
		t.Fatal("expected unsupported DingTalk message type write to fail")
	}
}

func TestDingTalkTemplateDefaultsAndWriteValidation(t *testing.T) {
	settings := defaultAppSettings()
	if settings.DingTalkTitleTemplate != "" || settings.DingTalkContentTemplate != "" {
		t.Fatalf("expected empty DingTalk template defaults, got %#v", settings)
	}

	recovered, err := settingsFromValue(json.RawMessage(`{"localePreference":"auto","dingtalkTitleTemplate":"标题","dingtalkContentTemplate":"正文","monthlyBudget":"2333"}`))
	if err != nil {
		t.Fatal(err)
	}
	if recovered.DingTalkTitleTemplate != "标题" || recovered.DingTalkContentTemplate != "正文" || recovered.MonthlyBudget != "2333" {
		t.Fatalf("expected DingTalk templates to survive settings recovery, got %#v", recovered)
	}

	recovered, err = settingsFromValue(json.RawMessage(`{"localePreference":"auto","dingtalkTitleTemplate":"` + strings.Repeat("a", dingtalkTitleTemplateMaxRunes+1) + `","dingtalkContentTemplate":42,"monthlyBudget":"2333"}`))
	if err != nil {
		t.Fatal(err)
	}
	if recovered.DingTalkTitleTemplate != "" || recovered.DingTalkContentTemplate != "" || recovered.MonthlyBudget != "2333" {
		t.Fatalf("expected stored invalid DingTalk templates to recover only those fields, got %#v", recovered)
	}

	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"dingtalkTitleTemplate":"`+strings.Repeat("a", dingtalkTitleTemplateMaxRunes+1)+`"}`)); err == nil {
		t.Fatal("expected overly long DingTalk title template write to fail")
	}
	if _, err := mergeSettingsForWrite(defaultAppSettings(), json.RawMessage(`{"dingtalkContentTemplate":"`+strings.Repeat("a", dingtalkContentTemplateMaxRunes+1)+`"}`)); err == nil {
		t.Fatal("expected overly long DingTalk content template write to fail")
	}
}
