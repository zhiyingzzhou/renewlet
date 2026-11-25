// Worker 认证测试保护账号生命周期边界；D1 细节用 mock 固定，测试只关心 route 安全决策。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminPatchUser,
  adminResetUserMfa,
  adminResetUserPasskeys,
  appStatus,
  createInitialAdmin,
  login,
  mfaDisable,
  mfaRecoveryRegenerate,
  mfaTotpEnable,
  mfaVerify,
  passkeyAuthenticateOptions,
  passkeyAuthenticateVerify,
  passkeyDelete,
  passkeyRegisterVerify,
  requireAuth,
} from "./auth";
import { readSuccessData } from "./api-test-helpers";
import { AccountSecuritySchemaError } from "./account-security-schema";
import { toResponse } from "./http";
import type { AuthSecuritySettingsRow, Env, UserRow } from "./types";

const mocks = vi.hoisted(() => ({
  enabledAdminCount: vi.fn(),
  ensureSettings: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  hashPassword: vi.fn(),
  nowIso: vi.fn(),
  sha256: vi.fn(),
  verifyPassword: vi.fn(),
  createMfaAuthTicket: vi.fn(),
  deletePasskeyForCurrentUser: vi.fn(),
  deleteMfaAuthTicketsForUser: vi.fn(),
  deletePasskeysForUser: vi.fn(),
  disableAuthenticatorMfaForCurrentUser: vi.fn(),
  disableAuthenticatorMfaForUser: vi.fn(),
  enableTotp: vi.fn(),
  finishPasskeyAuthentication: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  authenticatorMfaMethodsForUser: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  startPasskeyAuthentication: vi.fn(),
  verifyMfaLogin: vi.fn(),
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    enabledAdminCount: mocks.enabledAdminCount,
    ensureSettings: mocks.ensureSettings,
    findUserByEmail: mocks.findUserByEmail,
    findUserById: mocks.findUserById,
    nowIso: mocks.nowIso,
  };
});

vi.mock("./crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crypto")>();
  return {
    ...actual,
    hashPassword: mocks.hashPassword,
    sha256: mocks.sha256,
    verifyPassword: mocks.verifyPassword,
  };
});

vi.mock("./mfa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mfa")>();
  return {
    ...actual,
    createMfaAuthTicket: mocks.createMfaAuthTicket,
    deletePasskeyForCurrentUser: mocks.deletePasskeyForCurrentUser,
    deleteMfaAuthTicketsForUser: mocks.deleteMfaAuthTicketsForUser,
    deletePasskeysForUser: mocks.deletePasskeysForUser,
    disableAuthenticatorMfaForCurrentUser: mocks.disableAuthenticatorMfaForCurrentUser,
    disableAuthenticatorMfaForUser: mocks.disableAuthenticatorMfaForUser,
    enableTotp: mocks.enableTotp,
    finishPasskeyAuthentication: mocks.finishPasskeyAuthentication,
    finishPasskeyRegistration: mocks.finishPasskeyRegistration,
    authenticatorMfaMethodsForUser: mocks.authenticatorMfaMethodsForUser,
    regenerateRecoveryCodes: mocks.regenerateRecoveryCodes,
    startPasskeyAuthentication: mocks.startPasskeyAuthentication,
    verifyMfaLogin: mocks.verifyMfaLogin,
  };
});

beforeEach(() => {
  mocks.createMfaAuthTicket.mockReset().mockResolvedValue({
    ticketId: "mfa-ticket",
    expiresAt: "2026-06-03T00:05:00.000Z",
    methods: ["totp"],
  });
  mocks.deleteMfaAuthTicketsForUser.mockReset().mockResolvedValue(undefined);
  mocks.deletePasskeyForCurrentUser.mockReset().mockResolvedValue(renewedSession("passkey-delete-session"));
  mocks.deletePasskeysForUser.mockReset().mockResolvedValue(undefined);
  mocks.disableAuthenticatorMfaForCurrentUser.mockReset().mockResolvedValue(renewedSession("mfa-disable-session"));
  mocks.disableAuthenticatorMfaForUser.mockReset().mockResolvedValue(undefined);
  mocks.enableTotp.mockReset().mockResolvedValue({
    ...renewedSession("totp-enable-session"),
    response: { ...renewedSession("totp-enable-session").response, recoveryCodes: ["ABCD-EFGH-IJKL"] },
  });
  mocks.finishPasskeyAuthentication.mockReset().mockResolvedValue({
    response: {
      type: "session",
      session: { expiresAt: "2026-07-03T00:00:00.000Z" },
      user: { id: "usr_passkey", email: "passkey@example.com", name: "Passkey User", role: "user", banned: false },
    },
    sessionToken: "passkey-session",
    csrfToken: "csrf-token",
    expiresAt: "2026-07-03T00:00:00.000Z",
  });
  mocks.finishPasskeyRegistration.mockReset().mockResolvedValue(renewedSession("passkey-register-session"));
  mocks.authenticatorMfaMethodsForUser.mockReset().mockResolvedValue([]);
  mocks.regenerateRecoveryCodes.mockReset().mockResolvedValue({
    ...renewedSession("recovery-regenerate-session"),
    response: { ...renewedSession("recovery-regenerate-session").response, recoveryCodes: ["MNOP-QRST-UVWX"] },
  });
  mocks.startPasskeyAuthentication.mockReset().mockResolvedValue({
    challengeId: "challenge-1",
    expiresAt: "2026-06-03T00:05:00.000Z",
    options: passkeyAuthenticationOptions(),
  });
  mocks.verifyMfaLogin.mockReset().mockResolvedValue({
    response: {
      type: "session",
      session: { expiresAt: "2026-07-03T00:00:00.000Z" },
      user: { id: "usr_mfa", email: "mfa@example.com", name: "MFA User", role: "user", banned: false },
    },
    sessionToken: "mfa-session",
    csrfToken: "csrf-token",
    expiresAt: "2026-07-03T00:00:00.000Z",
  });
});

describe("Cloudflare admin password reset boundary", () => {
  beforeEach(() => {
    mocks.enabledAdminCount.mockReset().mockResolvedValue(2);
    mocks.ensureSettings.mockReset().mockResolvedValue(undefined);
    mocks.findUserByEmail.mockReset();
    mocks.findUserById.mockReset();
    mocks.hashPassword.mockReset().mockResolvedValue("hashed-new-password");
    mocks.nowIso.mockReset().mockReturnValue("2026-06-03T00:00:00.000Z");
    mocks.sha256.mockReset().mockResolvedValue("token-hash");
    mocks.verifyPassword.mockReset().mockResolvedValue(true);
  });

  it("rejects resetting the current admin through admin patch", async () => {
    const updateRun = vi.fn();
    mocks.findUserById.mockResolvedValue(userRow({ id: "usr_admin", role: "admin" }));

    await expect(adminPatchUser(requestFixture({ newPassword: "newpassword123" }), envFixture(updateRun), "usr_admin"))
      .rejects.toMatchObject({
        status: 400,
        message: "Use the change password flow to update the current account password",
      });

    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("keeps admin reset available for other users", async () => {
    const updateRun = vi.fn().mockResolvedValue({});
    mocks.findUserById.mockResolvedValue(userRow({ id: "usr_user", role: "user" }));

    const response = await adminPatchUser(requestFixture({ newPassword: "newpassword123" }), envFixture(updateRun), "usr_user");

    expect(response.status).toBe(200);
    expect(mocks.hashPassword).toHaveBeenCalledWith("newpassword123");
    expect(updateRun).toHaveBeenCalledTimes(2);
    expect(mocks.deleteMfaAuthTicketsForUser).toHaveBeenCalledWith(expect.anything(), "usr_user");
  });
});

describe("Cloudflare auth settings initialization", () => {
  beforeEach(() => {
    mocks.enabledAdminCount.mockReset().mockResolvedValue(0);
    mocks.ensureSettings.mockReset().mockResolvedValue(undefined);
    mocks.findUserByEmail.mockReset();
    mocks.findUserById.mockReset();
    mocks.hashPassword.mockReset().mockResolvedValue("hashed-password");
    mocks.nowIso.mockReset().mockReturnValue("2026-06-03T00:00:00.000Z");
    mocks.sha256.mockReset().mockResolvedValue("token-hash");
    mocks.verifyPassword.mockReset().mockResolvedValue(true);
  });

  it("creates initial admin settings with auto regardless of request locale", async () => {
    const setup = setupEnvFixture([[1, 1, 1, 1]]);

    const response = await createInitialAdmin(jsonRequest("/api/app/setup", "POST", {
      name: "Admin",
      email: "admin@example.com",
      password: "password123",
    }, { "x-renewlet-locale": "zh-CN" }), setup.env);

    expect(response.status).toBe(201);
    expect(setup.batches).toHaveLength(1);
    const batch = setup.batches.at(0);
    const boundBatch = setup.boundValues.at(0);
    if (!batch || !boundBatch) throw new Error("expected the setup transaction batch");
    const userInsert = batch.at(0);
    const settingsBindings = boundBatch.at(1);
    if (!userInsert || !settingsBindings) throw new Error("expected setup user and settings statements");
    expect(batch).toHaveLength(4);
    expect(userInsert).toContain("WHERE NOT EXISTS");
    expect(batch.slice(1).every((sql) => /FROM users WHERE id = \?/.test(sql))).toBe(true);
    expect(String(settingsBindings.at(1))).toContain('"localePreference":"auto"');
    expect(String(settingsBindings.at(1))).not.toContain('"locale":');
    expect(mocks.ensureSettings).not.toHaveBeenCalled();
  });

  it("allows only one concurrent setup request to initialize settings and scheduler", async () => {
    const setup = setupEnvFixture([
      [1, 1, 1, 1],
      [0, 0, 0, 0],
    ]);

    const responses = await Promise.all([
      createInitialAdmin(jsonRequest("/api/app/setup", "POST", {
        name: "First",
        email: "first@example.com",
        password: "password123",
      }), setup.env).catch((error: unknown) => toResponse(error)),
      createInitialAdmin(jsonRequest("/api/app/setup", "POST", {
        name: "Second",
        email: "second@example.com",
        password: "password123",
      }), setup.env).catch((error: unknown) => toResponse(error)),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 403]);
    expect(setup.batches).toHaveLength(2);
    expect(setup.batches.every((batch) => batch.length === 4)).toBe(true);
    expect(setup.batches.flatMap((batch) => batch.slice(1)).every((sql) => /FROM users WHERE id = \?/.test(sql))).toBe(true);
    expect(mocks.ensureSettings).not.toHaveBeenCalled();
  });

  it("ensures settings before returning a login session", async () => {
    const run = vi.fn().mockResolvedValue({});
    mocks.findUserByEmail.mockResolvedValue(userRow({ id: "usr_login", email: "login@example.com" }));

    const response = await login(jsonRequest("/api/app/auth/login", "POST", {
      email: "login@example.com",
      password: "password123",
    }, { "x-renewlet-locale": "zh-CN" }), envFixture(run));

    expect(response.status).toBe(200);
    expect(mocks.verifyPassword).toHaveBeenCalledWith("password123", "old-hash");
    expect(mocks.ensureSettings).toHaveBeenCalledWith(expect.anything(), "usr_login");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("requires Turnstile before looking up password login users when enabled", async () => {
    const response = await login(jsonRequest("/api/app/auth/login", "POST", {
      email: "login@example.com",
      password: "password123",
    }), envFixture(vi.fn(), authSecurityRow())).catch((error: unknown) => toResponse(error));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("TURNSTILE_REQUIRED");
    expect(mocks.findUserByEmail).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("fails closed on Turnstile Siteverify network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("secret-value upstream down");
    }));

    const response = await login(jsonRequest("/api/app/auth/login", "POST", {
      email: "login@example.com",
      password: "password123",
      turnstileToken: "bad-token",
    }), envFixture(vi.fn(), authSecurityRow())).catch((error: unknown) => toResponse(error));

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("TURNSTILE_FAILED");
    expect(body).not.toContain("secret-value upstream down");
    expect(mocks.findUserByEmail).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("continues the password login flow after a successful Turnstile verification", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn().mockResolvedValue({});
    mocks.findUserByEmail.mockResolvedValue(userRow({ id: "usr_login", email: "login@example.com" }));

    const response = await login(jsonRequest("/api/app/auth/login", "POST", {
      email: "login@example.com",
      password: "password123",
      turnstileToken: "ok-token",
    }, { "cf-connecting-ip": "203.0.113.9" }), envFixture(run, authSecurityRow()));

    expect(response.status).toBe(200);
    expect(mocks.findUserByEmail).toHaveBeenCalledWith(expect.anything(), "login@example.com");
    expect(mocks.verifyPassword).toHaveBeenCalledWith("password123", "old-hash");
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const [, init] = calls[0] ?? [];
    expect(String(init?.body)).toContain("secret=secret-value");
    expect(String(init?.body)).toContain("response=ok-token");
    expect(String(init?.body)).toContain("remoteip=203.0.113.9");
  });

  it("returns an MFA ticket without creating a session when an authenticator is enabled", async () => {
    const run = vi.fn().mockResolvedValue({});
    mocks.findUserByEmail.mockResolvedValue(userRow({ id: "usr_mfa", email: "mfa@example.com" }));
    mocks.authenticatorMfaMethodsForUser.mockResolvedValue(["totp"]);
    mocks.createMfaAuthTicket.mockResolvedValue({
      ticketId: "ticket-second-factor",
      expiresAt: "2026-06-03T00:05:00.000Z",
      methods: ["totp"],
    });

    const response = await login(jsonRequest("/api/app/auth/login", "POST", {
      email: "mfa@example.com",
      password: "password123",
    }, { "x-renewlet-locale": "zh-CN" }), envFixture(run));

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toEqual({
      type: "mfa_required",
      ticketId: "ticket-second-factor",
      expiresAt: "2026-06-03T00:05:00.000Z",
      methods: ["totp"],
    });
    expect(mocks.createMfaAuthTicket).toHaveBeenCalledWith(expect.anything(), "usr_mfa", ["totp"], undefined);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Cloudflare account security session renewal", () => {
  beforeEach(() => {
    mocks.enabledAdminCount.mockReset().mockResolvedValue(2);
    mocks.ensureSettings.mockReset().mockResolvedValue(undefined);
    mocks.findUserByEmail.mockReset();
    mocks.findUserById.mockReset();
    mocks.hashPassword.mockReset().mockResolvedValue("hashed-new-password");
    mocks.nowIso.mockReset().mockReturnValue("2026-06-03T00:00:00.000Z");
    mocks.sha256.mockReset().mockResolvedValue("token-hash");
    mocks.verifyPassword.mockReset().mockResolvedValue(true);
  });

  it("returns a renewed session together with one-time recovery codes after enabling TOTP", async () => {
    const response = await mfaTotpEnable(jsonRequest("/api/app/auth/mfa/totp/enable", "POST", {
      setupId: "setup-token",
      code: "123456",
      currentPassword: "password123",
    }, authHeaders()), envFixture(vi.fn()));

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({
      type: "session",
      session: { expiresAt: "2026-07-03T00:00:00.000Z" },
      recoveryCodes: ["ABCD-EFGH-IJKL"],
    });
    expect(mocks.enableTotp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "usr_admin" }), "setup-token", "123456");
  });

  it("returns a renewed session after regenerating recovery codes", async () => {
    mocks.authenticatorMfaMethodsForUser.mockResolvedValueOnce(["totp"]);

    const response = await mfaRecoveryRegenerate(jsonRequest("/api/app/auth/mfa/recovery/regenerate", "POST", {
      currentPassword: "password123",
    }, authHeaders()), envFixture(vi.fn()));

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({
      type: "session",
      session: { expiresAt: "2026-07-03T00:00:00.000Z" },
      recoveryCodes: ["MNOP-QRST-UVWX"],
    });
    expect(mocks.regenerateRecoveryCodes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "usr_admin" }));
  });

  it("returns renewed sessions for self-service passkey and authenticator mutations", async () => {
    const env = envFixture(vi.fn());

    const registerResponse = await passkeyRegisterVerify(jsonRequest("/api/app/auth/passkeys/register/verify", "POST", {
      challengeId: "challenge-1",
      name: "MacBook Touch ID",
      response: passkeyRegistrationResponse(),
    }, authHeaders()), env);
    const deleteResponse = await passkeyDelete(jsonRequest("/api/app/auth/passkeys/pkey_1/delete", "POST", {
      currentPassword: "password123",
    }, authHeaders()), env, "pkey_1");
    const disableResponse = await mfaDisable(jsonRequest("/api/app/auth/mfa/disable", "POST", {
      currentPassword: "password123",
    }, authHeaders()), env);

    await expect(readSuccessData(registerResponse)).resolves.toMatchObject({ session: { expiresAt: "2026-07-03T00:00:00.000Z" } });
    await expect(readSuccessData(deleteResponse)).resolves.toMatchObject({ session: { expiresAt: "2026-07-03T00:00:00.000Z" } });
    await expect(readSuccessData(disableResponse)).resolves.toMatchObject({ session: { expiresAt: "2026-07-03T00:00:00.000Z" } });
    expect(mocks.finishPasskeyRegistration).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ id: "usr_admin" }), "challenge-1", "MacBook Touch ID", expect.anything());
    expect(mocks.deletePasskeyForCurrentUser).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "usr_admin" }), "pkey_1");
    expect(mocks.disableAuthenticatorMfaForCurrentUser).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "usr_admin" }));
  });
});

describe("Cloudflare cookie session boundary", () => {
  beforeEach(() => {
    mocks.enabledAdminCount.mockReset().mockResolvedValue(2);
    mocks.ensureSettings.mockReset().mockResolvedValue(undefined);
    mocks.findUserByEmail.mockReset();
    mocks.findUserById.mockReset();
    mocks.hashPassword.mockReset().mockResolvedValue("hashed-new-password");
    mocks.nowIso.mockReset().mockReturnValue("2026-06-03T00:00:00.000Z");
    mocks.sha256.mockReset().mockResolvedValue("token-hash");
    mocks.verifyPassword.mockReset().mockResolvedValue(true);
  });

  it("does not accept Authorization bearer as a browser session", async () => {
    await expect(requireAuth(new Request("https://renewlet.example/api/app/settings", {
      headers: { authorization: "Bearer session-token" },
    }), envFixture(vi.fn()))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("requires CSRF header for unsafe cookie-authenticated requests", async () => {
    await expect(requireAuth(new Request("https://renewlet.example/api/app/settings", {
      method: "PUT",
      headers: { cookie: "renewlet_session=session-token; renewlet_csrf=csrf-token" },
      body: "{}",
    }), envFixture(vi.fn()))).rejects.toMatchObject({
      status: 403,
      code: "CSRF_TOKEN_INVALID",
    });
  });
});

describe("Cloudflare passkey authenticate options boundary", () => {
  beforeEach(() => {
    mocks.startPasskeyAuthentication.mockReset().mockResolvedValue({
      challengeId: "challenge-1",
      expiresAt: "2026-06-03T00:05:00.000Z",
      options: passkeyAuthenticationOptions(),
    });
  });

  it("creates an unauthenticated passkey challenge without requiring a session", async () => {
    const response = await passkeyAuthenticateOptions(
      jsonRequest("/api/app/auth/passkeys/authenticate/options", "POST", {}),
      envFixture(vi.fn()),
    );

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toEqual({
      challengeId: "challenge-1",
      expiresAt: "2026-06-03T00:05:00.000Z",
      options: passkeyAuthenticationOptions(),
    });
    expect(mocks.startPasskeyAuthentication).toHaveBeenCalledTimes(1);
  });

  it("reports challenge initialization failures as bad requests instead of session expiry", async () => {
    mocks.startPasskeyAuthentication.mockRejectedValueOnce(new Error("account security key unavailable"));

    await expect(passkeyAuthenticateOptions(
      jsonRequest("/api/app/auth/passkeys/authenticate/options", "POST", {}),
      envFixture(vi.fn()),
    )).rejects.toMatchObject({
      status: 400,
      message: "Invalid request parameters",
    });
  });
});

describe("Cloudflare account security infrastructure errors", () => {
  it("does not report MFA storage initialization failures as session expiry", async () => {
    mocks.verifyMfaLogin.mockRejectedValueOnce(new AccountSecuritySchemaError(new Error("D1_ERROR: permission denied")));

    await expect(mfaVerify(jsonRequest("/api/app/auth/mfa/verify", "POST", {
      method: "totp",
      ticketId: "ticket-1",
      code: "123456",
    }), envFixture(vi.fn()))).rejects.toMatchObject({
      name: "AccountSecuritySchemaError",
      message: "D1_ERROR: permission denied",
    });
  });

  it("does not report passkey storage initialization failures as session expiry", async () => {
    mocks.finishPasskeyAuthentication.mockRejectedValueOnce(new AccountSecuritySchemaError(new Error("D1_ERROR: permission denied")));

    await expect(passkeyAuthenticateVerify(jsonRequest("/api/app/auth/passkeys/authenticate/verify", "POST", {
      challengeId: "challenge-1",
      response: passkeyAuthenticationResponse(),
    }), envFixture(vi.fn()))).rejects.toMatchObject({
      name: "AccountSecuritySchemaError",
      message: "D1_ERROR: permission denied",
    });
  });
});

describe("Cloudflare admin MFA reset boundary", () => {
  beforeEach(() => {
    mocks.enabledAdminCount.mockReset().mockResolvedValue(2);
    mocks.ensureSettings.mockReset().mockResolvedValue(undefined);
    mocks.findUserByEmail.mockReset();
    mocks.findUserById.mockReset();
    mocks.hashPassword.mockReset().mockResolvedValue("hashed-new-password");
    mocks.nowIso.mockReset().mockReturnValue("2026-06-03T00:00:00.000Z");
    mocks.sha256.mockReset().mockResolvedValue("token-hash");
    mocks.verifyPassword.mockReset().mockResolvedValue(true);
  });

  it("rejects resetting the current administrator MFA state", async () => {
    mocks.findUserById.mockResolvedValue(userRow({ id: "usr_admin", role: "admin" }));

    await expect(adminResetUserMfa(adminRequest(), envFixture(vi.fn()), "usr_admin")).rejects.toMatchObject({
      status: 400,
    });

    expect(mocks.disableAuthenticatorMfaForUser).not.toHaveBeenCalled();
  });

  it("resets another user MFA state through the centralized cleanup helper", async () => {
    mocks.findUserById.mockResolvedValue(userRow({ id: "usr_user", role: "user" }));

    const response = await adminResetUserMfa(adminRequest(), envFixture(vi.fn()), "usr_user");

    expect(response.status).toBe(200);
    expect(mocks.disableAuthenticatorMfaForUser).toHaveBeenCalledWith(expect.anything(), "usr_user");
  });

  it("resets another user's passkeys through the passkey cleanup helper", async () => {
    mocks.findUserById.mockResolvedValue(userRow({ id: "usr_user", role: "user" }));

    const response = await adminResetUserPasskeys(adminRequest(), envFixture(vi.fn()), "usr_user");

    expect(response.status).toBe(200);
    expect(mocks.deletePasskeysForUser).toHaveBeenCalledWith(expect.anything(), "usr_user");
  });
});

describe("Cloudflare app status", () => {
  beforeEach(() => {
    mocks.enabledAdminCount.mockReset().mockResolvedValue(0);
    mocks.ensureSettings.mockReset().mockResolvedValue(undefined);
    mocks.findUserByEmail.mockReset();
    mocks.findUserById.mockReset();
    mocks.hashPassword.mockReset().mockResolvedValue("hashed-new-password");
    mocks.nowIso.mockReset().mockReturnValue("2026-06-03T00:00:00.000Z");
    mocks.sha256.mockReset().mockResolvedValue("token-hash");
    mocks.verifyPassword.mockReset().mockResolvedValue(true);
  });

  it("returns setup capability with demo mode fixed off", async () => {
    const response = await appStatus(new Request("https://renewlet.example/api/app/status"), envFixture(vi.fn()));

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toEqual({
      setupRequired: true,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: false, siteKey: "" },
    });
  });

  it("returns a stable unavailable error when a status dependency fails", async () => {
    const env = envFixture(vi.fn());
    env.DB.prepare = vi.fn(() => {
      throw new Error("users table unavailable");
    }) as unknown as D1Database["prepare"];

    const response = await appStatus(new Request("https://renewlet.example/api/app/status"), env)
      .catch((error: unknown) => toResponse(error));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "APP_STATUS_UNAVAILABLE",
        requestId: expect.any(String),
      },
    });
  });
});

function jsonRequest(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://renewlet.example${path}`, {
    method,
    headers: {
      "accept-language": "en-US",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function requestFixture(body: unknown): Request {
  return new Request("https://renewlet.example/api/app/admin/users/usr_user", {
    method: "PATCH",
    headers: {
      "accept-language": "en-US",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
}

function adminRequest(): Request {
  return new Request("https://renewlet.example/api/app/admin/users/usr_user/mfa/reset", {
    method: "POST",
    headers: {
      "accept-language": "en-US",
      ...authHeaders(),
    },
  });
}

function authHeaders(): Record<string, string> {
  return {
    "cookie": "renewlet_session=session-token; renewlet_csrf=csrf-token",
    "x-renewlet-csrf": "csrf-token",
  };
}

function envFixture(updateRun: ReturnType<typeof vi.fn>, authSecurity?: AuthSecuritySettingsRow | null): Env {
  const sessionTouchRun = vi.fn().mockResolvedValue({});
  return {
    DB: {
      batch: vi.fn(async (statements: Array<{ run?: () => Promise<unknown> }>) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run?.());
        return results;
      }),
      prepare: vi.fn((sql: string) => ({
        first: vi.fn().mockResolvedValue(sql.includes("SELECT id FROM users") ? null : undefined),
        bind: vi.fn(() => {
          if (sql.includes("FROM sessions JOIN users")) {
            return { first: vi.fn().mockResolvedValue(authRow()) };
          }
          if (sql.includes("SUM(CASE WHEN auto_renew")) {
            return { first: vi.fn().mockResolvedValue({ auto_renew_count: 0, repeat_reminder_count: 0 }) };
          }
          if (sql.includes("FROM subscription_scheduler_state")) {
            return { first: vi.fn().mockResolvedValue(null) };
          }
          if (sql.includes("SELECT settings_json FROM settings")) {
            return { first: vi.fn().mockResolvedValue(null) };
          }
          if (sql.includes("FROM auth_security_settings")) {
            return { first: vi.fn().mockResolvedValue(authSecurity ?? null) };
          }
          if (sql.includes("UPDATE sessions SET last_seen_at")) {
            return { run: sessionTouchRun };
          }
          return { run: updateRun };
        }),
      })),
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
}

function setupEnvFixture(batchChanges: number[][]): {
  env: Env;
  batches: string[][];
  boundValues: unknown[][][];
} {
  const batches: string[][] = [];
  const boundValues: unknown[][][] = [];
  let batchIndex = 0;
  const env = {
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({ sql, values })),
      })),
      batch: vi.fn(async (statements: Array<{ sql: string; values: unknown[] }>) => {
        const index = batchIndex++;
        batches.push(statements.map((statement) => statement.sql));
        boundValues.push(statements.map((statement) => statement.values));
        return (batchChanges[index] ?? []).map((changes) => ({ meta: { changes } }));
      }),
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
  return { env, batches, boundValues };
}

function authSecurityRow(overrides: Partial<AuthSecuritySettingsRow> = {}): AuthSecuritySettingsRow {
  return {
    key: "global",
    turnstile_enabled: 1,
    turnstile_site_key: "site-key",
    turnstile_secret: "secret-value",
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

function authRow(): UserRow & {
  session_id: string;
  session_token_hash: string;
  session_user_id: string;
  session_expires_at: string;
  session_created_at: string;
  session_last_seen_at: string;
  session_csrf_token_hash: string;
} {
  return {
    ...userRow({ id: "usr_admin", email: "admin@example.com", name: "Admin", role: "admin" }),
    session_id: "session-current",
    session_token_hash: "token-hash",
    session_user_id: "usr_admin",
    session_expires_at: "2026-07-03T00:00:00.000Z",
    session_created_at: "2026-06-03T00:00:00.000Z",
    session_last_seen_at: "2026-06-03T00:00:00.000Z",
    session_csrf_token_hash: "token-hash",
  };
}

function renewedSession(token: string) {
  return {
    response: {
      type: "session" as const,
      session: { expiresAt: "2026-07-03T00:00:00.000Z" },
      user: { id: "usr_admin", email: "admin@example.com", name: "Admin", role: "admin", banned: false },
    },
    sessionToken: token,
    csrfToken: "csrf-token",
    expiresAt: "2026-07-03T00:00:00.000Z",
  };
}

function passkeyAuthenticationOptions() {
  return {
    challenge: "challenge-value",
    timeout: 60_000,
    rpId: "renewlet.example",
    allowCredentials: [],
    userVerification: "required" as const,
    hints: [],
  };
}

function passkeyRegistrationResponse() {
  return {
    id: "credential-id",
    rawId: "credential-id",
    response: {
      clientDataJSON: "client-data",
      attestationObject: "attestation-object",
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

function passkeyAuthenticationResponse() {
  return {
    id: "credential-1",
    rawId: "credential-1",
    response: {
      clientDataJSON: "client-data",
      authenticatorData: "authenticator-data",
      signature: "signature",
      userHandle: "user-handle",
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

function userRow(overrides: Partial<UserRow>): UserRow {
  return {
    id: "usr_user",
    email: "user@example.com",
    name: "User",
    role: "user",
    banned: 0,
    ban_reason: "",
    password_hash: "old-hash",
    reset_token_hash: null,
    reset_token_expires_at: null,
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}
