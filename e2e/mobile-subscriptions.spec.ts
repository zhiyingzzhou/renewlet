// 移动端订阅 E2E 同时保护标签抽屉、tag 输入和底部操作区；这些交互依赖真实触控布局与浮层栈。
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/test";
import {
  createSubscription,
  expectTagInputPopoverLayout,
  expectTagSuggestionListScrollable,
  openSubscriptionDetailDialog,
  openSubscriptionEditDialog,
  subscriptionCard,
  uniqueE2EName,
} from "./support/subscriptions";
import {
  expectActionNearContainerBottom,
  expectDetailFooterStableWhileScrolling,
  expectNoHorizontalOverflow,
  expectOverlayLeavesTopScrim,
  expectScrollableRegionReachesTarget,
  getRequiredLocatorBoundingBox,
} from "./support/layout";
import { createProductSubscriptionSeed, deleteProductSubscriptionsByName } from "./support/product-api";

type SubscriptionCardLayoutSeed = {
  name: string;
  category: string;
  paymentMethod: string;
  startDate: string;
  nextBillingDate: string;
};

async function createSubscriptionLayoutRecord(
  page: Page,
  seed: SubscriptionCardLayoutSeed,
) {
  // 直接走产品 API 种记录，让用例只覆盖真实卡片排版；认证态仍来自 setup project。
  await createProductSubscriptionSeed(page, {
    ...seed,
    price: "20",
    currency: "USD",
    reminderDays: 7,
  });
}

async function captureSubscriptionCardLayout(card: Locator) {
  return card.evaluate((element) => {
    const query = (testId: string) => {
      const target = element.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!target) {
        throw new Error(`Missing ${testId}`);
      }
      const rect = target.getBoundingClientRect();
      return {
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
      };
    };

    const cardRect = element.getBoundingClientRect();
    return {
      cardRight: Math.round(cardRect.right * 100) / 100,
      billingDate: query("subscription-card-meta-billing-date"),
      categoryBadge: query("subscription-card-badge-category"),
      paymentMethod: query("subscription-card-meta-payment-method"),
      renewalBadge: query("subscription-card-badge-renewal"),
      relativeBilling: query("subscription-card-meta-relative-billing"),
      startDate: query("subscription-card-meta-start-date"),
      statusBadge: query("subscription-card-badge-status"),
    };
  });
}

async function dateOnlyFromLocalToday(page: Page, days: number) {
  return page.evaluate((offset) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }, days);
}

async function captureAmountLineMetrics(amount: Locator) {
  return amount.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lineRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    const amountRect = element.getBoundingClientRect();
    return {
      amountRight: amountRect.right,
      lineCount: lineRects.length,
      textRight: lineRects.at(-1)?.right ?? Number.NaN,
    };
  });
}

test("mobile subscription tag drawer and tag input layout", async ({ page }, testInfo) => {
  const plainName = uniqueE2EName(testInfo, "Mobile Plain");
  const taggedName = uniqueE2EName(testInfo, "Mobile Tagged");
  const tagName = uniqueE2EName(testInfo, "mobile-tag");
  const manyTags = [
    tagName,
    "云服务",
    "Issues",
    "Planning",
    "Testing",
    "QA",
    "E2E",
    "Browsers",
    "Automation",
    "Performance",
    "Billing",
    "Design",
    "Docs",
  ].join("、");

  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  await createSubscription(page, {
    name: plainName,
    price: "8",
    currencyLabel: "USD",
  });
  await createSubscription(page, {
    name: taggedName,
    price: "12",
    currencyLabel: "USD",
    tags: manyTags,
  });

  const mobilePaymentTypeSortRow = page.getByTestId("mobile-payment-type-sort-row");
  const mobileAdvancedTagRow = page.getByTestId("mobile-advanced-tag-row");
  await expect(mobilePaymentTypeSortRow).toBeVisible();
  await expect(mobileAdvancedTagRow).toBeVisible();
  const mobilePaymentTypeControl = mobilePaymentTypeSortRow.getByRole("combobox").filter({ hasText: "所有付费类型" });
  const mobileSortControl = mobilePaymentTypeSortRow.getByRole("combobox", { name: "排序" });
  const mobileAdvancedControl = mobileAdvancedTagRow.getByRole("button", { name: "更多筛选" });
  const mobileTagButton = mobileAdvancedTagRow.getByRole("button", { name: "标签" });
  await expect(page.getByTestId("mobile-selected-tags")).toHaveCount(0);
  const [mobilePaymentTypeBox, mobileSortBox, mobileAdvancedBox, mobileTagBox] = await Promise.all([
    getRequiredLocatorBoundingBox(mobilePaymentTypeControl, "mobile payment type filter"),
    getRequiredLocatorBoundingBox(mobileSortControl, "mobile sort filter"),
    getRequiredLocatorBoundingBox(mobileAdvancedControl, "mobile advanced filter"),
    getRequiredLocatorBoundingBox(mobileTagButton, "mobile tag filter"),
  ]);
  expect(Math.abs(mobilePaymentTypeBox.y - mobileSortBox.y), "mobile payment type and sort controls should share a row").toBeLessThan(8);
  expect(mobileSortBox.x, "mobile sort filter should sit to the right of payment type").toBeGreaterThan(
    mobilePaymentTypeBox.x + mobilePaymentTypeBox.width - 1,
  );
  expect(Math.abs(mobileAdvancedBox.y - mobileTagBox.y), "mobile advanced and tag controls should share a row").toBeLessThan(8);
  expect(mobileTagBox.x, "mobile tag button should sit to the right of advanced filters").toBeGreaterThan(
    mobileAdvancedBox.x + mobileAdvancedBox.width - 1,
  );

  await mobileTagButton.click();
  const tagDrawer = page.getByRole("dialog", { name: "筛选标签" });
  await expect(tagDrawer).toBeVisible();
  await expectOverlayLeavesTopScrim(page, tagDrawer, "mobile tag filter drawer");
  await expectActionNearContainerBottom(
    tagDrawer,
    tagDrawer.getByRole("button", { name: "确定" }),
    "mobile tag filter drawer confirm",
  );
  await tagDrawer.getByPlaceholder("搜索标签...").fill(tagName);
  await tagDrawer.getByRole("button", { name: tagName }).click();
  await tagDrawer.getByRole("button", { name: "确定" }).click();
  await expect(tagDrawer).toBeHidden();
  await expect(page.getByTestId("mobile-selected-tags")).toBeVisible();
  await expect(subscriptionCard(page, taggedName)).toBeVisible();
  await expect(subscriptionCard(page, plainName)).toBeHidden();
  await expect(subscriptionCard(page, taggedName)).toBeInViewport();

  await mobileAdvancedTagRow.getByRole("button", { name: "标签(1)" }).click();
  await expect(tagDrawer).toBeVisible();
  await tagDrawer.getByRole("button", { name: "清空标签" }).click();
  await expect(tagDrawer).toBeHidden();
  await expect(page.getByTestId("mobile-selected-tags")).toHaveCount(0);
  await expect(subscriptionCard(page, plainName)).toBeVisible();

  const plainEditDialog = await openSubscriptionEditDialog(page, plainName);
  await plainEditDialog.getByLabel("标签", { exact: true }).click();
  await expectTagSuggestionListScrollable(page);
  await page.keyboard.press("Escape");
  await plainEditDialog.getByRole("button", { name: "取消" }).click();
  await expect(plainEditDialog).toBeHidden();

  const editDialog = await openSubscriptionEditDialog(page, taggedName);
  const editTagInput = editDialog.getByLabel("标签", { exact: true });
  await editTagInput.fill("测试、研发、财务、运营、设计、增长");
  await editTagInput.click();
  await page.keyboard.type("layout");
  await expectTagInputPopoverLayout(page, editDialog);
  await page.keyboard.press("Escape");
  await editDialog.getByRole("button", { name: "取消" }).click();
  await expect(editDialog).toBeHidden();
});

test("mobile subscription card keeps date metadata naturally on the first available row", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  const subscriptionName = uniqueE2EName(testInfo, "Netflix Pro");
  const now = Date.now();
  const dateOnlyFromNow = (days: number) => new Date(now + days * 86_400_000).toISOString().slice(0, 10);
  await createSubscriptionLayoutRecord(page, {
    name: subscriptionName,
    category: "hosting_domains",
    paymentMethod: "google_pay",
    startDate: dateOnlyFromNow(-30),
    nextBillingDate: dateOnlyFromNow(30),
  });
  await page.reload();

  const card = subscriptionCard(page, subscriptionName);
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport();
  await expectNoHorizontalOverflow(page, "mobile subscription card metadata");

  const layout = await captureSubscriptionCardLayout(card);

  expect(Math.abs(layout.startDate.top - layout.billingDate.top), "start and billing dates should share a row").toBeLessThanOrEqual(4);
  expect(layout.billingDate.left, "billing date should sit after start date").toBeGreaterThan(layout.startDate.right - 1);
  expect(layout.paymentMethod.top, "payment method can wrap only after the billing date row").toBeGreaterThanOrEqual(layout.startDate.top - 1);
  expect(layout.relativeBilling.top, "relative billing can wrap only after the billing date row").toBeGreaterThanOrEqual(layout.startDate.top - 1);

  expect(Math.abs(layout.categoryBadge.top - layout.statusBadge.top), "category and status badges should share a row").toBeLessThanOrEqual(4);
  expect(Math.abs(layout.statusBadge.top - layout.renewalBadge.top), "status and renewal badges should share a row").toBeLessThanOrEqual(4);
  expect(layout.categoryBadge.right, "category badge should stay inside card").toBeLessThanOrEqual(layout.cardRight + 1);
  expect(layout.statusBadge.right, "status badge should stay inside card").toBeLessThanOrEqual(layout.cardRight + 1);
  expect(layout.renewalBadge.right, "renewal badge should stay inside card").toBeLessThanOrEqual(layout.cardRight + 1);
});

test("mobile upcoming renewal amounts stay single-line and right-aligned without page overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  const scenarioIdentity = `${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const upcomingRecords = [
    {
      amount: "$6 USD",
      currency: "USD",
      name: `000-UpcomingRenewalWithAnUnbrokenResponsiveName-${scenarioIdentity}`,
      price: "6",
    },
    {
      amount: "$149 USD",
      currency: "USD",
      name: `001-Upcoming Medium-${scenarioIdentity}`,
      price: "149",
    },
    {
      amount: "€199 EUR",
      currency: "EUR",
      name: `002-Upcoming Short-${scenarioIdentity}`,
      price: "199",
    },
  ] as const;
  const [startDate, nextBillingDate] = await Promise.all([
    dateOnlyFromLocalToday(page, -30),
    // 首页只展示真实排序后的前五条；放在 today 桶后由数字前缀稳定选中本测试的三条样本。
    dateOnlyFromLocalToday(page, 0),
  ]);

  try {
    await deleteProductSubscriptionsByName(page, upcomingRecords.map((record) => record.name));
    for (const record of upcomingRecords) {
      await createProductSubscriptionSeed(page, {
        name: record.name,
        price: record.price,
        currency: record.currency,
        startDate,
        nextBillingDate,
        reminderDays: 30,
      });
    }
    await page.reload();
    const upcomingSection = page.getByRole("heading", { name: "即将续费/到期", exact: true }).last().locator("../..");
    const amounts: Locator[] = [];
    for (const record of upcomingRecords) {
      const name = upcomingSection.getByText(record.name, { exact: true });
      await expect(name).toBeVisible();
      const amount = name.locator("../..").getByText(record.amount, { exact: true });
      await expect(amount).toBeVisible();
      amounts.push(amount);
    }

    const metrics = await Promise.all(amounts.map((amount) => captureAmountLineMetrics(amount)));
    for (const [index, amount] of metrics.entries()) {
      expect(amount.lineCount, `upcoming amount ${index}: rendered text lines`).toBe(1);
      expect(Number.isFinite(amount.textRight), `upcoming amount ${index}: text range right edge`).toBe(true);
      expect(
        Math.abs(amount.textRight - amount.amountRight),
        `upcoming amount ${index}: text and amount cell right edge`,
      ).toBeLessThanOrEqual(1);
    }
    for (const amount of metrics.slice(1)) {
      expect(
        Math.abs(metrics[0]!.amountRight - amount.amountRight),
        "upcoming amount cells share one right edge",
      ).toBeLessThanOrEqual(1);
    }
    await expectNoHorizontalOverflow(page, "mobile upcoming renewal rows");
  } finally {
    await deleteProductSubscriptionsByName(page, upcomingRecords.map((record) => record.name));
  }
});

test("mobile calendar and long detail preserve scroll, title, breakpoint, and focus contracts", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  const subscriptionName = uniqueE2EName(testInfo, "Responsive Mobile Detail");
  const notesEnd = `${subscriptionName} notes end`;
  const notesValue = [
    ...Array.from({ length: 24 }, (_, index) => `Mobile responsive detail note line ${index + 1}.`),
    notesEnd,
  ].join("\n");
  await createProductSubscriptionSeed(page, {
    name: subscriptionName,
    price: "123456.78",
    currency: "USD",
    category: "hosting_domains",
    paymentMethod: "google_pay",
    startDate: "2099-01-01",
    nextBillingDate: "2099-06-15",
    reminderDays: 30,
    tags: Array.from({ length: 30 }, (_, index) => `responsive-mobile-detail-tag-${index + 1}`),
    notes: notesValue,
  });

  try {
    await page.goto("/subscriptions");
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

    const mobileDetail = await openSubscriptionDetailDialog(page, subscriptionName);
    await expect(mobileDetail.dialog.getByRole("heading", { name: subscriptionName, exact: true })).toHaveCount(1);
    const mobileFooter = mobileDetail.dialog.locator("[data-subscription-dialog-footer]");
    for (const action of ["关闭", "添加到日历", "续订", "编辑"]) {
      await expect(mobileFooter.getByRole("button", { name: action, exact: true })).toBeVisible();
    }
    const notes = mobileDetail.dialog.getByText(notesEnd, { exact: false });
    await expectDetailFooterStableWhileScrolling(
      mobileDetail.dialog.locator('[data-dialog-scroll-region="subscription-detail"]'),
      notes,
      "mobile subscription detail",
    );

    await mobileFooter.getByRole("button", { name: "添加到日历", exact: true }).click();
    await expect(mobileDetail.dialog).toBeHidden();
    const calendarDialog = page.getByRole("dialog", { name: "添加到日历" });
    await expect(calendarDialog).toBeVisible();
    await expect.poll(
      () => calendarDialog.evaluate((element) => element.contains(document.activeElement)),
      { message: "mobile calendar dialog owns focus after detail transition" },
    ).toBe(true);
    await expectScrollableRegionReachesTarget(
      calendarDialog.locator('[data-dialog-scroll-region="subscription-calendar"]'),
      calendarDialog.getByRole("link", { name: "用 Yahoo Calendar 打开" }),
      "mobile subscription calendar",
    );
    await calendarDialog.getByRole("button", { name: "关闭" }).click();
    await expect(calendarDialog).toBeHidden();

    const reopenedMobileDetail = await openSubscriptionDetailDialog(page, subscriptionName);
    await reopenedMobileDetail.dialog.locator("[data-subscription-dialog-footer]")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await expect(reopenedMobileDetail.dialog).toBeHidden();
    await expect(reopenedMobileDetail.trigger).toBeFocused();

    for (const boundary of [
      { width: 639, panelClass: /h5-drawer-panel/ },
      { width: 640, panelClass: /h5-dialog-frame/ },
    ]) {
      await page.setViewportSize({ width: boundary.width, height: 720 });
      const detail = await openSubscriptionDetailDialog(page, subscriptionName);
      await expect(detail.dialog).toHaveClass(boundary.panelClass);
      await expect(detail.dialog.getByRole("heading", { name: subscriptionName, exact: true })).toHaveCount(1);
      await detail.dialog.locator("[data-subscription-dialog-footer]")
        .getByRole("button", { name: "关闭", exact: true })
        .click();
      await expect(detail.dialog).toBeHidden();
      await expect(detail.trigger).toBeFocused();
    }
  } finally {
    await deleteProductSubscriptionsByName(page, [subscriptionName]);
  }
});
