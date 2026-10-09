import { expect, type Page, type Response } from "@playwright/test";

export const adminEmail = "admin-e2e@example.com";
export const adminPassword = "password123";
export const adminStorageState = "e2e/.auth/admin.json";

/** 捕获 Renewlet 产品登录响应；Cloudflare 巡检使用独立 auth setup，不复用这个判定。 */
export function isProductLoginResponse(response: Response): boolean {
  return response.url().includes("/api/app/auth/login") &&
    response.request().method() === "POST";
}

/** 确认空库首屏仍是 Renewlet 初始化页，而不是 PocketBase installer 后台。 */
export async function expectRenewletSetupPage(page: Page) {
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "初始化 Renewlet" })).toBeVisible();
  // PocketBase 空库默认 installer 曾经会弹到后端 /_/#/pbinstall；这里守住
  // Renewlet /setup 是唯一首屏入口，避免 headed E2E 看见无关后端管理页。
  await expect(page.getByText("Setup your PocketBase instance")).toHaveCount(0);
  await expect(page.getByText("Create your first superuser account")).toHaveCount(0);
}

export async function loginThroughProductUI(page: Page, email: string, password: string) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  // 登录成功必须以产品 auth 响应为准；URL 跳转可能先发生，但 cookie session 还没完全落盘。
  const loginResponsePromise = page.waitForResponse((response) => isProductLoginResponse(response));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok(), await loginResponse.text()).toBe(true);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("月均支出")).toBeVisible();
}
