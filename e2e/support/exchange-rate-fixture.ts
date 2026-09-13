import { cachedExchangeRateDataSchema, SUPPORTED_EXCHANGE_RATE_CURRENCIES } from "../../packages/shared/src/schemas/exchange-rates";

export const e2eFrankfurterRates = SUPPORTED_EXCHANGE_RATE_CURRENCIES.map((quote, index) => ({
  date: "2026-08-17", base: "USD", quote, rate: quote === "USD" ? 1 : 1 + (index + 1) / 1000,
}));

/** 只写隔离浏览器的现行缓存格式；避免 page.route 关闭 HTTP cache，使暖缓存测量失真。 */
export function performanceExchangeRateCache(day: string) {
  return {
    key: "exchange_rates_cache_v5:frankfurter",
    value: cachedExchangeRateDataSchema.parse({
      base: "USD", date: "2026-08-17", requestedProvider: "frankfurter", provider: "frankfurter",
      cachedAt: new Date(`${day}T12:00:00+08:00`).getTime(),
      rates: Object.fromEntries(e2eFrankfurterRates.map(({ quote, rate }) => [quote, rate])),
    }),
  };
}
