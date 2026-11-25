import { savePrimaryCredential, type LinkedIdentity } from "./primary-login-write";
import * as OTPAuth from "otpauth";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import {
  type AuthenticatorMfaMethod,
  type MfaRecoveryCodesResponse,
  type MfaVerifyBody,
  passkeyAuthenticationOptionsSchema,
  passkeyRegistrationOptionsSchema,
  type PasskeyAuthenticationOptionsResponse,
  type PasskeyAuthenticationResponse,
  type PasskeyRegistrationOptionsResponse,
  type PasskeyRegistrationResponse,
  type SessionResponse,
} from "@renewlet/shared/schemas/auth";
import { type AppLocale } from "./http";
import { serverText } from "./server-i18n";
import { newId, nowIso } from "./db";
import { randomToken, sha256 } from "./crypto";
import { requestOrigin } from "./request-origin";
import { withAccountSecuritySchema } from "./account-security-schema";
import { authenticationResponseForVerification, registrationResponseForVerification } from "./webauthn-response";
import {
  base64Url,
  decryptMfaSecret,
  encryptMfaSecret,
  fromBase64Url,
  mfaTextEncoder,
  mfaTicketHash,
  passkeyChallengeHash,
  recoveryCodeHash,
  sessionTtlDays,
  timingSafeEqual,
} from "./mfa-crypto";
import type {
  Env,
  MfaAuthTicketRow,
  MfaTotpCredentialRow,
  PasskeyChallengeRow,
  PasskeyCredentialRow,
  UserRow,
} from "./types";

/**
 * Cloudflare 账号安全运行面集中在本文件：TOTP/恢复码属于 MFA，Passkey 是独立登录凭据。
 * 二者共用 D1 self-heal、安装级 key ring 和 session 续签 helper，但 reset/登录语义必须分开。
 */
const MFA_TICKET_TTL_MS = 5 * 60 * 1000;
const MFA_TICKET_MAX_ATTEMPTS = 5;
const MFA_TOTP_PERIOD_SECONDS = 30;
const MFA_TOTP_ALLOWED_SKEW = 1;
const MFA_RECOVERY_CODE_COUNT = 10;

interface AccountSecuritySessionRenewal {
  session: IssuedSessionResponse;
  statements: D1PreparedStatement[];
}

export interface IssuedSessionResponse {
  response: SessionResponse;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}

export interface IssuedMfaRecoveryCodesResponse {
  response: MfaRecoveryCodesResponse;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}

export async function authenticatorMfaMethodsForUser(env: Env, userId: string): Promise<AuthenticatorMfaMethod[]> {
  return await withAccountSecuritySchema(env, async () => await authenticatorMfaMethodsForUserUnsafe(env, userId));
}

async function authenticatorMfaMethodsForUserUnsafe(env: Env, userId: string): Promise<AuthenticatorMfaMethod[]> {
  const [totp, recovery] = await Promise.all([
    env.DB.prepare("SELECT user_id FROM mfa_totp_credentials WHERE user_id = ? LIMIT 1").bind(userId).first<{ user_id: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(userId).first<{ count: number }>(),
  ]);
  const methods: AuthenticatorMfaMethod[] = [];
  if (totp) methods.push("totp");
  if ((recovery?.count ?? 0) > 0) methods.push("recovery_code");
  return methods;
}

export async function mfaStatusForUser(env: Env, userId: string) {
  return await withAccountSecuritySchema(env, async () => await mfaStatusForUserUnsafe(env, userId));
}

async function mfaStatusForUserUnsafe(env: Env, userId: string) {
  const [methods, recovery, passkeys] = await Promise.all([
    authenticatorMfaMethodsForUserUnsafe(env, userId),
    env.DB.prepare("SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?").bind(userId).first<{ count: number }>(),
  ]);
  return {
    enabled: methods.length > 0,
    methods,
    recoveryCodesRemaining: recovery?.count ?? 0,
    passkeyCount: passkeys?.count ?? 0,
  };
}

export async function listPasskeysForUser(env: Env, userId: string) {
  return await withAccountSecuritySchema(env, async () => await listPasskeysForUserUnsafe(env, userId));
}

async function listPasskeysForUserUnsafe(env: Env, userId: string) {
  const rows = await passkeyCredentialRows(env, userId);
  return {
    passkeys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
    })),
  };
}

export async function createMfaAuthTicket(env: Env, userId: string, methods: AuthenticatorMfaMethod[], identity?: LinkedIdentity) {
  return await withAccountSecuritySchema(env, async () => await createMfaAuthTicketUnsafe(env, userId, methods, identity));
}

async function createMfaAuthTicketUnsafe(env: Env, userId: string, methods: AuthenticatorMfaMethod[], identity?: LinkedIdentity) {
  const ticket = randomToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + MFA_TICKET_TTL_MS).toISOString();
  // ticket 表示“密码已通过、第二因素未完成”，只保存安装级账号安全 HMAC，不能让它获得 session 权限。
  await savePrimaryCredential(
    env,
    `INSERT INTO mfa_auth_tickets (id, user_id, ticket_hash, expires_at, attempts, methods_json, payload_ciphertext, created_at, updated_at)
     SELECT ?, ?, ?, ?, 0, ?, NULL, ?, ?`,
    [newId("mfat"), userId, await mfaTicketHash(env, ticket), expiresAt, JSON.stringify(methods), timestamp, timestamp],
    identity, "mfa_ticket",
  );
  return { ticketId: ticket, expiresAt, methods };
}

export async function startTotpSetup(env: Env, user: UserRow) {
  return await withAccountSecuritySchema(env, async () => await startTotpSetupUnsafe(env, user));
}

async function startTotpSetupUnsafe(env: Env, user: UserRow) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: "Renewlet",
    label: user.email,
    algorithm: "SHA1",
    digits: 6,
    period: MFA_TOTP_PERIOD_SECONDS,
    secret,
  });
  const setupId = randomToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + MFA_TICKET_TTL_MS).toISOString();
  // TOTP seed 先作为 setup ticket 的加密 payload 暂存；只有启用接口校验当前密码和验证码后才写入正式 credential。
  await env.DB.prepare(`
    INSERT INTO mfa_auth_tickets (id, user_id, ticket_hash, expires_at, attempts, methods_json, payload_ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).bind(
    newId("mfat"),
    user.id,
    await mfaTicketHash(env, setupId),
    expiresAt,
    JSON.stringify(["totp_setup"]),
    await encryptMfaSecret(env, secret.base32),
    timestamp,
    timestamp,
  ).run();
  return {
    setupId,
    secret: secret.base32,
    otpauthUrl: totp.toString(),
    expiresAt,
  };
}

export async function enableTotp(env: Env, user: UserRow, setupId: string, code: string): Promise<IssuedMfaRecoveryCodesResponse> {
  return await withAccountSecuritySchema(env, async () => await enableTotpUnsafe(env, user, setupId, code));
}

async function enableTotpUnsafe(env: Env, user: UserRow, setupId: string, code: string): Promise<IssuedMfaRecoveryCodesResponse> {
  const ticket = await mfaTicketByToken(env, setupId);
  if (!ticket || ticket.user_id !== user.id || !ticketMethods(ticket).includes("totp_setup")) {
    throw new Error("invalid MFA setup");
  }
  const secret = await decryptMfaSecret(env, ticket.payload_ciphertext ?? "");
  if (!(await validateTotp(secret, code, -1)).ok) {
    throw new Error("invalid MFA setup code");
  }
  // 启用 TOTP 是账号安全边界切换：替换 seed/恢复码后续签当前浏览器 session，旧 cookie session 和其它设备一起失效。
  const timestamp = nowIso();
  const recoveryCodes = newRecoveryCodes();
  const renewal = await prepareAccountSecuritySessionRenewal(env, user);
  const recoveryStatements = await Promise.all(recoveryCodes.map(async (codeValue) =>
    env.DB.prepare(`
      INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).bind(newId("mfar"), user.id, await recoveryCodeHash(env, codeValue), timestamp, timestamp),
  ));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mfa_totp_credentials WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").bind(user.id),
    env.DB.prepare(`
      INSERT INTO mfa_totp_credentials (user_id, secret_ciphertext, last_accepted_step, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).bind(user.id, ticket.payload_ciphertext, timestamp, timestamp),
    ...recoveryStatements,
    ...renewal.statements,
  ]);
  return issuedRecoveryCodesResponse(renewal.session, recoveryCodes);
}

export async function regenerateRecoveryCodes(env: Env, user: UserRow): Promise<IssuedMfaRecoveryCodesResponse> {
  return await withAccountSecuritySchema(env, async () => await regenerateRecoveryCodesUnsafe(env, user));
}

async function regenerateRecoveryCodesUnsafe(env: Env, user: UserRow): Promise<IssuedMfaRecoveryCodesResponse> {
  const timestamp = nowIso();
  const recoveryCodes = newRecoveryCodes();
  const renewal = await prepareAccountSecuritySessionRenewal(env, user);
  const statements = await Promise.all(recoveryCodes.map(async (codeValue) =>
    env.DB.prepare(`
      INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).bind(newId("mfar"), user.id, await recoveryCodeHash(env, codeValue), timestamp, timestamp),
  ));
  await env.DB.batch([
    // 重新生成会立即废弃旧的未使用恢复码；前端只会拿到这次响应里的明文。
    env.DB.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").bind(user.id),
    ...statements,
    ...renewal.statements,
  ]);
  return issuedRecoveryCodesResponse(renewal.session, recoveryCodes);
}

export async function disableAuthenticatorMfaForCurrentUser(env: Env, user: UserRow): Promise<IssuedSessionResponse> {
  return await withAccountSecuritySchema(env, async () => await disableAuthenticatorMfaForCurrentUserUnsafe(env, user));
}

async function disableAuthenticatorMfaForCurrentUserUnsafe(env: Env, user: UserRow): Promise<IssuedSessionResponse> {
  const renewal = await prepareAccountSecuritySessionRenewal(env, user);
  // 自助关闭认证器只移除 TOTP/恢复码；通行密钥仍是独立登录方式，但旧 session 必须被新 session 取代。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mfa_totp_credentials WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").bind(user.id),
    ...renewal.statements,
  ]);
  return renewal.session;
}

export async function disableAuthenticatorMfaForUser(env: Env, userId: string): Promise<void> {
  await withAccountSecuritySchema(env, async () => await disableAuthenticatorMfaForUserUnsafe(env, userId));
}

async function disableAuthenticatorMfaForUserUnsafe(env: Env, userId: string): Promise<void> {
  // 2FA reset 只清认证器和恢复码；Passkey 是独立安全项，必须走单独 reset，避免误删登录密钥。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mfa_totp_credentials WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM mfa_auth_tickets WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
}

export async function deletePasskeysForUser(env: Env, userId: string): Promise<void> {
  await withAccountSecuritySchema(env, async () => await deletePasskeysForUserUnsafe(env, userId));
}

async function deletePasskeysForUserUnsafe(env: Env, userId: string): Promise<void> {
  // Passkey reset 只清 WebAuthn 凭据和短期 challenge；认证器/恢复码仍由 2FA reset 管理。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM passkey_challenges WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM mfa_auth_tickets WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
}

export async function deleteMfaAuthTicketsForUser(env: Env, userId: string): Promise<void> {
  await withAccountSecuritySchema(env, async () => {
    await env.DB.prepare("DELETE FROM mfa_auth_tickets WHERE user_id = ?").bind(userId).run();
  });
}

export async function startPasskeyRegistration(env: Env, request: Request, user: UserRow): Promise<PasskeyRegistrationOptionsResponse> {
  return await withAccountSecuritySchema(env, async () => await startPasskeyRegistrationUnsafe(env, request, user));
}

async function startPasskeyRegistrationUnsafe(env: Env, request: Request, user: UserRow): Promise<PasskeyRegistrationOptionsResponse> {
  const { origin, rpID } = webAuthnRuntime(request);
  const rows = await passkeyCredentialRows(env, user.id);
  const options = await generateRegistrationOptions({
    rpName: "Renewlet",
    rpID,
    userID: mfaTextEncoder.encode(user.id),
    userName: user.email,
    userDisplayName: user.name || user.email,
    attestationType: "none",
    excludeCredentials: rows.map((row) => ({
      id: row.credential_id,
      transports: parseTransports(row.transports_json),
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = await storeWebAuthnChallenge(env, {
    userId: user.id,
    kind: "registration",
    challenge: options.challenge,
    sessionData: { origin, rpID },
  });
  return {
    challengeId: challengeId.challengeId,
    expiresAt: challengeId.expiresAt,
    options: passkeyRegistrationOptionsSchema.parse(options),
  };
}

export async function finishPasskeyRegistration(
  env: Env,
  request: Request,
  user: UserRow,
  challengeId: string,
  name: string,
  response: PasskeyRegistrationResponse,
): Promise<IssuedSessionResponse> {
  return await withAccountSecuritySchema(env, async () => await finishPasskeyRegistrationUnsafe(env, request, user, challengeId, name, response));
}

async function finishPasskeyRegistrationUnsafe(
  env: Env,
  request: Request,
  user: UserRow,
  challengeId: string,
  name: string,
  response: PasskeyRegistrationResponse,
): Promise<IssuedSessionResponse> {
  const challenge = await webAuthnChallengeByToken(env, challengeId, "registration");
  if (!challenge || challenge.user_id !== user.id) throw new Error("invalid WebAuthn challenge");
  const { origin, rpID } = webAuthnRuntime(request);
  assertWebAuthnRuntime(challenge, origin, rpID);
  // 注册校验完全交给 SimpleWebAuthn；Renewlet 只负责把 origin/RP 与短期 challenge 对齐并持久化结果。
  const verification = await verifyRegistrationResponse({
    response: registrationResponseForVerification(response),
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error("Passkey registration failed");
  const credential = verification.registrationInfo.credential;
  const timestamp = nowIso();
  const renewal = await prepareAccountSecuritySessionRenewal(env, user);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO passkey_credentials (id, user_id, name, credential_id, public_key, credential_json, counter, transports_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("pkey"),
      user.id,
      name.trim(),
      credential.id,
      base64Url(credential.publicKey),
      JSON.stringify(credentialJsonForStorage(credential)),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      timestamp,
      timestamp,
    ),
    env.DB.prepare("DELETE FROM passkey_challenges WHERE id = ?").bind(challenge.id),
    ...renewal.statements,
  ]);
  return renewal.session;
}

export async function startPasskeyAuthentication(env: Env, request: Request): Promise<PasskeyAuthenticationOptionsResponse> {
  return await withAccountSecuritySchema(env, async () => await startPasskeyAuthenticationUnsafe(env, request));
}

async function startPasskeyAuthenticationUnsafe(env: Env, request: Request): Promise<PasskeyAuthenticationOptionsResponse> {
  const { origin, rpID } = webAuthnRuntime(request);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
  });
  const challenge = await storeWebAuthnChallenge(env, {
    userId: null,
    kind: "authentication",
    challenge: options.challenge,
    sessionData: { origin, rpID },
  });
  // Passkey 是独立登录方式：authentication challenge 开始时未知用户，finish 通过 credential 反查账号并直接签产品 session。
  return {
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    options: passkeyAuthenticationOptionsSchema.parse({
      challenge: options.challenge,
      timeout: options.timeout,
      rpId: options.rpId,
      allowCredentials: options.allowCredentials,
      userVerification: options.userVerification,
      hints: [],
    }),
  };
}

export async function finishPasskeyAuthentication(
  env: Env,
  request: Request,
  challengeId: string,
  response: PasskeyAuthenticationResponse,
): Promise<IssuedSessionResponse> {
  return await withAccountSecuritySchema(env, async () => await finishPasskeyAuthenticationUnsafe(env, request, challengeId, response));
}

async function finishPasskeyAuthenticationUnsafe(
  env: Env,
  request: Request,
  challengeId: string,
  response: PasskeyAuthenticationResponse,
): Promise<IssuedSessionResponse> {
  const challenge = await webAuthnChallengeByToken(env, challengeId, "authentication");
  if (!challenge) throw new Error("invalid WebAuthn challenge");
  const { origin, rpID } = webAuthnRuntime(request);
  assertWebAuthnRuntime(challenge, origin, rpID);
  const responseId = response.id;
  const credentialRow = await env.DB.prepare(`
    SELECT * FROM passkey_credentials WHERE credential_id = ? LIMIT 1
  `).bind(responseId).first<PasskeyCredentialRow>();
  if (!credentialRow) throw new Error("unknown Passkey credential");
  const user = await env.DB.prepare(`
    SELECT id, email, name, role, banned, ban_reason, password_hash, reset_token_hash, reset_token_expires_at, created_at, updated_at
    FROM users WHERE id = ? LIMIT 1
  `).bind(credentialRow.user_id).first<UserRow>();
  if (!user || user.banned === 1) throw new Error("invalid Passkey user");
  const credential = passkeyCredentialFromRow(credentialRow);
  // SimpleWebAuthn 负责 assertion、UV、origin/RP ID 与 counter 校验；Worker 只在成功后更新计数并签产品 session。
  const verification = await verifyAuthenticationResponse({
    response: authenticationResponseForVerification(response),
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error("Passkey authentication failed");
  await env.DB.batch([
    env.DB.prepare("UPDATE passkey_credentials SET counter = ?, credential_json = ?, updated_at = ? WHERE id = ?").bind(
      verification.authenticationInfo.newCounter,
      JSON.stringify({
        ...credentialJsonForStorage(credential),
        counter: verification.authenticationInfo.newCounter,
      }),
      nowIso(),
      credentialRow.id,
    ),
    env.DB.prepare("DELETE FROM passkey_challenges WHERE id = ?").bind(challenge.id),
  ]);
  return await createSessionResponse(env, user);
}

export async function deletePasskeyForCurrentUser(env: Env, user: UserRow, passkeyId: string): Promise<IssuedSessionResponse> {
  return await withAccountSecuritySchema(env, async () => await deletePasskeyForCurrentUserUnsafe(env, user, passkeyId));
}

async function deletePasskeyForCurrentUserUnsafe(env: Env, user: UserRow, passkeyId: string): Promise<IssuedSessionResponse> {
  const credential = await env.DB.prepare("SELECT id FROM passkey_credentials WHERE id = ? AND user_id = ? LIMIT 1")
    .bind(passkeyId, user.id)
    .first<{ id: string }>();
  if (!credential) throw new Error("invalid Passkey credential");
  const renewal = await prepareAccountSecuritySessionRenewal(env, user);
  // 删除单个通行密钥后续签当前 session；同用户未完成的注册 challenge 不能继续沿用旧凭据上下文。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?").bind(passkeyId, user.id),
    env.DB.prepare("DELETE FROM passkey_challenges WHERE user_id = ?").bind(user.id),
    ...renewal.statements,
  ]);
  return renewal.session;
}

export async function verifyMfaLogin(env: Env, body: MfaVerifyBody, locale: AppLocale): Promise<IssuedSessionResponse> {
  return await withAccountSecuritySchema(env, async () => await verifyMfaLoginUnsafe(env, body, locale));
}

async function verifyMfaLoginUnsafe(env: Env, body: MfaVerifyBody, locale: AppLocale): Promise<IssuedSessionResponse> {
  const ticket = await mfaTicketByToken(env, body.ticketId);
  if (!ticket || ticket.attempts >= MFA_TICKET_MAX_ATTEMPTS || !ticketMethods(ticket).includes(body.method)) {
    if (ticket) await registerFailedMfaAttempt(env, ticket);
    throw new Error(serverText(locale, "auth.sessionExpired"));
  }
  const user = await env.DB.prepare(`
    SELECT id, email, name, role, banned, ban_reason, password_hash, reset_token_hash, reset_token_expires_at, created_at, updated_at
    FROM users WHERE id = ? LIMIT 1
  `).bind(ticket.user_id).first<UserRow>();
  if (!user || user.banned === 1) throw new Error(serverText(locale, "auth.sessionExpired"));

  let verified = false;
  if (body.method === "totp") {
    verified = await consumeTotp(env, user.id, body.code);
  } else if (body.method === "recovery_code") {
    verified = await consumeRecoveryCode(env, user.id, body.code);
  }
  if (!verified) {
    await registerFailedMfaAttempt(env, ticket);
    throw new Error(serverText(locale, "auth.sessionExpired"));
  }
  // MFA ticket 成功后单次消费；session 重新签发，前端只持有新的产品 token。
  await env.DB.prepare("DELETE FROM mfa_auth_tickets WHERE id = ?").bind(ticket.id).run();
  return await createSessionResponse(env, user);
}

async function consumeTotp(env: Env, userId: string, code: string): Promise<boolean> {
  const credential = await env.DB.prepare("SELECT * FROM mfa_totp_credentials WHERE user_id = ? LIMIT 1").bind(userId).first<MfaTotpCredentialRow>();
  if (!credential) return false;
  const secret = await decryptMfaSecret(env, credential.secret_ciphertext);
  // 允许前后一步抵抗轻微时钟偏移，但已接受 step 不得再次成功，避免 OTP 重放。
  const result = await validateTotp(secret, code, credential.last_accepted_step);
  if (!result.ok) return false;
  await env.DB.prepare("UPDATE mfa_totp_credentials SET last_accepted_step = ?, updated_at = ? WHERE user_id = ?")
    .bind(result.step, nowIso(), userId)
    .run();
  return true;
}

async function validateTotp(secretValue: string, code: string, lastAcceptedStep: number): Promise<{ ok: true; step: number } | { ok: false }> {
  const totp = new OTPAuth.TOTP({
    issuer: "Renewlet",
    label: "Renewlet",
    algorithm: "SHA1",
    digits: 6,
    period: MFA_TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretValue),
  });
  const currentStep = Math.floor(Date.now() / 1000 / MFA_TOTP_PERIOD_SECONDS);
  for (let offset = -MFA_TOTP_ALLOWED_SKEW; offset <= MFA_TOTP_ALLOWED_SKEW; offset += 1) {
    const step = currentStep + offset;
    if (step <= lastAcceptedStep) continue;
    const expected = totp.generate({ timestamp: step * MFA_TOTP_PERIOD_SECONDS * 1000 });
    if (timingSafeEqual(expected, code.trim())) return { ok: true, step };
  }
  return { ok: false };
}

async function consumeRecoveryCode(env: Env, userId: string, code: string): Promise<boolean> {
  const hash = await recoveryCodeHash(env, code);
  const row = await env.DB.prepare(`
    SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1
  `).bind(userId, hash).first<{ id: string }>();
  if (!row) return false;
  // 恢复码只使用一次；保留 used_at 比删除行更利于解释剩余数量和审计。
  await env.DB.prepare("UPDATE mfa_recovery_codes SET used_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), row.id).run();
  return true;
}

async function mfaTicketByToken(env: Env, token: string): Promise<MfaAuthTicketRow | null> {
  return await env.DB.prepare("SELECT * FROM mfa_auth_tickets WHERE ticket_hash = ? AND expires_at > ? LIMIT 1")
    .bind(await mfaTicketHash(env, token), nowIso())
    .first<MfaAuthTicketRow>();
}

async function registerFailedMfaAttempt(env: Env, ticket: MfaAuthTicketRow): Promise<void> {
  const attempts = ticket.attempts + 1;
  if (attempts >= MFA_TICKET_MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM mfa_auth_tickets WHERE id = ?").bind(ticket.id).run();
    return;
  }
  await env.DB.prepare("UPDATE mfa_auth_tickets SET attempts = ?, updated_at = ? WHERE id = ?").bind(attempts, nowIso(), ticket.id).run();
}

export async function prepareAccountSecuritySessionRenewal(env: Env, user: UserRow, linkedSessionId?: string): Promise<AccountSecuritySessionRenewal> {
  const token = randomToken();
  const csrfToken = randomToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + sessionTtlDays(env) * 24 * 60 * 60 * 1000).toISOString();
  const sessionId = newId("ses");
  const session = issuedSessionResponse(token, csrfToken, user, expiresAt);
  // D1 batch 会按事务执行：先插入新 session，再用 id<>new 删除旧 cookie session，避免成功响应拿到已失效 token。
  // OIDC 解绑在签发新会话时重查原会话和绑定；缺失时 user_id 非空约束将整批回滚。
  const sessionOwner = linkedSessionId
    ? "(SELECT s.user_id FROM sessions s JOIN oidc_links l ON l.user_id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>?)"
    : "?";
  const ownerValues = linkedSessionId ? [linkedSessionId, user.id, timestamp] : [user.id];
  const statements = [
    env.DB.prepare(`
      INSERT INTO sessions (id, token_hash, csrf_token_hash, user_id, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ${sessionOwner}, ?, ?, ?)
    `).bind(sessionId, await sha256(token), await sha256(csrfToken), ...ownerValues, expiresAt, timestamp, timestamp),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(user.id, sessionId),
    env.DB.prepare("DELETE FROM mfa_auth_tickets WHERE user_id = ?").bind(user.id),
  ];
  return { session, statements };
}

async function createSessionResponse(env: Env, user: UserRow): Promise<IssuedSessionResponse> {
  const token = randomToken();
  const csrfToken = randomToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + sessionTtlDays(env) * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO sessions (id, token_hash, csrf_token_hash, user_id, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(newId("ses"), await sha256(token), await sha256(csrfToken), user.id, expiresAt, timestamp, timestamp).run();
  return issuedSessionResponse(token, csrfToken, user, expiresAt);
}

function issuedSessionResponse(token: string, csrfToken: string, user: UserRow, expiresAt: string): IssuedSessionResponse {
  return {
    response: sessionResponsePayload(user, expiresAt),
    sessionToken: token,
    csrfToken,
    expiresAt,
  };
}

function issuedRecoveryCodesResponse(session: IssuedSessionResponse, recoveryCodes: string[]): IssuedMfaRecoveryCodesResponse {
  return {
    response: { ...session.response, recoveryCodes },
    sessionToken: session.sessionToken,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

function sessionResponsePayload(user: UserRow, expiresAt: string): SessionResponse {
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

function ticketMethods(ticket: MfaAuthTicketRow): string[] {
  try {
    const parsed = JSON.parse(ticket.methods_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function passkeyCredentialRows(env: Env, userId: string): Promise<PasskeyCredentialRow[]> {
  const result = await env.DB.prepare(`
    SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
  `).bind(userId).all<PasskeyCredentialRow>();
  return result.results ?? [];
}

async function storeWebAuthnChallenge(env: Env, input: {
  userId: string | null;
  kind: "registration" | "authentication";
  challenge: string;
  sessionData: { origin: string; rpID: string };
}): Promise<{ challengeId: string; expiresAt: string }> {
  const challengeId = randomToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + MFA_TICKET_TTL_MS).toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO passkey_challenges (id, user_id, challenge_id_hash, kind, challenge, session_data_json, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("pwch"),
      input.userId,
      await passkeyChallengeHash(env, challengeId),
      input.kind,
      input.challenge,
      JSON.stringify(input.sessionData),
      expiresAt,
      timestamp,
      timestamp,
    ),
  ];
  if (input.userId) {
    // 注册 challenge 绑定登录用户且同类只保留一个；独立登录 challenge 无用户，不能按 NULL 清掉其他浏览器流程。
    statements.unshift(env.DB.prepare("DELETE FROM passkey_challenges WHERE user_id = ? AND kind = ?").bind(input.userId, input.kind));
  }
  await env.DB.batch(statements);
  return { challengeId, expiresAt };
}

async function webAuthnChallengeByToken(
  env: Env,
  challengeId: string,
  kind: "registration" | "authentication",
): Promise<PasskeyChallengeRow | null> {
  return await env.DB.prepare(`
    SELECT * FROM passkey_challenges WHERE challenge_id_hash = ? AND kind = ? AND expires_at > ? LIMIT 1
  `).bind(await passkeyChallengeHash(env, challengeId), kind, nowIso()).first<PasskeyChallengeRow>();
}

function webAuthnRuntime(request: Request): { origin: string; rpID: string } {
  const origin = requestOrigin(request);
  const rpID = new URL(origin).hostname;
  if (!rpID) throw new Error("invalid WebAuthn RP ID");
  // Worker 只信任 Cloudflare 传入的 request.url；origin/RP ID 不匹配时 SimpleWebAuthn 会 fail closed。
  return { origin, rpID };
}

function assertWebAuthnRuntime(challenge: PasskeyChallengeRow, origin: string, rpID: string): void {
  const parsed = parseChallengeSessionData(challenge.session_data_json);
  if (parsed["origin"] !== origin || parsed["rpID"] !== rpID) {
    throw new Error("WebAuthn origin mismatch");
  }
}

function parseChallengeSessionData(value: string): { origin: string; rpID: string } {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid WebAuthn session");
  const record = parsed as Record<string, unknown>;
  if (typeof record["origin"] !== "string" || typeof record["rpID"] !== "string") throw new Error("invalid WebAuthn session");
  return { origin: record["origin"], rpID: record["rpID"] };
}

function passkeyCredentialFromRow(row: PasskeyCredentialRow): WebAuthnCredential {
  return {
    id: row.credential_id,
    publicKey: new Uint8Array(fromBase64Url(row.public_key)),
    counter: row.counter,
    transports: parseTransports(row.transports_json),
  };
}

function credentialJsonForStorage(credential: WebAuthnCredential): {
  id: string;
  publicKey: string;
  counter: number;
  transports: AuthenticatorTransportFuture[];
} {
  return {
    id: credential.id,
    publicKey: base64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
  };
}

function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is AuthenticatorTransportFuture => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function newRecoveryCodes(): string[] {
  return Array.from({ length: MFA_RECOVERY_CODE_COUNT }, () => {
    const secret = new OTPAuth.Secret({ size: 9 }).base32.toUpperCase();
    return `${secret.slice(0, 4)}-${secret.slice(4, 8)}-${secret.slice(8, 12)}`;
  });
}
