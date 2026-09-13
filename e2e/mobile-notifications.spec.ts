// 移动端通知历史 E2E 用大量失败 job 撑开抽屉，专门保护长错误文本、滚动区域和顶部遮罩的布局边界。
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { expectOverlayLeavesTopScrim } from "./support/layout";
import { gotoSettingsSectionAfterHydration } from "./support/settings";

async function createNotificationHistoryRecords(page: Page) {
  const userId = await page.evaluate(() => {
    const authRaw = window.localStorage.getItem("pocketbase_auth");
    if (!authRaw) {
      throw new Error("Missing PocketBase auth state");
    }

    const auth: unknown = JSON.parse(authRaw);
    const record = auth && typeof auth === "object" && "record" in auth ? auth.record : null;
    if (!record || typeof record !== "object" || !("id" in record) || typeof record.id !== "string" || !record.id) {
      throw new Error("PocketBase auth state is missing user id");
    }
    return record.id;
  });
  // 私有快照只能通过后端事务生成；测试进程固定写隔离 E2E 库，不复制存储格式或新增产品写入口。
  await promisify(execFile)("go", ["test", "./cmd/renewlet", "-run", "^TestNotificationHistoryBrowserFixture$", "-count=1"], {
    cwd: resolve(__dirname, "../apps/docker-server"),
    env: { ...process.env, RENEWLET_E2E_NOTIFICATION_USER: userId },
    timeout: 60_000,
  });
}

test("mobile notification history opens selected details in a bounded bottom drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  await createNotificationHistoryRecords(page);

  // 先挂响应监听再进入设置页，避免本地高速接口在 click/goto 后瞬间完成导致等待丢包。
  const historyRead = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && response.status() === 200
    && response.url().includes("/api/app/notifications/history")
  ));
  await gotoSettingsSectionAfterHydration(page, "settings-notifications");
  await historyRead;

  await page.getByRole("button", { name: "查看调度与历史" }).click();
  await page.getByRole("tab", { name: "发送历史" }).click();

  const rows = page.getByTestId("notification-history-row");
  await expect(rows).toHaveCount(12);
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("notification-history-desktop-detail")).toBeHidden();

  await rows.first().click();

  const drawer = page.getByTestId("notification-history-detail-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("发送详情");
  await expect(drawer).toContainText("累计尝试渠道");
  await expect(drawer).toContainText("smtp.example.com");
  await expect(drawer).toContainText("通知内容快照 11");
  await expect(drawer).toHaveClass(/h5-notification-history-detail-drawer/);
  await expectOverlayLeavesTopScrim(page, drawer, "notification history detail drawer", 48);

  const metrics = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      height: Math.round(rect.height * 100) / 100,
      viewportHeight: window.innerHeight,
    };
  });
  expect(metrics.height, "notification history drawer should not occupy the whole viewport").toBeLessThanOrEqual(
    metrics.viewportHeight * 0.79,
  );
});
