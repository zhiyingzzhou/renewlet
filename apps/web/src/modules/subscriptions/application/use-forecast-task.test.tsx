import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useForecastTask } from "./use-forecast-task";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("forecast task lifetime", () => {
  it("returns small projections immediately", () => {
    const factory = function* () { yield; return 42; };
    const { result } = renderHook(() => useForecastTask(factory));
    expect(result.current).toBe(42);
  });

  it("returns cheap work during the first render without an effect loading cycle", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const factory = function* () { for (let i = 0; i < 1000; i += 1) yield; return 42; };
    const { result } = renderHook(() => useForecastTask(factory));
    expect(result.current).toBe(42);
  });

  it("yields large work and discards superseded projections", async () => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 4);
    let oldSteps = 0;
    const oldFactory = function* () { for (let i = 0; i < 100; i += 1) { oldSteps += 1; yield; } return "old"; };
    const newFactory = function* () { for (let i = 0; i < 100; i += 1) yield; return "new"; };
    const { result, rerender } = renderHook(({ factory }) => useForecastTask(factory), { initialProps: { factory: oldFactory } });
    expect(result.current).toBeUndefined();
    await act(() => vi.advanceTimersToNextTimerAsync());
    expect(oldSteps).toBeGreaterThan(0);
    expect(oldSteps).toBeLessThan(100);
    rerender({ factory: newFactory });
    const cancelledAt = oldSteps;
    await act(() => vi.runAllTimersAsync());
    expect(oldSteps).toBe(cancelledAt);
    expect(result.current).toBe("new");
  });

  it("stops unfinished work on unmount", async () => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 4);
    let steps = 0;
    const factory = function* () { for (let i = 0; i < 100; i += 1) { steps += 1; yield; } return steps; };
    const { unmount } = renderHook(() => useForecastTask(factory));
    await act(() => vi.advanceTimersToNextTimerAsync());
    unmount();
    const stoppedAt = steps;
    await act(() => vi.runAllTimersAsync());
    expect(steps).toBe(stoppedAt);
  });
});
