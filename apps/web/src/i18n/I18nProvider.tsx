/**
 * i18n Provider 与格式化能力聚合层。
 *
 * 状态链路：
 *   自动初始语言 -> Lingui catalog -> document/api
 *   私有远端同步 -> state/document/api
 *   设置页本地预览 -> state/document/api，不提前写首屏缓存
 *   已保存语言 -> state/document/api + 显式偏好缓存
 *
 * 注意：locale 切换必须等 catalog 加载完成后原子激活；迟到请求不能修改任何全局语言状态。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { I18nProvider as LinguiProvider } from "@lingui/react";
import { setApiLocale } from "@/i18n/api-locale";
import {
  clearAccountLocaleProjection,
  detectBrowserLocale,
  getInitialLocale,
  isLocale,
  localeForPreference,
  localizedLabel,
  readAccountLocaleProjection,
  writeAccountLocaleProjection,
  type Locale,
  type LocalePreference,
  type LocalizedLabels,
} from "@/i18n/locales";
import { getProductCurrentUserId, subscribeProductSession } from "@/services/product-session";
import { activateLoadedLocale, linguiI18n, loadLocaleCatalog, translate, type MessageKey, type MessageParams } from "@/i18n/messages";
import { formatCurrency as formatCurrencyValue } from "@/lib/currency";
import { dateOnlyMessageParams, type DateOnly } from "@/lib/time/date-only";
import { reportClientError } from "@/lib/report-client-error";

interface I18nContextValue {
  locale: Locale;
  previewLocalePreference: (preference: LocalePreference) => void;
  commitLocalePreference: (preference: LocalePreference) => void;
  syncRemoteLocalePreference: (preference: LocalePreference) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
  formatDateOnly: (date: DateOnly | string, style?: "short" | "monthDay" | "full") => string;
  formatDateTime: (date: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (amount: number | string, currency: string) => string;
  label: (labels: LocalizedLabels) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function applyDocumentLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

/** 构建 Provider 外调用 `useI18n` 时的保守兜底，避免错误边界二次崩溃。 */
function createFallbackI18nValue(): I18nContextValue {
  const locale = getInitialLocale();
  const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
  return {
    locale,
    previewLocalePreference: () => undefined,
    commitLocalePreference: () => undefined,
    syncRemoteLocalePreference: () => undefined,
    t,
    formatDateOnly: (date, style = "short") => {
      const parts = dateOnlyMessageParams(date, locale, style);
      if (style === "monthDay") return t("date.monthDay", parts);
      if (style === "full") return t("date.full", parts);
      return t("date.short", parts);
    },
    formatDateTime: (date, options) => {
      const valueDate = date instanceof Date ? date : new Date(date);
      if (Number.isNaN(valueDate.getTime())) return String(date);
      return new Intl.DateTimeFormat(locale, options).format(valueDate);
    },
    formatNumber: (valueNumber, options) => new Intl.NumberFormat(locale, options).format(valueNumber),
    formatCurrency: (amount, currency) => formatCurrencyValue(amount, currency, locale),
    label: (labelSet) => localizedLabel(labelSet, locale),
  };
}

/** 唯一提交 Lingui catalog、React locale、document.lang 与 API locale 的客户端状态机。 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [initialLocale] = useState(getInitialLocale);
  const [localeState, setLocaleState] = useState(() => ({ locale: initialLocale, catalogVersion: 0 }));
  const catalogRequestRef = useRef(0);

  useEffect(() => {
    applyDocumentLocale(initialLocale);
    setApiLocale(initialLocale);
  }, [initialLocale]);

  const requestLocale = useCallback((
    nextLocale: Locale,
    preference: LocalePreference,
    mode: "preview" | "commit" | "remote" | "session",
    ownerUserId: string | null = null,
  ) => {
    if (!isLocale(nextLocale)) return;

    const requestId = catalogRequestRef.current + 1;
    catalogRequestRef.current = requestId;

    void loadLocaleCatalog(nextLocale)
      .then((messages) => {
        if (catalogRequestRef.current !== requestId) return;
        if (ownerUserId && getProductCurrentUserId() !== ownerUserId) return;
        // catalog、React context、document 与 API header 必须在同一获胜请求内提交，不能暴露半切换状态。
        activateLoadedLocale(nextLocale, messages);
        setLocaleState((current) => ({
          locale: nextLocale,
          catalogVersion: current.catalogVersion + 1,
        }));
        applyDocumentLocale(nextLocale);
        setApiLocale(nextLocale);
        if (mode === "commit" || mode === "remote") {
          if (preference === "auto") {
            clearAccountLocaleProjection(ownerUserId ?? undefined);
          } else if (ownerUserId) {
            writeAccountLocaleProjection(ownerUserId, preference);
          }
        }
      })
      .catch((error: unknown) => {
        if (catalogRequestRef.current !== requestId) return;
        reportClientError(error, { source: "i18n.load-catalog", locale: nextLocale });
      });
  }, []);

  const previewLocalePreference = useCallback((preference: LocalePreference) => {
    requestLocale(localeForPreference(preference), preference, "preview");
  }, [requestLocale]);

  const commitLocalePreference = useCallback((preference: LocalePreference) => {
    const userId = getProductCurrentUserId();
    requestLocale(localeForPreference(preference), preference, "commit", userId);
  }, [requestLocale]);

  const syncRemoteLocalePreference = useCallback((preference: LocalePreference) => {
    const userId = getProductCurrentUserId();
    requestLocale(localeForPreference(preference), preference, "remote", userId);
  }, [requestLocale]);

  useEffect(() => subscribeProductSession(() => {
    const userId = getProductCurrentUserId();
    const projection = readAccountLocaleProjection(userId);
    requestLocale(projection ?? detectBrowserLocale(), projection ?? "auto", "session", userId);
  }), [requestLocale]);

  const value = useMemo<I18nContextValue>(() => {
    const t = (key: MessageKey, params?: MessageParams) => translate(localeState.locale, key, params);

    return {
      locale: localeState.locale,
      previewLocalePreference,
      commitLocalePreference,
      syncRemoteLocalePreference,
      t,
      formatDateOnly: (date, style = "short") => {
        const parts = dateOnlyMessageParams(date, localeState.locale, style);
        if (style === "monthDay") return t("date.monthDay", parts);
        if (style === "full") return t("date.full", parts);
        return t("date.short", parts);
      },
      formatDateTime: (date, options) => {
        const valueDate = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(valueDate.getTime())) return String(date);
        return new Intl.DateTimeFormat(localeState.locale, options).format(valueDate);
      },
      formatNumber: (valueNumber, options) => new Intl.NumberFormat(localeState.locale, options).format(valueNumber),
      formatCurrency: (amount, currency) => formatCurrencyValue(amount, currency, localeState.locale),
      label: (labelSet) => localizedLabel(labelSet, localeState.locale),
    };
  }, [commitLocalePreference, localeState, previewLocalePreference, syncRemoteLocalePreference]);

  return (
    <LinguiProvider i18n={linguiI18n}>
      <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    </LinguiProvider>
  );
}

/** 读取当前已提交语言；Provider 缺失时返回保守兜底，保证错误边界仍能渲染。 */
export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    return createFallbackI18nValue();
  }
  return context;
}
