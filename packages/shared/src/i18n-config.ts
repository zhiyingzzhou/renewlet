// 由 scripts/generate-server-i18n.mjs 生成；源语言、运行时回退和账号偏好是三个独立契约。
export const SUPPORTED_LOCALES = ["zh-CN", "en-US", "ru-RU"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const SOURCE_LOCALE: Locale = "zh-CN";
export const FALLBACK_LOCALE: Locale = "en-US";
export const DEFAULT_LOCALE_PREFERENCE = "auto" as const;
export const LOCALE_PREFERENCES = [DEFAULT_LOCALE_PREFERENCE, ...SUPPORTED_LOCALES] as const;

export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === DEFAULT_LOCALE_PREFERENCE || isLocale(value);
}

/** 无设备上下文时解析账号偏好；浏览器内的 auto 必须重新探测设备，不能调用此 helper。 */
export function resolveLocalePreference(preference: LocalePreference): Locale {
  return preference === DEFAULT_LOCALE_PREFERENCE ? FALLBACK_LOCALE : preference;
}
