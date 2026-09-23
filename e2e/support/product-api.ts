import { expect, type Page } from "@playwright/test";
import {
  publicStatusPageCreateResponseSchema,
  publicStatusPageResponseSchema,
} from "../../packages/shared/src/schemas/public-status";

type JsonObject = Record<string, unknown>;

export type ProductSubscriptionSeed = {
  name: string;
  price: string;
  currency?: string;
  billingCycle?: "monthly" | "yearly";
  category?: string;
  status?: "active" | "trial" | "expired" | "paused" | "cancelled";
  paymentMethod?: string | null;
  startDate: string | null;
  nextBillingDate: string;
  notes?: string;
  autoRenew?: boolean;
  autoCalculateNextBillingDate?: boolean;
  reminderDays?: number;
  tags?: string[];
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function productApiFetch(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
) {
  // Seed/helper 请求必须穿过真实浏览器边界：HttpOnly session 随 cookie 发出，unsafe method 仍要证明同站 CSRF。
  const result = await page.evaluate(async ({ requestPath, requestOptions }) => {
    const method = requestOptions.method ?? "GET";
    const headers: Record<string, string> = {};
    if (requestOptions.body !== undefined) headers["Content-Type"] = "application/json";

    if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
      const csrfToken = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("renewlet_csrf="))
        ?.slice("renewlet_csrf=".length);
      if (!csrfToken) throw new Error("Missing Renewlet CSRF cookie");
      headers["X-Renewlet-CSRF"] = decodeURIComponent(csrfToken);
    }

    const response = await window.fetch(requestPath, {
      method,
      credentials: "include",
      headers,
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { body: text, json, ok: response.ok, status: response.status };
  }, { requestPath: path, requestOptions: options });

  return result;
}

export async function ensurePublicStatusPage(page: Page) {
  const statusResult = await productApiFetch(page, "/api/app/public-status-page");
  expect(statusResult.ok, `read public status page: ${statusResult.status} ${statusResult.body}`).toBe(true);
  const status = publicStatusPageResponseSchema.parse(statusResult.json).data.publicStatusPage;
  if (status.enabled) return;

  const createResult = await productApiFetch(page, "/api/app/public-status-page", { method: "POST", body: {} });
  expect(createResult.ok, `create public status page: ${createResult.status} ${createResult.body}`).toBe(true);
  publicStatusPageCreateResponseSchema.parse(createResult.json);
}

export async function createAdminManagedUser(
  page: Page,
  input: { name: string; email: string; password: string; role?: "user" | "admin" },
) {
  const result = await productApiFetch(page, "/api/app/admin/users", {
    method: "POST",
    body: { ...input, role: input.role ?? "user" },
  });
  expect(result.ok, `create managed user ${input.email}: ${result.status} ${result.body}`).toBe(true);
  return result.json;
}

export async function deleteProductSubscriptionsByName(page: Page, names: readonly string[]) {
  if (names.length === 0 || page.isClosed()) return;
  const expectedNames = new Set(names);
  const listResult = await productApiFetch(page, "/api/app/subscriptions?limit=100");
  expect(listResult.ok, `list subscriptions for cleanup: ${listResult.status} ${listResult.body}`).toBe(true);

  const responseData = isRecord(listResult.json) && isRecord(listResult.json.data)
    ? listResult.json.data
    : null;
  const rows = responseData && Array.isArray(responseData["subscriptions"]) ? responseData["subscriptions"] : [];

  // Release smoke 和完整 E2E 共享同一空库；清理必须走产品 API 删除真实记录，不能只把卡片从 UI 藏掉。
  for (const row of rows) {
    if (!isRecord(row) || typeof row["id"] !== "string" || typeof row["name"] !== "string") continue;
    if (!expectedNames.has(row["name"])) continue;
    const deleteResult = await productApiFetch(page, `/api/app/subscriptions/${encodeURIComponent(row["id"])}`, {
      method: "DELETE",
    });
    expect(deleteResult.ok, `delete release smoke subscription ${row["name"]}: ${deleteResult.status} ${deleteResult.body}`).toBe(true);
  }
}

export async function updateProductSettings(page: Page, patch: JsonObject) {
  const currentResult = await productApiFetch(page, "/api/app/settings");
  expect(currentResult.ok, `read settings before update: ${currentResult.status} ${currentResult.body}`).toBe(true);

  const responseData = isRecord(currentResult.json) && isRecord(currentResult.json.data)
    ? currentResult.json.data
    : null;
  const currentSettings = responseData && isRecord(responseData.settings) ? responseData.settings : null;
  if (!currentSettings) {
    throw new Error(`Invalid settings response: ${currentResult.body}`);
  }

  const aiRecognitionSecret = isRecord(patch.aiRecognition) && typeof patch.aiRecognition.apiKey === "string"
    ? patch.aiRecognition.apiKey
    : undefined;
  const aiRecognitionPublicPatch = isRecord(patch.aiRecognition)
    ? Object.fromEntries(Object.entries(patch.aiRecognition).filter(([key]) => key !== "apiKey"))
    : patch.aiRecognition;
  const publicPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "aiRecognition"));
  const aiRecognitionPatch = isRecord(aiRecognitionPublicPatch) && isRecord(currentSettings.aiRecognition)
    ? { ...currentSettings.aiRecognition, ...aiRecognitionPublicPatch }
    : aiRecognitionPublicPatch;
  // 设置接口是严格 PUT 全量契约；E2E 只覆盖目标字段时也要先合并远端当前值，避免把其它设置误清空。
  const nextSettings = {
    ...currentSettings,
    ...publicPatch,
    ...(aiRecognitionPatch === undefined ? {} : { aiRecognition: aiRecognitionPatch }),
    ...(aiRecognitionSecret === undefined ? {} : {
      secretUpdates: {
        "aiRecognition.apiKey": aiRecognitionSecret
          ? { action: "set", value: aiRecognitionSecret }
          : { action: "clear" },
      },
    }),
  };

  const updateResult = await productApiFetch(page, "/api/app/settings", {
    method: "PUT",
    body: nextSettings,
  });
  expect(updateResult.ok, `update settings: ${updateResult.status} ${updateResult.body}`).toBe(true);
}

export async function createProductSubscriptionSeed(page: Page, seed: ProductSubscriptionSeed) {
  const result = await productApiFetch(page, "/api/app/subscriptions", {
    method: "POST",
    body: {
      name: seed.name,
      logo: null,
      price: seed.price,
      currency: seed.currency ?? "CNY",
      billingCycle: seed.billingCycle ?? "monthly",
      customDays: null,
      customCycleUnit: null,
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
      category: seed.category ?? "productivity",
      status: seed.status ?? "active",
      paymentMethod: seed.paymentMethod ?? null,
      startDate: seed.startDate,
      nextBillingDate: seed.nextBillingDate,
      autoRenew: seed.autoRenew ?? false,
      autoCalculateNextBillingDate: seed.autoCalculateNextBillingDate ?? false,
      pinned: false,
      publicHidden: false,
      trialEndDate: null,
      website: null,
      notes: seed.notes ?? null,
      tags: seed.tags ?? [],
      reminderDays: seed.reminderDays ?? 3,
      repeatReminderEnabled: false,
      repeatReminderInterval: "1h",
      repeatReminderWindow: "72h",
      costSharing: null,
      extra: {},
    },
  });

  expect(result.ok, `create subscription seed ${seed.name}: ${result.status} ${result.body}`).toBe(true);
  const responseData = isRecord(result.json) && isRecord(result.json.data) ? result.json.data : null;
  const subscription = responseData && isRecord(responseData.subscription) ? responseData.subscription : null;
  if (!subscription || typeof subscription.id !== "string") {
    throw new Error(`Invalid create subscription response: ${result.body}`);
  }
  return subscription.id;
}
