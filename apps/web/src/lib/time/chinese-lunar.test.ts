import { describe, expect, it } from "vitest";
import {
  formatChineseLunarDateOnly,
  formatChineseLunarDateOnlyCompact,
  isChineseLunarCalendarSupported,
} from "./chinese-lunar";

describe("Chinese lunar date display", () => {
  it("formats Gregorian date-only values with the runtime locale", () => {
    expect(isChineseLunarCalendarSupported("zh-CN")).toBe(true);
    expect(formatChineseLunarDateOnly("2024-02-10", "zh-CN")).toBe("正月1日");
    expect(formatChineseLunarDateOnly("2024-02-10", "en-US")).toBe("First Month 1");
  });

  it("keeps the CLDR leap-month marker", () => {
    expect(formatChineseLunarDateOnly("2023-03-22", "zh-CN")).toContain("闰");
    expect(formatChineseLunarDateOnly("2023-03-22", "en-US")).toContain("bis");
  });

  it("uses compact grid labels while preserving leap-month markers", () => {
    expect(formatChineseLunarDateOnlyCompact("2024-02-10", "zh-CN")).toBe("正·1");
    expect(formatChineseLunarDateOnlyCompact("2023-03-22", "zh-CN")).toBe("闰二·1");
    expect(formatChineseLunarDateOnlyCompact("2024-02-10", "en-US")).toBe("1/1");
  });

  it("does not depend on the host timezone when formatting a date-only value", () => {
    const originalTimezone = process.env["TZ"];
    try {
      process.env["TZ"] = "Pacific/Honolulu";
      const west = formatChineseLunarDateOnly("2024-02-10", "zh-CN");
      process.env["TZ"] = "Pacific/Kiritimati";
      const east = formatChineseLunarDateOnly("2024-02-10", "zh-CN");
      expect(east).toBe(west);
    } finally {
      if (originalTimezone === undefined) delete process.env["TZ"];
      else process.env["TZ"] = originalTimezone;
    }
  });
});
