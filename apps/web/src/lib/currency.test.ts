import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_EXCHANGE_RATE_CURRENCIES } from "@/lib/currency-data";
import { moneyToNumber } from "@renewlet/shared/money";
import {
  formatCompactCurrencyAmount,
  formatCurrency,
  formatCurrencySymbolAmount,
  getCurrencyAmountPrefix,
} from "@/lib/currency";

describe("currency display", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses formatting work without retaining amounts or stale locale/currency identities", () => {
    formatCurrency(1, "EUR", "en-US");
    const NativeNumberFormat = Intl.NumberFormat;
    // Intl 兼容函数调用，但 formatToParts 要求真实实例；spy 必须透传 new，不能制造假构造器故障。
    const constructors = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) {
      return new NativeNumberFormat(locale, options);
    });
    for (let index = 0; index < 1000; index += 1) {
      expect(formatCurrency(index, "CNY", "zh-CN")).toContain(" CNY");
    }
    expect(constructors).toHaveBeenCalledTimes(2);
    expect(formatCurrency(1234.5, "EUR", "en-US")).toBe("€1,234.5 EUR");
    expect(constructors).toHaveBeenCalledTimes(4);
    expect(formatCurrency(5, "CNY", "zh-CN")).toBe("¥5 CNY");
    expect(constructors).toHaveBeenCalledTimes(6);
  });

  it("matches native formatting across supported and historical imported currencies", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const currency of [...SUPPORTED_EXCHANGE_RATE_CURRENCIES, "XXX", " usd ", "", "invalid"]) {
        const code = currency.trim().toUpperCase() || currency;
        let symbol = code;
        try {
          symbol = new Intl.NumberFormat(locale, {
            style: "currency", currency: code, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0,
          }).formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
        } catch {
          // 历史导入允许未知代码；与现有展示降级比较，不借优化拒绝旧输入。
        }
        const prefix = symbol.trim().toUpperCase() === code ? "" : symbol.trim();
        for (const amount of [0, -0, -1234.56, 0.009, 1234.567]) {
          const expected = new Intl.NumberFormat(locale, {
            minimumFractionDigits: 0, maximumFractionDigits: 2,
          }).format(moneyToNumber(amount));
          expect(formatCurrency(amount, currency, locale)).toBe(`${prefix}${expected} ${code}`);
        }
      }
    }
  });

  it("does not cache formatter failures or replace the previous valid identity", () => {
    formatCurrency(1, "CNY", "zh-CN");
    const NativeNumberFormat = Intl.NumberFormat;
    const constructors = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) {
      return new NativeNumberFormat(locale, options);
    }).mockImplementationOnce(function () {
      throw new RangeError("unavailable locale");
    });
    expect(formatCurrency(12.34, "CNY", "en-US")).toBe("¥12.34 CNY");
    expect(formatCurrency(1234.5, "CNY", "en-US")).toBe("¥1,234.5 CNY");
    expect(constructors).toHaveBeenCalledTimes(3);
  });

  it("keeps the narrow currency symbol and appends the ISO code for standalone amounts", () => {
    expect(formatCurrency(5, "USD", "zh-CN")).toBe("$5 USD");
    expect(formatCurrency(80, "CNY", "zh-CN")).toBe("¥80 CNY");
    expect(formatCurrency(12.5, "EUR", "en-US")).toBe("€12.5 EUR");
  });

  it("uses symbol-only amounts when a separate currency control already shows the code", () => {
    expect(getCurrencyAmountPrefix("USD", "zh-CN")).toBe("$");
    expect(formatCurrencySymbolAmount(5, "USD", "zh-CN")).toBe("$5");
  });

  it("keeps non-zero daily amounts visible at compact currency precision", () => {
    expect(formatCompactCurrencyAmount(1 / 3, "CNY", "zh-CN")).toBe("¥0.33");
    expect(formatCompactCurrencyAmount(0.01, "USD", "en-US")).toBe("$0.01");
    expect(formatCompactCurrencyAmount(0.009, "CNY", "zh-CN")).toBe("< ¥0.01");
    expect(formatCompactCurrencyAmount(0.009, "USD", "en-US")).toBe("< $0.01");
    expect(formatCompactCurrencyAmount(0, "CNY", "zh-CN")).toBe("¥0");
  });
});
