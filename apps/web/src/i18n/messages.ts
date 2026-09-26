/**
 * Lingui catalog 入口。
 *
 * 架构位置：本文件是前端唯一翻译引擎边界，业务代码继续通过 `t/translate`
 * 读取文案，但底层不再维护自研函数 map。
 */
import { setupI18n, type I18n, type Messages } from "@lingui/core";
import type { Locale } from "@/i18n/locales";
import type { MessageKey } from "@/i18n/catalog-keys";

export type { MessageKey } from "@/i18n/catalog-keys";
export type MessageParams = Record<string, string | number | boolean | null | undefined>;

type CatalogModule = {
  messages: Messages;
};

const catalogLoaders = {
  "zh-CN": () => import("@/i18n/catalog-loaders/zh-CN"),
  "en-US": () => import("@/i18n/catalog-loaders/en-US"),
  "ru-RU": () => import("@/i18n/catalog-loaders/ru-RU"),
} satisfies Record<Locale, () => Promise<CatalogModule>>;

const loadedCatalogs = new Map<Locale, Messages>();
const loadingCatalogs = new Map<Locale, Promise<Messages>>();
const localeI18nCache = new Map<Locale, I18n>();

function createMissingHandler(locale: string, id: string) {
  if (import.meta.env.DEV) {
    console.warn(`[i18n] missing message "${id}" for ${locale}`);
  }
  return id;
}

function createLocaleI18n(locale: Locale, messages: Messages) {
  return setupI18n({
    locale,
    messages: { [locale]: messages },
    missing: createMissingHandler,
  });
}

export const linguiI18n = setupI18n({
  missing: createMissingHandler,
});

export async function loadLocaleCatalog(locale: Locale): Promise<Messages> {
  const loaded = loadedCatalogs.get(locale);
  if (loaded) return loaded;
  const loading = loadingCatalogs.get(locale);
  if (loading) return loading;
  // 生产构建必须消费 Vite Lingui 插件预编译后的 `.po` catalog；不要恢复 raw TS catalog 或 runtime compiler。
  const promise = catalogLoaders[locale]()
    .then((module) => {
      loadedCatalogs.set(locale, module.messages);
      localeI18nCache.set(locale, createLocaleI18n(locale, module.messages));
      return module.messages;
    })
    .finally(() => {
      // in-flight map 只负责并发去重；失败任务必须释放，后续显式切换才能重新加载 catalog。
      if (loadingCatalogs.get(locale) === promise) {
        loadingCatalogs.delete(locale);
      }
    });
  loadingCatalogs.set(locale, promise);
  return promise;
}

export function activateLoadedLocale(locale: Locale, messages: Messages): void {
  // 只激活当前 UI locale；同步 translate 使用独立实例，避免后台格式化偷偷切换全局 React 语言。
  linguiI18n.loadAndActivate({ locale, messages });
}

export async function loadAndActivateLocale(locale: Locale): Promise<void> {
  activateLoadedLocale(locale, await loadLocaleCatalog(locale));
}

export function translate(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  const instance = localeI18nCache.get(locale);
  return instance ? instance._(key, params) : key;
}
