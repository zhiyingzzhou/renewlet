/**
 * 货币展示工具（前端 UI 用）。
 *
 * 背景：
 * - 多个组件里都有 `new Intl.NumberFormat(...).format(...)` 的重复实现
 * - 集中到这里方便统一展示规则与异常兜底
 */
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { getIntlCurrencyNarrowSymbol } from "@/lib/currency-data";
import { moneyToNumber } from "@renewlet/shared/money";

// 走势无障碍摘要会连续格式化大量同语言金额；只复用一个 Intl 实例，不保存金额或账号数据。
let numberFormatter: { locale: string; value: Intl.NumberFormat } | undefined;

/** currency 来自用户配置和导入数据，非法值只能降级展示，不能让统计页崩溃。 */
export function formatCurrency(amount: number | string, currency: string, locale = DEFAULT_LOCALE): string {
  const currencyCode = normalizeCurrencyCode(currency);
  return `${formatCurrencySymbolAmount(amount, currencyCode, locale)} ${currencyCode}`;
}

export function formatCurrencySymbolAmount(amount: number | string, currency: string, locale = DEFAULT_LOCALE): string {
  const numericAmount = moneyToNumber(amount);
  const formattedAmount = formatCurrencyNumber(numericAmount, locale);
  const prefix = getCurrencyAmountPrefix(currency, locale);
  // 金额前缀只取窄符号；ISO code 由 `formatCurrency` 或相邻货币选择器承担，避免恢复 `US$`/`AU$` 这类地区前缀。
  return prefix ? `${prefix}${formattedAmount}` : formattedAmount;
}

/** 保留低于 0.01 个货币单位的非零事实，避免常规两位小数格式让用户误读为零。 */
export function formatCompactCurrencyAmount(amount: number | string, currency: string, locale = DEFAULT_LOCALE): string {
  const numericAmount = moneyToNumber(amount);
  if (numericAmount > 0 && numericAmount < 0.01) {
    return `< ${formatCurrencySymbolAmount(0.01, currency, locale)}`;
  }
  return formatCurrencySymbolAmount(numericAmount, currency, locale);
}

export function getCurrencyAmountPrefix(currency: string, locale = DEFAULT_LOCALE): string {
  const currencyCode = normalizeCurrencyCode(currency);
  const symbol = getIntlCurrencyNarrowSymbol(currencyCode, locale).trim();
  if (!symbol || symbol.toUpperCase() === currencyCode) return "";
  return symbol;
}

function normalizeCurrencyCode(currency: string): string {
  return currency.trim().toUpperCase() || currency;
}

function formatCurrencyNumber(amount: number, locale: string): string {
  try {
    if (numberFormatter?.locale !== locale) {
      numberFormatter = {
        locale,
        value: new Intl.NumberFormat(locale, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }),
      };
    }
    return numberFormatter.value.format(amount);
  } catch {
    return Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2);
  }
}
