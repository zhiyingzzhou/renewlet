import { test, expect } from "./support/test";
import { adminStorageState } from "./support/auth";
import { productApiFetch, updateProductSettings } from "./support/product-api";
import { performanceEnvironmentSchema, performanceFixture } from "../scripts/browser-performance";
import {
  IMPORT_APPLY_SUBSCRIPTION_LIMIT, importApplyRequestSchema, importApplyResponseSchema,
} from "../packages/shared/src/schemas/import-export";

test.use({ storageState: adminStorageState });

test("seed the production performance account through the product API", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const environment = performanceEnvironmentSchema.parse(testInfo.config.metadata["performance"]);
  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
  const before = await productApiFetch(page, "/api/app/subscriptions?limit=1");
  expect(before.ok).toBe(true);
  expect(before.json).toMatchObject({ data: { total: 0 } });
  await updateProductSettings(page, { timezone: "Asia/Shanghai", localePreference: "zh-CN", exchangeRateProvider: "frankfurter" });
  const subscriptions = performanceFixture(environment.fixtureDay);
  // 千条夹具走产品已有批量入口，不用逐条创建打满限流；每批仍受 shared 上限、session/CSRF 和真实事务约束。
  for (let offset = 0; offset < subscriptions.length; offset += IMPORT_APPLY_SUBSCRIPTION_LIMIT) {
    const batch = subscriptions.slice(offset, offset + IMPORT_APPLY_SUBSCRIPTION_LIMIT);
    const body = importApplyRequestSchema.parse({ payload: { source: "renewlet", subscriptions: batch }, conflictMode: "skip" });
    const result = await productApiFetch(page, "/api/app/import/apply", { method: "POST", body });
    expect(result.ok, `performance seed failed: ${result.status} ${result.body}`).toBe(true);
    const applied = importApplyResponseSchema.parse(result.json);
    // 只允许隔离空库里的真实新建；冲突跳过或部分成功都不能成为千条基线。
    expect(applied.data.summary).toMatchObject({ total: batch.length, creates: batch.length, replaces: 0, skips: 0, errors: 0 });
  }
  const after = await productApiFetch(page, "/api/app/subscriptions?limit=1");
  expect(after.ok).toBe(true);
  expect(after.json).toMatchObject({ data: { total: 1000 } });
});
