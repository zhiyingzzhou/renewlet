import { accountSecurityKeyRing } from "./account-security-key";
import { openSecurityText, sealSecurityText } from "./mfa-crypto";
import { randomToken, sha256 } from "./crypto";
import { HttpError } from "./http";
import type { Env } from "./types";
import type { OidcConfig, OidcFlow } from "./oidc-protocol";

const cookieName = "__Host-renewlet_oidc";
export const callbackPath = "/api/app/auth/oidc/callback";
const ttl = 300;
export function flowCookie(token: string) {
  return cookieName + "=" + token + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + (token ? ttl : 0);
}
export async function readSite(env: Env) {
  const row = await env.DB.prepare(
    "SELECT oidc_enabled,oidc_revision,oidc_config FROM auth_security_settings WHERE key='global'",
  ).first<{ oidc_enabled: number; oidc_config: string; oidc_revision: string }>();
  const config: OidcConfig = row?.oidc_config
    ? (JSON.parse(
        await openSecurityText(await (await accountSecurityKeyRing(env)).oidc(), row.oidc_config),
      ) as OidcConfig)
    : { issuer: "", clientId: "", secret: "", callback: "" };
  return { enabled: row?.oidc_enabled === 1, revision: row?.oidc_revision ?? "", config };
}
export async function saveSite(
  env: Env,
  config: OidcConfig,
  revision: string,
  enabled: boolean,
  adminSessionId?: string,
) {
  const blob = await sealSecurityText(
    await (await accountSecurityKeyRing(env)).oidc(),
    JSON.stringify(config),
  );
  const now = new Date().toISOString();
  // 管理员通过 IdP 往返期间可能退出或降权，配置提交与该会话的有效性使用同一 SQL 快照。
  const activeAdmin = adminSessionId
    ? " AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.banned=0 AND u.role='admin')"
    : "";
  const adminValues = adminSessionId ? [adminSessionId, now] : [];
  const result = await env.DB.prepare(
    `
    INSERT INTO auth_security_settings (key,created_at,updated_at,oidc_enabled,oidc_revision,oidc_config)
    SELECT 'global',?,?,?,?,? WHERE (?='' OR EXISTS (SELECT 1 FROM auth_security_settings WHERE key='global' AND oidc_revision=?))${activeAdmin}
    ON CONFLICT(key) DO UPDATE SET oidc_enabled=excluded.oidc_enabled,oidc_revision=excluded.oidc_revision,
      oidc_config=excluded.oidc_config,updated_at=excluded.updated_at WHERE oidc_revision=?`,
  )
    .bind(now, now, Number(enabled), randomToken(24), blob, revision, revision, ...adminValues, revision)
    .run();
  if (result.meta.changes !== 1) throw new HttpError(409, "OIDC_CHANGED", "OIDC_CHANGED");
}
export async function storeFlow(env: Env, flow: OidcFlow) {
  const token = randomToken();
  const payload = await sealSecurityText(
    await (await accountSecurityKeyRing(env)).oidc(),
    JSON.stringify(flow),
  );
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM oidc_flows WHERE token_hash IN (SELECT token_hash FROM oidc_flows WHERE expires<=? ORDER BY expires LIMIT 32)",
    ).bind(now),
    env.DB.prepare("INSERT INTO oidc_flows(token_hash,expires,payload) VALUES(?,?,?)").bind(
      await sha256(token),
      now + ttl,
      payload,
    ),
  ]);
  return token;
}
export async function readFlow(request: Request, env: Env) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  if (!token) throw new HttpError(400, "OIDC_EXPIRED", "OIDC_EXPIRED");
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT payload FROM oidc_flows WHERE token_hash=? AND expires>?")
    .bind(hash, Math.floor(Date.now() / 1000))
    .first<{ payload: string }>();
  if (!row) throw new HttpError(400, "OIDC_EXPIRED", "OIDC_EXPIRED");
  const flow = JSON.parse(
    await openSecurityText(await (await accountSecurityKeyRing(env)).oidc(), row.payload),
  ) as OidcFlow;
  return { hash, flow };
}
export async function consumeFlow(env: Env, hash: string) {
  const result = await env.DB.prepare("DELETE FROM oidc_flows WHERE token_hash=? AND expires>?")
    .bind(hash, Math.floor(Date.now() / 1000))
    .run();
  if (result.meta.changes !== 1) throw new HttpError(400, "OIDC_EXPIRED", "OIDC_EXPIRED");
}
