import { describe, expect, it } from "vitest";
import { createBillingDateProjector, prepareBillingDateWindow, iterateBillingDates, type AdvanceBillingDateInput } from "./subscription-renewal";

const monthly: AdvanceBillingDateInput = {
  billingCycle: "monthly",
  startDate: "2026-01-31",
  nextBillingDate: "2026-02-28",
  autoCalculateNextBillingDate: true,
};

describe("billing date projections", () => {
  it("counts the saved first date separately from later anchor dates", () => {
    const projector = createBillingDateProjector({ ...monthly, nextBillingDate: "2026-02-15" });
    expect(projector.summarize(prepareBillingDateWindow("2026-02-01", "2026-02-28")))
      .toEqual({ count: 2, firstDate: "2026-02-15", lastDate: "2026-02-28" });
    expect(projector.summarize(prepareBillingDateWindow("2026-03-01", "2026-03-30")))
      .toEqual({ count: 0, firstDate: null, lastDate: null });
    expect(projector.summarize(prepareBillingDateWindow("2026-03-31", "2026-04-30")))
      .toEqual({ count: 2, firstDate: "2026-03-31", lastDate: "2026-04-30" });
  });

  it("counts daily periods without materializing the intervening events", () => {
    const projector = createBillingDateProjector({ ...monthly, billingCycle: "custom", customDays: 1,
      customCycleUnit: "day", startDate: "1900-01-01", nextBillingDate: "1900-01-02" });
    expect(projector.summarize(prepareBillingDateWindow("2024-01-01", "2024-12-31")))
      .toEqual({ count: 366, firstDate: "2024-01-01", lastDate: "2024-12-31" });
    expect(projector.summarize(prepareBillingDateWindow("2026-11-18", "2026-11-30")))
      .toEqual({ count: 13, firstDate: "2026-11-18", lastDate: "2026-11-30" });
  });

  it("summarizes leap-day and oversized cycles within the date-only boundary", () => {
    const yearly = createBillingDateProjector({ ...monthly, billingCycle: "annual", startDate: "2024-02-29", nextBillingDate: "2025-02-28" });
    expect(yearly.summarize(prepareBillingDateWindow("2025-03-01", "2028-02-29")))
      .toEqual({ count: 3, firstDate: "2026-02-28", lastDate: "2028-02-29" });
    const huge = createBillingDateProjector({ ...monthly, billingCycle: "custom", customDays: 1_000_000,
      customCycleUnit: "year", nextBillingDate: "9999-12-30", autoCalculateNextBillingDate: false });
    expect(huge.summarize(prepareBillingDateWindow("9999-12-01", "9999-12-31")))
      .toEqual({ count: 1, firstDate: "9999-12-30", lastDate: "9999-12-30" });
  });

  it("keeps the start anchor through February and includes both range endpoints", () => {
    expect([...iterateBillingDates(monthly, "2026-02-28", "2026-05-31")])
      .toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("anchors manual dates to the saved next date without mutating the subscription", () => {
    const input = Object.freeze({ ...monthly, startDate: null, nextBillingDate: "2026-01-31", autoCalculateNextBillingDate: false });
    expect([...iterateBillingDates(input, "2026-01-01", "2026-03-31")])
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(input.nextBillingDate).toBe("2026-01-31");
  });

  it("preserves a saved date before returning to the automatic anchor", () => {
    expect([...iterateBillingDates({ ...monthly, nextBillingDate: "2026-02-15" }, "2026-02-01", "2026-03-31")])
      .toEqual(["2026-02-15", "2026-02-28", "2026-03-31"]);
  });

  it("jumps past decades of overdue daily cycles", () => {
    expect([...iterateBillingDates({ ...monthly, billingCycle: "custom", customDays: 1, customCycleUnit: "day", startDate: "1900-01-01", nextBillingDate: "1900-01-02" }, "2026-06-01", "2026-06-03")])
      .toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it.each<[{ billingCycle: AdvanceBillingDateInput["billingCycle"]; customDays?: number; customCycleUnit?: AdvanceBillingDateInput["customCycleUnit"] }, string[]]>([
    [{ billingCycle: "weekly" }, ["2026-01-31", "2026-02-07", "2026-02-14"]],
    [{ billingCycle: "quarterly" }, ["2026-01-31", "2026-04-30", "2026-07-31"]],
    [{ billingCycle: "semi-annual" }, ["2026-01-31", "2026-07-31", "2027-01-31"]],
    [{ billingCycle: "annual" }, ["2026-01-31", "2027-01-31", "2028-01-31"]],
    [{ billingCycle: "custom", customDays: 2, customCycleUnit: "day" }, ["2026-01-31", "2026-02-02", "2026-02-04"]],
    [{ billingCycle: "custom", customDays: 2, customCycleUnit: "week" }, ["2026-01-31", "2026-02-14", "2026-02-28"]],
    [{ billingCycle: "custom", customDays: 2, customCycleUnit: "month" }, ["2026-01-31", "2026-03-31", "2026-05-31"]],
    [{ billingCycle: "custom", customDays: 2, customCycleUnit: "year" }, ["2026-01-31", "2028-01-31", "2030-01-31"]],
  ])("expands %j using the existing cycle rules", (cycle, expected) => {
    expect([...iterateBillingDates({ ...monthly, ...cycle, nextBillingDate: "2026-01-31" }, "2026-01-31", expected[2])]).toEqual(expected);
  });

  it("restores February 29 in the next leap year", () => {
    expect([...iterateBillingDates({ ...monthly, billingCycle: "annual", startDate: "2024-02-29", nextBillingDate: "2025-02-28" }, "2025-01-01", "2028-02-29")])
      .toEqual(["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  it("does not invent dates before the saved next date or for one-time purchases", () => {
    expect([...iterateBillingDates(monthly, "2026-01-01", "2026-02-27")]).toEqual([]);
    expect([...iterateBillingDates(monthly, "2026-03-01", "2026-02-28")]).toEqual([]);
    expect([...iterateBillingDates({ ...monthly, billingCycle: "one-time" }, "2026-01-01", "2027-01-01")]).toEqual([]);
  });

  it.each(["day", "week", "month", "year"] as const)("stops before an out-of-window custom %s period overflows", (customCycleUnit) => {
    const input = { ...monthly, billingCycle: "custom" as const, customCycleUnit, customDays: 1_000_000, autoCalculateNextBillingDate: false };
    expect([...iterateBillingDates(input, "2026-02-01", "2026-03-31")]).toEqual(["2026-02-28"]);
    expect([...iterateBillingDates(input, "2026-03-01", "2026-03-31")]).toEqual([]);
  });

  it("finishes at the date-only boundary even when no end date was requested", () => {
    expect([...iterateBillingDates({ ...monthly, nextBillingDate: "9999-12-30", autoCalculateNextBillingDate: false }, "9999-12-01")])
      .toEqual(["9999-12-30"]);
  });

  it("retains the original anchor when a range begins between cycle dates", () => {
    expect([...iterateBillingDates(monthly, "2026-03-01", "2026-05-30")]).toEqual(["2026-03-31", "2026-04-30"]);
    expect([...iterateBillingDates({ ...monthly, billingCycle: "weekly", autoCalculateNextBillingDate: false }, "2026-03-01", "2026-03-14")])
      .toEqual(["2026-03-07", "2026-03-14"]);
  });
});
