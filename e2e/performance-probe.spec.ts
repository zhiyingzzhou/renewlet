import { mock } from "node:test";
import { createServer } from "node:http";
import { expect, test } from "./support/test";
import { installPerformanceProbe, measurePerformance, observeHttpCache, waitForPerformanceContent } from "./support/performance-browser";
import { performanceSampleSchema } from "../scripts/browser-performance";

test.beforeEach(async ({ page }) => {
  await installPerformanceProbe(page, "2026-09-07");
  await page.route("**/performance-probe", (route) => route.fulfill({ contentType: "text/html", body: "<main>Probe</main>" }));
  await page.goto("/performance-probe");
});

test.afterEach(() => mock.restoreAll());

test("SPA timing starts on click rather than hover or automation preparation", async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<header><a href="/next">Navigate</a></header><div data-testid="dashboard-stat-grid">Content</div>';
    document.querySelector("a")?.addEventListener("click", (event) => {
      event.preventDefault();
      document.body.dataset["clickedAt"] = String(performance.now());
    });
    window.__renewletPerformance.start("navigation");
  });
  await page.getByRole("link", { name: "Navigate" }).hover();
  await page.getByRole("link", { name: "Navigate" }).click();
  await waitForPerformanceContent(page, "dashboard");
  const sample = await page.evaluate(() => ({
    measured: window.__renewletPerformance.finish(0).durationMs,
    sinceClick: performance.now() - Number(document.body.dataset["clickedAt"]),
  }));
  expect(sample.measured).toBeLessThanOrEqual(sample.sinceClick);
});

test("content readiness freezes time and DOM independently of later automation", async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<section data-testid="settings-section-content"><span id="locale">auto</span></section>';
    window.__renewletPerformance.start();
    document.querySelector("#locale")?.replaceChildren(document.createTextNode("中文"));
  });
  await waitForPerformanceContent(page, "settings");
  const before = await page.evaluate(() => window.__renewletPerformance.finish(0));
  await page.evaluate(() => document.body.append(document.createElement("aside")));
  expect(await page.evaluate(() => window.__renewletPerformance.finish(0))).toEqual(before);
  const fresh = await page.evaluate(() => {
    const start = window.__renewletPerformance.start();
    window.__renewletPerformance.markReady();
    return window.__renewletPerformance.finish(start);
  });
  expect(fresh.domNodes).toBe(before.domNodes + 1);
});

test("content commits before a delayed automation action resolves", async ({ page }, testInfo) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<button>Open</button>';
    document.querySelector("button")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", '<section role="dialog"><input id="name" /></section>');
      document.body.dataset["contentNodes"] = String(document.getElementsByTagName("*").length);
      // 两帧后的无关 DOM 故意先于动作 Promise 返回；样本必须冻结在内容首次就绪，而不是协议返回之后。
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.append(document.createElement("aside"));
        document.body.dataset["actionFinished"] = "true";
      }));
    });
  });
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("probe-observation", options) };
  await measurePerformance(page, observation, "dialog", "interaction", async () => {
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const completed = await page.waitForFunction(() => document.body.dataset["actionFinished"] === "true");
    await completed.dispose();
  }, () => waitForPerformanceContent(page, "dialog"));
  const attachment = testInfo.attachments.find((item) => item.name === "probe-observation")?.body;
  const sample = performanceSampleSchema.parse(JSON.parse(attachment?.toString() ?? "null"));
  expect(sample.metrics?.domNodes).toBe(await page.evaluate(() => Number(document.body.dataset["contentNodes"])));
});

test("input readiness freezes the matching result without waiting for Node polling", async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<input placeholder="搜索订阅、标签或备注..." /><article data-testid="subscription-card"><h3>before</h3></article>';
    document.querySelector("input")?.addEventListener("input", (event) => {
      if (event.target instanceof HTMLInputElement) document.querySelector("h3")?.replaceChildren(event.target.value);
    });
    window.__renewletPerformance.start("input");
  });
  await page.getByPlaceholder("搜索订阅、标签或备注...").fill("after");
  await waitForPerformanceContent(page, "search");
  const before = await page.evaluate(() => window.__renewletPerformance.finish(0));
  await page.getByPlaceholder("搜索订阅、标签或备注...").fill("later");
  expect(await page.evaluate(() => window.__renewletPerformance.finish(0))).toEqual(before);
});

test("scroll readiness requires the committed later virtual row and retains its snapshot", async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="root" style="height:80px;overflow:auto"><div data-testid="virtualized-subscription-list" style="height:1000px"><div data-index="301"><article data-testid="subscription-card">Row</article></div></div></div>';
    window.__renewletPerformance.start("scroll");
  });
  await page.locator("#root").evaluate((root) => root.scrollTo({ top: 500 }));
  await waitForPerformanceContent(page, "scroll");
  const before = await page.evaluate(() => window.__renewletPerformance.finish(0));
  await page.locator("#root").evaluate((root) => root.scrollTo({ top: 600 }));
  expect(await page.evaluate(() => window.__renewletPerformance.finish(0))).toEqual(before);
});

test("cache observations distinguish an actual 304 from a cold response", async ({ browser }) => {
  const server = createServer((request, response) => {
    if (request.url === "/assets/probe.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("ETag", '"probe-v1"');
      response.statusCode = request.headers["if-none-match"] === '"probe-v1"' ? 304 : 200;
      response.end(response.statusCode === 304 ? undefined : "window.cacheProbeLoaded = true;");
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<script src="/assets/probe.js"></script>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext();
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback probe address");
    const page = await context.newPage();
    const observer = await observeHttpCache(page);
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.goto("about:blank");
      await page.goto(`http://127.0.0.1:${address.port}`);
    } finally {
      expect(await observer.stop()).toEqual([{ path: "/assets/probe.js", source: "revalidated" }]);
    }
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("shifted business dates preserve resource timing and elapsed wall time", async ({ page }) => {
  await page.route("**/performance-resource", (route) => route.fulfill({ body: "native resource timing" }));
  const observed = await page.evaluate(async () => {
    const before = performance.now();
    const wallBefore = Date.now();
    await fetch("/performance-resource").then((response) => response.text());
    return {
      now: Date.now(), constructed: new Date().toISOString(), explicit: new Date("2026-01-01").toISOString(),
      elapsed: performance.now() - before,
      wallElapsed: Date.now() - wallBefore,
      resources: performance.getEntriesByType("resource").map((entry) => entry.name),
    };
  });
  expect(observed.now).toBeGreaterThan(new Date("2026-09-07T12:00:00+08:00").getTime());
  expect(observed.constructed).toMatch(/^2026-09-07T04:/);
  expect(observed.explicit).toBe("2026-01-01T00:00:00.000Z");
  expect(observed.elapsed).toBeGreaterThan(0);
  expect(observed.wallElapsed).toBeGreaterThan(0);
  expect(Math.abs(observed.elapsed - observed.wallElapsed)).toBeLessThan(5);
  expect(observed.resources.some((url) => url.endsWith("/performance-resource"))).toBe(true);
});

test("measurement freezes pending requests and removes its listeners", async ({ page }, testInfo) => {
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/performance-pending", async (route) => {
    await responseGate;
    await route.fulfill({ body: "finished after measurement" });
  });
  const on = mock.method(page, "on");
  const off = mock.method(page, "off");
  // 采集器自检不是产品性能样本，使用不同附件名，不能混入十次采样的分位数。
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("probe-observation", options) };
  try {
    await measurePerformance(page, observation, "probe", "interaction", async () => {
      const requested = page.waitForRequest("**/performance-pending");
      await page.evaluate(() => { void fetch("/performance-pending"); });
      await requested;
    }, async () => {});
    for (const call of on.mock.calls.slice(0, 4)) expect(off.mock.calls.map((removed) => removed.arguments)).toContainEqual(call.arguments);
    const body = testInfo.attachments.find((attachment) => attachment.name === "probe-observation")?.body;
    expect(body).toBeDefined();
    const sample = performanceSampleSchema.parse(JSON.parse(body?.toString() ?? "null"));
    expect(sample.errors).toEqual([]);
    expect(sample.metrics).toMatchObject({ requests: 1, pendingRequests: 1, responseBodyBytes: 0 });
  } finally {
    const finished = page.waitForResponse("**/performance-pending");
    releaseResponse();
    await (await finished).finished();
  }
});

test("failed measurement retains the error and cleans up listeners", async ({ page }, testInfo) => {
  const on = mock.method(page, "on");
  const off = mock.method(page, "off");
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("probe-observation", options) };
  await expect(measurePerformance(page, observation, "probe", "interaction", async () => {
    throw new Error("intentional readiness failure");
  }, async () => {})).rejects.toThrow("intentional readiness failure");
  for (const call of on.mock.calls) expect(off.mock.calls.map((removed) => removed.arguments)).toContainEqual(call.arguments);
  const body = testInfo.attachments.find((attachment) => attachment.name === "probe-observation")?.body;
  const sample = performanceSampleSchema.parse(JSON.parse(body?.toString() ?? "null"));
  expect(sample.metrics).toBeNull();
  expect(sample.errors).toContain("intentional readiness failure");
});
