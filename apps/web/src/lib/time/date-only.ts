/**
 * 业务日期工具（date-only）。
 *
 * 设计原则：
 * - 订阅开始日、下次扣费日、试用结束日都是“日历日期”，不是某个 UTC instant。
 * - domain 层使用 `DateOnly` 字符串，只有 UI 日历控件边界临时转换为本地 `Date`。
 * - 所有加天/月/年和跨日差值都使用 Temporal.PlainDate，避免运行环境时区影响。
 */
import { Temporal } from "@js-temporal/polyfill";
import { translate } from "@/i18n/messages";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";

/** `YYYY-MM-DD` 业务日期品牌类型，表示日历日期而不是 UTC instant。 */
export type DateOnly = string & { readonly __brand: "DateOnly" };

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 校验字符串是否为真实存在的 `YYYY-MM-DD` 日期。 */
export function isValidDateOnly(input: string): boolean {
  if (!DATE_ONLY_RE.test(input)) return false;
  try {
    Temporal.PlainDate.from(input);
    return true;
  } catch {
    return false;
  }
}

/** 断言并品牌化 date-only 字符串；非法值会抛错让调用方停止写入。 */
export function assertDateOnly(input: string): DateOnly {
  if (!isValidDateOnly(input)) {
    throw new Error(`Invalid date-only value: ${input}`);
  }
  return input as DateOnly;
}

/** 转为 Temporal.PlainDate，后续加减天/月/年都不经过运行时本地时区。 */
export function toPlainDate(date: DateOnly | string): Temporal.PlainDate {
  return Temporal.PlainDate.from(assertDateOnly(date));
}

/** 从 Temporal.PlainDate 转回 DateOnly 字符串。 */
export function fromPlainDate(date: Temporal.PlainDate): DateOnly {
  return assertDateOnly(date.toString());
}

/** 将本地 Date 控件值转换为 DateOnly；仅用于 UI 边界，不用于调度语义。 */
export function dateToDateOnly(date: Date): DateOnly {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid Date");
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return assertDateOnly(`${year}-${month}-${day}`);
}

/** 将 DateOnly 转成本地午夜 Date，主要供日历控件显示。 */
export function dateOnlyToLocalDate(date: DateOnly | string): Date {
  const value = assertDateOnly(date);
  return new Date(`${value}T00:00:00`);
}

/** 计算指定 IANA 时区下的今天，供通知提醒按用户本地日期判断。 */
export function todayDateOnlyInTimeZone(now: Date, timeZone: string): DateOnly {
  const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  return fromPlainDate(instant.toZonedDateTimeISO(timeZone).toPlainDate());
}

/** 对 DateOnly 做日历维度加法，避免 DST/时区导致加一天不是同一日期的问题。 */
export function addDateOnly(
  date: DateOnly | string,
  duration: Temporal.DurationLike,
): DateOnly {
  return fromPlainDate(toPlainDate(date).add(duration));
}

/** 比较两个 DateOnly 的先后顺序。 */
export function compareDateOnly(a: DateOnly | string, b: DateOnly | string): number {
  return Temporal.PlainDate.compare(toPlainDate(a), toPlainDate(b));
}

/** 计算两个 DateOnly 的自然日差值。 */
export function daysBetweenDateOnly(start: DateOnly | string, end: DateOnly | string): number {
  return toPlainDate(start).until(toPlainDate(end), { largestUnit: "day" }).days;
}

/** 判断两个 DateOnly 是否处于同一年月。 */
export function isSameMonthDateOnly(date: DateOnly | string, month: DateOnly | string): boolean {
  const left = toPlainDate(date);
  const right = toPlainDate(month);
  return left.year === right.year && left.month === right.month;
}

export type DateOnlyDisplayStyle = "short" | "monthDay" | "full";

// 数字日期习惯按语言区分：英文只有完整日期补零，俄文 dd.MM.yyyy 全部补零，中文不补零。
const ZERO_PADDED_DATE_STYLES: Partial<Record<Locale, readonly DateOnlyDisplayStyle[]>> = {
  "en-US": ["full"],
  "ru-RU": ["short", "monthDay", "full"],
};

/** 生成日期 catalog 消息参数；只影响展示，DateOnly 值本身不变。 */
export function dateOnlyMessageParams(date: DateOnly | string, locale: Locale, style: DateOnlyDisplayStyle) {
  const value = toPlainDate(date);
  const width = ZERO_PADDED_DATE_STYLES[locale]?.includes(style) ? 2 : 1;
  return {
    year: value.year,
    month: String(value.month).padStart(width, "0"),
    day: String(value.day).padStart(width, "0"),
  };
}

/** 格式化为简洁展示日期。 */
export function formatDateOnlyForDisplay(date: DateOnly | string, locale: Locale = DEFAULT_LOCALE): string {
  return translate(locale, "date.short", dateOnlyMessageParams(date, locale, "short"));
}

/** 格式化为月日短格式，用于即将续费等紧凑 UI。 */
export function formatDateOnlyMonthDay(date: DateOnly | string, locale: Locale = DEFAULT_LOCALE): string {
  const { month, day } = dateOnlyMessageParams(date, locale, "monthDay");
  return translate(locale, "date.monthDay", { month, day });
}

/** 格式化为当前语言的完整日期。 */
export function formatDateOnlyChinese(date: DateOnly | string, locale: Locale = DEFAULT_LOCALE): string {
  return translate(locale, "date.full", dateOnlyMessageParams(date, locale, "full"));
}
