import { describe, expect, it, vi } from "vitest";
import { dateOnlyInZone, safeTimeZone } from "./time";

describe("worker date-only formatter reuse", () => {
  it("keeps each instant and zone distinct across midnight and DST", () => {
    for (const [instant, zone, expected] of [
      ["2026-03-08T04:59:59Z", "America/New_York", "2026-03-07"],
      ["2026-03-08T05:00:00Z", "America/New_York", "2026-03-08"],
      ["2026-03-08T07:00:00Z", "America/New_York", "2026-03-08"],
      ["2026-11-01T05:30:00Z", "America/New_York", "2026-11-01"],
      ["2026-11-01T06:30:00Z", "America/New_York", "2026-11-01"],
      ["2026-11-18T16:00:00Z", "Asia/Shanghai", "2026-11-19"],
      ["2026-11-18T16:00:00Z", "UTC", "2026-11-18"],
      ["2026-11-18T16:00:00Z", "Invalid/Zone", "2026-11-18"],
    ] as const) expect(dateOnlyInZone(new Date(instant), zone)).toBe(expected);
    expect(safeTimeZone("Invalid/Zone")).toBe("UTC");
    expect(() => dateOnlyInZone(new Date(NaN), "UTC")).toThrow(RangeError);
  });

  it("reuses bounded formatters without caching the computed date", async () => {
    vi.resetModules();
    const time = await import("./time");
    const DateTimeFormat = Intl.DateTimeFormat;
    const constructor = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new DateTimeFormat(locales, options);
    });
    try {
      const now = new Date("2026-11-18T12:00:00Z");
      time.dateOnlyInZone(now, "UTC");
      const initialCalls = constructor.mock.calls.length;
      expect(time.dateOnlyInZone(new Date("2026-11-19T12:00:00Z"), "UTC")).toBe("2026-11-19");
      expect(constructor).toHaveBeenCalledTimes(initialCalls);
      for (const zone of Intl.supportedValuesOf("timeZone").slice(0, 33)) time.dateOnlyInZone(now, zone);
      const beforeRead = constructor.mock.calls.length;
      expect(time.dateOnlyInZone(now, "UTC")).toBe("2026-11-18");
      expect(constructor).toHaveBeenCalledTimes(beforeRead + 2);
    } finally { constructor.mockRestore(); }
  });
});
