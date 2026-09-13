/**
 * 汇率适配器、设置页和订阅表单共享的货币数据。
 *
 * 支持集合固定为 Frankfurter、fawazahmed0/exchange-api 与 FloatRates 可互补覆盖的法币集合。
 * 三方少量漂移由汇率 store 补齐并提示；标签和符号运行时由 Intl 派生，让列表保持紧凑且支持 locale。
 */
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";
import {
  SUPPORTED_EXCHANGE_RATE_CURRENCIES,
  type SupportedExchangeRateCurrency,
} from "@renewlet/shared/schemas/exchange-rates";

export {
  SUPPORTED_EXCHANGE_RATE_CURRENCIES,
  type SupportedExchangeRateCurrency,
};

const SUPPORTED_EXCHANGE_RATE_CURRENCY_SET = new Set<string>(SUPPORTED_EXCHANGE_RATE_CURRENCIES);

/** 产品级常用货币顺序：只用于生成空配置/新用户的默认货币管理顺序。 */
export const COMMON_CURRENCY_PRIORITY = [
  "CNY", "USD", "EUR", "GBP", "AUD", "TRY", "NGN", "ARS", "PHP",
] as const satisfies readonly SupportedExchangeRateCurrency[];

const COMMON_CURRENCY_PRIORITY_INDEX = new Map<string, number>(
  COMMON_CURRENCY_PRIORITY.map((currency, index) => [currency, index]),
);

export function isSupportedExchangeRateCurrency(value: string): value is SupportedExchangeRateCurrency {
  return SUPPORTED_EXCHANGE_RATE_CURRENCY_SET.has(value);
}

export function orderCurrencyItemsByCommonPriority<T extends { value: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const aRank = COMMON_CURRENCY_PRIORITY_INDEX.get(a.value);
    const bRank = COMMON_CURRENCY_PRIORITY_INDEX.get(b.value);
    if (aRank === undefined && bRank === undefined) return 0;
    if (aRank === undefined) return 1;
    if (bRank === undefined) return -1;
    return aRank - bRank;
  });
}

export function getIntlCurrencyName(currency: string, locale: Locale = DEFAULT_LOCALE): string {
  try {
    const displayNames = new Intl.DisplayNames([locale], { type: "currency" });
    return displayNames.of(currency) ?? currency;
  } catch {
    return currency;
  }
}

export function getIntlCurrencySymbol(currency: string, locale: Locale = DEFAULT_LOCALE): string {
  try {
    const narrowParts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    }).formatToParts(0);
    const narrowSymbol = narrowParts.find((part) => part.type === "currency")?.value;
    if (narrowSymbol && (currency === "USD" || narrowSymbol !== "$")) return narrowSymbol;

    const symbolParts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "symbol",
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return symbolParts.find((part) => part.type === "currency")?.value ?? narrowSymbol ?? currency;
  } catch {
    return currency;
  }
}

// 只保留最近一种展示身份，语言或货币改变即重算；不持久化，也不随历史导入代码无限增长。
let narrowSymbol: { currency: string; locale: Locale; value: string } | undefined;

export function getIntlCurrencyNarrowSymbol(currency: string, locale: Locale = DEFAULT_LOCALE): string {
  try {
    if (narrowSymbol?.currency === currency && narrowSymbol.locale === locale) return narrowSymbol.value;
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    }).formatToParts(0);
    const value = parts.find((part) => part.type === "currency")?.value ?? currency;
    narrowSymbol = { currency, locale, value };
    return value;
  } catch {
    return currency;
  }
}

export interface IntlCurrencyIdentityLabel {
  code: string;
  name: string;
  symbol: string;
  label: string;
}

function isCurrencySymbolCode(symbol: string, code: string): boolean {
  return symbol.trim().toUpperCase() === code;
}

function formatCurrencyIdentityLabel(code: string, name: string, symbol: string): string {
  if (isCurrencySymbolCode(symbol, code)) {
    return name === code ? code : `${code} ${name}`;
  }
  return `${symbol} ${name} (${code})`;
}

export function getIntlCurrencyIdentityLabel(currency: string, locale: Locale = DEFAULT_LOCALE): IntlCurrencyIdentityLabel {
  const code = currency.toUpperCase();
  const name = getIntlCurrencyName(code, locale);
  const symbol = getIntlCurrencySymbol(code, locale);
  const label = formatCurrencyIdentityLabel(code, name, symbol);

  return { code, name, symbol, label };
}

export function getIntlCurrencyOptionLabel(currency: string, locale: Locale = DEFAULT_LOCALE): string {
  return getIntlCurrencyIdentityLabel(currency, locale).label;
}
