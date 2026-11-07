import {
  cachedExchangeRateDataSchema,
  exchangeApiUsdResponseSchema,
  frankfurterRatesResponseSchema,
  floatRatesResponseSchema,
  type CachedExchangeRateData,
  type ExchangeRateCoverageWarning,
  type ExchangeRateData,
  type ExchangeRateProvider,
  type ExchangeRateSource,
  type ExchangeRates,
} from "@/lib/api/schemas/exchange-rates";
import {
  SUPPORTED_EXCHANGE_RATE_CURRENCIES,
  isSupportedExchangeRateCurrency,
} from "@/lib/currency-data";
import { reportClientError } from "@/lib/report-client-error";
import {
  createRawErrorResponseDetails,
  createRawErrorResponseDetailsFromText,
  type RawErrorResponseDetails,
} from "@/lib/raw-error-response";

const CACHE_KEY_PREFIX = "exchange_rates_cache_v5";
const CACHE_DURATION = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
// 少量缺币常见于公开汇率源覆盖漂移；超过阈值说明 provider 响应整体不可信，应切到下一个来源。
const MAX_PARTIAL_MISSING_CURRENCIES = 5;

/** 回退汇率：当 API 失败时使用（以 USD 为 base，快照来自 exchange-api，2026-05-17）。 */
export const FALLBACK_RATES: ExchangeRates = {
  AED: 3.6725000, AFN: 63.658356, ALL: 82.049317, AMD: 368.26261, AOA: 927.89052, ARS: 1394.9049,
  AUD: 1.3990788, AWG: 1.7900000, AZN: 1.7018910, BAM: 1.6824426, BBD: 2, BDT: 122.76805,
  BHD: 0.37600000, BIF: 2977.6097, BND: 1.2804094, BOB: 6.9277967, BRL: 5.0541011, BSD: 1,
  BWP: 14.150296, BYN: 2.7815765, BZD: 2.0124111, CAD: 1.3750033, CDF: 2240.4135, CHF: 0.78756477,
  CLP: 909.78596, CNY: 6.8102395, COP: 3793.3717, CRC: 452.90696, CUP: 23.942409, CVE: 94.856376,
  CZK: 20.918924, DJF: 178.53764, DKK: 6.4287998, DOP: 59.294146, DZD: 132.63320, EGP: 52.896417,
  ERN: 15, ETB: 157.67443, EUR: 0.86021924, FJD: 2.2038675, GBP: 0.75036482, GEL: 2.6727088,
  GHS: 11.420097, GIP: 0.75036482, GMD: 74.387435, GNF: 8775.3083, GTQ: 7.6239521, GYD: 209.17509,
  HKD: 7.8322861, HNL: 26.655286, HTG: 131.85968, HUF: 311.42641, IDR: 17520.102, ILS: 2.9195183,
  INR: 96.092713, IQD: 1310.2693, IRR: 1318130.4, ISK: 123.53707, JMD: 157.78473, JOD: 0.70900000,
  JPY: 158.76500, KES: 129.33193, KGS: 87.476084, KHR: 4004.7397, KMF: 423.20012, KRW: 1497.9907,
  KWD: 0.30745534, KZT: 469.57870, LAK: 21845.013, LBP: 89850.857, LKR: 326.70390, LRD: 183.23841,
  LSL: 16.685385, LYD: 6.3389662, MAD: 9.2476793, MDL: 17.213349, MGA: 4195.4209, MKD: 52.843551,
  MMK: 2099.5143, MNT: 3577.8783, MOP: 8.0672547, MRU: 40.060138, MUR: 47.168339, MVR: 15.443861,
  MWK: 1734.4546, MXN: 17.338153, MYR: 3.9555973, MZN: 63.811576, NAD: 16.685385, NGN: 1371.4380,
  NIO: 36.669477, NOK: 9.3090038, NPR: 153.82041, NZD: 1.7117580, OMR: 0.38504301, PAB: 1,
  PEN: 3.4340260, PGK: 4.3657103, PHP: 61.642886, PKR: 278.48796, PLN: 3.6524299, PYG: 6093.4983,
  QAR: 3.6400000, RON: 4.4360943, RSD: 100.97878, RUB: 72.871048, RWF: 1463.2286, SAR: 3.7500000,
  SBD: 8.0160156, SCR: 14.816184, SDG: 600.22335, SEK: 9.4480011, SGD: 1.2804094, SOS: 571.46575,
  SRD: 37.164242, SSP: 4708.0623, STN: 21.177571, SVC: 8.7500000, SYP: 110.52498, SZL: 16.685385,
  THB: 32.589042, TJS: 9.3438338, TMT: 3.5035881, TND: 2.9092984, TOP: 2.3635045, TRY: 45.490536,
  TTD: 6.7639706, TWD: 31.587183, TZS: 2599.9078, UAH: 44.030585, UGX: 3754.7311, USD: 1,
  UYU: 40.220808, UZS: 11985.338, VES: 514.46503, VND: 26355.251, VUV: 118.20420, WST: 2.7063800,
  XAF: 564.26683, XCD: 2.6999999, XCG: 1.7948790, XOF: 564.26683, XPF: 102.65146, YER: 238.59917,
  ZAR: 16.685385, ZMW: 18.909888,
};

const EXCHANGE_API_PRIMARY_USD_FEED = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";
const EXCHANGE_API_FALLBACK_USD_FEED = "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json";
// Frankfurter 默认响应包含加密资产；按产品法币清单限定请求，避免额外资产使整份响应无法通过校验。
const FRANKFURTER_USD_FEED = `https://api.frankfurter.dev/v2/rates?${new URLSearchParams({
  base: "USD",
  quotes: SUPPORTED_EXCHANGE_RATE_CURRENCIES.join(","),
})}`;
const FLOATRATES_USD_FEED = "https://www.floatrates.com/daily/usd.json";
// 已保存 provider 是用户偏好，不能因默认源升级而迁移；失败或少量缺口再按全局顺序补位。
const EXCHANGE_RATE_PROVIDER_FALLBACK_ORDER = ["frankfurter", "floatrates", "exchange-api"] as const satisfies readonly ExchangeRateProvider[];

export const DEFAULT_EXCHANGE_RATE_PROVIDER: ExchangeRateProvider = "frankfurter";

export type ExchangeRateErrorKind = "timeout" | "contract" | "network";

export type ExchangeRateSnapshot = {
  rates: ExchangeRates;
  baseRate: string;
  activeProvider: ExchangeRateSource;
  warning: ExchangeRateCoverageWarning | null;
  sourceDate: string;
  lastUpdated: Date;
};

export type ExchangeRateStore = {
  readCachedSnapshot(requestedProvider: ExchangeRateProvider): ExchangeRateSnapshot | null;
  loadRemoteSnapshot(requestedProvider: ExchangeRateProvider): Promise<ExchangeRateSnapshot>;
};

type ExchangeRateStorage = Pick<Storage, "getItem" | "setItem">;
type FetchLike = typeof fetch;
type InFlightRatesRequest = {
  controller: AbortController;
  promise: Promise<CachedExchangeRateData>;
};

type NormalizedExchangeRateData = ExchangeRateData & {
  missingCurrencies: string[];
};

export type ExchangeRateStoreOptions = {
  fetch?: FetchLike;
  storage?: ExchangeRateStorage | null;
  now?: () => number;
};

class ExchangeRateContractError extends Error {
  constructor(
    message = "Invalid exchange rate response",
    readonly errorDetails: RawErrorResponseDetails | null = null,
  ) {
    super(message);
    this.name = "ExchangeRateContractError";
  }
}

class ExchangeRateTimeoutError extends Error {
  constructor(message = "Exchange rate request timed out") {
    super(message);
    this.name = "ExchangeRateTimeoutError";
  }
}

class ExchangeRateProviderError extends Error {
  constructor(
    readonly provider: ExchangeRateProvider,
    readonly kind: ExchangeRateErrorKind,
    readonly originalCause: unknown,
    readonly errorDetails: RawErrorResponseDetails | null = exchangeRateErrorDetailsFromError(originalCause),
  ) {
    super(`Exchange rate provider ${provider} failed: ${kind}`);
    this.name = "ExchangeRateProviderError";
  }
}

class ExchangeRateUpstreamError extends Error {
  constructor(
    message: string,
    readonly errorDetails: RawErrorResponseDetails,
  ) {
    super(message);
    this.name = "ExchangeRateUpstreamError";
  }
}

function getDefaultStorage(): ExchangeRateStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function exchangeRateCacheKey(requestedProvider: ExchangeRateProvider): string {
  return `${CACHE_KEY_PREFIX}:${requestedProvider}`;
}

function getMissingSupportedCurrencies(rates: ExchangeRates): string[] {
  return SUPPORTED_EXCHANGE_RATE_CURRENCIES.filter((currency) => rates[currency] === undefined);
}

function normalizeFrankfurterRatesResponse(value: unknown): NormalizedExchangeRateData | null {
  const parsed = frankfurterRatesResponseSchema.safeParse(value);
  if (!parsed.success) return null;

  const rates: ExchangeRates = { USD: 1 };
  let date: string | null = null;

  for (const row of parsed.data) {
    if (!isSupportedExchangeRateCurrency(row.quote)) continue;
    if (row.quote === "USD") {
      // Frankfurter v2 会返回 USD 自报价；只能接受 rate=1，避免把坏 base 行静默写入缓存。
      if (row.rate !== 1) return null;
      if (date === null || row.date > date) {
        date = row.date;
      }
      continue;
    }
    if (rates[row.quote] !== undefined) return null;
    rates[row.quote] = row.rate;
    if (date === null || row.date > date) {
      date = row.date;
    }
  }

  if (!date) return null;

  return {
    base: "USD",
    date,
    rates,
    missingCurrencies: getMissingSupportedCurrencies(rates),
  };
}

function normalizeExchangeApiUsdResponse(value: unknown): NormalizedExchangeRateData | null {
  const parsed = exchangeApiUsdResponseSchema.safeParse(value);
  if (!parsed.success) return null;

  const rates: ExchangeRates = { USD: 1 };
  for (const [key, rate] of Object.entries(parsed.data.usd)) {
    const code = key.toUpperCase();
    if (!isSupportedExchangeRateCurrency(code)) continue;
    // exchange-api 按小写 map 暴露汇率；少量缺币留给 partial 补齐，非法 rate 已在 schema 层失败。
    // 同一币种重复出现通常代表上游结构漂移；直接拒绝比静默覆盖更容易发现数据问题。
    if (rates[code] !== undefined && code !== "USD") return null;
    rates[code] = rate;
  }

  return {
    base: "USD",
    date: parsed.data.date,
    rates,
    missingCurrencies: getMissingSupportedCurrencies(rates),
  };
}

function normalizeFloatRatesResponse(value: unknown): NormalizedExchangeRateData | null {
  const parsed = floatRatesResponseSchema.safeParse(value);
  if (!parsed.success) return null;

  const rates: ExchangeRates = { USD: 1 };
  let date: string | null = null;

  for (const [key, row] of Object.entries(parsed.data)) {
    const keyCode = key.toUpperCase();
    if (!isSupportedExchangeRateCurrency(keyCode) && !isSupportedExchangeRateCurrency(row.alphaCode)) continue;
    // FloatRates 同时给对象 key 和 alphaCode；二者不一致时宁愿失败，避免把错误汇率挂到合法币种上。
    if (keyCode !== row.alphaCode) return null;
    if (rates[row.alphaCode] !== undefined) return null;

    rates[row.alphaCode] = row.rate;
    date ??= row.date;
  }

  if (!date) return null;

  return {
    base: "USD",
    date,
    rates,
    missingCurrencies: getMissingSupportedCurrencies(rates),
  };
}

function normalizeCachedExchangeRateData(value: unknown): CachedExchangeRateData | null {
  // localStorage 可能被旧版本或用户手动污染；缓存命中前同样走 schema。
  const parsed = cachedExchangeRateDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function getProviderOrder(preferredProvider: ExchangeRateProvider): ExchangeRateProvider[] {
  return [
    preferredProvider,
    ...EXCHANGE_RATE_PROVIDER_FALLBACK_ORDER.filter((provider) => provider !== preferredProvider),
  ];
}

function applyCachedRates(data: CachedExchangeRateData): ExchangeRateSnapshot {
  return {
    rates: { ...data.rates, USD: 1 },
    baseRate: data.base,
    activeProvider: data.provider,
    warning: data.warning ?? null,
    sourceDate: data.date,
    lastUpdated: new Date(data.cachedAt),
  };
}

export function errorKindFromProviderError(error: unknown): ExchangeRateErrorKind {
  if (error instanceof ExchangeRateProviderError) return error.kind;
  if (error instanceof ExchangeRateTimeoutError) return "timeout";
  if (error instanceof ExchangeRateContractError || error instanceof SyntaxError) return "contract";
  return "network";
}

export function getExchangeRateErrorMessageKey(kind: ExchangeRateErrorKind) {
  if (kind === "timeout") return "error.timeout";
  if (kind === "contract") return "error.exchangeRatesContract";
  return "error.network";
}

export function exchangeRateErrorDetailsFromError(error: unknown): RawErrorResponseDetails | null {
  if (error instanceof ExchangeRateProviderError) return error.errorDetails;
  if (error instanceof ExchangeRateUpstreamError) return error.errorDetails;
  if (error instanceof ExchangeRateContractError) return error.errorDetails;
  if (error instanceof Error || typeof error === "string") return createRawErrorResponseDetails(error);
  return null;
}

export function exchangeRateErrorLogContext(error: unknown): Record<string, unknown> {
  if (error instanceof ExchangeRateProviderError) {
    return {
      name: error.name,
      message: error.message,
      provider: error.provider,
      kind: error.kind,
      cause: exchangeRateErrorLogContext(error.originalCause),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: typeof error === "string" ? error : String(error) };
}

export function reportExchangeRateFetchError(error: unknown): void {
  reportClientError(new Error("Exchange rate fetch failed"), {
    source: "exchange-rates.fetch",
    ...exchangeRateErrorLogContext(error),
  });
}

export function createExchangeRateStore(options: ExchangeRateStoreOptions = {}): ExchangeRateStore {
  const memoryCache = new Map<ExchangeRateProvider, CachedExchangeRateData>();
  const inFlightRequests = new Map<ExchangeRateProvider, InFlightRatesRequest>();
  const fetcher: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const storage = () => options.storage === undefined ? getDefaultStorage() : options.storage;

  function readCachedRates(requestedProvider: ExchangeRateProvider): CachedExchangeRateData | null {
    const memoryCached = memoryCache.get(requestedProvider);
    if (memoryCached && now() - memoryCached.cachedAt < CACHE_DURATION) return memoryCached;

    try {
      const cached = storage()?.getItem(exchangeRateCacheKey(requestedProvider));
      if (!cached) return null;

      const data = normalizeCachedExchangeRateData(JSON.parse(cached));
      if (!data) return null;
      if (data.requestedProvider !== requestedProvider) return null;

      // 24h 缓存是可用性优先：汇率轻微滞后，比每次打开页面都依赖外部网络更适合自托管。
      if (now() - data.cachedAt < CACHE_DURATION) {
        memoryCache.set(requestedProvider, data);
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  function setCachedRates(
    data: ExchangeRateData,
    provider: ExchangeRateProvider,
    requestedProvider: ExchangeRateProvider,
    warning: ExchangeRateCoverageWarning | null = null,
  ): CachedExchangeRateData {
    const cached: CachedExchangeRateData = {
      base: data.base,
      date: data.date,
      rates: data.rates,
      cachedAt: now(),
      provider,
      requestedProvider,
      warning,
    };
    memoryCache.set(requestedProvider, cached);
    try {
      storage()?.setItem(exchangeRateCacheKey(requestedProvider), JSON.stringify(cached));
    } catch (e) {
      console.warn("Failed to cache exchange rates:", e);
    }
    return cached;
  }

  async function fetchJsonWithTimeout(url: string, parentSignal: AbortSignal): Promise<{
    payload: unknown;
    responseText: string;
  }> {
    const controller = new AbortController();
    let timedOut = false;

    // 父级 abort 表示 provider 已切换或组件卸载；超时 abort 才需要反馈成用户可见的网络超时。
    const abortFromParent = () => controller.abort();
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    try {
      const response = await fetcher(url, {
        signal: controller.signal,
      });
      const responseText = await response.text();

      if (!response.ok) {
        const code = `HTTP ${response.status}`;
        throw new ExchangeRateUpstreamError(
          `HTTP error: ${response.status}`,
          createRawErrorResponseDetailsFromText({
            code,
            message: response.statusText || code,
            responseText,
          }),
        );
      }

      try {
        return { payload: JSON.parse(responseText) as unknown, responseText };
      } catch {
        throw new ExchangeRateContractError(
          "Invalid exchange rate JSON",
          createRawErrorResponseDetailsFromText({
            code: "INVALID_RESPONSE",
            message: "Invalid exchange rate JSON",
            responseText,
          }),
        );
      }
    } catch (e) {
      if (timedOut) throw new ExchangeRateTimeoutError();
      throw e;
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  }

  function assertAcceptableProviderCoverage(
    provider: ExchangeRateProvider,
    data: NormalizedExchangeRateData,
    responseText: string,
  ): NormalizedExchangeRateData {
    // 覆盖率阈值是 partial 成功与 contract 失败的分界；raw body 只在失败路径给排障弹窗使用。
    if (data.missingCurrencies.length <= MAX_PARTIAL_MISSING_CURRENCIES) return data;

    throw new ExchangeRateContractError(
      `Exchange-rate provider ${provider} is missing too many currencies`,
      createRawErrorResponseDetailsFromText({
        code: "INCOMPLETE_RESPONSE",
        message: `Exchange-rate provider ${provider} is missing too many currencies`,
        responseText,
      }),
    );
  }

  async function fetchFrankfurterRates(signal: AbortSignal): Promise<NormalizedExchangeRateData> {
    const { payload, responseText } = await fetchJsonWithTimeout(FRANKFURTER_USD_FEED, signal);
    const data = normalizeFrankfurterRatesResponse(payload);
    if (!data) {
      throw new ExchangeRateContractError(
        "Invalid Frankfurter response",
        createRawErrorResponseDetailsFromText({
          code: "INVALID_RESPONSE",
          message: "Invalid Frankfurter response",
          responseText,
        }),
      );
    }
    return assertAcceptableProviderCoverage("frankfurter", data, responseText);
  }

  async function fetchExchangeApiRates(signal: AbortSignal): Promise<NormalizedExchangeRateData> {
    const failures: unknown[] = [];
    for (const url of [EXCHANGE_API_PRIMARY_USD_FEED, EXCHANGE_API_FALLBACK_USD_FEED]) {
      try {
        const { payload, responseText } = await fetchJsonWithTimeout(url, signal);
        const data = normalizeExchangeApiUsdResponse(payload);
        if (!data) {
          throw new ExchangeRateContractError(
            "Invalid exchange-api response",
            createRawErrorResponseDetailsFromText({
              code: "INVALID_RESPONSE",
              message: "Invalid exchange-api response",
              responseText,
            }),
          );
        }
        return assertAcceptableProviderCoverage("exchange-api", data, responseText);
      } catch (e) {
        if (signal.aborted && !(e instanceof ExchangeRateTimeoutError)) throw e;
        failures.push(e);
        // exchange-api 的两个 URL 是同一数据源的 CDN 兜底；记录具体端点便于排查区域性 CDN 故障。
        console.warn(`Failed to fetch exchange rates from exchange-api endpoint ${url}:`, exchangeRateErrorLogContext(e));
      }
    }

    throw failures[0] ?? new Error("No exchange-api endpoint returned data");
  }

  async function fetchProviderRates(
    provider: ExchangeRateProvider,
    signal: AbortSignal,
  ): Promise<NormalizedExchangeRateData> {
    try {
      if (provider === "frankfurter") {
        return await fetchFrankfurterRates(signal);
      }
      if (provider === "exchange-api") {
        return await fetchExchangeApiRates(signal);
      }

      const { payload, responseText } = await fetchJsonWithTimeout(FLOATRATES_USD_FEED, signal);
      const data = normalizeFloatRatesResponse(payload);
      if (!data) {
        throw new ExchangeRateContractError(
          "Invalid FloatRates response",
          createRawErrorResponseDetailsFromText({
            code: "INVALID_RESPONSE",
            message: "Invalid FloatRates response",
            responseText,
          }),
        );
      }
      return assertAcceptableProviderCoverage(provider, data, responseText);
    } catch (e) {
      if (signal.aborted && !(e instanceof ExchangeRateTimeoutError)) throw e;
      throw new ExchangeRateProviderError(provider, errorKindFromProviderError(e), e);
    }
  }

  function toProviderError(provider: ExchangeRateProvider, error: unknown): ExchangeRateProviderError {
    return error instanceof ExchangeRateProviderError
      ? error
      : new ExchangeRateProviderError(provider, errorKindFromProviderError(error), error);
  }

  function warnProviderFailure(provider: ExchangeRateProvider, error: ExchangeRateProviderError): void {
    console.warn(`Failed to fetch exchange rates from ${provider}:`, exchangeRateErrorLogContext(error));
  }

  async function completePartialRates(
    primaryData: NormalizedExchangeRateData,
    primaryProvider: ExchangeRateProvider,
    requestedProvider: ExchangeRateProvider,
    remainingProviders: ExchangeRateProvider[],
    signal: AbortSignal,
    providerFailures: ExchangeRateProviderError[],
  ): Promise<CachedExchangeRateData> {
    const rates: ExchangeRates = { ...primaryData.rates, USD: 1 };
    const initialMissingCurrencies = primaryData.missingCurrencies;
    const fillSources: Record<string, ExchangeRateSource> = {};
    let missingCurrencies = initialMissingCurrencies;

    // partial 成功仍必须产出完整 USD base rates；后续远端只填主来源缺口，不覆盖已可信的主来源汇率。
    for (const provider of remainingProviders) {
      if (missingCurrencies.length === 0) break;

      try {
        const fillerData = await fetchProviderRates(provider, signal);
        for (const currency of missingCurrencies) {
          const rate = fillerData.rates[currency];
          if (rate !== undefined) {
            rates[currency] = rate;
            fillSources[currency] = provider;
          }
        }
        missingCurrencies = getMissingSupportedCurrencies(rates);
      } catch (e) {
        if (signal.aborted) throw e;
        const providerError = toProviderError(provider, e);
        providerFailures.push(providerError);
        warnProviderFailure(provider, providerError);
      }
    }

    // 远端补不齐时才落到内置快照；这让统计保持可用，同时通过 warning 暴露暂用来源。
    for (const currency of missingCurrencies) {
      const rate = FALLBACK_RATES[currency];
      if (rate !== undefined) {
        rates[currency] = rate;
        fillSources[currency] = "builtin";
      }
    }

    missingCurrencies = getMissingSupportedCurrencies(rates);
    if (missingCurrencies.length > 0) {
      throw new ExchangeRateProviderError(
        primaryProvider,
        "contract",
        new ExchangeRateContractError(`Exchange-rate provider ${primaryProvider} could not be completed`),
      );
    }

    const warning: ExchangeRateCoverageWarning = {
      kind: "partial",
      provider: primaryProvider,
      missingCurrencies: initialMissingCurrencies,
      fillSources,
    };

    return setCachedRates(
      { ...primaryData, rates },
      primaryProvider,
      requestedProvider,
      warning,
    );
  }

  function loadRemoteRates(requestedProvider: ExchangeRateProvider): Promise<CachedExchangeRateData> {
    const currentRequest = inFlightRequests.get(requestedProvider);
    if (currentRequest && !currentRequest.controller.signal.aborted) {
      return currentRequest.promise;
    }

    const controller = new AbortController();
    const promise = (async () => {
      const providerFailures: ExchangeRateProviderError[] = [];
      const providerOrder = getProviderOrder(requestedProvider);
      for (const [index, provider] of providerOrder.entries()) {
        try {
          const data = await fetchProviderRates(provider, controller.signal);
          const ratesWithBase = { ...data.rates, USD: 1 };
          // 少量缺币是成功态：完成补齐后缓存 warning，避免设置页展示“查看错误响应”误导用户。
          if (data.missingCurrencies.length > 0) {
            return await completePartialRates(
              { ...data, rates: ratesWithBase },
              provider,
              requestedProvider,
              providerOrder.slice(index + 1),
              controller.signal,
              providerFailures,
            );
          }
          return setCachedRates({ ...data, rates: ratesWithBase }, provider, requestedProvider);
        } catch (e) {
          if (controller.signal.aborted) throw e;
          const providerError = toProviderError(provider, e);
          providerFailures.push(providerError);
          warnProviderFailure(provider, providerError);
        }
      }

      throw providerFailures[0] ?? new ExchangeRateProviderError(requestedProvider, "network", new Error("No exchange-rate provider returned data"));
    })().finally(() => {
      const current = inFlightRequests.get(requestedProvider);
      if (current?.controller === controller) {
        inFlightRequests.delete(requestedProvider);
      }
    });

    inFlightRequests.set(requestedProvider, {
      controller,
      promise,
    });
    return promise;
  }

  return {
    readCachedSnapshot(requestedProvider) {
      const cached = readCachedRates(requestedProvider);
      return cached ? applyCachedRates(cached) : null;
    },
    async loadRemoteSnapshot(requestedProvider) {
      return applyCachedRates(await loadRemoteRates(requestedProvider));
    },
  };
}

// 默认实例是生产运行面的共享缓存事实源；测试通过 factory 注入独立 store，避免暴露测试专用 reset 出口。
export const defaultExchangeRateStore = createExchangeRateStore();
