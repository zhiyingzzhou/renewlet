import { savePrimaryCredential, type LinkedIdentity } from "./primary-login-write";
import { changePasswordBodySchema } from "@renewlet/shared/schemas/account";
import {
  loginBodySchema,
  loginPayloadSchema,
  mfaCurrentPasswordBodySchema,
  mfaRecoveryCodesPayloadSchema,
  mfaStatusPayloadSchema,
  mfaTotpEnableBodySchema,
  mfaTotpSetupPayloadSchema,
  mfaVerifyBodySchema,
  passkeyAuthenticationOptionsPayloadSchema,
  passkeyAuthenticateOptionsBodySchema,
  passkeyAuthenticateVerifyBodySchema,
  passkeyDeleteBodySchema,
  passkeyRegistrationOptionsPayloadSchema,
  passkeyRegisterOptionsBodySchema,
  passkeyRegisterVerifyBodySchema,
  passkeysPayloadSchema,
  sessionPayloadSchema,
  setupCreateBodySchema,
  type SessionResponse,
} from "@renewlet/shared/schemas/auth";
import { appStatusPayloadSchema, passwordResetStatusPayloadSchema, setupStatusPayloadSchema } from "@renewlet/shared/schemas/app";
import { adminCreateUserBodySchema, adminPatchUserBodySchema, adminUserPayloadSchema, adminUsersPayloadSchema } from "@renewlet/shared/schemas/admin";
import {
  clearSessionCookies,
  csrfHeaderToken,
  HttpError,
  isUnsafeMethod,
  ok,
  readJson,
  requestLocale,
  sessionCookieToken,
  setSessionCookies,
  successJson,
  type AppLocale,
} from "./http";
import { serverText } from "./server-i18n";
import {
  enabledAdminCount,
  ensureSettings,
  findUserByEmail,
  findUserById,
  hasEnabledAdmin,
  listUsers,
  newId,
  nowIso,
  toAdminUser,
  USER_COLUMNS_FROM_USERS,
} from "./db";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto";
import type { AuthContext, Env, SessionAuthRow, UserRow } from "./types";
import {
  createMfaAuthTicket,
  deleteMfaAuthTicketsForUser,
  deletePasskeyForCurrentUser,
  deletePasskeysForUser,
  disableAuthenticatorMfaForCurrentUser,
  disableAuthenticatorMfaForUser,
  enableTotp,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  listPasskeysForUser,
  mfaStatusForUser,
  regenerateRecoveryCodes,
  startPasskeyAuthentication,
  startPasskeyRegistration,
  startTotpSetup,
  verifyMfaLogin,
  authenticatorMfaMethodsForUser,
  type IssuedMfaRecoveryCodesResponse,
  type IssuedSessionResponse,
} from "./mfa";
import { isAccountSecuritySchemaError } from "./account-security-schema";
import { publicTurnstileConfig, requireTurnstileForPasswordLogin } from "./auth-security-store";
import { buildInitialUserStateQueries } from "./initial-user-state";

const DEFAULT_SESSION_TTL_DAYS = 30;
const SESSION_LAST_SEEN_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * appStatus 暴露认证前应用能力状态。
 *
 * Cloudflare v1 不支持 Docker Demo Mode，但仍必须返回同一契约，避免前端 capability 判断按运行面分叉。
 */
async function buildAppStatus(env: Env) {
  const [hasAdmin, turnstile] = await Promise.all([
    hasEnabledAdmin(env),
    publicTurnstileConfig(env),
  ]);
  return appStatusPayloadSchema.parse({
    setupRequired: !hasAdmin,
    setupEnabled: setupEnabled(env),
    demoMode: false,
    // status 只公开完整可用的 siteKey；Turnstile secret 和 secretConfigured 只存在管理员访问安全接口。
    turnstile,
  });
}

export async function appStatus(request: Request, env: Env): Promise<Response> {
  try {
    return successJson(await buildAppStatus(env));
  } catch (error: unknown) {
    throw appStatusUnavailable(request, error);
  }
}

/**
 * setupStatus 暴露旧首装入口状态。
 *
 * 新前端读取 appStatus；保留两字段响应，避免外部探针因 demoMode 额外字段解析失败。
 */
export async function setupStatus(request: Request, env: Env): Promise<Response> {
  try {
    const status = await buildAppStatus(env);
    return successJson(setupStatusPayloadSchema.parse({
      setupRequired: status.setupRequired,
      setupEnabled: status.setupEnabled,
    }));
  } catch (error: unknown) {
    throw appStatusUnavailable(request, error);
  }
}

function appStatusUnavailable(request: Request, error: unknown): HttpError {
  const requestId = crypto.randomUUID();
  console.error("app_status_unavailable", { requestId, error });
  return new HttpError(503, serverText(requestLocale(request), "common.internalError"), "APP_STATUS_UNAVAILABLE", { requestId });
}

/**
 * createInitialAdmin 完成 Cloudflare 运行面的唯一首次管理员创建。
 *
 * 这个端点承担安装向导的安全闸门：只有部署允许 setup 且 D1 中不存在启用管理员时才能写入。
 */
export async function createInitialAdmin(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  // 初始化只允许“还没有启用管理员”这一瞬间进入；Cloudflare 版没有 PocketBase installer 可兜底。
  if (!setupEnabled(env)) throw new HttpError(403, serverText(locale, "auth.setupDisabled"));
  const body = await readJson(request, setupCreateBodySchema, locale);
  const timestamp = nowIso();
  const user: UserRow = {
    id: newId("usr"),
    email: body.email.trim(),
    name: body.name.trim(),
    role: "admin",
    banned: 0,
    ban_reason: "",
    password_hash: await hashPassword(body.password),
    reset_token_hash: null,
    reset_token_expires_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  if (!(await createUserWithInitialState(env, user, true))) {
    throw new HttpError(403, serverText(locale, "auth.setupAlreadyInitialized"));
  }
  return ok(201);
}

/** login 创建 HttpOnly session cookie；响应体只返回过期时间和用户安全视图。 */
export async function login(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const body = await readJson(request, loginBodySchema, locale);
  // 人机验证必须先于用户查询和密码校验；MFA/Passkey/setup 走各自认证流，不消费 turnstileToken。
  await requireTurnstileForPasswordLogin(request, env, body.turnstileToken, locale);
  const user = await findUserByEmail(env, body.email.trim());
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    throw new HttpError(400, serverText(locale, "auth.invalidEmailOrPassword"));
  }
  return finishPrimaryLogin(request, env, user);
}

// 已验证的外部身份仍须完成本地账号状态和 MFA 检查。
export async function finishPrimaryLogin(request: Request, env: Env, user: UserRow, identity?: LinkedIdentity): Promise<Response> {
  const locale = requestLocale(request);
  if (user.banned === 1) {
    throw new HttpError(403, serverText(locale, "auth.accountDisabled"));
  }
  await ensureSettings(env, user.id);
  const mfaMethods = await authenticatorMfaMethodsForUser(env, user.id);
  if (mfaMethods.length > 0) {
    // MFA 用户密码正确后只签短期 ticket，不签产品 session；第二因素完成前前端仍是未登录态。
    const ticket = await createMfaAuthTicket(env, user.id, mfaMethods, identity);
    return successJson(loginPayloadSchema.parse({
      type: "mfa_required",
      ticketId: ticket.ticketId,
      expiresAt: ticket.expiresAt,
      methods: ticket.methods,
    }));
  }
  return sessionSuccessResponse(request, await createIssuedSession(env, user, identity));
}

/**
 * session 复用 requireAuth 的完整认证检查恢复当前用户。
 *
 * 前端刷新时依赖该端点用 HttpOnly cookie 恢复可信用户状态，不能只信 localStorage 非密快照。
 */
export async function session(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  return successJson(sessionPayloadSchema.parse(toSessionResponse(auth.user, auth.session.expires_at)));
}

/**
 * logout 删除当前 cookie 对应的 D1 session。
 *
 * 登出保持幂等；有效 session 的 unsafe 请求仍要过 CSRF，避免第三方页面强制用户退出。
 */
export async function logout(request: Request, env: Env): Promise<Response> {
  const token = sessionCookieToken(request);
  if (token) {
    try {
      const auth = await requireAuth(request, env);
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(auth.session.id).run();
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    }
  }
  return clearSessionCookies(ok(), request);
}

export async function mfaVerify(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const body = await readJson(request, mfaVerifyBodySchema, locale);
  const issued = await verifyMfaLogin(env, body, locale).catch((error: unknown) => {
    if (isAccountSecuritySchemaError(error)) throw error;
    // ticket 过期、方法不匹配和 OTP/恢复码错误统一成 401，避免暴露可枚举的认证器状态。
    throw new HttpError(401, serverText(locale, "auth.sessionExpired"));
  });
  return sessionSuccessResponse(request, issued);
}

export async function mfaStatus(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  return successJson(mfaStatusPayloadSchema.parse(await mfaStatusForUser(env, auth.user.id)));
}

export async function mfaTotpSetup(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  // setup 只生成短期加密 seed；真正启用还要当前密码和验证码，避免打开弹窗就改变账号安全状态。
  return successJson(mfaTotpSetupPayloadSchema.parse(await startTotpSetup(env, auth.user)));
}

export async function mfaTotpEnable(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, mfaTotpEnableBodySchema, locale);
  if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) {
    throw new HttpError(400, serverText(locale, "auth.currentPasswordIncorrect"));
  }
  // 敏感账号安全操作成功后会续签 cookie session；前端只缓存新的非密 session 视图。
  const response = await enableTotp(env, auth.user, body.setupId, body.code).catch(() => {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  });
  return recoveryCodesSuccessResponse(request, response);
}

export async function mfaRecoveryRegenerate(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, mfaCurrentPasswordBodySchema, locale);
  if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) {
    throw new HttpError(400, serverText(locale, "auth.currentPasswordIncorrect"));
  }
  if ((await authenticatorMfaMethodsForUser(env, auth.user.id)).length === 0) {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  }
  // 恢复码明文只在这次响应出现；重新生成同时续签 cookie session，让旧 session 和旧恢复码一起失效。
  const response = await regenerateRecoveryCodes(env, auth.user);
  return recoveryCodesSuccessResponse(request, response);
}

export async function passkeys(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  return successJson(passkeysPayloadSchema.parse(await listPasskeysForUser(env, auth.user.id)));
}

export async function passkeyRegisterOptions(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, passkeyRegisterOptionsBodySchema, locale);
  if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) {
    throw new HttpError(400, serverText(locale, "auth.currentPasswordIncorrect"));
  }
  // Passkey 是独立登录方式；注册要求当前密码，但不要求先启用 TOTP，避免制造半成品二因素依赖。
  const response = await startPasskeyRegistration(env, request, auth.user).catch(() => {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  });
  return successJson(passkeyRegistrationOptionsPayloadSchema.parse(response));
}

export async function passkeyRegisterVerify(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, passkeyRegisterVerifyBodySchema, locale);
  const response = await finishPasskeyRegistration(env, request, auth.user, body.challengeId, body.name, body.response).catch(() => {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  });
  return sessionSuccessResponse(request, response);
}

export async function passkeyAuthenticateOptions(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  await readJson(request, passkeyAuthenticateOptionsBodySchema, locale);
  // Passkey options 是认证前 challenge 创建；初始化失败不能冒充 session 过期，否则会触发前端清登录态。
  const response = await startPasskeyAuthentication(env, request).catch(() => {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  });
  return successJson(passkeyAuthenticationOptionsPayloadSchema.parse(response));
}

export async function passkeyAuthenticateVerify(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const body = await readJson(request, passkeyAuthenticateVerifyBodySchema, locale);
  const response = await finishPasskeyAuthentication(env, request, body.challengeId, body.response).catch((error: unknown) => {
    if (isAccountSecuritySchemaError(error)) throw error;
    throw new HttpError(401, serverText(locale, "auth.sessionExpired"));
  });
  return sessionSuccessResponse(request, response);
}

export async function passkeyDelete(request: Request, env: Env, passkeyId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, passkeyDeleteBodySchema, locale);
  if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) {
    throw new HttpError(400, serverText(locale, "auth.currentPasswordIncorrect"));
  }
  const response = await deletePasskeyForCurrentUser(env, auth.user, passkeyId).catch(() => {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  });
  return sessionSuccessResponse(request, response);
}

export async function mfaDisable(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, mfaCurrentPasswordBodySchema, locale);
  if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) {
    throw new HttpError(400, serverText(locale, "auth.currentPasswordIncorrect"));
  }
  // 关闭 MFA 是敏感账号生命周期操作；自助路径续签当前 session，管理员 reset 才全量踢下线。
  const response = await disableAuthenticatorMfaForCurrentUser(env, auth.user);
  return sessionSuccessResponse(request, response);
}

/**
 * changePassword 更新当前用户密码并收敛会话。
 *
 * 改密后删除其它 session 是 Cloudflare 版的账号接管防线，避免旧设备继续持有密码变更前的 token。
 */
export async function changePassword(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, changePasswordBodySchema, locale);
  if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) {
    throw new HttpError(400, serverText(locale, "auth.currentPasswordIncorrect"));
  }
  const timestamp = nowIso();
  const passwordHash = await hashPassword(body.newPassword);
  // 改密后只保留当前 session，避免旧设备继续持有已知密码时代的 token。
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(passwordHash, timestamp, auth.user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(auth.user.id, auth.session.id),
  ]);
  return ok();
}

/**
 * passwordResetStatus 固定声明 Cloudflare 运行面不支持邮件找回。
 *
 * Cloudflare 通知 SMTP 是账号级设置，不作为部署级认证恢复通道，避免未登录用户触发邮件发送面。
 */
export async function passwordResetStatus(): Promise<Response> {
  // Cloudflare 版不接收部署级 SMTP secrets；账号恢复走管理员用户管理里的重置密码。
  return successJson(passwordResetStatusPayloadSchema.parse({ enabled: false }));
}

/**
 * adminListUsers 返回管理员视图下的用户列表。
 *
 * 用户管理是跨账号数据面，必须始终先通过 requireAdmin，不能复用普通用户的 requireAuth。
 */
export async function adminListUsers(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const users = await listUsers(env);
  return successJson(adminUsersPayloadSchema.parse({
    users: await Promise.all(users.map(async (user) => {
      const status = await mfaStatusForUser(env, user.id);
      return toAdminUser(user, {
        mfaEnabled: status.enabled,
        mfaMethods: status.methods,
        passkeysEnabled: status.passkeyCount > 0,
        passkeyCount: status.passkeyCount,
      });
    })),
  }));
}

/**
 * adminCreateUser 由管理员在 Cloudflare D1 中创建新账号。
 *
 * 这里不开放自助注册；账号生命周期全部挂在管理员边界下，和 Docker/PocketBase 管理语义保持一致。
 */
export async function adminCreateUser(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  await requireAdmin(request, env);
  const body = await readJson(request, adminCreateUserBodySchema, locale);
  const timestamp = nowIso();
  const user: UserRow = {
    id: newId("usr"),
    email: body.email.trim(),
    name: body.name.trim(),
    role: body.role,
    banned: 0,
    ban_reason: "",
    password_hash: await hashPassword(body.password),
    reset_token_hash: null,
    reset_token_expires_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await createUserWithInitialState(env, user, false);
  return successJson(adminUserPayloadSchema.parse({ user: toAdminUser(user) }), { status: 201 });
}

async function createUserWithInitialState(
  env: Env,
  user: UserRow,
  initialSetup: boolean,
): Promise<boolean> {
  // D1 batch 是账号创建的唯一事务边界；setup loser 的 user id 不存在，后三条 SELECT INSERT 因而全部零写入。
  const queries = buildInitialUserStateQueries(user, initialSetup);
  const results = await env.DB.batch(queries.map((query) => env.DB.prepare(query.sql).bind(...query.bindings)));
  return results[0]?.meta.changes === 1;
}

/**
 * adminPatchUser 更新角色、禁用状态或重置密码。
 *
 * 角色/禁用变更会经过最后管理员保护；禁用账号时同步清 session，避免旧 cookie session 在 TTL 内继续可用。
 */
export async function adminPatchUser(request: Request, env: Env, userId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAdmin(request, env);
  const user = await findUserById(env, userId);
  if (!user) throw new HttpError(404, serverText(locale, "auth.userNotFound"));
  const body = await readJson(request, adminPatchUserBodySchema, locale);
  const nextRole = body.role ?? user.role;
  const nextBanned = typeof body.banned === "boolean" ? body.banned : user.banned === 1;
  await assertNotLastAdminMutation(env, locale, auth.user.id, user, nextRole, nextBanned);
  if (body.newPassword && user.id === auth.user.id) {
    // 自己改密码必须走 account/password 校验当前密码，不能让管理员 patch 成为弱认证入口。
    throw new HttpError(400, serverText(locale, "auth.selfPasswordResetForbidden"));
  }
  const timestamp = nowIso();
  const passwordHash = body.newPassword ? await hashPassword(body.newPassword) : null;
  const updateUser = env.DB.prepare(`
    UPDATE users SET role = ?, banned = ?, ban_reason = ?, password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?
  `).bind(
    nextRole,
    nextBanned ? 1 : 0,
    nextBanned ? serverText(locale, "auth.adminDisabledReason") : "",
    passwordHash,
    timestamp,
    user.id,
  );
  // 管理员重置密码或禁用账号立即踢下线；否则旧 token 会在 TTL 内继续通过 session 校验。
  if (nextBanned || body.newPassword) {
    // MFA ticket 属于账号安全 schema；走统一 helper 才能在旧 D1 漂移时先补表再清理。
    await deleteMfaAuthTicketsForUser(env, user.id);
    await env.DB.batch([
      updateUser,
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    ]);
  } else {
    await updateUser.run();
  }
  return ok();
}

export async function adminResetUserMfa(request: Request, env: Env, userId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAdmin(request, env);
  const user = await findUserById(env, userId);
  if (!user) throw new HttpError(404, serverText(locale, "auth.userNotFound"));
  // 管理员不能 reset 自己的 2FA；自救必须走设置页并提供当前密码，避免单一已登录 session 自降安全级别。
  if (user.id === auth.user.id) throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  await disableAuthenticatorMfaForUser(env, user.id);
  return ok();
}

export async function adminResetUserPasskeys(request: Request, env: Env, userId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAdmin(request, env);
  const user = await findUserById(env, userId);
  if (!user) throw new HttpError(404, serverText(locale, "auth.userNotFound"));
  if (user.id === auth.user.id) throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"));
  await deletePasskeysForUser(env, user.id);
  return ok();
}

/**
 * adminDeleteUser 删除指定账号及其 D1 关系数据。
 *
 * R2 对象不做同步删除；D1 metadata 级联失效后资产读取会先因 owner 查不到而返回 404。
 */
export async function adminDeleteUser(request: Request, env: Env, userId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAdmin(request, env);
  const user = await findUserById(env, userId);
  if (!user) throw new HttpError(404, serverText(locale, "auth.userNotFound"));
  if (user.id === auth.user.id) throw new HttpError(400, serverText(locale, "auth.cannotDeleteCurrentAdmin"));
  await assertNotLastAdminMutation(env, locale, auth.user.id, user, "user", true);
  // D1 外键级联负责清 session/settings/subscriptions/assets metadata；R2 对象仍只能通过失效 metadata 变成不可读孤儿。
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  return ok();
}

/**
 * requireAuth 是 Cloudflare Worker API 的统一认证边界。
 *
 * 它把 cookie token、D1 session、用户启用状态、过期时间和 unsafe CSRF 收敛在一次检查里。
 */
export async function requireAuth(request: Request, env: Env): Promise<AuthContext> {
  const locale = requestLocale(request);
  const token = sessionCookieToken(request);
  if (!token) throw new HttpError(401, serverText(locale, "auth.loginRequired"));
  // session 与 user 联查是认证边界：过期、被禁用、用户被删都会在同一次检查里失效。
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT sessions.id AS session_id, sessions.token_hash AS session_token_hash, sessions.user_id AS session_user_id,
           sessions.expires_at AS session_expires_at, sessions.created_at AS session_created_at,
           sessions.last_seen_at AS session_last_seen_at, sessions.csrf_token_hash AS session_csrf_token_hash, ${USER_COLUMNS_FROM_USERS}
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, nowIso()).first<SessionAuthRow>();
  if (!row || row.banned === 1) throw new HttpError(401, serverText(locale, "auth.sessionExpired"));
  if (!row.session_csrf_token_hash) throw new HttpError(401, serverText(locale, "auth.sessionExpired"));
  await validateSessionCsrf(request, row.session_csrf_token_hash, locale);
  const user = rowToUser(row);
  const session = {
    id: row.session_id,
    token_hash: row.session_token_hash,
    csrf_token_hash: row.session_csrf_token_hash,
    user_id: row.session_user_id,
    expires_at: row.session_expires_at,
    created_at: row.session_created_at,
    last_seen_at: row.session_last_seen_at,
  };
  await touchSessionLastSeenIfStale(env, session.id, session.last_seen_at);
  return { user, session };
}

/**
 * requireAdmin 在 requireAuth 之上收紧管理员操作边界。
 *
 * 所有跨用户数据、系统信息和账号生命周期操作都应走这里，避免普通登录态误触管理面。
 */
export async function requireAdmin(request: Request, env: Env): Promise<AuthContext> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  if (auth.user.role !== "admin") throw new HttpError(403, serverText(locale, "auth.adminRequired"));
  return auth;
}

async function createIssuedSession(env: Env, user: UserRow, identity?: LinkedIdentity): Promise<IssuedSessionResponse> {
  const token = randomToken();
  const csrfToken = randomToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + sessionTtlDays(env) * 24 * 60 * 60 * 1000).toISOString();
  // session token 与 CSRF token 分开保存 hash：前者只在 HttpOnly cookie，后者只证明同站脚本上下文。
  await savePrimaryCredential(
    env,
    `INSERT INTO sessions (id, token_hash, csrf_token_hash, user_id, expires_at, created_at, last_seen_at)
     SELECT ?, ?, ?, ?, ?, ?, ?`,
    [newId("ses"), await sha256(token), await sha256(csrfToken), user.id, expiresAt, timestamp, timestamp],
    identity, "session",
  );
  return {
    response: toSessionResponse(user, expiresAt),
    sessionToken: token,
    csrfToken,
    expiresAt,
  };
}

export function sessionSuccessResponse(request: Request, issued: IssuedSessionResponse): Response {
  return setSessionCookies(successJson(sessionPayloadSchema.parse(issued.response)), request, issued.sessionToken, issued.csrfToken, issued.expiresAt);
}

function recoveryCodesSuccessResponse(request: Request, issued: IssuedMfaRecoveryCodesResponse): Response {
  return setSessionCookies(successJson(mfaRecoveryCodesPayloadSchema.parse(issued.response)), request, issued.sessionToken, issued.csrfToken, issued.expiresAt);
}

async function validateSessionCsrf(request: Request, csrfTokenHash: string, locale: AppLocale): Promise<void> {
  if (!isUnsafeMethod(request.method)) return;
  // CSRF header 与非 HttpOnly cookie 同值，只有同站脚本能读取；D1 仍只保存 hash，避免泄漏后直接伪造。
  const token = csrfHeaderToken(request);
  if (!token || await sha256(token) !== csrfTokenHash) {
    throw new HttpError(403, serverText(locale, "auth.sessionExpired"), "CSRF_TOKEN_INVALID");
  }
}

function toSessionResponse(user: UserRow, expiresAt: string): SessionResponse {
  return {
    type: "session",
    session: { expiresAt },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      banned: user.banned === 1,
    },
  };
}

async function touchSessionLastSeenIfStale(env: Env, sessionId: string, lastSeenAt: string): Promise<void> {
  const lastSeen = Date.parse(lastSeenAt);
  const now = Date.now();
  if (!Number.isNaN(lastSeen) && now - lastSeen < SESSION_LAST_SEEN_TOUCH_INTERVAL_MS) return;
  // last_seen_at 只是会话活跃审计，不参与认证授权；节流写入避免所有只读 API 都放大成 D1 write。
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(new Date(now).toISOString(), sessionId).run();
}

export function setupEnabled(env: Env): boolean {
  return env.SETUP_ENABLED !== "false";
}

function sessionTtlDays(env: Env): number {
  const value = Number.parseInt(env.SESSION_TTL_DAYS ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SESSION_TTL_DAYS;
}

async function assertNotLastAdminMutation(
  env: Env,
  locale: AppLocale,
  currentUserId: string,
  target: UserRow,
  nextRole: "user" | "admin",
  nextBanned: boolean,
): Promise<void> {
  const removesEnabledAdmin = target.role === "admin" && target.banned === 0 && (nextRole !== "admin" || nextBanned);
  // 防自锁分两层：当前管理员不能移除自己，最后一个启用管理员也不能被移除。
  if (target.id === currentUserId && removesEnabledAdmin) {
    throw new HttpError(400, serverText(locale, "auth.cannotDisableOrDemoteCurrentAdmin"));
  }
  if (removesEnabledAdmin && await enabledAdminCount(env) <= 1) {
    throw new HttpError(400, serverText(locale, "auth.atLeastOneEnabledAdmin"));
  }
}

function rowToUser(row: UserRow): UserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    banned: row.banned,
    ban_reason: row.ban_reason,
    password_hash: row.password_hash,
    reset_token_hash: row.reset_token_hash,
    reset_token_expires_at: row.reset_token_expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
