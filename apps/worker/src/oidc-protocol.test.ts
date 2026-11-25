import { expect, it, vi } from "vitest";
import { authorization, verifiedSubject, type OidcFlow } from "./oidc-protocol";
import { base64Url } from "./encoding";

it("discovers a path issuer, exchanges with PKCE and accepts only its signed ID token", async () => {
  const issuer = "https://1.1.1.1/application/o/fixture/";
  const flow: OidcFlow = {
    purpose: "test",
    config: {
      issuer,
      clientId: "client",
      secret: "fixture-secret",
      callback: "https://renewlet.example/api/app/auth/oidc/callback",
    },
    nonce: "fixture-nonce",
    verifier: "a".repeat(43),
    state: "fixture-state",
    revision: "",
    session: "",
    next: "/",
    subject: "",
  };
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const encoder = new TextEncoder();
  const encode = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));
  let invalidateSignature = false;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url === issuer + ".well-known/openid-configuration")
      return Response.json({
        issuer,
        authorization_endpoint: issuer + "authorize",
        token_endpoint: issuer + "token",
        jwks_uri: issuer + "keys",
      });
    if (url === issuer + "keys")
      return Response.json({ keys: [{ ...jwk, kid: "key", alg: "RS256", use: "sig" }] });
    expect(url).toBe(issuer + "token");
    expect(new URLSearchParams(String(init.body)).get("code_verifier")).toBe(flow.verifier);
    const now = Math.floor(Date.now() / 1000);
    const jwt = [
      encode({ alg: "RS256", kid: "key" }),
      encode({
        iss: issuer,
        aud: flow.config.clientId,
        sub: "external-user",
        nonce: flow.nonce,
        iat: now,
        exp: now + 60,
      }),
    ].join(".");
    const signature = new Uint8Array(
      await crypto.subtle.sign(algorithm.name, keys.privateKey, encoder.encode(jwt)),
    );
    if (invalidateSignature) signature[0] = (signature[0] ?? 0) ^ 1;
    return Response.json({
      id_token: jwt + "." + base64Url(signature),
      access_token: "fixture",
      token_type: "Bearer",
    });
  });
  try {
    const params = new URL(await authorization(flow)).searchParams;
    const challenge = await crypto.subtle.digest("SHA-256", encoder.encode(flow.verifier));
    expect(params.get("code_challenge")).toBe(base64Url(new Uint8Array(challenge)));
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("redirect_uri")).toBe(flow.config.callback);
    const query = new URLSearchParams({ state: flow.state, code: "fixture-code" });
    await expect(verifiedSubject(flow, query)).resolves.toBe("external-user");
    await expect(verifiedSubject({ ...flow, nonce: "changed" }, query)).rejects.toThrow();
    invalidateSignature = true;
    await expect(verifiedSubject(flow, query)).rejects.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});
