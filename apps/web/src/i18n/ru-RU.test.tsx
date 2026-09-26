// ru-RU 测试保护第三种界面语言：catalog 完整、复数与日期格式、持久化 labels 契约和切换/缓存链路。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "@lingui/conf";
import { getCatalogs } from "@lingui/cli/api";
import { I18nProvider, useI18n } from "@/i18n/I18nProvider";
import { getApiLocale } from "@/i18n/api-locale";
import { MESSAGE_KEYS } from "@/i18n/catalog-keys";
import { labelsFromCatalog } from "@/i18n/label-messages";
import {
  getInitialLocale,
  localizedLabel,
  type LocalizedLabels,
  normalizeLocale,
  readAccountLocaleProjection,
} from "@/i18n/locales";
import { loadLocaleCatalog, translate } from "@/i18n/messages";
import { formatDateOnlyChinese, formatDateOnlyForDisplay, formatDateOnlyMonthDay } from "@/lib/time/date-only";
import { writeProductSession } from "@/services/product-session";
import { CURRENCY_OPTIONS } from "@/types/subscription";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{children}</I18nProvider>
      </QueryClientProvider>
    );
  };
}

beforeAll(async () => {
  await loadLocaleCatalog("ru-RU");
});

describe("ru-RU catalog", () => {
  it("keeps English as a complete locale", () => {
    expect(translate("en-US", "nav.subscriptions")).toBe("Subscriptions");
    expect(translate("en-US", "common.save")).toBe("Save");
  });

  it("loads Russian messages", () => {
    expect(translate("ru-RU", "nav.subscriptions")).toBe("Подписки");
    expect(translate("ru-RU", "nav.settings")).toBe("Настройки");
    expect(translate("ru-RU", "common.save")).toBe("Сохранить");
    expect(translate("ru-RU", "common.cancel")).toBe("Отмена");
    expect(translate("ru-RU", "locale.ruRU")).toBe("Русский");
    expect(translate("en-US", "locale.ruRU")).toBe("Русский");
  });

  it("never renders a raw message id", () => {
    const raw = MESSAGE_KEYS.filter((key) => {
      const value = translate("ru-RU", key, { count: 2, days: 2, hours: 2, date: "05.03.2026" });
      return value === key || value.trim() === "";
    });
    expect(raw).toEqual([]);
  });

  it("uses Russian plural forms", () => {
    const items = (count: number) => translate("ru-RU", "common.items", { count });
    expect(items(1)).toBe("1 элемент");
    expect(items(2)).toBe("2 элемента");
    expect(items(5)).toBe("5 элементов");
    expect(items(11)).toBe("11 элементов");
    expect(items(21)).toBe("21 элемент");
    expect(translate("ru-RU", "reminder.days", { days: 3 })).toBe("За 3 дня");
    expect(translate("en-US", "reminder.days", { days: 3 })).toBe("3 days before");
  });

  it("falls back to English when a Russian translation is missing", async () => {
    const config = getConfig({ cwd: clientDir, configPath: path.join(clientDir, "lingui.config.ts") });
    const catalog = (await getCatalogs(config)).find((item) => item.path.endsWith("/common"));
    expect(catalog).toBeDefined();
    const readAll = catalog!.readAll.bind(catalog);
    catalog!.readAll = async (locales) => {
      const catalogs = await readAll(locales);
      const russian = catalogs["ru-RU"];
      if (russian?.["nav.subscriptions"]) russian["nav.subscriptions"].translation = "";
      return catalogs;
    };

    const { messages } = await catalog!.getTranslations("ru-RU", {
      fallbackLocales: config.fallbackLocales,
      sourceLocale: config.sourceLocale,
    });

    expect(messages["nav.subscriptions"]).toBe("Subscriptions");
    expect(messages["nav.settings"]).toBe("Настройки");
  });
});

describe("ru-RU formatting", () => {
  it("formats date-only values as dd.MM.yyyy without touching stored dates", () => {
    expect(formatDateOnlyForDisplay("2026-03-05", "ru-RU")).toBe("05.03.2026");
    expect(formatDateOnlyMonthDay("2026-03-05", "ru-RU")).toBe("05.03");
    expect(formatDateOnlyChinese("2026-03-05", "ru-RU")).toBe("05.03.2026");
    expect(formatDateOnlyChinese("2026-03-05", "en-US")).toBe(translate("en-US", "date.full", { year: 2026, month: "03", day: "05" }));
    expect(formatDateOnlyForDisplay("2026-03-05", "zh-CN")).toBe(translate("zh-CN", "date.short", { year: 2026, month: 3, day: 5 }));
  });

  it("formats numbers and currency with ru-RU separators", async () => {
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });
    act(() => result.current.commitLocalePreference("ru-RU"));
    await waitFor(() => expect(result.current.locale).toBe("ru-RU"));

    expect(result.current.formatNumber(1234.5)).toBe(new Intl.NumberFormat("ru-RU").format(1234.5));
    expect(result.current.formatNumber(1234.5)).toContain(",5");
    expect(result.current.formatCurrency(1234.5, "USD")).toContain("1");
    expect(result.current.formatDateOnly("2026-03-05", "full")).toBe("05.03.2026");
  });
});

describe("ru-RU labels", () => {
  it("translates unchanged built-in labels while keeping the persisted shape bilingual", () => {
    const stored = labelsFromCatalog("status.active");
    expect(Object.keys(stored).sort()).toEqual(["en-US", "zh-CN"]);
    expect(localizedLabel(stored, "ru-RU")).toBe(translate("ru-RU", "status.active"));
    expect(localizedLabel(stored, "en-US")).toBe("Active");
  });

  it("shows user-entered labels as-is with the English label as fallback", () => {
    const userLabels: LocalizedLabels = { "zh-CN": "自定义", "en-US": "My card" };
    expect(localizedLabel(userLabels, "ru-RU")).toBe("My card");
  });

  it("derives Russian currency names from Intl", () => {
    const usd = CURRENCY_OPTIONS.find((option) => option.value === "USD");
    expect(usd).toBeDefined();
    const russian = localizedLabel(usd!.labels, "ru-RU");
    expect(russian).toContain("USD");
    expect(russian).not.toBe(localizedLabel(usd!.labels, "en-US"));
  });
});

describe("ru-RU locale selection", () => {
  it("maps Russian browser tags to ru-RU", () => {
    expect(normalizeLocale("ru")).toBe("ru-RU");
    expect(normalizeLocale("ru-BY")).toBe("ru-RU");
    expect(normalizeLocale("RU_ru")).toBe("ru-RU");
    expect(normalizeLocale("uk-UA")).toBe("en-US");
  });

  it("switches without reload and persists the explicit choice for the account", async () => {
    writeProductSession({
      type: "session",
      session: { expiresAt: "2026-12-31T00:00:00.000Z" },
      user: { id: "user-ru", email: "ru@example.com", name: "ru", role: "user", banned: false },
    });
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    act(() => result.current.commitLocalePreference("ru-RU"));

    await waitFor(() => expect(result.current.locale).toBe("ru-RU"));
    expect(result.current.t("nav.subscriptions")).toBe("Подписки");
    expect(document.documentElement.lang).toBe("ru-RU");
    expect(getApiLocale()).toBe("ru-RU");
    expect(readAccountLocaleProjection("user-ru")).toBe("ru-RU");
    expect(getInitialLocale()).toBe("ru-RU");

    act(() => result.current.commitLocalePreference("en-US"));

    await waitFor(() => expect(result.current.locale).toBe("en-US"));
    expect(result.current.t("nav.subscriptions")).toBe("Subscriptions");
    expect(readAccountLocaleProjection("user-ru")).toBe("en-US");
  });
});
