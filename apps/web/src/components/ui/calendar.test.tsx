// Calendar primitive 测试保护移动端 sheet、caption/nav 和 date-only 选择语义，避免 DayPicker 升级破坏表单日期。
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Calendar } from "@/components/ui/calendar";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string) => key,
    formatDateTime: (date: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("zh-CN", options).format(date),
  }),
}));

describe("Calendar mobile sheet layout", () => {
  it("marks the calendar grid so mobile sheets can render seven equal columns", () => {
    const { container } = render(
      <div className="h5-mobile-sheet-calendar">
        <Calendar mode="single" defaultMonth={new Date(2026, 4, 1)} />
      </div>,
    );

    expect(container.querySelector(".h5-calendar-root")).not.toBeNull();
    expect(container.querySelector(".h5-calendar-months")).not.toBeNull();
    expect(container.querySelector(".h5-calendar-month")).not.toBeNull();
    expect(container.querySelector(".h5-calendar-month-grid")).not.toBeNull();
    expect(container.querySelectorAll(".h5-calendar-weekday")).toHaveLength(7);
    expect(container.querySelector(".h5-calendar-week")).not.toBeNull();
    expect(container.querySelector(".h5-calendar-day")).not.toBeNull();
    expect(container.querySelector(".h5-calendar-day-button")).not.toBeNull();
  });

  it("keeps Gregorian day numbers primary and adds a lunar description when enabled", () => {
    const { container } = render(
      <Calendar showLunarCalendar mode="single" defaultMonth={new Date(2024, 1, 1)} />,
    );

    expect(container.querySelector(".h5-calendar-lunar")).not.toBeNull();
    expect(container.querySelectorAll(".h5-calendar-week")).toHaveLength(6);
    expect(container.querySelectorAll(".h5-calendar-day-button")).toHaveLength(42);
    const lunarDescription = container.querySelector("[aria-description]");
    expect(lunarDescription).not.toBeNull();
    expect(lunarDescription?.getAttribute("aria-description")).toContain("date.chineseLunarDescription");
    expect(lunarDescription?.querySelector("span[aria-hidden='true']")).not.toBeNull();
  });
});
