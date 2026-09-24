import { expect, test } from "./support/test";
import {
  getSettingsSaveButton,
  gotoSettingsSectionAfterHydration,
} from "./support/settings";
import { openAddSubscriptionDialog } from "./support/subscriptions";

async function setLunarCalendar(page: Parameters<typeof gotoSettingsSectionAfterHydration>[0], enabled: boolean) {
  await gotoSettingsSectionAfterHydration(page, "settings-display");
  const toggle = page.getByRole("switch", { name: "显示中国农历日期" });
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== enabled) {
    await toggle.click();
    const save = getSettingsSaveButton(page);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeHidden();
  }
}

test("lunar date picker keeps the complete six-week grid visible", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  await setLunarCalendar(page, true);

  try {
    await page.goto("/subscriptions");
    const dialog = await openAddSubscriptionDialog(page);
    const startDate = dialog.getByRole("button", { name: /开始日期.*选择日期/ }).first();
    await expect(startDate).toBeVisible();
    await startDate.click();

    const surface = mobile
      ? page.locator(".h5-mobile-sheet-calendar").last()
      : page.locator(".h5-calendar-popover:visible").last();
    await expect(surface).toBeVisible();
    await surface.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });
    const grid = surface.getByRole("grid");
    await expect(grid).toBeVisible();
    await expect(surface.locator(".h5-calendar-week")).toHaveCount(6);
    await expect(surface.locator(".h5-calendar-day-button")).toHaveCount(42);
    await expect(surface.locator(".h5-calendar-lunar")).toHaveCount(1);

    const metrics = await surface.evaluate((element) => {
      const surfaceRect = element.getBoundingClientRect();
      const cells = Array.from(element.querySelectorAll<HTMLElement>(".h5-calendar-day-button"));
      const lastCell = cells.at(-1);
      if (!lastCell) throw new Error("Missing final lunar calendar cell");
      const lastRect = lastCell.getBoundingClientRect();
      const style = getComputedStyle(element);
      const parent = element.parentElement?.getBoundingClientRect();
      return {
        bottom: Math.round(surfaceRect.bottom),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        top: Math.round(surfaceRect.top),
        height: Math.round(surfaceRect.height),
        lastCellBottom: Math.round(lastRect.bottom),
        side: element.getAttribute("data-side"),
        position: style.position,
        transform: style.transform,
        parentBottom: parent ? Math.round(parent.bottom) : null,
        visualViewport: window.visualViewport ? {
          height: Math.round(window.visualViewport.height),
          offsetTop: Math.round(window.visualViewport.offsetTop),
        } : null,
        viewportVar: getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height").trim(),
        layoutVar: getComputedStyle(document.documentElement).getPropertyValue("--app-layout-viewport-height").trim(),
        viewportHeight: window.innerHeight,
      };
    });
    expect(metrics.lastCellBottom, `final calendar week should remain inside the surface: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.bottom + 1);
    expect(metrics.bottom, `calendar surface should remain inside the viewport: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    expect(metrics.scrollHeight - metrics.clientHeight, "complete calendar should not require an inner scroll").toBeLessThanOrEqual(1);

    const selectedDay = surface.locator(".h5-calendar-day-button:not([disabled])").first();
    await expect(selectedDay).toBeVisible();
    await selectedDay.click();
    await expect(dialog.getByRole("button", { name: /开始日期.*农历/ }).first()).toBeVisible();
    await expect(surface).toBeHidden();
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
    await setLunarCalendar(page, false);
  }
});
