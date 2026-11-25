import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { Page, Request, TestInfo } from "@playwright/test";
import { subscriptionsIndexResponseSchema } from "@renewlet/shared/schemas/subscriptions";
import { test, expect } from "./support/test";
import { buildArtifactHash } from "../scripts/browser-performance";
import { deleteProductSubscriptionsByName, productApiFetch } from "./support/product-api";
import { createSubscription, subscriptionCard, uniqueE2EName } from "./support/subscriptions";

async function servePreviousBuild(page: Page, baseURL: string | undefined, testInfo: TestInfo) {
  const input = process.env["RENEWLET_E2E_PREVIOUS_DIST"];
  if (!input || !baseURL) throw new Error("Upgrade journey requires an explicit historical production dist and isolated baseURL");
  const previousDist = resolve(input);
  const previousRoot = resolve(previousDist, "../../..");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: previousRoot, encoding: "utf8" }).trim();
  const previousArtifactHash = buildArtifactHash(previousDist);
  const candidateArtifactHash = buildArtifactHash(resolve("apps/web/dist"));
  expect(previousArtifactHash, "Upgrade requires two distinct frontend builds").not.toBe(candidateArtifactHash);
  await testInfo.attach("upgrade-builds", { body: JSON.stringify({ revision, previousArtifactHash, candidateArtifactHash }), contentType: "application/json" });
  let previousDeployment = true;
  // 真实旧产物模拟发布前页面；只替换静态文件，认证和读写仍穿过本轮隔离的真实产品 API。
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!previousDeployment || url.origin !== new URL(baseURL).origin || url.pathname.startsWith("/api/")) return route.fallback();
    const isDocument = route.request().isNavigationRequest();
    if (!isDocument && !url.pathname.startsWith("/assets/") && url.pathname !== "/renewlet-client-bootstrap.js") return route.fallback();
    const file = resolve(previousDist, isDocument ? "index.html" : `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${previousDist}${sep}`)) throw new Error("Historical asset escaped its build directory");
    // 缺失旧 chunk 必须真实失败，不能偷偷回退到候选文件来假装旧页面兼容。
    await route.fulfill({ path: file });
  });
  return () => { previousDeployment = false; };
}

test("an open previous release preserves its draft, loaded routes and preferences until explicit refresh", async ({ page, baseURL }, testInfo) => {
  const deployCandidate = await servePreviousBuild(page, baseURL, testInfo);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "系统配置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  const theme = await page.evaluate(() => localStorage.getItem("renewlet_theme_mode"));
  expect(theme).not.toBeNull();
  await page.locator('header a[href="/subscriptions"]:visible').first().click();
  await expect(page.getByRole("heading", { name: "订阅列表", exact: true })).toBeVisible();
  const cropModuleResponse = page.waitForResponse((response) => /\/assets\/image-crop-dialog-[^/]+\.js$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "添加订阅", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "添加新订阅", exact: true });
  // 本旅程只覆盖已加载模块；先完成真实 focus 预取，避免发布时把晚到的裁剪预取混成删旧 chunk 场景。
  await dialog.getByTestId("logo-picker-control-row").getByRole("button").first().focus();
  const cropModule = await cropModuleResponse;
  expect(cropModule.ok()).toBe(true);
  expect(await cropModule.finished()).toBeNull();
  await dialog.getByLabel("服务名称", { exact: true }).fill("Unsaved upgrade draft");
  const navigations: string[] = [];
  const recordNavigation = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
  };
  page.on("request", recordNavigation);
  try {
    deployCandidate();
    await expect(dialog.getByLabel("服务名称", { exact: true })).toHaveValue("Unsaved upgrade draft");
    await dialog.getByLabel("服务名称", { exact: true }).fill("Still editing after deployment");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    // 只声称已加载模块可继续导航；这不是 HTTP 缓存或已删除 chunk 的恢复测试。
    await page.locator('header a[href="/settings"]:visible').first().click();
    await expect(page.getByRole("heading", { name: "系统配置", exact: true })).toBeVisible();
    expect(navigations).toEqual([]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "系统配置", exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("renewlet_theme_mode"))).toBe(theme);
    expect(navigations).toHaveLength(1);
  } finally {
    page.off("request", recordNavigation);
  }
});

test("subscriptions saved by the previous frontend keep their category and identity in grouped view", async ({ page, baseURL }, testInfo) => {
  const deployCandidate = await servePreviousBuild(page, baseURL, testInfo);
  const prefix = uniqueE2EName(testInfo, "Category upgrade");
  const names = [`${prefix} A`, `${prefix} B`] as const;
  const readSubscriptions = async () => {
    const result = await productApiFetch(page, `/api/app/subscriptions/index?q=${encodeURIComponent(prefix)}`);
    expect(result.ok, result.body).toBe(true);
    return subscriptionsIndexResponseSchema.parse(result.json).data.subscriptions;
  };
  await page.goto("/subscriptions");
  try {
    for (const name of names) await createSubscription(page, { name, price: "12" });
    const firstCard = subscriptionCard(page, names[0]);
    await firstCard.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expect(firstCard.getByTestId("subscription-pinned-title-icon")).toBeVisible();
    const saved = await readSubscriptions();
    expect(saved.map(({ name, category, pinned }) => [name, category, pinned])).toEqual([
      [names[0], "productivity", true], [names[1], "productivity", false],
    ]);

    deployCandidate();
    await page.reload();
    const groupByCategory = page.getByRole("switch", { name: "按分类分组" });
    await page.getByRole("searchbox").fill(prefix);
    await expect(page.getByRole("button", { name: "切换到列表视图" })).toBeVisible();
    await expect(groupByCategory).not.toBeChecked();
    await groupByCategory.click();
    await expect(page.getByRole("heading", { level: 2, name: "生产力 2 个订阅", exact: true })).toBeVisible();
    await expect(page.getByTestId("subscription-card").getByRole("heading", { level: 3 })).toHaveText([...names]);
    await expect(firstCard.getByTestId("subscription-pinned-title-icon")).toBeVisible();
    expect(await readSubscriptions()).toEqual(saved);

    await page.reload();
    await expect(groupByCategory).not.toBeChecked();
  } finally {
    await deleteProductSubscriptionsByName(page, names);
  }
});
