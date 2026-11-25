import * as oauth from "oauth4webapi";
import { assertSafeOutboundUrl } from "./outbound-url-policy";
import { fetchUpstream } from "./upstream-http";
import { readUpstreamResponseTextUpToLimit } from "./upstream-response";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  secret: string;
  callback: string;
}
export interface OidcFlow {
  purpose: "login" | "link" | "test";
  config: OidcConfig;
  revision: string;
  session: string;
  next: string;
  state: string;
  nonce: string;
  verifier: string;
  subject: string;
}

const transport = async (
  url: string,
  init: oauth.CustomFetchOptions<"GET", undefined> | oauth.CustomFetchOptions<"POST", URLSearchParams>,
) => {
  await assertSafeOutboundUrl(url, "en-US");
  // SDK 的超时覆盖响应体读取，慢速 JWKS 或令牌响应也会中止。
  const deadline = AbortSignal.timeout(8000);
  const response = await fetchUpstream(url, {
    method: init.method,
    headers: init.headers,
    body: init.body ?? null,
    signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
    redirect: "error",
  });
  const body = await readUpstreamResponseTextUpToLimit(response, "OIDC", 256 * 1024);
  return new Response(body, { status: response.status, headers: response.headers });
};
const options = { [oauth.customFetch]: transport };
let discovery: { issuer: string; until: number; server: oauth.AuthorizationServer } | undefined;

async function discover(issuer: string) {
  const url = new URL(issuer);
  if (url.search || url.hash || url.username || url.password || url.protocol !== "https:")
    throw new Error("invalid issuer");
  if (discovery?.issuer === issuer && discovery.until > Date.now()) return discovery.server;
  const server = await oauth.processDiscoveryResponse(url, await oauth.discoveryRequest(url, options));
  if (
    server.issuer !== issuer ||
    !server.authorization_endpoint ||
    !server.token_endpoint ||
    !server.jwks_uri
  ) {
    throw new Error("incomplete discovery");
  }
  await assertSafeOutboundUrl(server.authorization_endpoint, "en-US");
  // Workers 的外发 I/O 归属当前请求，跨请求只共享已完成的元数据和库维护的公钥缓存。
  discovery = { issuer, until: Date.now() + 300_000, server };
  return server;
}

export async function authorization(f: OidcFlow): Promise<string> {
  const server = await discover(f.config.issuer);
  const url = new URL(server.authorization_endpoint!);
  const params = {
    client_id: f.config.clientId,
    scope: "openid",
    response_type: "code",
    redirect_uri: f.config.callback,
    state: f.state,
    nonce: f.nonce,
    code_challenge_method: "S256",
    code_challenge: await oauth.calculatePKCECodeChallenge(f.verifier),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}
export async function verifiedSubject(f: OidcFlow, query: URLSearchParams): Promise<string> {
  const server = await discover(f.config.issuer);
  const client: oauth.Client = { client_id: f.config.clientId, id_token_signed_response_alg: "RS256" };
  const params = oauth.validateAuthResponse(server, client, query, f.state);
  const auth =
    server.token_endpoint_auth_methods_supported?.includes("client_secret_post") &&
    !server.token_endpoint_auth_methods_supported.includes("client_secret_basic")
      ? oauth.ClientSecretPost
      : oauth.ClientSecretBasic;
  const response = await oauth.authorizationCodeGrantRequest(
    server,
    client,
    auth(f.config.secret),
    params,
    f.config.callback,
    f.verifier,
    options,
  );
  const tokens = await oauth.processAuthorizationCodeResponse(server, client, response, {
    expectedNonce: f.nonce,
    requireIdToken: true,
  });
  // 此库将应用层签名验证与响应解析分开；不能仅凭 HTTPS 响应认领已有账号。
  await oauth.validateApplicationLevelSignature(server, response, options);
  const claims = oauth.getValidatedIdTokenClaims(tokens);
  if (
    !claims?.sub ||
    !/^[\x20-\x7e]{1,255}$/.test(claims.sub) ||
    (claims.azp !== undefined && claims.azp !== client.client_id)
  )
    throw new Error("invalid subject");
  return claims.sub;
}
