import { subscriptionResponseSchema } from "@renewlet/shared/schemas/subscriptions";
import { expect, test } from "./support/test";
import { deleteProductSubscriptionsByName, productApiFetch } from "./support/product-api";
import { subscriptionCard, uniqueE2EName } from "./support/subscriptions";

test("restart confirms out-of-range member dates without losing sharing or balance", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/subscriptions");
  const name = uniqueE2EName(testInfo, "Restart shared subscription");
  const costSharing = { enabled: true, splitMode: "custom", collectionReminder: { enabled: true, reminderDays: 3 }, members: [
    { id: "member-old", name: "Alice", joinedDate: "2020-01-31", customAmount: "3", currency: "USD", note: "Keep this note" },
    { id: "member-inherited", name: "Bob", customAmount: "0" },
  ] };
  const created = await productApiFetch(page, "/api/app/subscriptions", { method: "POST", body: {
    name, price: "10", currency: "USD", billingCycle: "monthly", category: "entertainment", status: "active",
    startDate: "2020-01-01", nextBillingDate: "2099-01-01", autoRenew: false, autoCalculateNextBillingDate: false,
    costSharing, balance: "0", balanceCurrency: "JPY", reminderDays: -1,
    repeatReminderEnabled: false, repeatReminderInterval: "1h", repeatReminderWindow: "72h",
  } });
  expect(created.ok).toBe(true);
  const original = subscriptionResponseSchema.parse(created.json).data.subscription;
  try {
    await page.reload();
    const open = async () => {
      await subscriptionCard(page, name).getByRole("button", { name: "更多操作" }).click();
      await page.getByRole("menuitem", { name: "续订", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `续订「${name}」` });
      await dialog.getByRole("radio", { name: /重新开始订阅/ }).click();
      await expect(dialog.getByRole("heading", { name: "确认成员上车日期" })).toBeVisible();
      return dialog;
    };
    let dialog = await open();
    await expect(dialog.getByRole("button", { name: /Alice的上车日期/ })).toHaveAccessibleDescription(/原日期/);
    await expect(dialog.getByRole("button", { name: /Bob的上车日期/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    const cancelled = await productApiFetch(page, `/api/app/subscriptions/${original.id}`);
    expect(subscriptionResponseSchema.parse(cancelled.json).data.subscription.costSharing).toEqual(costSharing);
    dialog = await open();
    await dialog.getByRole("button", { name: /Alice的上车日期/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("restart-member-confirmation-390.png") });
    const responsePromise = page.waitForResponse(response => response.url().endsWith(`/${original.id}/renew`) && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "重新开始订阅", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(dialog).toBeHidden();
    const reloaded = await productApiFetch(page, `/api/app/subscriptions/${original.id}`);
    const saved = subscriptionResponseSchema.parse(reloaded.json).data.subscription;
    expect(saved).toMatchObject({ balance: "0", balanceCurrency: "JPY", costSharing: {
      ...costSharing, members: [{ ...costSharing.members[0], joinedDate: saved.startDate }, costSharing.members[1]],
    } });
    expect(saved.startDate).not.toBe(original.startDate);
  } finally { await deleteProductSubscriptionsByName(page, [name]); }
});
