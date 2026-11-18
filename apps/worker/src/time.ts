import { isValidTimeZone } from "@renewlet/shared/runtime";

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function safeTimeZone(timezone: string): string {
  // settings 的 timezone 契约是 IANA 名称；历史坏值只能在读取边界回退 UTC，不能让 Cron/ICS 永久跳过。
  return isValidTimeZone(timezone) ? timezone : "UTC";
}

export function dateOnlyInZone(date: Date, timezone: string): string {
  const zone = safeTimeZone(timezone);
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    // 缓存格式器而非日期结果：每次仍按当前 instant 处理跨日/DST；32 个时区限制长期 isolate 的内存。
    if (dateFormatters.size >= 32) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(date);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

export function localTimeInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: safeTimeZone(timezone), hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23" }).formatToParts(date);
  return `${part(parts, "hour")}:${part(parts, "minute")}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return value.toISOString().slice(0, 10);
}

export function toRfc3339Seconds(date: Date): string {
  return date.toISOString().replace(".000Z", "Z");
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? "00";
}
