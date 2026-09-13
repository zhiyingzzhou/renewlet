import {
  expect,
  test as base,
  type ConsoleMessage,
  type Page,
  type Route,
  type Request,
} from "@playwright/test";
import { performanceEnvironmentSchema } from "../../scripts/browser-performance";
import { e2eFrankfurterRates, performanceExchangeRateCache } from "./exchange-rate-fixture";

type BrowserDiagnostic = {
  level: "error" | "pageerror" | "warning";
  text: string;
};

const FRANKFURTER_ROUTE = /^https:\/\/api\.frankfurter\.dev\/v2\/rates(?:\?.*)?$/;
export const test = base.extend<{ pageGuards: void; cacheExchangeRates: boolean }>({
  cacheExchangeRates: [false, { option: true }],
  pageGuards: [async ({ page, cacheExchangeRates }, use, testInfo) => {
    const day = cacheExchangeRates ? performanceEnvironmentSchema.parse(testInfo.config.metadata["performance"]).fixtureDay : undefined;
    const guards = await installE2EPageGuards(page, day);
    try {
      await use();
    } finally {
      await guards.close();
    }
  }, { auto: true }],
});

export async function installE2EPageGuards(page: Page, exchangeRateCacheDay?: string): Promise<{ close(): Promise<void> }> {
  const diagnostics: BrowserDiagnostic[] = [];
  const fulfillFrankfurter = async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(e2eFrankfurterRates),
    });
  };
  const recordConsoleMessage = (message: ConsoleMessage) => {
    const level = message.type();
    if (level !== "error" && level !== "warning") return;
    diagnostics.push({ level, text: message.text() });
  };
  const recordPageError = (error: Error) => {
    diagnostics.push({ level: "pageerror", text: error.stack ?? error.message });
  };
  const recordExternalRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.protocol === "https:") diagnostics.push({ level: "error", text: `Performance fixture escaped to external host: ${url.hostname}` });
  };

  // 每个显式 BrowserContext 都必须复用这组守卫，避免手工 page 绕过第三方隔离或浏览器诊断门禁。
  if (exchangeRateCacheDay) {
    page.on("request", recordExternalRequest);
    const cache = performanceExchangeRateCache(exchangeRateCacheDay);
    await page.addInitScript(({ key, value }) => {
      if (location.protocol === "http:" || location.protocol === "https:") localStorage.setItem(key, JSON.stringify(value));
    }, cache);
  } else {
    await page.route(FRANKFURTER_ROUTE, fulfillFrankfurter);
  }
  page.on("console", recordConsoleMessage);
  page.on("pageerror", recordPageError);
  return {
    async close() {
      // 诊断监听必须覆盖 page.close；提前 unroute 会让在途汇率请求落回真实网络，并把 teardown warning 留在守卫之外。
      if (!page.isClosed()) {
        await page.close();
      }
      page.off("console", recordConsoleMessage);
      page.off("pageerror", recordPageError);
      page.off("request", recordExternalRequest);
      expect(diagnostics, "unexpected browser console warnings or errors").toEqual([]);
    },
  };
}

export { expect };
