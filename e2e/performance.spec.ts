import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installPerformanceProbe, measurePerformance, observeHttpCache, waitForPerformanceContent as waitForContent } from "./support/performance-browser";
import { performanceEnvironmentSchema, performancePages } from "../scripts/browser-performance";

const routes = {
  dashboard: "/", subscriptions: "/subscriptions", statistics: "/statistics", calendar: "/calendar", settings: "/settings",
} as const;

test.use({ cacheExchangeRates: true });

async function navigate(page: Page, route: keyof typeof routes) {
  await page.locator(`header a[href="${routes[route]}"]:visible`).first().click();
}

test.beforeEach(async ({ page }, testInfo) => {
  const environment = performanceEnvironmentSchema.parse(testInfo.config.metadata["performance"]);
  await installPerformanceProbe(page, environment.fixtureDay);
});

for (const route of performancePages) {
  test(`production ${route}: cold document and warm SPA navigation`, async ({ page }, testInfo) => {
    await measurePerformance(page, testInfo, route, "cold-document",
      () => page.goto(routes[route], { waitUntil: "domcontentloaded" }),
      () => waitForContent(page, route));
    const away = route === "dashboard" ? "subscriptions" : "dashboard";
    await navigate(page, away);
    await waitForContent(page, away);
    await measurePerformance(page, testInfo, route, "warm-spa",
      () => navigate(page, route), () => waitForContent(page, route));
    // 新文档丢弃 React/Query 内存，但保留同一 context 的 HTTP cache；不能与 SPA 暖导航混算。
    await page.goto("about:blank");
    const cacheObserver = await observeHttpCache(page);
    let cacheHits: Awaited<ReturnType<typeof cacheObserver.stop>>;
    try {
      await measurePerformance(page, testInfo, route, "warm-document",
        () => page.goto(routes[route], { waitUntil: "domcontentloaded" }), () => waitForContent(page, route));
    } finally {
      cacheHits = await cacheObserver.stop();
      await testInfo.attach("performance-http-cache", { body: JSON.stringify({ route, cacheHits }), contentType: "application/json" });
    }
    const resources = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
      .filter((entry) => new URL(entry.name).origin === location.origin && new URL(entry.name).pathname.startsWith("/assets/"))
      .map((entry) => ({ path: new URL(entry.name).pathname, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize })));
    await testInfo.attach("performance-http-cache", { body: JSON.stringify({ route, resources }), contentType: "application/json" });
    expect(cacheHits.length, "warm document must reuse cached asset bodies, including revalidation").toBeGreaterThan(0);
  });
}

test("production search commits its filtered result", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  await waitForContent(page, "subscriptions");
  const name = "Performance Subscription 1000-777";
  await measurePerformance(page, testInfo, "search", "interaction",
    () => page.getByPlaceholder("搜索订阅、标签或备注...").fill(name),
    () => waitForContent(page, "search"));
});

test("production 1000-row virtual list scroll", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  await waitForContent(page, "subscriptions");
  const indexResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/subscriptions/index");
  await page.getByPlaceholder("搜索订阅、标签或备注...").fill("Performance Subscription");
  expect((await indexResponse).ok()).toBe(true);
  await expect(page.getByTestId("virtualized-subscription-list")).toBeVisible();
  // 先证明索引已提交为千行虚拟列表，避免把 50 条分页数据的滚动误记成规模基线。
  await expect.poll(() => page.getByTestId("virtualized-subscription-list").evaluate((list) => list.getBoundingClientRect().height)).toBeGreaterThan(20_000);
  await measurePerformance(page, testInfo, "scroll", "interaction",
    () => page.locator("#root").evaluate((root) => root.scrollTo({ top: root.scrollHeight })),
    () => waitForContent(page, "scroll"));
});

test("production add dialog opens without changing data", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  await waitForContent(page, "subscriptions");
  const dialog = page.getByRole("dialog", { name: "添加新订阅" });
  await measurePerformance(page, testInfo, "dialog", "interaction",
    () => page.getByRole("button", { name: "添加订阅", exact: true }).first().click(),
    () => waitForContent(page, "dialog"));
  // 表单要求显式关闭；计时结束后走取消清理，不用 Escape 绕过既有草稿保护。
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("production calendar switches the requested month", async ({ page }, testInfo) => {
  await page.goto("/calendar");
  await waitForContent(page, "calendar");
  await measurePerformance(page, testInfo, "calendar-switch", "interaction", async () => {
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/app/subscriptions/calendar");
    await page.getByRole("button", { name: "下个月", exact: true }).click();
    expect((await response).ok()).toBe(true);
  }, async () => {
    await waitForContent(page, "calendar-switch");
  });
});
