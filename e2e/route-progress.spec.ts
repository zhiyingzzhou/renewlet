import type { Request, Route } from "@playwright/test";
import { expect, test } from "./support/test";

test("navigation progress waits for main data without moving the header", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dashboard-stat-grid")).toBeVisible();
  await expect(page.getByTestId("route-progress")).toHaveCSS("opacity", "0");

  let releaseRequest: () => void = () => {};
  const released = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const matchesCollection = (url: URL) => url.pathname === "/api/app/subscriptions";
  const reads: Request[] = [];
  const collectionResults = () => Promise.all(reads.map(async (request) => {
    const response = request.existingResponse();
    if (!response) return request.failure()?.errorText ?? "pending";
    const failure = await response.finished();
    return request.failure()?.errorText ?? failure?.message ?? response.status();
  }));
  // 同时覆盖 hover 预取和 click 后首读；只冻结集合 GET，不延迟模块或真实写操作。
  const holdCollection = async (route: Route) => {
    if (route.request().method() === "GET") {
      reads.push(route.request());
      await released;
    }
    if (!page.isClosed()) await route.continue();
  };
  await page.route(matchesCollection, holdCollection);
  try {
    const link = page.locator('header a[href="/subscriptions"]:visible');
    await link.click();
    await expect(page.getByTestId("subscriptions-skeleton-list")).toBeVisible();
    const progress = page.getByTestId("route-progress");
    await expect(progress).toHaveCSS("opacity", "1");
    await expect.poll(() => progress.locator("div").evaluate((bar) =>
      Number(getComputedStyle(bar).getPropertyValue("--route-progress")),
    )).toBeGreaterThan(0.08);
    const loadingHeader = await page.getByTestId("app-header").boundingBox();
    const loadingWidth = await page.locator("#root").evaluate((root) => root.clientWidth);

    releaseRequest();
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    await expect(progress).toHaveCSS("opacity", "0");
    const readyHeader = await page.getByTestId("app-header").boundingBox();
    expect(loadingHeader).not.toBeNull();
    expect(readyHeader).not.toBeNull();
    if (!loadingHeader || !readyHeader) throw new Error("Missing header geometry");
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(loadingHeader[dimension] - readyHeader[dimension])).toBeLessThanOrEqual(1);
    }
    expect(await page.locator("#root").evaluate((root) => root.clientWidth)).toBe(loadingWidth);
    // 开发态卸载可取消已消费 AbortSignal 的查询；只允许一次明确取消，有效集合读取仍限一次。
    await expect.poll(async () => (await collectionResults()).filter(
      (result) => result !== "net::ERR_ABORTED",
    )).toEqual([200]);
    const initialReads = await collectionResults();
    expect(initialReads.filter((result) => result === "net::ERR_ABORTED").length).toBeLessThanOrEqual(1);

    await page.goBack();
    await expect(page.getByTestId("dashboard-stat-grid")).toBeVisible();
    await expect(progress).toHaveCSS("opacity", "0");
    await page.goForward();
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    await expect(progress).toHaveCSS("opacity", "0");
    await expect.poll(collectionResults).toEqual(initialReads);
  } finally {
    releaseRequest();
    if (!page.isClosed()) await page.unroute(matchesCollection, holdCollection);
  }
});

test("reduced-motion navigation keeps a static bar and clears it on readiness", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let releaseRequest: () => void = () => {};
  const released = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const matchesCollection = (url: URL) => url.pathname === "/api/app/subscriptions";
  const holdCollection = async (route: Route) => {
    await released;
    if (!page.isClosed()) await route.continue();
  };
  await page.route(matchesCollection, holdCollection);
  try {
    await page.goto("/subscriptions");
    const progress = page.getByTestId("route-progress");
    await expect(progress).toHaveCSS("opacity", "1");
    const sizes = await progress.evaluate((container) => ({
      container: container.getBoundingClientRect().width,
      bar: container.firstElementChild?.getBoundingClientRect().width ?? 0,
    }));
    expect(Math.abs(sizes.container - sizes.bar)).toBeLessThanOrEqual(1);
    releaseRequest();
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    await expect(progress).toHaveCSS("opacity", "0");
  } finally {
    releaseRequest();
    if (!page.isClosed()) await page.unroute(matchesCollection, holdCollection);
  }
});
