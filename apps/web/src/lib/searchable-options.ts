/**
 * 可搜索下拉选项构建工具。
 *
 * 架构位置：
 * - Settings/订阅表单中的货币、时区等下拉共用这里的关键词和匹配策略。
 * - UI 组件只负责展示和交互，不复制搜索算法。
 *
 * 注意： 搜索评分只决定命中与否；展示顺序由调用方传入的业务顺序决定。
 */
import { formatTimeZoneOffset } from "@/lib/time/time-zone";
import { getIntlCurrencyIdentityLabel } from "@/lib/currency-data";
import type { ConfigItem } from "@/types/config";
import type { CurrencyOption, CurrencyRegion } from "@/types/subscription";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, localizedLabel, type Locale } from "@/i18n/locales";
import { translate } from "@/i18n/messages";

/** 可搜索 Select/Command 组件使用的通用选项结构。 */
export interface SearchableSelectOption {
  value: string;
  label: string;
  keywords?: string[];
  disabled?: boolean;
}

const CURRENCY_REGION_KEYWORDS: Record<CurrencyRegion, string[]> = {
  asia: ["亚洲", "asia"],
  europe: ["欧洲", "europe"],
  americas: ["美洲", "america", "americas", "north america", "south america"],
  oceania: ["大洋洲", "oceania"],
  africa: ["非洲", "africa"],
  global: [],
};

const SEARCH_SEPARATOR_PATTERN = /[\s/_().,$￥¥€£₩₹₺₪฿₱+\-:]+/g;
const CURRENCY_SYMBOL_QUERY_PATTERN = /^[,$￥¥€£₩₹₺₪฿₱]+$/;
const SHORT_SEARCH_MAX_LENGTH = 1;

interface SearchPattern {
  normalized: string;
  compact: string;
  hasCompact: boolean;
  parts: string[];
  currencySymbolOnly: boolean;
  short: boolean;
  canUseSubsequenceFallback: boolean;
}

/** 归一化搜索文本，去掉重音并统一小写，提升跨语言搜索命中率。 */
export function normalizeSearchText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function compactSearchText(input: string): string {
  // 紧凑匹配会移除空白、分隔符和常见货币符号，让 `US D`、`USD`、`$` 类输入尽量落到同一搜索口径。
  return normalizeSearchText(input).replace(SEARCH_SEPARATOR_PATTERN, "");
}

function createSearchPattern(search: string): SearchPattern | null {
  const normalized = normalizeSearchText(search);
  if (!normalized) return null;

  const compact = compactSearchText(normalized);
  const hasCompact = compact.length > 0;
  const parts = normalized.split(/\s+/).filter(Boolean);

  return {
    normalized,
    compact,
    hasCompact,
    parts,
    currencySymbolOnly: CURRENCY_SYMBOL_QUERY_PATTERN.test(normalized),
    short: isShortSearchQuery(normalized, compact),
    canUseSubsequenceFallback: hasCompact && shouldUseSubsequenceFallback(compact),
  };
}

function isShortSearchQuery(normalizedSearch: string, compactSearch: string): boolean {
  const searchLength = Array.from(compactSearch || normalizedSearch.replace(/\s+/g, "")).length;
  return searchLength > 0 && searchLength <= SHORT_SEARCH_MAX_LENGTH;
}

function searchTokens(normalizedValue: string): string[] {
  return normalizedValue.split(SEARCH_SEPARATOR_PATTERN).filter(Boolean);
}

function startsWithSearchToken(normalizedValue: string, pattern: SearchPattern): boolean {
  return searchTokens(normalizedValue).some((token) => (
    token.startsWith(pattern.normalized)
    || (pattern.hasCompact && compactSearchText(token).startsWith(pattern.compact))
  ));
}

/**
 * 对候选文本计算搜索匹配分数。
 *
 * 评分保留精确、前缀和 token 前缀；只有非短查询才允许包含、多词包含和子序列兜底。
 */
export function rankSearchText(values: readonly string[], search: string): number {
  const pattern = createSearchPattern(search);
  if (!pattern) return 1;

  let best = 0;
  for (const raw of values) {
    const value = normalizeSearchText(raw);
    const compactValue = compactSearchText(raw);
    if (!value && !compactValue) continue;

    if (
      value === pattern.normalized
      || (pattern.hasCompact && compactValue === pattern.compact)
    ) {
      best = Math.max(best, 1);
    } else if (
      value.startsWith(pattern.normalized)
      || (pattern.hasCompact && compactValue.startsWith(pattern.compact))
    ) {
      best = Math.max(best, 0.9);
    } else if (startsWithSearchToken(value, pattern)) {
      best = Math.max(best, 0.85);
    } else if (pattern.currencySymbolOnly && value.includes(pattern.normalized)) {
      best = Math.max(best, 0.8);
    } else if (pattern.short) {
      // 短查询不能用包含/子序列扩散命中，否则货币列表会被 currency/global 这类低信息别名污染。
      continue;
    } else if (
      value.includes(pattern.normalized)
      || (pattern.hasCompact && compactValue.includes(pattern.compact))
    ) {
      best = Math.max(best, 0.7);
    } else if (pattern.parts.length > 1 && pattern.parts.every((part) => value.includes(part))) {
      best = Math.max(best, 0.55);
    } else if (pattern.canUseSubsequenceFallback && isSubsequence(pattern.compact, compactValue)) {
      best = Math.max(best, 0.35);
    }
  }

  return best;
}

/** 统一 option 搜索字段，避免组件和领域列表各自拼接 value/label/keywords 后规则分叉。 */
export function rankSearchableOption(
  option: Pick<SearchableSelectOption, "value" | "label" | "keywords">,
  search: string,
): number {
  return rankSearchText([option.value, option.label, ...(option.keywords ?? [])], search);
}

export function matchesSearchableOption(
  option: Pick<SearchableSelectOption, "value" | "label" | "keywords">,
  search: string,
): boolean {
  return rankSearchableOption(option, search) > 0;
}

function shouldUseSubsequenceFallback(compactSearch: string): boolean {
  return compactSearch.length >= 4;
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function uniq(values: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const next = value?.trim();
    if (!next) continue;
    const key = normalizeSearchText(next);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

/** 为货币生成多语言/符号/区域关键词，支持 CNY、人民币、¥ 等搜索方式。 */
export function createCurrencyKeywords(
  currency: Pick<CurrencyOption, "value" | "labels" | "region">,
): string[] {
  const zhLabel = localizedLabel(currency.labels, "zh-CN");
  const enLabel = localizedLabel(currency.labels, "en-US");
  const zhIdentity = getIntlCurrencyIdentityLabel(currency.value, "zh-CN");
  const enIdentity = getIntlCurrencyIdentityLabel(currency.value, "en-US");
  const otherIdentities = SUPPORTED_LOCALES
    .filter((locale) => locale !== "zh-CN" && locale !== "en-US")
    .map((locale) => getIntlCurrencyIdentityLabel(currency.value, locale));
  return uniq([
    currency.value,
    currency.value.toLowerCase(),
    zhLabel,
    enLabel,
    zhIdentity.label,
    enIdentity.label,
    zhIdentity.symbol,
    enIdentity.symbol,
    zhIdentity.name,
    enIdentity.name,
    ...otherIdentities.flatMap((identity) => [identity.label, identity.symbol, identity.name]),
    ...CURRENCY_REGION_KEYWORDS[currency.region],
  ]);
}

/** 当前值即使已被禁用也按货币管理位置保留为 disabled 选项，避免编辑旧订阅时丢失显示上下文。 */
export function createCurrencySelectOptions(params: {
  currencies: readonly ConfigItem[];
  currencyOptions: readonly CurrencyOption[];
  includeDisabledCurrent?: string;
  locale?: Locale;
}): SearchableSelectOption[] {
  const locale = params.locale ?? DEFAULT_LOCALE;
  const optionByValue = new Map(params.currencyOptions.map((option) => [option.value, option]));
  const currentValue = params.includeDisabledCurrent;

  const items: SearchableSelectOption[] = [];

  for (const item of params.currencies) {
    const disabled = item.enabled === false;
    if (disabled && item.value !== currentValue) continue;
    const option = optionByValue.get(item.value);
    const label = option ? localizedLabel(option.labels, locale) : localizedLabel(item.labels, locale);
    items.push({
      value: item.value,
      label: disabled ? translate(locale, "common.optionDisabled", { label }) : label,
      ...(disabled ? { disabled: true } : {}),
      keywords: option ? createCurrencyKeywords(option) : uniq([item.value, localizedLabel(item.labels, "zh-CN"), localizedLabel(item.labels, "en-US")]),
    });
  }

  return items;
}

/** 为 IANA 时区生成城市、区域和当前 offset 关键词。 */
export function createTimeZoneKeywords(timeZone: string, now = new Date()): string[] {
  const [area, city] = timeZone.split("/");
  const cityWords = city?.replace(/_/g, " ");
  const offset = formatTimeZoneOffset(timeZone, now);
  const offsetLower = offset.toLowerCase();
  const offsetGmt = offset.replace(/^UTC/i, "GMT");
  const offsetWithoutColon = offset.replace(":", "");
  // 同时提供 `UTC+08:00`、`GMT+08:00`、`utc0800`、`+0800` 等变体，覆盖用户搜索时常见的 offset 写法。
  const offsetCompact = offset
    .replace(/^UTC/i, "utc")
    .replace(":", "")
    .replace("+", "");

  return uniq([
    timeZone,
    timeZone.replace(/_/g, " "),
    area,
    city,
    cityWords,
    offset,
    offsetLower,
    offsetGmt,
    offsetGmt.toLowerCase(),
    offsetWithoutColon,
    offsetWithoutColon.toLowerCase(),
    offsetCompact,
    offsetCompact.toLowerCase(),
    offset.replace(/^UTC/i, ""),
    offset.replace(/^UTC/i, "").replace(":", ""),
  ]);
}

/** 创建时区下拉选项，label 中包含当前 offset 作为辅助识别信息。 */
export function createTimeZoneSelectOptions(timeZones: readonly string[], now = new Date()): SearchableSelectOption[] {
  return timeZones.map((timeZone) => ({
    value: timeZone,
    label: `${timeZone} (${formatTimeZoneOffset(timeZone, now)})`,
    keywords: createTimeZoneKeywords(timeZone, now),
  }));
}
