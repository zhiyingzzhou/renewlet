ALTER TABLE auth_security_settings ADD COLUMN oidc_enabled INTEGER NOT NULL DEFAULT 0 CHECK (oidc_enabled IN (0,1));
ALTER TABLE auth_security_settings ADD COLUMN oidc_config TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_security_settings ADD COLUMN oidc_revision TEXT NOT NULL DEFAULT '';

-- 绑定只认 issuer/sub；外部资料不能用于匹配、创建或提升本地账号。
CREATE TABLE oidc_links (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  UNIQUE(issuer, subject)
);
CREATE TABLE oidc_flows (
  token_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_oidc_flows_expiry ON oidc_flows(expires);
