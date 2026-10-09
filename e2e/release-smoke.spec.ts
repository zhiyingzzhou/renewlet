import type { Page } from "@playwright/test";
import { expect, installE2EPageGuards, test } from "./support/test";
import { loginThroughProductUI } from "./support/auth";
import { createAdminManagedUser, deleteProductSubscriptionsByName, updateProductSettings } from "./support/product-api";
import { subscriptionCard, uniqueE2EName } from "./support/subscriptions";
import { createStoredZip } from "./support/zip";

test.describe("release smoke", () => {
  // Release smoke 共享 setup 产出的唯一管理员库状态；串行执行能避免导入、设置和账号安全旅程互相抢会话。
  test.describe.configure({ mode: "serial" });

  test("release smoke @release keeps the initialized admin session usable", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("月均支出")).toBeVisible();

    await page.goto("/subscriptions");
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
  });

  test("release smoke @release restores a Renewlet ZIP export", async ({ page }, testInfo) => {
    const subscriptionName = uniqueE2EName(testInfo, "Release Zip Restore");
    try {
      // 最小 Renewlet ZIP 仍包含 manifest，守住真实导入恢复契约，而不是只测裸 JSON happy path。
      const zip = createStoredZip([
        {
          name: "data.json",
          content: JSON.stringify(createRenewletExport(subscriptionName)),
        },
        {
          name: "manifest.json",
          content: JSON.stringify({
            kind: "renewlet-export",
            schemaVersion: 1,
            exportedAt: "2026-08-05T00:00:00.000Z",
            subscriptions: 1,
            assets: 0,
            missingAssets: [],
          }),
        },
      ]);

      await page.goto("/subscriptions");
      await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
      await page.getByRole("button", { name: "导入数据" }).click();

      const dialog = page.getByRole("dialog", { name: "导入数据" });
      await expect(dialog).toBeVisible();
      const previewResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/app/import/preview") && response.request().method() === "POST",
      );
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "renewlet-release-smoke.zip",
        mimeType: "application/zip",
        buffer: zip,
      });
      const previewResponse = await previewResponsePromise;
      expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
      await expect(dialog.getByRole("heading", { name: "预览结果" })).toBeVisible();
      await expect(dialog.getByText(subscriptionName)).toBeVisible();

      const applyResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/app/import/apply") && response.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "执行导入" }).click();
      const applyResponse = await applyResponsePromise;
      expect(applyResponse.ok(), await applyResponse.text()).toBe(true);
      await expect(dialog).toBeHidden();
      await expect(subscriptionCard(page, subscriptionName)).toBeVisible();
    } finally {
      await deleteProductSubscriptionsByName(page, [subscriptionName]);
    }
  });

  test("release smoke @release imports an AI mocked SSE draft through preview", async ({ page }, testInfo) => {
    const subscriptionName = uniqueE2EName(testInfo, "Release AI Draft");
    try {
      await page.goto("/");
      await expect(page.getByText("月均支出")).toBeVisible();
      await updateProductSettings(page, {
        aiRecognition: {
          providerType: "openai",
          transportProtocol: "openai-chat",
          model: "gpt-5-mini",
          modelInputMode: "manual",
          baseUrl: "",
          apiKey: "sk-e2e-mocked",
          defaultThinkingControl: null,
        },
      });
      await page.reload();
      await installAIRecognitionSSEMock(page, subscriptionName);

      await page.goto("/subscriptions");
      await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
      await page.getByRole("button", { name: "AI 识别添加" }).click();

      const dialog = page.getByRole("dialog", { name: "AI 识别订阅" });
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder("粘贴记事本、备忘录或从 Excel 复制出的订阅列表...").fill(`${subscriptionName} USD 18 monthly 2026-09-05`);

      const streamResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/app/ai/subscriptions/recognize/stream") && response.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "生成订阅草稿" }).click();
      const streamResponse = await streamResponsePromise;
      expect(streamResponse.ok(), await streamResponse.text()).toBe(true);
      await expect(dialog.getByRole("heading", { name: "识别草稿" })).toBeVisible();
      await expect(dialog.getByText(subscriptionName)).toBeVisible();

      const previewResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/app/import/preview") && response.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "生成导入预览" }).click();
      const previewResponse = await previewResponsePromise;
      expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
      await expect(dialog.getByRole("heading", { name: "预览结果" })).toBeVisible();

      const applyResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/app/import/apply") && response.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "确认添加" }).click();
      const applyResponse = await applyResponsePromise;
      expect(applyResponse.ok(), await applyResponse.text()).toBe(true);
      await expect(dialog).toBeHidden();
      await expect(subscriptionCard(page, subscriptionName)).toBeVisible();
    } finally {
      await deleteProductSubscriptionsByName(page, [subscriptionName]);
    }
  });

  test("release smoke @release changes a managed user password and signs in again", async ({ page, browser, baseURL }, testInfo) => {
    if (!baseURL) throw new Error("Release smoke requires the Playwright frontend baseURL");
    const suffix = uniqueE2EName(testInfo, "release-user").toLowerCase();
    const email = `${suffix}@example.com`;
    const initialPassword = "password123";
    const nextPassword = "password456";

    await page.goto("/");
    await expect(page.getByText("月均支出")).toBeVisible();
    await createAdminManagedUser(page, {
      name: "Release User",
      email,
      password: initialPassword,
    });

    const userContext = await browser.newContext({
      baseURL,
      locale: "zh-CN",
      // 新用户旅程必须从空浏览器态开始；继承管理员 storageState 会把改密测试伪装成已登录。
      storageState: { cookies: [], origins: [] },
      timezoneId: "Asia/Shanghai",
    });
    const userPage = await userContext.newPage();
    const userPageGuards = await installE2EPageGuards(userPage);
    try {
      await loginThroughProductUI(userPage, email, initialPassword);
      await changeCurrentUserPassword(userPage, initialPassword, nextPassword);
      await logoutThroughProductUI(userPage);
      await loginThroughProductUI(userPage, email, nextPassword);
      await changeCurrentUserPassword(userPage, nextPassword, initialPassword);
    } finally {
      try {
        await userPageGuards.close();
      } finally {
        await userContext.close();
      }
    }

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
  });
});

function createRenewletExport(subscriptionName: string) {
  // 这里构造的是导入 wire fixture；字段保持和 shared import schema 对齐，避免 release smoke 依赖当前表单默认值。
  return {
    kind: "renewlet-export",
    schemaVersion: 1,
    exportedAt: "2026-08-05T00:00:00.000Z",
    data: {
      subscriptions: [{
        id: `rel_${subscriptionName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60)}`,
        name: subscriptionName,
        price: "18",
        currency: "USD",
        billingCycle: "monthly",
        category: "developer_tools",
        status: "active",
        pinned: false,
        publicHidden: false,
        startDate: "2026-08-01",
        nextBillingDate: "2026-09-01",
        autoRenew: false,
        autoCalculateNextBillingDate: true,
        tags: ["release-smoke"],
        reminderDays: 3,
        repeatReminderEnabled: false,
        repeatReminderInterval: "1h",
        repeatReminderWindow: "72h",
        extra: {},
      }],
      assets: [],
    },
  };
}

async function installAIRecognitionSSEMock(page: Page, subscriptionName: string) {
  // Release E2E 只验证 Renewlet SSE 消费和导入状态机；第三方 AI provider 必须 mock，避免 tag 发布依赖外部密钥或配额。
  await page.route("**/api/app/ai/subscriptions/recognize/stream", async (route) => {
    const response = createAIRecognitionResponse(subscriptionName);
    const events = [
      { type: "recognition/progress", stage: "model-start" },
      { type: "recognition/partial", subscriptionsSeen: 1, warningsSeen: 0 },
      { type: "recognition/final", response },
    ];
    await route.fulfill({
      status: 200,
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      },
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });
}

function createAIRecognitionResponse(subscriptionName: string) {
  return {
    providerType: "openai",
    transportProtocol: "openai-chat",
    model: "gpt-5-mini",
    subscriptions: [{
      name: subscriptionName,
      price: "18",
      currency: "USD",
      billingCycle: "monthly",
      customDays: null,
      customCycleUnit: null,
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
      category: "developer_tools",
      status: "active",
      paymentMethod: null,
      startDate: "2026-08-01",
      nextBillingDate: "2026-09-05",
      autoCalculateNextBillingDate: true,
      trialEndDate: null,
      website: null,
      notes: { value: "Release smoke subscription recognized from mocked billing text.", source: "suggested" },
      tags: ["release-smoke"],
      reminderDays: null,
      repeatReminderEnabled: null,
      repeatReminderInterval: null,
      repeatReminderWindow: null,
      confidence: "high",
      warnings: [],
    }],
    warnings: [],
    diagnostics: {
      schemaVersion: "1",
      promptVersion: "release-smoke",
      schemaName: "release-smoke",
      prompt: {
        system: { value: "", truncated: false },
        user: { value: "", truncated: false },
      },
      output: {
        rawModelText: null,
        rawObjectJson: null,
      },
      request: {
        providerType: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-5-mini",
        thinkingControl: null,
        maxOutputTokens: 4096,
        textCharCount: 0,
        images: [],
      },
      response: {
        usage: null,
        finishReason: null,
        providerMetadata: null,
      },
    },
  };
}

async function changeCurrentUserPassword(page: Page, currentPassword: string, newPassword: string) {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
  await page.getByRole("button", { name: "修改密码" }).click();
  const dialog = page.getByRole("dialog", { name: "修改密码" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("当前密码", { exact: true }).fill(currentPassword);
  await dialog.getByLabel("新密码", { exact: true }).fill(newPassword);
  await dialog.getByLabel("确认密码", { exact: true }).fill(newPassword);

  const passwordResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/app/account/password") && response.request().method() === "PUT",
  );
  await dialog.getByRole("button", { name: "保存新密码" }).click();
  const passwordResponse = await passwordResponsePromise;
  expect(passwordResponse.ok(), await passwordResponse.text()).toBe(true);
  await expect(dialog).toBeHidden();
}

async function logoutThroughProductUI(page: Page) {
  const logoutResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/app/auth/logout") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "退出登录" }).click();
  const logoutResponse = await logoutResponsePromise;
  expect(logoutResponse.ok(), await logoutResponse.text()).toBe(true);
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
}
