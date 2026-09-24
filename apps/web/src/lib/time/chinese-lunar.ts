import { assertDateOnly, type DateOnly } from "@/lib/time/date-only";
import type { Locale } from "@/i18n/locales";

type LunarDisplayStyle = "full" | "compact";

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterForLocale(locale: Locale, style: LunarDisplayStyle = "full"): Intl.DateTimeFormat | null {
  const cacheKey = `${locale}:${style}`;
  const cached = formatterCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let formatter: Intl.DateTimeFormat | null = null;
  try {
    const candidate = new Intl.DateTimeFormat(locale, {
      calendar: "chinese",
      month: style === "compact" && locale !== "zh-CN" ? "numeric" : "long",
      day: "numeric",
    });
    // 某些运行时会静默回落到 Gregorian；只有确认 ICU 实际采用 chinese 才能展示结果。
    formatter = candidate.resolvedOptions().calendar === "chinese" ? candidate : null;
  } catch {
    formatter = null;
  }
  formatterCache.set(cacheKey, formatter);
  return formatter;
}

function anchoredDateForDateOnly(date: DateOnly | string): Date {
  const value = assertDateOnly(date);
  const anchoredDate = new Date(0);
  // setUTCFullYear 避免 Date.UTC 将 00–99 年份误解释为 1900–1999。
  anchoredDate.setUTCFullYear(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  );
  anchoredDate.setUTCHours(12, 0, 0, 0);
  return anchoredDate;
}

/** 浏览器是否具备真实的中国农历 Intl/CLDR 格式化能力。 */
export function isChineseLunarCalendarSupported(locale: Locale): boolean {
  return formatterForLocale(locale) !== null;
}

/**
 * 只在显示边界把 Gregorian date-only 锚定到 UTC 中午；农历值不进入业务日期运算。
 * UTC 中午避开所有用户时区的跨日边界，同时保留 CLDR 对闰月的 month 文本。
 */
export function formatChineseLunarDateOnly(date: DateOnly | string, locale: Locale): string | null {
  const formatter = formatterForLocale(locale);
  if (!formatter) return null;
  return formatter.format(anchoredDateForDateOnly(date));
}

/**
 * 网格副信息使用紧凑分隔符，给七列日历留下稳定的水平空间；完整月日仍用于已选值和无障碍描述。
 */
export function formatChineseLunarDateOnlyCompact(date: DateOnly | string, locale: Locale): string | null {
  const formatter = formatterForLocale(locale, "compact");
  if (!formatter) return null;
  const anchoredDate = anchoredDateForDateOnly(date);

  if (locale === "zh-CN") {
    const parts = formatter.formatToParts(anchoredDate);
    const lunarMonth = parts.find((part) => part.type === "month")?.value;
    const lunarDay = parts.find((part) => part.type === "day")?.value;
    if (lunarMonth && lunarDay) return `${lunarMonth.replace(/月$/u, "")}·${lunarDay}`;
  }

  return formatter.format(anchoredDate);
}
