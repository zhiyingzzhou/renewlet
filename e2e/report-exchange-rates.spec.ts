import { test, expect } from "./support/test";

for (const departure of ["navigate", "reload", "close"] as const) {
  test(`report snapshot cancels without warnings on document ${departure}`, async ({ page }) => {
    const diagnosticKey = "e2e-report-discard-diagnostics";
    await page.addInitScript((key) => {
      const append = (event: string) => {
        const events: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
        events.push(event);
        localStorage.setItem(key, JSON.stringify(events));
      };
      // 旧文档的 console 可能不再关联 Playwright Page；保留原始输出，同时让下一个文档读取取消边界的诊断。
      const warn = console.warn;
      console.warn = (...args: unknown[]) => {
        append(`warning: ${args.map(String).join(" ")}`);
        warn(...args);
      };
      addEventListener("pagehide", (event) => append(`pagehide: ${event.persisted}`));
    }, diagnosticKey);
    await page.route("**/api/app/exchange-rate-snapshots?*", (route) => route.fulfill({
      json: { ok: true, data: { snapshots: [] } },
    }));
    const captureURL = /\/api\/app\/exchange-rate-snapshots\/\d{4}-\d{2}$/;
    // 刻意不响应，由原生离开取消拦截中的请求；不留下等待 response 的 route 回调或任意延迟。
    await page.route(captureURL, () => undefined);
    const pendingCapture = page.waitForRequest((request) => request.method() === "PUT" && captureURL.test(request.url()));
    await page.goto("/");
    await pendingCapture;
    if (departure === "close") {
      await page.close();
    } else if (departure === "reload") {
      await page.reload();
    } else {
      await page.goto("/subscriptions");
    }
    const reader = await page.context().newPage();
    try {
      await reader.route("**/__report-diagnostics__", (route) => route.fulfill({
        contentType: "text/html", body: "<!doctype html><title>Report diagnostics</title>",
      }));
      await reader.goto("/__report-diagnostics__");
      const events = await reader.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as string[], diagnosticKey);
      expect(events).toContain("pagehide: false");
      expect(events.filter((event) => event.startsWith("warning:"))).toEqual([]);
    } finally {
      await reader.close();
    }
  });
}
