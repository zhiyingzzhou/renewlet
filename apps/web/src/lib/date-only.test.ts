// DateOnly 测试保护纯日期算法，避免 JS Date 时区换算把续费日推前或推后一天。
import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { assertDateOnly, compareDateOnly, dateOnlyMessageParams, dateOnlyToLocalDate, isSameMonthDateOnly, isValidDateOnly } from "@/lib/time/date-only";

describe("date-only", () => {
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isValidDateOnly("2026-02-28")).toBe(true);
    expect(isValidDateOnly("2026-02-31")).toBe(false);
    expect(isValidDateOnly("2026-13-01")).toBe(false);
    expect(isValidDateOnly("")).toBe(false);
  });

  it("rejects ISO datetimes instead of normalizing across time zones", () => {
    expect(() => assertDateOnly("2026-01-10T23:30:00.000Z")).toThrow("Invalid date-only");
    expect(() => assertDateOnly("2026-02-31")).toThrow("Invalid date-only");
  });

  it("throws before parsing invalid date-only values into Date", () => {
    expect(assertDateOnly("2026-12-01")).toBe("2026-12-01");
    expect(dateOnlyToLocalDate(assertDateOnly("2026-12-01")).getFullYear()).toBe(2026);
    expect(() => dateOnlyToLocalDate("2026-02-31")).toThrow("Invalid date-only");
  });

  it("preserves calendar ordering and display across leap centuries and date bounds", () => {
    const dates = ["0000-02-29", "0099-12-31", "0100-03-01", "1900-02-28", "2000-02-29", "2026-11-18", "9999-12-31"];
    for (const date of dates) {
      const plain = Temporal.PlainDate.from(date);
      expect(dateOnlyMessageParams(date, "zh-CN", "monthDay")).toEqual({ year: plain.year, month: String(plain.month), day: String(plain.day) });
      expect(dateOnlyMessageParams(date, "ru-RU", "full")).toEqual({ year: plain.year, month: String(plain.month).padStart(2, "0"), day: String(plain.day).padStart(2, "0") });
      for (const other of dates) {
        expect(compareDateOnly(date, other)).toBe(Temporal.PlainDate.compare(date, other));
        const otherPlain = Temporal.PlainDate.from(other);
        expect(isSameMonthDateOnly(date, other)).toBe(plain.year === otherPlain.year && plain.month === otherPlain.month);
      }
    }
  });

  it("does not let comparison or display bypass invalid-date validation", () => {
    for (const date of ["1900-02-29", "2026-04-31", "2026-1-01", "10000-01-01", "2026-11-18T00:00:00Z"]) {
      expect(() => compareDateOnly(date, "2026-11-18")).toThrow("Invalid date-only");
      expect(() => isSameMonthDateOnly("2026-11-18", date)).toThrow("Invalid date-only");
      expect(() => dateOnlyMessageParams(date, "en-US", "short")).toThrow("Invalid date-only");
    }
  });
});
