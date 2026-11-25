import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { TransactionalD1Database } from "./subscription-d1-test-support";
import { callback, finish, loginOptions, unlink } from "./oidc";
import { saveSite, readSite, storeFlow, flowCookie, callbackPath } from "./oidc-store";
import { hashPassword, sha256 } from "./crypto";
import { base64Url } from "./encoding";
import { resetAccountSecurityKeyRingForTest } from "./account-security-key";
import type { Env } from "./types";

describe("OIDC on D1", () => {
  it("preserves the existing user, consumes login once and enforces local MFA", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        readFileSync(
          new URL("../../../scripts/fixtures/cloudflare-upgrades/v0.3.37.sql", import.meta.url),
          "utf8",
        ),
      );
      db.exec(readFileSync(new URL("../migrations/0048_oidc.sql", import.meta.url), "utf8"));
      resetAccountSecurityKeyRingForTest();
      const bucket = {
        get: async () =>
          new Response(JSON.stringify({ version: 1, key: base64Url(new Uint8Array(32).fill(5)) })),
      };
      const env: Env = {
        DB: new TransactionalD1Database(db) as unknown as D1Database,
        ASSETS: {} as Fetcher,
        ASSETS_BUCKET: bucket as unknown as R2Bucket,
      };
      const config = {
        issuer: "https://issuer.example/application/o/test/",
        clientId: "client",
        secret: "secret-fixture",
        callback: "https://renewlet.example" + callbackPath,
      };
      await saveSite(env, config, "", true);
      expect(
        db.prepare("SELECT oidc_config FROM auth_security_settings WHERE key='global'").get()?.[
          "oidc_config"
        ],
      ).not.toContain(config.secret);
      const options = (await (await loginOptions(env)).json()) as { data: { oidc: boolean } };
      expect(options.data.oidc).toBe(true);
      expect(JSON.stringify(options)).not.toContain(config.issuer);
      const { revision } = await readSite(env);
      const now = new Date().toISOString();
      const expiry = new Date(Date.now() + 3_600_000).toISOString();
      const csrf = "fixture-csrf";
      const session = "fixture-session";
      const sessionHash = await sha256(session);
      db.prepare(
        "INSERT INTO sessions(id,token_hash,csrf_token_hash,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
      ).run("seed-session", sessionHash, await sha256(csrf), "usr_fixture", expiry, now, now);
      await expect(saveSite(env, config, revision, false, "revoked-admin-session")).rejects.toMatchObject({
        code: "OIDC_CHANGED",
      });
      const flowBase = {
        config,
        revision,
        session: sessionHash,
        next: "/",
        state: "",
        nonce: "",
        verifier: "",
        subject: "linked-sub",
      };
      const requestCookie = (token: string, sessionToken: string = session) =>
        "renewlet_session=" + sessionToken + "; " + flowCookie(token).split(";")[0];
      const linkFlow = await storeFlow(env, { ...flowBase, purpose: "link" });
      const linkReq = new Request("https://renewlet.example/api/app/auth/oidc/link/confirm", {
        method: "POST",
        headers: { cookie: requestCookie(linkFlow), "x-renewlet-csrf": csrf },
      });
      const grant = async (subject: string) => {
        const token = await storeFlow(env, {
          purpose: "login",
          config,
          revision,
          session: await sha256(""),
          next: "/",
          state: "",
          nonce: "",
          verifier: "",
          subject,
        });
        return new Request("https://renewlet.example/api/app/auth/oidc/finish", {
          method: "POST",
          headers: { cookie: flowCookie(token).split(";")[0] ?? "" },
        });
      };
      await expect(finish(await grant("fixture@example.com"), env, "login")).rejects.toMatchObject({
        code: "OIDC_UNLINKED",
      });
      const linked = await finish(linkReq, env, "link");
      expect(db.prepare("SELECT id FROM sessions WHERE id='seed-session'").get()).toBeUndefined();
      const sessionCookies = linked.headers
        .getSetCookie()
        .map((v) => v.split(";")[0]!)
        .join("; ");
      const csrfCookie = linked.headers
        .getSetCookie()
        .find((v) => v.startsWith("renewlet_csrf="))!
        .split(";")[0]!
        .slice("renewlet_csrf=".length);
      const cancelFlow = await storeFlow(env, {
        ...flowBase,
        purpose: "login",
        next: "/calendar",
        session: await sha256(""),
        subject: "",
        state: "one-time-state",
      });
      const returnRequest = new Request(config.callback + "?error=access_denied&state=one-time-state", {
        headers: { cookie: flowCookie(cancelFlow).split(";")[0] ?? "" },
      });
      const cancelled = await callback(returnRequest, env);
      expect(cancelled.headers.get("location")).toBe("/login?oidc=cancelled&next=%2Fcalendar");
      expect((await callback(returnRequest, env)).headers.get("location")).toBe("/login?oidc=error");
      const request = await grant("linked-sub");
      const login = await finish(request, env, "login");
      expect(login.headers.get("set-cookie")).toContain("renewlet_session=");
      await expect(login.json()).resolves.toMatchObject({
        data: { type: "session", user: { id: "usr_fixture" } },
      });
      await expect(finish(request, env, "login")).rejects.toMatchObject({ code: "OIDC_EXPIRED" });
      db.prepare(
        "INSERT INTO mfa_totp_credentials(user_id,secret_ciphertext,created_at,updated_at) VALUES(?,?,?,?)",
      ).run("usr_fixture", "test", new Date().toISOString(), new Date().toISOString());
      const mfa = await finish(await grant("linked-sub"), env, "login");
      expect(mfa.headers.get("set-cookie")).not.toContain("renewlet_session=");
      await expect(mfa.json()).resolves.toMatchObject({ data: { type: "mfa_required", methods: ["totp"] } });
      const stale = await grant("linked-sub");
      await saveSite(env, config, revision, false);
      await expect(finish(stale, env, "login")).rejects.toMatchObject({ code: "OIDC_CHANGED" });
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
        await hashPassword("test-password"),
        "usr_fixture",
      );
      const unlinkRequest = (currentPassword: string) =>
        new Request("https://renewlet.example/api/app/auth/oidc/unlink", {
          method: "POST",
          headers: {
            cookie: sessionCookies,
            "x-renewlet-csrf": csrfCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ currentPassword }),
        });
      await expect(unlink(unlinkRequest("wrong"), env)).rejects.toMatchObject({ code: "OIDC_PASSWORD" });
      await unlink(unlinkRequest("test-password"), env);
      expect(db.prepare("SELECT user_id FROM oidc_links").get()).toBeUndefined();
      expect(db.prepare("SELECT user_id FROM mfa_auth_tickets").get()).toBeUndefined();
    } finally {
      db.close();
      resetAccountSecurityKeyRingForTest();
    }
  });
});
