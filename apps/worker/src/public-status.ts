/**
 * 公开状态页 Worker handler 管理低权限 bearer token 和公开 allowlist 投影。
 *
 * 登录态 API 只回显可复制 URL；公开 API 不读 session，必须同时保护 token、owner、价格开关和 R2 私有资产引用。
 */
import {
  publicStatusPageCreateRequestSchema,
  publicStatusPageCreatePayloadSchema,
  publicStatusPagePayloadSchema,
  publicStatusPageUpdateRequestSchema,
  publicStatusPayloadSchema,
} from "@renewlet/shared/schemas/public-status";
import { customConfigSchema, type ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { isOneTimeBuyout, isOneTimeFixedTerm } from "@renewlet/shared/subscription-billing";
import { getCustomConfig, getSettings, intToBool, newId, nowIso, toApiSubscription } from "./db";
import { randomToken } from "./crypto";
import { requireAuth } from "./auth";
import { HttpError, ok, readJson, requestLocale, successJson } from "./http";
import { serverText, type AppLocale } from "./server-i18n";
import { calendarFeedBuiltInCategoryLabelKey } from "./calendar-feed-built-in-labels";
import { getExchangeRatePublicBasis } from "./exchange-rate-snapshots";
import { requestOrigin } from "./request-origin";
import type { AssetRow, Env, PublicStatusPageRow, SubscriptionRow } from "./types";
import { publicStatusSubscriptionQueryPlan } from "./subscription-list-filters";

const PUBLIC_STATUS_LIMIT = 500;
const publicStatusTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const privateAssetLogoPattern = /^\/api\/app\/assets\/([A-Za-z0-9_-]+)$/;
const currencyPattern = /^[A-Z]{3}$/;

type PublicStatusCategoryResolver = {
  category(value: string): { value: string; label: string; color?: string };
};

/** 读取当前用户公开展示页状态；只回显完整 URL，不拆出 token 字段。 */
export async function readPublicStatusPage(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const row = await getPublicStatusPage(env, auth.user.id);
  return successJson(publicStatusPagePayloadSchema.parse({ publicStatusPage: publicStatusPageStatus(row, request) }));
}

/** 创建或复用公开展示页；请求体必须为空对象，token 始终由 Worker 生成。 */
export async function createPublicStatusPage(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await readJson(request, publicStatusPageCreateRequestSchema, locale);
  const row = await ensurePublicStatusPage(env, auth.user.id);
  return successJson(publicStatusPageCreatePayloadSchema.parse({
    publicStatusPage: {
      ...publicStatusPageStatus(row, request),
      enabled: true,
    },
  }));
}

export async function updatePublicStatusPage(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, publicStatusPageUpdateRequestSchema, locale);
  const existing = await getPublicStatusPage(env, auth.user.id);
  if (!existing) throw new HttpError(404, serverText(locale, "common.notFound"), "NOT_FOUND");
  // PATCH 只改金额开关；token 与 pageUrl 不接受客户端提交，避免设置页草稿把 bearer secret 持久化。
  const timestamp = nowIso();
  const row: PublicStatusPageRow = {
    ...existing,
    show_prices: body.showPrices ? 1 : 0,
    hide_expired: body.hideExpired ? 1 : 0,
    hide_lifetime: body.hideLifetime ? 1 : 0,
    updated_at: timestamp,
  };
  await env.DB.prepare("UPDATE public_status_pages SET show_prices = ?, hide_expired = ?, hide_lifetime = ?, updated_at = ? WHERE user_id = ?")
    .bind(row.show_prices, row.hide_expired, row.hide_lifetime, timestamp, auth.user.id)
    .run();
  return successJson(publicStatusPagePayloadSchema.parse({ publicStatusPage: publicStatusPageStatus(row, request) }));
}

export async function deletePublicStatusPage(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  // 撤销只删除公开页 token，不改订阅 publicHidden；重新开启时用户原先的可见性选择仍然有效。
  await env.DB.prepare("DELETE FROM public_status_pages WHERE user_id = ?").bind(auth.user.id).run();
  return ok();
}

export async function readPublicStatus(request: Request, env: Env, token: string): Promise<Response> {
  const locale = requestLocale(request);
  const page = await getPublicStatusPageByToken(env, token);
  if (!page) throw new HttpError(404, serverText(locale, "common.notFound"), "NOT_FOUND");
  const settings = await getSettings(env, page.user_id);
  // 公开状态页属于访客界面；分类标签跟随本次请求，不继承页面 owner 的账号内容语言。
  const resolver = await newPublicStatusCategoryResolver(env, page.user_id, locale);
  const now = new Date();
  const today = todayDateOnly(settings.timezone, now);
  const { rows, truncated } = await listPublicStatusSubscriptions(env, page, today);
  const showPrices = intToBool(page.show_prices);
  const response = publicStatusPayloadSchema.parse({
    page: {
      title: "Renewlet",
      showPrices,
      ...(showPrices ? { currency: effectivePublicStatusCurrency(settings) } : {}),
      ...(showPrices ? { exchangeRateBasis: await getExchangeRatePublicBasis(env, page.user_id) } : {}),
      // asOf 是 owner 账号时区下的 date-only；匿名前端不得从 UTC generatedAt 猜测业务日期。
      asOf: today,
      generatedAt: now.toISOString(),
      truncated,
    },
    subscriptions: rows.map((row) => publicStatusSubscription(row, request, page, resolver, today)),
  });
  return successJson(response, { headers: publicStatusHeaders() });
}

export async function readPublicStatusAsset(request: Request, env: Env, token: string, assetId: string): Promise<Response> {
  const locale = requestLocale(request);
  const page = await getPublicStatusPageByToken(env, token);
  if (!page || !assetId) throw new HttpError(404, serverText(locale, "common.notFound"), "NOT_FOUND");
  const asset = await env.DB.prepare(`
    SELECT id, user_id, kind, r2_key, original_name, mime_type, size_bytes, created_at, updated_at
    FROM assets
    WHERE user_id = ? AND id = ?
    LIMIT 1
  `).bind(page.user_id, assetId).first<AssetRow>();
  if (!asset) throw new HttpError(404, serverText(locale, "common.notFound"), "NOT_FOUND");
  if (!await publicStatusAssetIsReferenced(env, page.user_id, assetId)) {
    // 公开资产代理每次都要求 token、owner 和可见订阅引用同时成立，避免公开 URL 枚举同用户其它私有资产。
    throw new HttpError(404, serverText(locale, "common.notFound"), "NOT_FOUND");
  }
  const object = await env.ASSETS_BUCKET.get(asset.r2_key);
  if (!object) throw new HttpError(404, serverText(locale, "asset.fileMissing"), "NOT_FOUND");
  const contentType = asset.mime_type || object.httpMetadata?.contentType || "application/octet-stream";
  const headers = publicStatusHeaders();
  headers.set("content-type", contentType);
  if (contentType.split(";")[0]?.trim().toLowerCase() === "image/svg+xml") {
    headers.set("content-security-policy", "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; sandbox");
  }
  if (asset.size_bytes !== null) headers.set("content-length", String(asset.size_bytes));
  return new Response(object.body, { headers });
}

async function ensurePublicStatusPage(env: Env, userId: string): Promise<PublicStatusPageRow> {
  const existing = await getPublicStatusPage(env, userId);
  if (existing) return existing;
  const timestamp = nowIso();
  // token 由 Worker 生成并仅作为完整 URL 回显；D1 保存可撤销 token，不能塞进 settings_json/export。
  const row: PublicStatusPageRow = {
    id: newId("pub"),
    user_id: userId,
    token: randomToken(),
    show_prices: 0,
    hide_expired: 0,
    hide_lifetime: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await env.DB.prepare(`
    INSERT INTO public_status_pages (id, user_id, token, show_prices, hide_expired, hide_lifetime, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(row.id, row.user_id, row.token, row.show_prices, row.hide_expired, row.hide_lifetime, row.created_at, row.updated_at).run();
  return row;
}

async function getPublicStatusPage(env: Env, userId: string): Promise<PublicStatusPageRow | null> {
  return await env.DB.prepare(`
    SELECT id, user_id, token, show_prices, hide_expired, hide_lifetime, created_at, updated_at
    FROM public_status_pages
    WHERE user_id = ?
    LIMIT 1
  `).bind(userId).first<PublicStatusPageRow>();
}

async function getPublicStatusPageByToken(env: Env, token: string): Promise<PublicStatusPageRow | null> {
  if (!publicStatusTokenPattern.test(token)) return null;
  // 公开 API 不区分无效、撤销和猜测 token；调用方统一走 404，避免 token 探测信号。
  return await env.DB.prepare(`
    SELECT id, user_id, token, show_prices, hide_expired, hide_lifetime, created_at, updated_at
    FROM public_status_pages
    WHERE token = ?
    LIMIT 1
  `).bind(token).first<PublicStatusPageRow>();
}

async function listPublicStatusSubscriptions(env: Env, page: PublicStatusPageRow, today: string): Promise<{ rows: SubscriptionRow[]; truncated: boolean }> {
  // 公开页复用私有默认集合顺序，但响应仍只经过公开 allowlist 投影。
  const plan = publicStatusSubscriptionQueryPlan(page.user_id, today, PUBLIC_STATUS_LIMIT + 1, {
    hideExpired: intToBool(page.hide_expired),
    hideLifetime: intToBool(page.hide_lifetime),
  });
  const result = await env.DB.prepare(plan.sql).bind(...plan.params).all<SubscriptionRow>();
  const rows = result.results.slice(0, PUBLIC_STATUS_LIMIT);
  return { rows, truncated: result.results.length > PUBLIC_STATUS_LIMIT };
}

function publicStatusSubscription(
  row: SubscriptionRow,
  request: Request,
  page: PublicStatusPageRow,
  resolver: PublicStatusCategoryResolver,
  today: string,
) {
  const subscription = toApiSubscription(row);
  const priceFields = intToBool(page.show_prices) ? publicStatusPriceProjection(subscription) : {};
  return {
    name: subscription.name,
    ...(subscription.logo ? { logo: publicStatusLogoUrl(request, page.token, subscription.logo) } : {}),
    category: resolver.category(subscription.category),
    status: publicStatusEffectiveStatus(subscription, today),
    startDate: subscription.startDate,
    nextBillingDate: isOneTimeBuyout(subscription)
      ? null
      : subscription.nextBillingDate,
    updatedAt: subscription.updatedAt ?? nowIso(),
    ...priceFields,
  };
}

function publicStatusPriceProjection(subscription: ReturnType<typeof toApiSubscription>) {
  // 周期字段只随 showPrices 出站，用于公开页折算汇总金额；关闭金额时不暴露任何可推导账单信息。
  return {
    price: subscription.price,
    currency: subscription.currency,
    billingCycle: subscription.billingCycle,
    ...(subscription.customDays ? { customDays: subscription.customDays } : {}),
    ...(subscription.customCycleUnit ? { customCycleUnit: subscription.customCycleUnit } : {}),
    ...(isOneTimeFixedTerm(subscription) && subscription.oneTimeTermUnit ? {
      oneTimeTermCount: subscription.oneTimeTermCount,
      oneTimeTermUnit: subscription.oneTimeTermUnit,
    } : {}),
  };
}

function effectivePublicStatusCurrency(settings: Awaited<ReturnType<typeof getSettings>>): string {
  if (settings.publicStatusCurrency !== "inherit" && currencyPattern.test(settings.publicStatusCurrency)) {
    return settings.publicStatusCurrency;
  }
  return currencyPattern.test(settings.defaultCurrency) ? settings.defaultCurrency : "CNY";
}

function publicStatusEffectiveStatus(subscription: ApiSubscription, today: string): ApiSubscription["status"] {
  if (subscription.status === "expired") return "expired";
  if (isOneTimeBuyout(subscription)) return subscription.status;
  // 公开页是状态面板，沿用站内“有效状态”口径；兼容旧 active/trial 过期数据但不回写 D1。
  if ((subscription.status === "active" || subscription.status === "trial") && subscription.nextBillingDate < today) {
    return "expired";
  }
  return subscription.status;
}

function todayDateOnly(timezone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = value("year");
    const month = value("month");
    const day = value("day");
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // 用户设置中的时区坏值只影响公开页状态投影；回落 UTC，避免公开 API 因单个设置值不可用而整体 500。
  }
  return now.toISOString().slice(0, 10);
}

function publicStatusLogoUrl(request: Request, token: string, logo: string): string {
  const match = privateAssetLogoPattern.exec(logo);
  if (!match) return logo;
  const assetId = match[1];
  if (!assetId) return logo;
  return `${requestOrigin(request)}/api/public/status/${encodeURIComponent(token)}/assets/${encodeURIComponent(assetId)}`;
}

async function publicStatusAssetIsReferenced(env: Env, userId: string, assetId: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT id
    FROM subscriptions
    WHERE user_id = ? AND public_hidden = 0 AND logo = ?
    LIMIT 1
  `).bind(userId, `/api/app/assets/${assetId}`).first<{ id: string }>();
  return Boolean(row);
}

async function newPublicStatusCategoryResolver(env: Env, userId: string, locale: AppLocale): Promise<PublicStatusCategoryResolver> {
  const result = customConfigSchema.safeParse(await getCustomConfig(env, userId));
  const categories = result.success ? result.data.categories : [];
  const byValue = new Map(categories.map((item) => [item.value, item]));
  return {
    category(value) {
      const custom = byValue.get(value);
      if (custom) {
        return {
          value,
          label: localizedConfigLabel(custom.labels, locale, value),
          ...(custom.color ? { color: custom.color } : {}),
        };
      }
      const key = calendarFeedBuiltInCategoryLabelKey(value);
      return { value, label: key ? serverText(locale, key) : value };
    },
  };
}

function localizedConfigLabel(labels: ApiCustomConfig["categories"][number]["labels"], locale: AppLocale, fallback: string): string {
  if (locale === "en-US") return labels["en-US"] || labels["zh-CN"] || fallback;
  return labels["zh-CN"] || labels["en-US"] || fallback;
}

function publicStatusPageStatus(row: PublicStatusPageRow | null, request: Request) {
  if (!row) return { enabled: false, showPrices: false, hideExpired: false, hideLifetime: false };
  return {
    enabled: true,
    createdAt: row.created_at,
    pageUrl: publicStatusPageUrl(request, row.token),
    showPrices: intToBool(row.show_prices),
    hideExpired: intToBool(row.hide_expired),
    hideLifetime: intToBool(row.hide_lifetime),
    updatedAt: row.updated_at,
  };
}

function publicStatusPageUrl(request: Request, token: string): string {
  return `${requestOrigin(request)}/status/${encodeURIComponent(token)}`;
}

function publicStatusHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  });
}
