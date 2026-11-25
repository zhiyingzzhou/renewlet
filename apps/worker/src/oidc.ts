import { mfaCurrentPasswordBodySchema } from "@renewlet/shared/schemas/auth";
import { oidcDraftSchema, oidcStartSchema, oidcRevisionSchema } from "@renewlet/shared/schemas/oidc";
import { requireAdmin, requireAuth, finishPrimaryLogin, sessionSuccessResponse, setupEnabled } from "./auth";
import { publicTurnstileConfig } from "./auth-security-store";
import { hasEnabledAdmin, nowIso, findUserById } from "./db";
import { randomToken, sha256, verifyPassword } from "./crypto";
import { prepareAccountSecuritySessionRenewal } from "./mfa";
import { HttpError, ok, readJson, requestLocale, sessionCookieToken, successJson } from "./http";
import type { OidcFlow } from "./oidc-protocol";
import { callbackPath, consumeFlow, flowCookie, readFlow, readSite, saveSite, storeFlow } from "./oidc-store";
import type { AuthContext, Env } from "./types";

function reject(code: string): never {
  throw new HttpError(400, code, code);
}
function callbackURL(request: Request) {
  return new URL(callbackPath, request.url).href;
}
function sessionKey(request: Request) {
  return sha256(sessionCookieToken(request) ?? "");
}
function withCookie(response: Response, token: string) {
  response.headers.append("set-cookie", flowCookie(token));
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function loginOptions(env: Env) {
  const options = async () =>
    env.DB.prepare(
      `SELECT turnstile_enabled, turnstile_site_key,
    (turnstile_secret <> '') AS has_secret, oidc_enabled FROM auth_security_settings WHERE key='global'`,
    ).first<{
      turnstile_enabled: number;
      turnstile_site_key: string;
      has_secret: number;
      oidc_enabled: number;
    }>();
  const [admin, row] = await Promise.all([
    hasEnabledAdmin(env),
    options().catch(async (error: unknown) => {
      if (!/no such (?:table: auth_security_settings|column: oidc_enabled)/i.test(String(error))) throw error;
      // 迁移中的读请求仍使用旧版 Turnstile 策略，避免把已启用的人机验证误报为关闭。
      const turnstile = await publicTurnstileConfig(env);
      return {
        turnstile_enabled: Number(turnstile.enabled),
        turnstile_site_key: turnstile.siteKey,
        has_secret: 1,
        oidc_enabled: 0,
      };
    }),
  ]);
  const enabled = Boolean(row?.turnstile_enabled && row.has_secret && row.turnstile_site_key);
  return successJson(
    {
      setupRequired: !admin,
      setupEnabled: setupEnabled(env),
      demoMode: false,
      turnstile: { enabled, siteKey: enabled ? row!.turnstile_site_key : "" },
      oidc: admin && row?.oidc_enabled === 1,
      passwordReset: false,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function siteSettings(request: Request, env: Env) {
  await requireAdmin(request, env);
  const site = await readSite(env);
  return successJson(
    {
      enabled: site.enabled,
      revision: site.revision,
      issuer: site.config.issuer,
      clientId: site.config.clientId,
      secretConfigured: Boolean(site.config.secret),
      callback: callbackURL(request),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function disableSite(request: Request, env: Env) {
  const admin = await requireAdmin(request, env);
  const { revision } = await readJson(request, oidcRevisionSchema, requestLocale(request));
  const site = await readSite(env);
  await saveSite(env, site.config, revision, false, admin.session.id);
  return ok();
}
async function passwordAuth(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const body = await readJson(request, mfaCurrentPasswordBodySchema, requestLocale(request));
  if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) reject("OIDC_PASSWORD");
  return auth;
}
export async function linkStatus(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const row = await env.DB.prepare("SELECT issuer FROM oidc_links WHERE user_id=?")
    .bind(auth.user.id)
    .first<{ issuer: string }>();
  return successJson({ issuer: row?.issuer ?? "" }, { headers: { "cache-control": "no-store" } });
}
export async function unlink(request: Request, env: Env) {
  const auth = await passwordAuth(request, env);
  const renewal = await prepareAccountSecuritySessionRenewal(env, auth.user, auth.session.id);
  try {
    await env.DB.batch([
      ...renewal.statements,
      env.DB.prepare("DELETE FROM oidc_links WHERE user_id=?").bind(auth.user.id),
    ]);
  } catch (error) {
    if (/constraint/i.test(String(error))) reject("OIDC_CHANGED");
    throw error;
  }
  return sessionSuccessResponse(request, renewal.session);
}
export async function start(request: Request, env: Env, purpose: OidcFlow["purpose"]) {
  const auth =
    purpose === "test"
      ? await requireAdmin(request, env)
      : purpose === "link"
        ? await passwordAuth(request, env)
        : null;
  const site = await readSite(env);
  const flow: OidcFlow = {
    purpose,
    config: site.config,
    revision: site.revision,
    session: auth?.session.token_hash ?? (await sessionKey(request)),
    next: "/",
    state: randomToken(),
    verifier: randomToken(),
    nonce: randomToken(),
    subject: "",
  };
  if (purpose === "test") {
    const draft = await readJson(request, oidcDraftSchema, requestLocale(request));
    if (site.revision !== draft.revision) reject("OIDC_CHANGED");
    // 已保存密钥只允许用于同一 issuer/client 组合；测试不写线上配置。
    const same = site.config.issuer === draft.issuer && site.config.clientId === draft.clientId;
    flow.config = {
      issuer: draft.issuer,
      clientId: draft.clientId,
      secret: draft.secret || (same ? site.config.secret : ""),
      callback: callbackURL(request),
    };
    if (!flow.config.secret) reject("OIDC_INVALID");
  } else if (!site.enabled) reject("OIDC_DISABLED");
  if (purpose === "login") {
    const { next } = await readJson(request, oidcStartSchema, requestLocale(request));
    if (
      next.startsWith("/") &&
      !next.startsWith("//") &&
      !next.includes("\\") &&
      new URL(next, request.url).pathname !== "/login"
    )
      flow.next = next;
  }
  if (!flow.config.callback.startsWith("https://") || flow.config.callback !== callbackURL(request))
    reject("OIDC_ORIGIN");
  const { authorization } = await import("./oidc-protocol");
  const url = await authorization(flow).catch(() => reject("OIDC_PROVIDER"));
  return withCookie(successJson({ url }), await storeFlow(env, flow));
}
export async function callback(request: Request, env: Env) {
  const query = new URL(request.url).searchParams;
  let dest = "/login",
    anchor = "",
    status = "error",
    next = "";
  let cookie: string | undefined;
  try {
    const { flow, hash } = await readFlow(request, env);
    if (
      !flow.state ||
      flow.subject ||
      query.getAll("state").length !== 1 ||
      query.get("state") !== flow.state ||
      callbackURL(request) !== flow.config.callback ||
      (flow.session && flow.session !== (await sessionKey(request)))
    )
      reject("OIDC_EXPIRED");
    await consumeFlow(env, hash);
    cookie = "";
    next = flow.next;
    if (flow.purpose !== "login") {
      dest = "/settings";
      anchor = flow.purpose === "test" ? "#settings-access-security" : "#settings-account";
    }
    if (query.get("error") === "access_denied") {
      status = "cancelled";
    } else {
      const { verifiedSubject } = await import("./oidc-protocol");
      flow.subject = await verifiedSubject(flow, query);
      flow.state = "";
      flow.nonce = "";
      flow.verifier = "";
      cookie = await storeFlow(env, flow);
      status = flow.purpose;
    }
  } catch {
    /* 回调返回固定站内状态，避免将上游异常或授权码带入页面与日志。 */
  }
  const params = new URLSearchParams({ oidc: status });
  if (dest === "/login" && next) params.set("next", next);
  const response = new Response(null, {
    status: 303,
    headers: {
      location: dest + "?" + params + anchor,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
  return cookie === undefined ? response : withCookie(response, cookie);
}
export async function review(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const { flow } = await readFlow(request, env);
  if (!flow.subject || flow.session !== auth.session.token_hash || flow.purpose === "login")
    reject("OIDC_EXPIRED");
  return successJson(
    {
      purpose: flow.purpose,
      issuer: flow.config.issuer,
      clientId: flow.config.clientId,
      subject: flow.subject,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function finish(request: Request, env: Env, purpose: OidcFlow["purpose"]) {
  const auth: AuthContext | null =
    purpose === "test"
      ? await requireAdmin(request, env)
      : purpose === "link"
        ? await requireAuth(request, env)
        : null;
  const { flow, hash } = await readFlow(request, env);
  if (
    !flow.subject ||
    flow.purpose !== purpose ||
    flow.session !== (auth?.session.token_hash ?? (await sessionKey(request)))
  )
    reject("OIDC_EXPIRED");
  const site = await env.DB.prepare(
    "SELECT oidc_revision,oidc_enabled FROM auth_security_settings WHERE key='global'",
  ).first<{ oidc_revision: string; oidc_enabled: number }>();
  if ((site?.oidc_revision ?? "") !== flow.revision || (purpose !== "test" && !site?.oidc_enabled))
    reject("OIDC_CHANGED");
  await consumeFlow(env, hash);
  if (purpose === "test" && auth) {
    await saveSite(env, flow.config, flow.revision, true, auth.session.id);
    return withCookie(ok(), "");
  }
  if (auth) {
    const renewal = await prepareAccountSecuritySessionRenewal(env, auth.user);
    // INSERT 与会话轮换在同一事务；旧会话或配置已变化时 NOT NULL 约束使整批回滚。
    const link = env.DB.prepare(
      `INSERT INTO oidc_links(user_id,issuer,subject)
      VALUES ((SELECT sessions.user_id FROM sessions JOIN auth_security_settings ON key='global'
        WHERE sessions.id=? AND expires_at>? AND oidc_enabled=1 AND oidc_revision=?),?,?)`,
    ).bind(auth.session.id, nowIso(), flow.revision, flow.config.issuer, flow.subject);
    try {
      await env.DB.batch([link, ...renewal.statements]);
    } catch (error) {
      if (/constraint/i.test(String(error))) reject("OIDC_CONFLICT");
      throw error;
    }
    return withCookie(sessionSuccessResponse(request, renewal.session), "");
  }
  const id = await env.DB.prepare(
    `SELECT user_id FROM oidc_links JOIN auth_security_settings ON key='global'
    WHERE issuer=? AND subject=? AND oidc_enabled=1 AND oidc_revision=?`,
  )
    .bind(flow.config.issuer, flow.subject, flow.revision)
    .first<{ user_id: string }>();
  const user = id ? await findUserById(env, id.user_id) : null;
  if (!user) reject("OIDC_UNLINKED");
  return withCookie(
    await finishPrimaryLogin(request, env, user, {
      issuer: flow.config.issuer,
      subject: flow.subject,
      revision: flow.revision,
      userId: user.id,
    }),
    "",
  );
}
