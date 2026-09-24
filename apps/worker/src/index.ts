import { bulkUpdatePublicVisibility } from "./subscription-public-visibility";
import { healthPayloadSchema } from "@renewlet/shared/schemas/app";
import { Hono, type Context } from "hono";
import {
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminPatchUser,
  adminResetUserMfa,
  adminResetUserPasskeys,
  appStatus,
  changePassword,
  createInitialAdmin,
  login,
  logout,
  mfaDisable,
  mfaRecoveryRegenerate,
  mfaStatus,
  mfaTotpEnable,
  mfaTotpSetup,
  mfaVerify,
  passkeyAuthenticateOptions,
  passkeyAuthenticateVerify,
  passkeyDelete,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  passkeys,
  passwordResetStatus,
  session,
  setupStatus,
} from "./auth";
import { readAuthSecurity, testAuthSecurityTurnstile, updateAuthSecurity } from "./auth-security";
import { deleteAsset, listUploadedAssets, readAsset, uploadAsset } from "./assets";
import {
  calendarFeedIcs,
  createCalendarFeed,
  createSubscriptionCalendarFeed,
  deleteCalendarFeed,
  deleteSubscriptionCalendarFeed,
  downloadSubscriptionCalendarIcs,
  listSubscriptionCalendarFeeds,
  readCalendarFeed,
  readSubscriptionCalendarFeed,
  rotateCalendarFeed,
  rotateSubscriptionCalendarFeed,
} from "./calendar-feed";
import { readCustomConfig, readSettings, updateCustomConfig, updateSettings } from "./settings";
import { putExchangeRateSnapshot, readExchangeRateSnapshots } from "./exchange-rate-snapshots";
import { createSubscription, deleteSubscription, readSubscriptions, renewSubscription, updateSubscription } from "./subscriptions";
import {
  readSubscriptionAnalytics,
  readSubscriptionCalendar,
  readSubscriptionDetail,
  readSubscriptionExport,
  readSubscriptionFacets,
  readSubscriptionIndex,
} from "./subscription-collections";
import { applyImport, previewImport } from "./import-export";
import {
  createCloudBackup,
  deleteCloudBackup,
  downloadCloudBackup,
  listCloudBackups,
  readCloudBackupConfig,
  runDueCloudBackups,
  testCloudBackupConfig,
  updateCloudBackupConfig,
} from "./cloud-backup";
import { recognizeSubscriptions, recognizeSubscriptionsStream, testAIRecognitionConnection } from "./ai-recognition";
import { listAIModels } from "./ai-models";
import {
  builtInIconIndexStatus,
  checkBuiltInIconIndexProvider,
  refreshBuiltInIconIndexProvider,
} from "./media-icon-index";
import { consumeBuiltInIconIndexRefreshQueue } from "./media-icon-index-refresh-queue";
import { mediaCandidates } from "./search";
import { notificationHistory, notificationOverview, notificationRun, notificationTest, runScheduledNotifications } from "./notifications";
import { renewAutoSubscriptionsForAllUsers } from "./subscription-renewal";
import {
  createPublicStatusPage,
  deletePublicStatusPage,
  readPublicStatus,
  readPublicStatusAsset,
  readPublicStatusPage,
  updatePublicStatusPage,
} from "./public-status";
import {
  createApiToken,
  deleteApiToken,
  listApiTokens,
  publicApiDue,
  publicApiMe,
  publicApiStatus,
  publicApiSubscription,
  publicApiSubscriptions,
} from "./public-api";
import {
  deleteTelegramBotCommands,
  installTelegramBotCommands,
  readTelegramBotCommands,
  telegramWebhook,
} from "./telegram-bot";
import { systemRestart, systemUpdate, systemUpdateStatus, systemVersion } from "./system";
import { errorResponse, methodNotAllowed, requestLocale, requireSameOriginUnsafe, successJson, toResponse, type AppLocale } from "./http";
import { serverText } from "./server-i18n";
import type { Env } from "./types";

type AppBindings = {
  Bindings: Env;
  Variables: {
    locale: AppLocale;
  };
};

type AppContext = Context<AppBindings>;
type AppRouter = Hono<AppBindings>;
type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type RouteHandler = (context: AppContext) => Response | Promise<Response>;

export interface RuntimeRouteManifestEntry {
  path: string;
  methods: RouteMethod[];
}

/**
 * Cloudflare Worker 入口。
 *
 * Static Assets 负责前端文件，Hono 只接管 `/api/*`、公开 ICS 和 scheduled cron；路由表是
 * Cloudflare 运行面的产品 API 边界，不扩展成 PocketBase REST 兼容层。
 */
const app = newAppRouter();

app.use("*", async (context, next) => {
  // locale 必须在全局 middleware 设置，404/405/onError 这类未进入业务 handler 的响应也依赖它。
  context.set("locale", requestLocale(context.req.raw));
  // CSRF 的同源检查只约束浏览器产品 API；Public API、Telegram、ICS 和 Cron 都有自己的 bearer/secret 边界。
  if (context.req.path.startsWith("/api/app/")) {
    requireSameOriginUnsafe(context.req.raw, context.get("locale"));
  }
  await next();
});

// Hono onError 是 Worker 错误 envelope 的最后入口；业务 handler 不应自己拼错误 JSON。
app.onError((error, context) => toResponse(error, context.get("locale") ?? requestLocale(context.req.raw)));

app.notFound((context) => {
  const locale = context.get("locale") ?? requestLocale(context.req.raw);
  return errorResponse(404, serverText(locale, "common.notFound"), "NOT_FOUND");
});

defineRoute(app, "/calendar/renewals.ics", {
  GET: (context) => calendarFeedIcs(context.req.raw, context.env),
});

defineRoute(app, "/api/app/health", {
  GET: () => health(),
});

defineRoute(app, "/api/app/ready", {
  GET: (context) => ready(context.env),
});

defineRoute(app, "/api/app/status", {
  GET: (context) => appStatus(context.req.raw, context.env),
});

defineRoute(app, "/api/app/setup", {
  GET: (context) => setupStatus(context.req.raw, context.env),
  POST: (context) => createInitialAdmin(context.req.raw, context.env),
});

const authRoutes = newAppRouter();
defineRoute(authRoutes, "/login", { POST: (context) => login(context.req.raw, context.env) });
defineRoute(authRoutes, "/session", { GET: (context) => session(context.req.raw, context.env) });
defineRoute(authRoutes, "/logout", { POST: (context) => logout(context.req.raw, context.env) });
defineRoute(authRoutes, "/mfa/verify", { POST: (context) => mfaVerify(context.req.raw, context.env) });
defineRoute(authRoutes, "/passkeys/authenticate/options", { POST: (context) => passkeyAuthenticateOptions(context.req.raw, context.env) });
defineRoute(authRoutes, "/passkeys/authenticate/verify", { POST: (context) => passkeyAuthenticateVerify(context.req.raw, context.env) });
defineRoute(authRoutes, "/mfa/status", { GET: (context) => mfaStatus(context.req.raw, context.env) });
defineRoute(authRoutes, "/mfa/totp/setup", { POST: (context) => mfaTotpSetup(context.req.raw, context.env) });
defineRoute(authRoutes, "/mfa/totp/enable", { POST: (context) => mfaTotpEnable(context.req.raw, context.env) });
defineRoute(authRoutes, "/mfa/recovery/regenerate", { POST: (context) => mfaRecoveryRegenerate(context.req.raw, context.env) });
defineRoute(authRoutes, "/passkeys", { GET: (context) => passkeys(context.req.raw, context.env) });
defineRoute(authRoutes, "/passkeys/register/options", { POST: (context) => passkeyRegisterOptions(context.req.raw, context.env) });
defineRoute(authRoutes, "/passkeys/register/verify", { POST: (context) => passkeyRegisterVerify(context.req.raw, context.env) });
defineRoute(authRoutes, "/passkeys/:id/delete", { POST: (context) => passkeyDelete(context.req.raw, context.env, routeParam(context, "id")) });
defineRoute(authRoutes, "/mfa/disable", { POST: (context) => mfaDisable(context.req.raw, context.env) });
app.route("/api/app/auth", authRoutes);

const adminRoutes = newAppRouter();
defineRoute(adminRoutes, "/users", {
  GET: (context) => adminListUsers(context.req.raw, context.env),
  POST: (context) => adminCreateUser(context.req.raw, context.env),
});
defineRoute(adminRoutes, "/users/:id/mfa/reset", { POST: (context) => adminResetUserMfa(context.req.raw, context.env, routeParam(context, "id")) });
defineRoute(adminRoutes, "/users/:id/passkeys/reset", { POST: (context) => adminResetUserPasskeys(context.req.raw, context.env, routeParam(context, "id")) });
defineRoute(adminRoutes, "/users/:id", {
  PATCH: (context) => adminPatchUser(context.req.raw, context.env, routeParam(context, "id")),
  DELETE: (context) => adminDeleteUser(context.req.raw, context.env, routeParam(context, "id")),
});
defineRoute(adminRoutes, "/system/update", { POST: (context) => systemUpdate(context.req.raw, context.env) });
defineRoute(adminRoutes, "/system/update/status", { GET: (context) => systemUpdateStatus(context.req.raw, context.env) });
defineRoute(adminRoutes, "/system/restart", { POST: (context) => systemRestart(context.req.raw, context.env) });
// 访问安全是站点级管理员策略；这里必须和用户 settings 路由分开，避免 secret 进入账号草稿/导出链路。
defineRoute(adminRoutes, "/auth-security", {
  GET: (context) => readAuthSecurity(context.req.raw, context.env),
  PUT: (context) => updateAuthSecurity(context.req.raw, context.env),
});
defineRoute(adminRoutes, "/auth-security/turnstile/test", { POST: (context) => testAuthSecurityTurnstile(context.req.raw, context.env) });
defineRoute(adminRoutes, "/media/icon-index", { GET: (context) => builtInIconIndexStatus(context.req.raw, context.env) });
defineRoute(adminRoutes, "/media/icon-index/providers/:provider/check", {
  POST: (context) => checkBuiltInIconIndexProvider(context.req.raw, context.env, routeParam(context, "provider")),
});
defineRoute(adminRoutes, "/media/icon-index/providers/:provider/refresh", {
  POST: (context) => refreshBuiltInIconIndexProvider(context.req.raw, context.env, routeParam(context, "provider")),
});
app.route("/api/app/admin", adminRoutes);

const accountRoutes = newAppRouter();
defineRoute(accountRoutes, "/password", { PUT: (context) => changePassword(context.req.raw, context.env) });
defineRoute(accountRoutes, "/password-reset/status", { GET: () => passwordResetStatus() });
app.route("/api/app/account", accountRoutes);

defineRoute(app, "/api/app/system/version", { GET: (context) => systemVersion(context.req.raw, context.env) });

defineRoute(app, "/api/app/settings", {
  GET: (context) => readSettings(context.req.raw, context.env),
  PUT: (context) => updateSettings(context.req.raw, context.env),
});

defineRoute(app, "/api/app/custom-config", {
  GET: (context) => readCustomConfig(context.req.raw, context.env),
  PUT: (context) => updateCustomConfig(context.req.raw, context.env),
});

defineRoute(app, "/api/app/exchange-rate-snapshots", {
  GET: (context) => readExchangeRateSnapshots(context.req.raw, context.env),
});
defineRoute(app, "/api/app/exchange-rate-snapshots/:month", {
  PUT: (context) => putExchangeRateSnapshot(context.req.raw, context.env, routeParam(context, "month")),
});

const apiTokenRoutes = newAppRouter();
defineRoute(apiTokenRoutes, "/", {
  GET: (context) => listApiTokens(context.req.raw, context.env),
  POST: (context) => createApiToken(context.req.raw, context.env),
});
defineRoute(apiTokenRoutes, "/:id", {
  DELETE: (context) => deleteApiToken(context.req.raw, context.env, routeParam(context, "id")),
});
app.route("/api/app/api-tokens", apiTokenRoutes);

defineRoute(app, "/api/app/telegram-bot/commands", {
  GET: (context) => readTelegramBotCommands(context.req.raw, context.env),
  POST: (context) => installTelegramBotCommands(context.req.raw, context.env),
  DELETE: (context) => deleteTelegramBotCommands(context.req.raw, context.env),
});

const subscriptionRoutes = newAppRouter();
defineRoute(subscriptionRoutes, "/", {
  GET: (context) => readSubscriptions(context.req.raw, context.env),
  POST: (context) => createSubscription(context.req.raw, context.env),
});
defineRoute(subscriptionRoutes, "/bulk-public-visibility", { POST: (context) => bulkUpdatePublicVisibility(context.req.raw, context.env) });
// 集合静态路由先于 /:id 注册，避免 Hono 把 index/analytics/calendar-feeds/facets/export 当作订阅 ID。
defineRoute(subscriptionRoutes, "/index", { GET: (context) => readSubscriptionIndex(context.req.raw, context.env) });
defineRoute(subscriptionRoutes, "/analytics", { GET: (context) => readSubscriptionAnalytics(context.req.raw, context.env) });
defineRoute(subscriptionRoutes, "/calendar", { GET: (context) => readSubscriptionCalendar(context.req.raw, context.env) });
defineRoute(subscriptionRoutes, "/calendar-feeds", { GET: (context) => listSubscriptionCalendarFeeds(context.req.raw, context.env) });
defineRoute(subscriptionRoutes, "/facets", { GET: (context) => readSubscriptionFacets(context.req.raw, context.env) });
defineRoute(subscriptionRoutes, "/export", { GET: (context) => readSubscriptionExport(context.req.raw, context.env) });
defineRoute(subscriptionRoutes, "/:id/calendar-feed", {
  GET: (context) => readSubscriptionCalendarFeed(context.req.raw, context.env, routeParam(context, "id")),
  POST: (context) => createSubscriptionCalendarFeed(context.req.raw, context.env, routeParam(context, "id")),
  DELETE: (context) => deleteSubscriptionCalendarFeed(context.req.raw, context.env, routeParam(context, "id")),
});
defineRoute(subscriptionRoutes, "/:id/calendar-feed/rotate", {
  POST: (context) => rotateSubscriptionCalendarFeed(context.req.raw, context.env, routeParam(context, "id")),
});
defineRoute(subscriptionRoutes, "/:id/calendar.ics", {
  GET: (context) => downloadSubscriptionCalendarIcs(context.req.raw, context.env, routeParam(context, "id")),
});
defineRoute(subscriptionRoutes, "/:id/renew", {
  POST: (context) => renewSubscription(context.req.raw, context.env, routeParam(context, "id")),
});
defineRoute(subscriptionRoutes, "/:id", {
  GET: (context) => readSubscriptionDetail(context.req.raw, context.env, routeParam(context, "id")),
  PATCH: (context) => updateSubscription(context.req.raw, context.env, routeParam(context, "id")),
  DELETE: (context) => deleteSubscription(context.req.raw, context.env, routeParam(context, "id")),
});
app.route("/api/app/subscriptions", subscriptionRoutes);

defineRoute(app, "/api/app/import/preview", { POST: (context) => previewImport(context.req.raw, context.env) });
defineRoute(app, "/api/app/import/apply", { POST: (context) => applyImport(context.req.raw, context.env) });

defineRoute(app, "/api/app/cloud-backup/config", {
  GET: (context) => readCloudBackupConfig(context.req.raw, context.env),
  PUT: (context) => updateCloudBackupConfig(context.req.raw, context.env),
});
defineRoute(app, "/api/app/cloud-backup/test", { POST: (context) => testCloudBackupConfig(context.req.raw, context.env) });
defineRoute(app, "/api/app/cloud-backups", {
  GET: (context) => listCloudBackups(context.req.raw, context.env),
  POST: (context) => createCloudBackup(context.req.raw, context.env),
});
defineRoute(app, "/api/app/cloud-backups/:id/download", {
  GET: (context) => downloadCloudBackup(context.req.raw, context.env, routeParam(context, "id")),
});
defineRoute(app, "/api/app/cloud-backups/:id", {
  DELETE: (context) => deleteCloudBackup(context.req.raw, context.env, routeParam(context, "id")),
});

defineRoute(app, "/api/app/ai/subscriptions/recognize/stream", { POST: (context) => recognizeSubscriptionsStream(context.req.raw, context.env) });
defineRoute(app, "/api/app/ai/subscriptions/recognize", { POST: (context) => recognizeSubscriptions(context.req.raw, context.env) });
defineRoute(app, "/api/app/ai/subscriptions/test", { POST: (context) => testAIRecognitionConnection(context.req.raw, context.env) });
defineRoute(app, "/api/app/ai/models/list", { POST: (context) => listAIModels(context.req.raw, context.env) });

const assetRoutes = newAppRouter();
defineRoute(assetRoutes, "/", {
  GET: (context) => listUploadedAssets(context.req.raw, context.env),
  POST: (context) => uploadAsset(context.req.raw, context.env),
});
defineRoute(assetRoutes, "/:id", {
  GET: (context) => readAsset(context.req.raw, context.env, routeParam(context, "id")),
  DELETE: (context) => deleteAsset(context.req.raw, context.env, routeParam(context, "id")),
});
app.route("/api/app/assets", assetRoutes);

defineRoute(app, "/api/app/calendar-feed", {
  GET: (context) => readCalendarFeed(context.req.raw, context.env),
  POST: (context) => createCalendarFeed(context.req.raw, context.env),
  DELETE: (context) => deleteCalendarFeed(context.req.raw, context.env),
});
defineRoute(app, "/api/app/calendar-feed/rotate", {
  POST: (context) => rotateCalendarFeed(context.req.raw, context.env),
});
defineRoute(app, "/api/app/public-status-page", {
  GET: (context) => readPublicStatusPage(context.req.raw, context.env),
  POST: (context) => createPublicStatusPage(context.req.raw, context.env),
  PATCH: (context) => updatePublicStatusPage(context.req.raw, context.env),
  DELETE: (context) => deletePublicStatusPage(context.req.raw, context.env),
});

defineRoute(app, "/api/app/notifications/history", { GET: (context) => notificationHistory(context.req.raw, context.env) });
defineRoute(app, "/api/app/notifications/overview", { GET: (context) => notificationOverview(context.req.raw, context.env) });
defineRoute(app, "/api/app/notifications/test", { POST: (context) => notificationTest(context.req.raw, context.env) });
defineRoute(app, "/api/app/notifications/run", { POST: (context) => notificationRun(context.req.raw, context.env) });
defineRoute(app, "/api/app/media/candidates", { POST: (context) => mediaCandidates(context.req.raw, context.env) });

const publicRoutes = newAppRouter();
defineRoute(publicRoutes, "/v1/me", { GET: (context) => publicApiMe(context.req.raw, context.env) });
defineRoute(publicRoutes, "/v1/subscriptions", { GET: (context) => publicApiSubscriptions(context.req.raw, context.env) });
defineRoute(publicRoutes, "/v1/subscriptions/:id", { GET: (context) => publicApiSubscription(context.req.raw, context.env, routeParam(context, "id")) });
defineRoute(publicRoutes, "/v1/status", { GET: (context) => publicApiStatus(context.req.raw, context.env) });
defineRoute(publicRoutes, "/v1/due", { GET: (context) => publicApiDue(context.req.raw, context.env) });
defineRoute(publicRoutes, "/status/:token", { GET: (context) => readPublicStatus(context.req.raw, context.env, routeParam(context, "token")) });
defineRoute(publicRoutes, "/status/:token/assets/:assetId", {
  GET: (context) => readPublicStatusAsset(context.req.raw, context.env, routeParam(context, "token"), routeParam(context, "assetId")),
});
app.route("/api/public", publicRoutes);

defineRoute(app, "/api/telegram/webhook/:bindingId", {
  POST: (context) => telegramWebhook(context.req.raw, context.env, routeParam(context, "bindingId")),
});

function newAppRouter(): AppRouter {
  return new Hono<AppBindings>({ strict: false });
}

function routeParam(context: AppContext, name: string): string {
  const value = context.req.param(name);
  // Hono 只有匹配到含参数的 route 才会进入这些 handler；这里集中收窄类型并在路由表漂移时尽早失败。
  if (!value) throw new Error(`Missing Hono route parameter: ${name}`);
  return value;
}

/**
 * defineRoute 集中维护同路径 405 语义；Hono 负责匹配，业务 handler 仍只拿原始 Request/Env。
 */
function defineRoute(router: AppRouter, path: string, handlers: Partial<Record<RouteMethod, RouteHandler>>): void {
  if (handlers.GET) router.get(path, handlers.GET);
  if (handlers.POST) router.post(path, handlers.POST);
  if (handlers.PUT) router.put(path, handlers.PUT);
  if (handlers.PATCH) router.patch(path, handlers.PATCH);
  if (handlers.DELETE) router.delete(path, handlers.DELETE);
  router.all(path, (context) => methodNotAllowed(context.get("locale") ?? requestLocale(context.req.raw)));
}

/** 从 Hono 已注册 routes 导出产品契约；ALL fallback、scheduled 和 queue 不属于 HTTP route manifest。 */
export function workerProductRouteManifest(): RuntimeRouteManifestEntry[] {
  const methodsByPath = new Map<string, Set<RouteMethod>>();
  for (const route of app.routes) {
    const method = route.method.toUpperCase();
    if (!isRouteMethod(method)) continue;
    const path = normalizeRuntimeRoutePath(route.path);
    const methods = methodsByPath.get(path) ?? new Set<RouteMethod>();
    methods.add(method);
    methodsByPath.set(path, methods);
  }
  return [...methodsByPath.entries()]
    .map(([path, methods]) => ({ path, methods: [...methods].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function isRouteMethod(method: string): method is RouteMethod {
  return method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function normalizeRuntimeRoutePath(path: string): string {
  const normalized = `/${path.trim().replace(/^\/+|\/+$/g, "")}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  return normalized === "/" ? normalized : normalized.replace(/\/$/, "");
}

async function runScheduledTasks(env: Env): Promise<void> {
  // Cron 阶段必须串行：自动续订先修正日期，通知再取内容，云备份最后跑慢远端存储。
  await runScheduledPhase("auto_renew_subscriptions", () => renewAutoSubscriptionsForAllUsers(env));
  await runScheduledPhase("notifications", () => runScheduledNotifications(env));
  await runScheduledPhase("cloud_backups", () => runDueCloudBackups(env));
}

async function runScheduledPhase(phase: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    // 顶层隔离只记录阶段摘要并继续后续任务；Cron 里 provider/raw 错误不得把 secret 带进平台日志。
    console.error("scheduled_phase_failed", {
      event: "scheduled_phase_failed",
      phase,
      error: safeScheduledPhaseError(error),
    });
  }
}

function safeScheduledPhaseError(error: unknown): { name: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name || "Error" : typeof error,
    message: redactScheduledPhaseError(message).slice(0, 300),
  };
}

function redactScheduledPhaseError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/sctp\d+t[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/SCT[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|token|sendkey)\s*[:=]\s*)[^,\s;]+/gi, "$1[redacted]")
    .replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|AWSAccessKeyId|Signature|Expires|access_key|accessKey|api_key|apikey|token|sendkey|sendKey|key)=)[^&\s"'<>]+/gi, "$1[redacted]");
}

/** health 返回最小可缓存外的存活信息；不读取 D1/R2，避免健康检查放大平台短暂抖动。 */
function health(): Response {
  return successJson(healthPayloadSchema.parse({ time: new Date().toISOString() }));
}

function maintenanceResponse(): Response {
  return Response.json(
    { error: { code: "MAINTENANCE_MODE", message: "Renewlet is temporarily unavailable during a database upgrade." } },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "900",
      },
    },
  );
}

function maintenanceModeEnabled(env: Env): boolean {
  return env.RENEWLET_MAINTENANCE_MODE === "true";
}

async function ready(env: Env): Promise<Response> {
  // ready 只验证 D1 binding 可用；R2/第三方 provider 不应拖慢平台健康检查。
  await env.DB.prepare("SELECT 1").first();
  return health();
}

const worker: ExportedHandler<Env> = {
  fetch(request, env, context) {
    // 维护响应必须在 Hono、认证和 D1 之前短路；Static Assets 未命中 run_worker_first，仍可继续托管 SPA。
    if (maintenanceModeEnabled(env)) return maintenanceResponse();
    // 保留原始 ExecutionContext 传给 Hono；后续 middleware/handler 需要平台 waitUntil 时只能从这里继承。
    return app.fetch(request, env, context);
  },

  async scheduled(_controller, env) {
    // 排他迁移期间不再启动后台写入，部署编排器会等待旧 invocation 的 15 分钟平台上限后才写 D1。
    if (maintenanceModeEnabled(env)) return;
    await runScheduledTasks(env);
  },

  async queue(batch, env) {
    if (maintenanceModeEnabled(env)) {
      // consumer 解绑存在传播竞态；已送达 maintenance version 的 batch 延迟重试，不能确认或进入 DLQ。
      batch.retryAll({ delaySeconds: 900 });
      return;
    }
    // Queue consumer 只处理后台图标索引切换；HTTP refresh 已在 D1 job 中暴露 queued/running/failed 状态。
    await consumeBuiltInIconIndexRefreshQueue(batch, env);
  },
};

export default worker;
