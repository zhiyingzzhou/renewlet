/**
 * locale 基础规则。
 *
 * 架构位置：支持集合来自 shared 生成物；本模块只拥有浏览器探测、首屏账号缓存和双语持久化 label 读取。
 *
 * 注意：新增语言时必须补齐 Lingui catalog，并用同构夹具锁住浏览器、Go 与 Worker 的匹配规则。
 */
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
  type Locale,
  type LocalePreference,
} from "@renewlet/shared/i18n-config";
import {
  clearAccountLocaleProjection,
  readAccountLocaleProjection,
  writeAccountLocaleProjection,
} from "@/i18n/account-locale-projection";
import { getProductCurrentUserId } from "@/services/product-session";

export { SUPPORTED_LOCALES, isLocale, type Locale, type LocalePreference };

/**
 * 持久化配置 labels 的固定语言集合；它是 custom-config 存储契约，不随界面语言扩展。
 * 其它界面语言显示时回退到内置 catalog 译文或英文 label。
 */
export const LABEL_LOCALES = ["zh-CN", "en-US"] as const satisfies readonly Locale[];
export type LabelLocale = (typeof LABEL_LOCALES)[number];
export type LocalizedLabels = Record<LabelLocale, string>;

export const DEFAULT_LOCALE: Locale = FALLBACK_LOCALE;

function primaryLanguage(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] ?? "";
}

/** 将设备语言标签收敛到界面语言；先精确匹配，再按基础语言匹配（中文变体归中文），其它回退英文。 */
export function normalizeLocale(value: unknown): Locale {
  if (isLocale(value)) return value;
  if (typeof value !== "string") return DEFAULT_LOCALE;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === normalized);
  if (exact) return exact;
  const language = primaryLanguage(normalized);
  return SUPPORTED_LOCALES.find((locale) => primaryLanguage(locale) === language) ?? DEFAULT_LOCALE;
}

/** 设备推断只读取浏览器第一首选语言，不把 Accept-Language 或账号 settings 混入客户端职责。 */
export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const language = navigator.languages?.[0] || navigator.language;
  return normalizeLocale(language);
}

/** 明确偏好直接覆盖设备；auto 每次解析当前设备，不能复用后台的英文 fallback helper。 */
export function localeForPreference(preference: LocalePreference): Locale {
  return preference === "auto" ? detectBrowserLocale() : preference;
}

/** React 启动语言与同步 bootstrap 保持同一优先级：明确账号缓存优先，其次设备首选语言。 */
export function getInitialLocale(): Locale {
  return readAccountLocaleProjection(getProductCurrentUserId()) ?? detectBrowserLocale();
}

export { clearAccountLocaleProjection, readAccountLocaleProjection, writeAccountLocaleProjection };

export function labels(zhCN: string, enUS: string): LocalizedLabels {
  return { "zh-CN": zhCN, "en-US": enUS };
}

export function isLabelLocale(locale: Locale): locale is LabelLocale {
  return (LABEL_LOCALES as readonly string[]).includes(locale);
}

function labelIdentity(source: LocalizedLabels): string {
  return `${source["zh-CN"]}\u0000${source["en-US"]}`;
}

const derivedLabelResolvers = new Map<string, (locale: Locale) => string>();

/**
 * 为可由运行时推导的 labels（内置 catalog 标签、Intl 货币名）登记其它界面语言的解析函数；
 * 持久化副本只要与登记值完全一致（用户未改名）就按当前界面语言显示，用户自定义文本回退英文原文。
 */
export function withDerivedLabels(source: LocalizedLabels, resolve: (locale: Locale) => string): LocalizedLabels {
  derivedLabelResolvers.set(labelIdentity(source), resolve);
  return source;
}

export function localizedLabel(source: LocalizedLabels, locale: Locale): string {
  const value = isLabelLocale(locale)
    ? source[locale]
    : derivedLabelResolvers.get(labelIdentity(source))?.(locale) || source["en-US"];
  if (!value) {
    throw new Error(`Missing localized label for ${locale}`);
  }
  return value;
}
