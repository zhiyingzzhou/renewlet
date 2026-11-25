import { HttpError } from "./http";
import type { Env } from "./types";

export interface LinkedIdentity {
  issuer: string;
  subject: string;
  revision: string;
  userId: string;
}

// 绑定撤销/改配与签发凭据可能交错。把最终授权条件放在 INSERT 的 SELECT 内，普通密码登录使用原有单次写入。
export async function savePrimaryCredential(
  env: Env,
  insert: string,
  values: string[],
  identity: LinkedIdentity | undefined,
  kind: "session" | "mfa_ticket",
) {
  let query = insert;
  if (identity) {
    query += ` WHERE EXISTS (SELECT 1 FROM oidc_links l JOIN users u ON u.id=l.user_id
      JOIN auth_security_settings a ON a.key='global' WHERE l.issuer=? AND l.subject=? AND l.user_id=?
      AND u.banned=0 AND a.oidc_enabled=1 AND a.oidc_revision=?)`;
    values.push(identity.issuer, identity.subject, identity.userId, identity.revision);
    if (kind === "session") {
      query += ` AND NOT EXISTS (SELECT 1 FROM mfa_totp_credentials WHERE user_id=?)
       AND NOT EXISTS (SELECT 1 FROM mfa_recovery_codes WHERE user_id=? AND used_at IS NULL)`;
      values.push(identity.userId, identity.userId);
    }
  }
  const result = await env.DB.prepare(query)
    .bind(...values)
    .run();
  if (identity && result.meta.changes !== 1) throw new HttpError(400, "OIDC_CHANGED", "OIDC_CHANGED");
}
