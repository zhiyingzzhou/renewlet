import { describe, expect, it } from "vitest";
import { accountContentLocale, requestLocale } from "./server-i18n";

function localeRequest(headers: HeadersInit = {}): Request {
  return new Request("https://renewlet.example/api/app/example", { headers });
}

describe("server locale resolution", () => {
  it("prefers a valid explicit locale over Accept-Language", () => {
    expect(requestLocale(localeRequest({
      "X-Renewlet-Locale": "en-US",
      "Accept-Language": "zh-CN,zh;q=0.9",
    }))).toBe("en-US");
  });

  it.each(["fr-FR", "zh-Hant", "zh-CN, en-US", "zh-$$$"])(
    "falls back to English for invalid explicit locale %j without consulting Accept-Language",
    (explicitLocale) => {
      expect(requestLocale(localeRequest({
        "X-Renewlet-Locale": explicitLocale,
        "Accept-Language": "zh-CN",
      }))).toBe("en-US");
    },
  );

  it.each([
    ["", "en-US"],
    ["en-US;q=0.7, zh-CN;q=0.9", "zh-CN"],
    ["fr-FR, en;q=0.8", "en-US"],
    ["en-GB, zh-CN;q=0.2", "en-US"],
    ["en-US;q=0, zh-Hant;q=0.8", "zh-CN"],
    ["zh-CN;q=0.8junk, en-US;q=0.7", "en-US"],
    ["zh-CN;q=1.1, en-US;q=0.4", "en-US"],
    ["zh-CN;q=NaN, en-US;q=0.4", "en-US"],
    ["zh-CN;q=0x1, en-US;q=0.4", "en-US"],
    ["zh-CN;q=0.1234, en-US;q=0.4", "en-US"],
    ["zh-$$$;q=0.9, en-US;q=0.8", "en-US"],
    ["*;q=0.9, zh-CN;q=0.8", "en-US"],
    ["zh-CN;q=0.5, en-US;q=0.5", "zh-CN"],
    ["ru-RU,ru;q=0.9,en;q=0.8", "ru-RU"],
    ["ru, en;q=0.8", "ru-RU"],
  ] as const)("resolves Accept-Language %j as %s", (acceptLanguage, expected) => {
    expect(requestLocale(localeRequest({ "Accept-Language": acceptLanguage }))).toBe(expected);
  });

  it("uses explicit account preferences and English for auto background content", () => {
    expect(accountContentLocale("zh-CN")).toBe("zh-CN");
    expect(accountContentLocale("en-US")).toBe("en-US");
    expect(accountContentLocale("ru-RU")).toBe("ru-RU");
    expect(accountContentLocale("auto")).toBe("en-US");
  });
});
