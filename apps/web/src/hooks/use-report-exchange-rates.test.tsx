import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExchangeRateSnapshotBody, ExchangeRateSnapshotV1 } from "@/lib/api/schemas/exchange-rates";
import type { ExchangeRateSnapshot, ExchangeRateStore } from "./exchange-rate-store";
import { createUseReportExchangeRates } from "./use-report-exchange-rates";

const serviceMocks = vi.hoisted(() => ({
  list: vi.fn<(_range: { from?: string; to?: string }, _signal?: AbortSignal) => Promise<ExchangeRateSnapshotV1[]>>(),
  capture: vi.fn<(_month: string, _body: ExchangeRateSnapshotBody, _signal?: AbortSignal) => Promise<ExchangeRateSnapshotV1>>(),
}));

vi.mock("@/services/exchange-rate-snapshot-service", () => ({
  exchangeRateSnapshotService: serviceMocks,
}));

const currentMonth = "2026-08";

function remoteStore(overrides: Partial<Awaited<ReturnType<ExchangeRateStore["loadRemoteSnapshot"]>>> = {}): ExchangeRateStore {
  return {
    readCachedSnapshot: () => null,
    loadRemoteSnapshot: vi.fn().mockResolvedValue({
      rates: { USD: 1, CNY: 7 },
      baseRate: "USD",
      activeProvider: "frankfurter",
      warning: null,
      sourceDate: "2026-08-01",
      lastUpdated: new Date("2026-08-06T00:00:00.000Z"),
      ...overrides,
    }),
  };
}

describe("useReportExchangeRates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    serviceMocks.list.mockResolvedValue([]);
    serviceMocks.capture.mockImplementation(async (_month, body) => ({
      schemaVersion: 1,
      month: currentMonth,
      ...body,
      capturedAt: "2026-08-06T12:00:00.000Z",
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    serviceMocks.list.mockReset();
    serviceMocks.capture.mockReset();
  });

  it("captures the current report month after a trusted provider succeeds", async () => {
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore());

    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(serviceMocks.capture).toHaveBeenCalledTimes(1));
    expect(serviceMocks.list).toHaveBeenCalledWith(
      { from: currentMonth, to: currentMonth },
      expect.any(AbortSignal),
    );
    expect(serviceMocks.capture).toHaveBeenCalledWith(currentMonth, {
      base: "USD",
      rates: { USD: 1, CNY: 7 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
    }, expect.any(AbortSignal));
    expect(result.current.reportBasisStatus).toEqual({
      month: currentMonth,
      locked: true,
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T12:00:00.000Z",
    });
  });

  it("uses an existing locked snapshot as the report converter without writing it again", async () => {
    serviceMocks.list.mockResolvedValue([{
      schemaVersion: 1,
      month: currentMonth,
      base: "USD",
      rates: { USD: 1, CNY: 6 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    }]);
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore({
      rates: { USD: 1, CNY: 6 },
      sourceDate: "2026-08-01",
    }));

    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(result.current.reportBasisStatus.locked).toBe(true));
    expect(result.current.convert("6", "CNY", "USD")).toBe(1);
    expect(serviceMocks.capture).not.toHaveBeenCalled();
  });

  it("keeps loading false while exposing manual refresh progress for a locked snapshot", async () => {
    const lockedSnapshot: ExchangeRateSnapshotV1 = {
      schemaVersion: 1,
      month: currentMonth,
      base: "USD",
      rates: { USD: 1, CNY: 6 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    };
    const liveSnapshot: ExchangeRateSnapshot = {
      rates: lockedSnapshot.rates,
      baseRate: "USD",
      activeProvider: "frankfurter",
      warning: null,
      sourceDate: lockedSnapshot.sourceDate,
      lastUpdated: new Date(lockedSnapshot.capturedAt),
    };
    let resolveRemote!: (snapshot: ExchangeRateSnapshot) => void;
    serviceMocks.list.mockResolvedValue([lockedSnapshot]);
    const store: ExchangeRateStore = {
      readCachedSnapshot: () => liveSnapshot,
      loadRemoteSnapshot: vi.fn(() => new Promise<ExchangeRateSnapshot>((resolve) => {
        resolveRemote = resolve;
      })),
    };
    const useReportExchangeRates = createUseReportExchangeRates(store);
    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(result.current.reportBasisStatus.locked).toBe(true));
    let refreshPromise!: ReturnType<typeof result.current.refresh>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.isRefreshing).toBe(true);

    await act(async () => {
      resolveRemote(liveSnapshot);
      await refreshPromise;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("waits for a manual refresh to finish before capturing an unlocked report snapshot", async () => {
    const liveSnapshot: ExchangeRateSnapshot = {
      rates: { USD: 1, CNY: 7 },
      baseRate: "USD",
      activeProvider: "frankfurter",
      warning: null,
      sourceDate: "2026-08-01",
      lastUpdated: new Date("2026-08-06T00:00:00.000Z"),
    };
    let resolveList!: (snapshots: ExchangeRateSnapshotV1[]) => void;
    let resolveRemote!: (snapshot: ExchangeRateSnapshot) => void;
    serviceMocks.list.mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve;
    }));
    const store: ExchangeRateStore = {
      readCachedSnapshot: () => liveSnapshot,
      loadRemoteSnapshot: vi.fn(() => new Promise<ExchangeRateSnapshot>((resolve) => {
        resolveRemote = resolve;
      })),
    };
    const useReportExchangeRates = createUseReportExchangeRates(store);
    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    let refreshPromise!: ReturnType<typeof result.current.refresh>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await act(async () => {
      resolveList([]);
    });

    expect(result.current.isRefreshing).toBe(true);
    expect(serviceMocks.capture).not.toHaveBeenCalled();

    await act(async () => {
      resolveRemote(liveSnapshot);
      await refreshPromise;
    });
    await waitFor(() => expect(serviceMocks.capture).toHaveBeenCalledTimes(1));
  });

  it("does not persist builtin fallback rates as a report snapshot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store: ExchangeRateStore = {
      readCachedSnapshot: () => null,
      loadRemoteSnapshot: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const useReportExchangeRates = createUseReportExchangeRates(store);

    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeProvider).toBe("builtin");
    expect(serviceMocks.capture).not.toHaveBeenCalled();
  });

  it("keeps a suspended document request but cancels it when the document is permanently discarded", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let rejectCapture: (error: Error) => void = () => { throw new Error("Capture has not started"); };
    serviceMocks.capture.mockImplementation(() => new Promise((_resolve, reject) => { rejectCapture = reject; }));
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore());
    renderHook(() => useReportExchangeRates());
    await waitFor(() => expect(serviceMocks.capture).toHaveBeenCalledTimes(1));
    const signal = serviceMocks.capture.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    expect(signal?.aborted).toBe(false);
    // BFCache 恢复不重新挂载 Hook；第一次暂存不能移除永久离开时仍要使用的清理监听。
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    expect(signal?.aborted).toBe(true);
    await act(async () => rejectCapture(new Error("Discarded document request")));
    expect(warning).not.toHaveBeenCalled();
  });

  it.each([false, true])("still exposes a committed capture failure with StrictMode=%s", async (reactStrictMode) => {
    const failure = new Error("Capture service unavailable");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    serviceMocks.capture.mockRejectedValue(failure);
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore());
    const { result } = renderHook(() => useReportExchangeRates(), { reactStrictMode });
    await waitFor(() => expect(result.current.reportBasisCaptureError).toBe(failure));
    expect(warning).toHaveBeenCalledExactlyOnceWith("Failed to capture report exchange-rate snapshot:", failure);
  });

  it("preserves the locked report basis and reports a real refresh capture failure", async () => {
    const failure = new Error("Snapshot write unavailable");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    serviceMocks.list.mockResolvedValue([{
      schemaVersion: 1, month: currentMonth, base: "USD", rates: { USD: 1, CNY: 6 },
      requestedProvider: "frankfurter", provider: "frankfurter", sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    }]);
    serviceMocks.capture.mockRejectedValue(failure);
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore());
    const { result, rerender } = renderHook(() => useReportExchangeRates());
    await waitFor(() => expect(result.current.reportBasisCaptureError).toBe(failure));
    expect(result.current.reportBasisStatus.locked).toBe(true);
    expect(result.current.convert(1, "USD", "CNY")).toBe(6);
    rerender();
    expect(warning).toHaveBeenCalledExactlyOnceWith("Failed to capture report exchange-rate snapshot:", failure);
  });

  it("does not commit or report a late capture rejection after unmount", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let rejectCapture: (error: Error) => void = () => { throw new Error("Capture has not started"); };
    serviceMocks.capture.mockImplementation(() => new Promise((_resolve, reject) => { rejectCapture = reject; }));
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore());
    const { unmount } = renderHook(() => useReportExchangeRates(), { reactStrictMode: true });
    await waitFor(() => expect(serviceMocks.capture).toHaveBeenCalledTimes(1));
    const signal = serviceMocks.capture.mock.calls[0]?.[2];
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => rejectCapture(new Error("Late capture rejection")));
    expect(warning).not.toHaveBeenCalled();
  });

  it("disposes every document listener and pending read under StrictMode", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    serviceMocks.list.mockImplementation(() => new Promise(() => {}));
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore());
    const { unmount } = renderHook(() => useReportExchangeRates(), { reactStrictMode: true });
    await waitFor(() => expect(serviceMocks.list).toHaveBeenCalledTimes(2));
    const signal = serviceMocks.list.mock.calls.at(-1)?.[1];
    expect(signal?.aborted).toBe(false);
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    expect(signal?.aborted).toBe(true);
    unmount();
    for (const call of added.mock.calls.filter(([type]) => type === "pagehide")) {
      expect(removed.mock.calls).toContainEqual(call);
    }
    expect(serviceMocks.capture).not.toHaveBeenCalled();
  });
});
