import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { Request } from "@playwright/test";
import { test, expect } from "./support/test";
import { buildArtifactHash } from "../scripts/browser-performance";

test("an open previous release preserves its draft, loaded routes and preferences until explicit refresh", async ({ page, baseURL }, testInfo) => {
  const input = process.env["RENEWLET_E2E_PREVIOUS_DIST"];
  if (!input || !baseURL) throw new Error("Upgrade journey requires an explicit historical production dist and isolated baseURL");
  const previousDist = resolve(input);
  const previousRoot = resolve(previousDist, "../../..");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: previousRoot, encoding: "utf8" }).trim();
  await testInfo.attach("upgrade-builds", { body: JSON.stringify({ revision,
    previousArtifactHash: buildArtifactHash(previousDist), candidateArtifactHash: buildArtifactHash(resolve("apps/web/dist")) }), contentType: "application/json" });
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
    previousDeployment = false;
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
