import { subscriptionResponseSchema } from "@renewlet/shared/schemas/subscriptions";
import { expect, test } from "./support/test";
import { createProductSubscriptionSeed, deleteProductSubscriptionsByName, productApiFetch } from "./support/product-api";
import { openSubscriptionDetailDialog, subscriptionCard, uniqueE2EName } from "./support/subscriptions";

test("manual early renewal stays in More, hands off details, saves once, and restores focus", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  const name = uniqueE2EName(testInfo, "Early renewal");
  const id = await createProductSubscriptionSeed(page, { name, price: "12", startDate: "2026-01-31", nextBillingDate: "2099-01-31", autoRenew: false, autoCalculateNextBillingDate: false });
  try {
    await page.reload();
    const card = subscriptionCard(page, name);
    await expect(card.getByRole("button", { name: "续订", exact: true })).toHaveCount(0);
    const more = card.getByRole("button", { name: "更多操作" });
    await more.click();
    await page.getByRole("menuitem", { name: "续订", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `续订「${name}」` });
    await expect(dialog.getByRole("radio", { name: /延续原周期/ })).toBeChecked();
    await expect(dialog.getByText(/2099.*2.*28/)).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(more).toBeFocused();
    const detail = await openSubscriptionDetailDialog(page, name);
    await detail.dialog.getByRole("button", { name: "续订", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await dialog.getByLabel("价格", { exact: true }).fill("0");
    let release!: () => void;
    let observed!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const requestSeen = new Promise<void>(r => { observed = r; });
    let writes = 0;
    await page.route(`**/api/app/subscriptions/${id}/renew`, async route => { writes++; observed(); await gate; await route.continue(); });
    await dialog.getByRole("button", { name: "确认续订" }).click();
    await requestSeen;
    await expect(dialog.getByRole("button", { name: "取消" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("renewal-saving.png") });
    release();
    await expect(dialog).toBeHidden();
    expect(writes).toBe(1);
    const result = await productApiFetch(page, `/api/app/subscriptions/${id}`);
    expect(subscriptionResponseSchema.parse(result.json).data.subscription).toMatchObject({ nextBillingDate: "2099-02-28", price: "0", startDate: "2026-01-31" });
  } finally { await deleteProductSubscriptionsByName(page, [name]); }
});

test("lost renewal response requires reading committed state before another explicit confirmation", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  const name = uniqueE2EName(testInfo, "Lost renewal response");
  const id = await createProductSubscriptionSeed(page, { name, price: "12", status: "expired", startDate: "2026-01-31", nextBillingDate: "2026-02-28", autoRenew: false });
  try {
    await page.reload();
    await subscriptionCard(page, name).getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "续订", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `续订「${name}」` });
    await expect(dialog.getByRole("radio", { name: /延续原周期/ })).toBeChecked();
    let writes = 0;
    // 服务端真实提交后破坏成功响应，验证结果未知分支不会把写请求自动重放。
    await page.route(`**/api/app/subscriptions/${id}/renew`, async route => {
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await dialog.getByLabel("价格", { exact: true }).fill("23");
    await dialog.getByRole("button", { name: "确认续订" }).click();
    await expect(dialog.getByRole("alert")).toContainText("尚无法确认");
    await expect(dialog.getByRole("button", { name: "确认续订" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("renewal-result-unknown.png") });
    await dialog.getByRole("button", { name: "刷新续订信息" }).click();
    await expect(dialog.getByRole("button", { name: "确认续订" })).toBeEnabled();
    await expect(dialog.getByLabel("价格", { exact: true })).toHaveValue("23");
    expect(writes).toBe(1);
    await dialog.getByRole("button", { name: "取消" }).click();
    const result = await productApiFetch(page, `/api/app/subscriptions/${id}`);
    expect(subscriptionResponseSchema.parse(result.json).data.subscription).toMatchObject({ status: "active", price: "23" });
  } finally { await deleteProductSubscriptionsByName(page, [name]); }
});

test("narrow restart form scrolls its dates without covering footer actions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/subscriptions");
  const name = uniqueE2EName(testInfo, "Narrow renewal");
  await createProductSubscriptionSeed(page, { name, price: "12", startDate: "2026-01-31", nextBillingDate: "2099-01-31", autoRenew: false });
  try {
    await page.reload();
    await subscriptionCard(page, name).getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "续订", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `续订「${name}」` });
    await dialog.getByRole("radio", { name: /重新开始订阅/ }).click();
    const fields = dialog.locator('[data-dialog-region="renewal-fields"]');
    const actions = dialog.locator('[data-dialog-region="renewal-actions"]');
    // 宽度断言抓不到 fieldset 的纵向绘制溢出；检查真实命中区，不能靠 footer 背景遮住仍可点击的日期。
    const footerOwnsHitArea = () => actions.evaluate(node => {
      const rect = node.getBoundingClientRect();
      for (let y = rect.top + 4; y < rect.bottom - 4; y += 8) {
        if (!node.contains(document.elementFromPoint(rect.left + rect.width / 2, y))) return false;
      }
      return true;
    });
    await expect.poll(footerOwnsHitArea).toBe(true);
    const box = await fields.boundingBox();
    if (!box) throw new Error("Renewal fields are not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => fields.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(dialog.locator("#renew-start-date")).toBeInViewport();
    await expect(dialog.locator("#renew-next-billing-date")).toBeInViewport();
    await expect.poll(footerOwnsHitArea).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("renewal-restart-scrolled-320.png") });
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toBeHidden();
  } finally { await deleteProductSubscriptionsByName(page, [name]); }
});
