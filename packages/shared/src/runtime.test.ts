// runtime 测试保护 reminderDays 哨兵值；Go、D1、前端和导入导出都依赖这组三态语义。
import { describe, expect, it, vi } from "vitest";
import {
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  effectiveReminderDays,
  isValidReminderDays,
} from "./runtime";

describe("reminder day runtime contract", () => {
  it("accepts disabled, inherited and explicit reminder boundaries", () => {
    for (const value of [DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS, 0, 3650]) {
      expect(isValidReminderDays(value)).toBe(true);
    }

    for (const value of [-3, 3651]) {
      expect(isValidReminderDays(value)).toBe(false);
    }
  });

  it("does not resolve disabled reminders into an effective day count", () => {
    expect(effectiveReminderDays(DISABLED_REMINDER_DAYS, 3)).toBeUndefined();
    expect(effectiveReminderDays(INHERIT_REMINDER_DAYS, 5)).toBe(5);
    expect(effectiveReminderDays(0, 5)).toBe(0);
  });
});

describe("time zone validation", () => {
  it("preserves Intl validity and bounds reuse of successful names", async () => {
    vi.resetModules();
    const { isValidTimeZone } = await import("./runtime");
    const DateTimeFormat = Intl.DateTimeFormat;
    const constructor = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new DateTimeFormat(locales, options);
    });
    try {
      for (const zone of ["UTC", "Asia/Shanghai", "America/New_York", "US/Eastern"]) {
        expect(isValidTimeZone(zone)).toBe(true);
      }
      const calls = constructor.mock.calls.length;
      expect(isValidTimeZone("US/Eastern")).toBe(true);
      expect(constructor).toHaveBeenCalledTimes(calls);
      for (const zone of ["", "Not/A_Timezone", "Asia/Shanghai "]) expect(isValidTimeZone(zone)).toBe(false);
      expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
      const afterEviction = constructor.mock.calls.length;
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(constructor).toHaveBeenCalledTimes(afterEviction + 1);
    } finally { constructor.mockRestore(); }
  });
});
