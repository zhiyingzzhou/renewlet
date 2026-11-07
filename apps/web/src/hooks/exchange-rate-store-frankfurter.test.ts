import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_EXCHANGE_RATE_CURRENCIES } from "@/lib/currency-data";
import { createExchangeRateStore } from "./exchange-rate-store";

const supportedRows = SUPPORTED_EXCHANGE_RATE_CURRENCIES.map((quote, index) => ({
  date: "2026-11-06",
  base: "USD",
  quote,
  rate: quote === "USD" ? 1 : index + 1.25,
}));
const supportedRates = Object.fromEntries(supportedRows.map(({ quote, rate }) => [quote, rate]));

// Frankfurter 的默认集合已包含加密资产；夹具按官方 quotes 参数筛选，守住请求范围而非放宽法币校验。
const upstreamRows = [
  ...supportedRows,
  { date: "2026-11-06", base: "USD", quote: "AAVE", rate: 0.0076554 },
  { date: "2026-11-06", base: "USD", quote: "BTC", rate: 0.00001 },
  { date: "2026-11-06", base: "USD", quote: "USDT", rate: 1.0016 },
];

describe("Frankfurter request scope", () => {
  it("requests only supported fiat quotes and caches a complete USD snapshot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.frankfurter.dev/v2/rates");
      expect(url.searchParams.get("base")).toBe("USD");
      const quotes = url.searchParams.get("quotes")?.split(",");
      expect(quotes).toEqual([...SUPPORTED_EXCHANGE_RATE_CURRENCIES]);
      return Response.json(upstreamRows.filter((row) => !quotes || quotes.includes(row.quote)));
    });
    const store = createExchangeRateStore({ fetch, storage: null });

    const snapshot = await store.loadRemoteSnapshot("frankfurter");

    expect(snapshot).toMatchObject({
      rates: supportedRates,
      baseRate: "USD",
      activeProvider: "frankfurter",
      sourceDate: "2026-11-06",
      warning: null,
    });
    expect(Object.keys(snapshot.rates)).toHaveLength(SUPPORTED_EXCHANGE_RATE_CURRENCIES.length);
    expect(store.readCachedSnapshot("frankfurter")).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the same fiat scope when Frankfurter is a fallback provider", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "www.floatrates.com") return new Response("Unavailable", { status: 503 });
      expect(url.origin + url.pathname).toBe("https://api.frankfurter.dev/v2/rates");
      const quotes = url.searchParams.get("quotes")?.split(",");
      expect(quotes).toEqual([...SUPPORTED_EXCHANGE_RATE_CURRENCIES]);
      return Response.json(upstreamRows.filter((row) => !quotes || quotes.includes(row.quote)));
    });
    const store = createExchangeRateStore({ fetch, storage: null });

    const snapshot = await store.loadRemoteSnapshot("floatrates");

    expect(snapshot.activeProvider).toBe("frankfurter");
    expect(snapshot.rates).toEqual(supportedRates);
    expect(store.readCachedSnapshot("floatrates")).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveBeenCalledExactlyOnceWith(
      "Failed to fetch exchange rates from floatrates:",
      expect.objectContaining({ provider: "floatrates", kind: "network" }),
    );
  });
});
