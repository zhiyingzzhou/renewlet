package main

// 服务端 locale 测试保护 X-Renewlet-Locale 优先级和 catalog placeholder；通知/错误文案不能依赖前端 Lingui runtime。

import (
	"net/http"
	"testing"
)

func TestRequestLocalePrefersExplicitHeader(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "/api/app/example", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	req.Header.Set("X-Renewlet-Locale", "en-US")

	if got := requestLocale(req); got != localeEnUS {
		t.Fatalf("expected en-US, got %s", got)
	}

	req.Header.Set("X-Renewlet-Locale", "en-GB")
	if got := requestLocale(req); got != localeEnUS {
		t.Fatalf("expected unsupported explicit header to fall back to en-US, got %s", got)
	}

	for _, invalid := range []string{"fr-FR", "zh-Hant", "zh-CN, en-US", "zh-$$$"} {
		req.Header.Set("X-Renewlet-Locale", invalid)
		if got := requestLocale(req); got != localeEnUS {
			t.Fatalf("expected invalid explicit header %q to fall back to default locale, got %s", invalid, got)
		}
	}
}

func TestAcceptLanguageLocaleUsesHighestQualitySupportedLanguage(t *testing.T) {
	if got := acceptLanguageLocale(""); got != localeEnUS {
		t.Fatalf("expected empty Accept-Language to fall back to en-US, got %s", got)
	}
	if got := acceptLanguageLocale("en-US;q=0.7, zh-CN;q=0.9"); got != localeZhCN {
		t.Fatalf("expected zh-CN, got %s", got)
	}
	if got := acceptLanguageLocale("ru, en;q=0.8"); got != appLocale("ru-RU") {
		t.Fatalf("expected ru-RU for primary language ru, got %s", got)
	}
	if got := acceptLanguageLocale("fr-FR, en;q=0.8"); got != localeEnUS {
		t.Fatalf("expected en-US, got %s", got)
	}
	if got := acceptLanguageLocale("en-GB, zh-CN;q=0.2"); got != localeEnUS {
		t.Fatalf("expected en-US for en-GB, got %s", got)
	}
	if got := acceptLanguageLocale("en-US;q=0, zh-Hant;q=0.8"); got != localeZhCN {
		t.Fatalf("expected zh-CN for zh-Hant fallback, got %s", got)
	}
	if got := acceptLanguageLocale("zh-CN;q=0.8junk, en-US;q=0.7"); got != localeEnUS {
		t.Fatalf("expected malformed quality item to be skipped, got %s", got)
	}
	if got := acceptLanguageLocale("zh-CN;q=1.1, en-US;q=0.4"); got != localeEnUS {
		t.Fatalf("expected out-of-range quality item to be skipped, got %s", got)
	}
	if got := acceptLanguageLocale("zh-CN;q=NaN, en-US;q=0.4"); got != localeEnUS {
		t.Fatalf("expected non-finite quality item to be skipped, got %s", got)
	}
	if got := acceptLanguageLocale("zh-CN;q=0x1, en-US;q=0.4"); got != localeEnUS {
		t.Fatalf("expected non-decimal quality item to be skipped, got %s", got)
	}
	if got := acceptLanguageLocale("zh-CN;q=0.1234, en-US;q=0.4"); got != localeEnUS {
		t.Fatalf("expected over-precise quality item to be skipped, got %s", got)
	}
	if got := acceptLanguageLocale("zh-$$$;q=0.9, en-US;q=0.8"); got != localeEnUS {
		t.Fatalf("expected invalid language tag to be skipped, got %s", got)
	}
	if got := acceptLanguageLocale("*;q=0.9, zh-CN;q=0.8"); got != localeEnUS {
		t.Fatalf("expected wildcard to select the default locale by quality, got %s", got)
	}
	if got := acceptLanguageLocale("zh-CN;q=0.5, en-US;q=0.5"); got != localeZhCN {
		t.Fatalf("expected original order to break equal-quality ties, got %s", got)
	}
}

func TestAccountContentLocaleUsesExplicitPreferenceOrEnglishFallback(t *testing.T) {
	settings := defaultAppSettings()
	if got := accountContentLocale(settings); got != localeEnUS {
		t.Fatalf("expected auto account content to fall back to en-US, got %s", got)
	}
	settings.LocalePreference = string(preferenceZhCN)
	if got := accountContentLocale(settings); got != localeZhCN {
		t.Fatalf("expected explicit zh-CN account preference, got %s", got)
	}
	settings.LocalePreference = "fr-FR"
	if got := accountContentLocale(settings); got != localeEnUS {
		t.Fatalf("expected invalid account preference to fall back to en-US, got %s", got)
	}
}

func TestServerI18nLocalizer(t *testing.T) {
	if got := normalizeAppLocale("en-GB"); got != localeEnUS {
		t.Fatalf("expected en-US, got %s", got)
	}
	if got := serverText(localeEnUS, "common.requestBodyTooLarge"); got != "Request body is too large" {
		t.Fatalf("unexpected localized text: %q", got)
	}
	if got := serverFormat(localeZhCN, "common.requiredField", map[string]interface{}{"label": "Webhook URL"}); got != "Webhook URL 不能为空" {
		t.Fatalf("unexpected formatted text: %q", got)
	}
	if got := serverFormat(localeEnUS, "notification.content.itemLine", map[string]interface{}{
		"name":       "Acme",
		"targetDate": "2026-05-17",
		"amount":     "18",
		"currency":   "USD",
		"extra":      "3 days before",
	}); got != "- Acme: 2026-05-17, 18 USD (3 days before)" {
		t.Fatalf("unexpected named placeholder output: %q", got)
	}
	if got := serverText(localeEnUS, "missing.key"); got != "missing.key" {
		t.Fatalf("expected missing key fallback, got %q", got)
	}
}
