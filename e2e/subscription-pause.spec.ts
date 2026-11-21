import { subscriptionResponseSchema } from "@renewlet/shared/schemas/subscriptions";
import { expect, test } from "./support/test";
import { createProductSubscriptionSeed, deleteProductSubscriptionsByName, productApiFetch } from "./support/product-api";
import { subscriptionCard, uniqueE2EName } from "./support/subscriptions";

test("More pauses once and resumes only after an explicit status selection", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  const name = uniqueE2EName(testInfo, "Pause and resume");
  const id = await createProductSubscriptionSeed(page, { name, price: "120.99", startDate: "2026-01-31", nextBillingDate: "2099-01-31" });
  const path = `/api/app/subscriptions/${id}`;
  try {
    await page.reload();
    await page.getByPlaceholder("搜索订阅、标签或备注...").fill(name);
    const more = subscriptionCard(page, name).getByRole("button", { name: "更多操作" });
    const writes: Record<string, unknown>[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === path && request.method() === "PATCH") writes.push(request.postDataJSON());
    });
    await more.click();
    await page.getByRole("menuitem", { name: "暂停订阅" }).click();
    await expect(page.getByText(`已暂停「${name}」`, { exact: true })).toBeVisible();
    expect(writes).toEqual([{ status: "paused", expectedUpdatedAt: expect.any(String) }]);
    // 暂停写入可能先于 Radix 退出动画完成；旧 Portal 仍有菜单项时不能用它判断第二次打开成功。
    await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("menuitem", { name: "恢复订阅…" }).click();
    const dialog = page.getByRole("dialog", { name: "恢复订阅" });
    const status = dialog.getByRole("combobox", { name: "状态", exact: true });
    await expect(status).toBeFocused();
    await dialog.getByRole("button", { name: "恢复订阅", exact: true }).click();
    await expect(status).toHaveAttribute("aria-invalid", "true");
    expect(writes).toHaveLength(1);
    await status.click();
    await page.getByRole("option", { name: "活跃", exact: true }).click();
    await dialog.getByRole("button", { name: "恢复订阅", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(more).toBeFocused();
    expect(writes[1]).toEqual({ status: "active", expectedUpdatedAt: expect.any(String) });
    const result = await productApiFetch(page, path);
    expect(subscriptionResponseSchema.parse(result.json).data.subscription).toMatchObject({ price: "120.99", nextBillingDate: "2099-01-31", status: "active" });
  } finally {
    await deleteProductSubscriptionsByName(page, [name]);
  }
});

test("dashboard metrics keep their full text inside each card across grid breakpoints", async ({ page }, testInfo) => {
  await page.goto("/");
  const name = uniqueE2EName(testInfo, "Long monthly amount");
  await createProductSubscriptionSeed(page, { name, price: "987654.32", startDate: "2026-01-01", nextBillingDate: "2099-01-01" });
  try {
    await page.reload();
    const grid = page.getByTestId("dashboard-stat-grid");
    await expect(grid).toBeVisible();
    await expect(grid.locator("p")).toHaveCount(12);
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await grid.locator("p").evaluateAll(paragraphs => paragraphs.every(paragraph => {
        const card = paragraph.closest("[data-testid]")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        return Array.from(range.getClientRects()).every(rect => rect.left >= card.left && rect.right <= card.right
          && rect.top >= card.top && rect.bottom <= card.bottom) && getComputedStyle(paragraph).textOverflow !== "ellipsis";
      })), `Text clipped at ${width}px`).toBe(true);
    }
  } finally {
    await deleteProductSubscriptionsByName(page, [name]);
  }
});
