import type { Env } from "./types";
import { arrayBufferFromBytes, base64Url, base64UrlToArrayBuffer } from "./encoding";

const ACCOUNT_SECURITY_KEY_OBJECT = "system/account-security/key.v1.json";
const ACCOUNT_SECURITY_KEY_VERSION = 1;
const ACCOUNT_SECURITY_KEY_BYTES = 32;
const ACCOUNT_SECURITY_KEY_SALT = "renewlet:account-security:v1";

export interface AccountSecurityKeyRing {
  oidc: () => Promise<CryptoKey>;
  totpSeed: CryptoKey;
  recoveryCode: CryptoKey;
  mfaTicket: CryptoKey;
  passkeyChallenge: CryptoKey;
}

interface AccountSecurityKeyFile {
  version: number;
  key: string;
}

let accountSecurityKeyRingPromise: Promise<AccountSecurityKeyRing> | null = null;

export async function accountSecurityKeyRing(env: Env): Promise<AccountSecurityKeyRing> {
  if (!accountSecurityKeyRingPromise) {
    // 这里缓存的是安装级常量 key ring，不是请求/用户/session 状态；避免每次 OTP/Passkey 热路径都读 R2。
    accountSecurityKeyRingPromise = loadAccountSecurityKeyRing(env).catch((error: unknown) => {
      accountSecurityKeyRingPromise = null;
      throw error;
    });
  }
  return accountSecurityKeyRingPromise;
}

async function loadAccountSecurityKeyRing(env: Env): Promise<AccountSecurityKeyRing> {
  const master = await readOrCreateAccountSecurityMasterKey(env);
  const hkdfKey = await crypto.subtle.importKey("raw", arrayBufferFromBytes(master), "HKDF", false, ["deriveBits"]);
  // 同一个 cold-start 里只导入一次 HKDF master，四个用途靠 info 分域；Promise 缓存后热路径不再读 R2 或重复派生。
  const [totpSeedBytes, recoveryCodeBytes, mfaTicketBytes, passkeyChallengeBytes] = await Promise.all([
    deriveKeyBytes(hkdfKey, "totp-seed-aes-gcm"),
    deriveKeyBytes(hkdfKey, "recovery-code-hmac"),
    deriveKeyBytes(hkdfKey, "mfa-ticket-hmac"),
    deriveKeyBytes(hkdfKey, "passkey-challenge-hmac"),
  ]);
  // 单点登录密钥只在触发 OIDC 时派生，减少普通认证冷启动开销。
  let oidc: Promise<CryptoKey> | undefined;
  return {
    oidc: () => oidc ??= deriveKeyBytes(hkdfKey, "oidc-aes-gcm").then(importAesGcmKey),
    totpSeed: await importAesGcmKey(totpSeedBytes),
    recoveryCode: await importHmacKey(recoveryCodeBytes),
    mfaTicket: await importHmacKey(mfaTicketBytes),
    passkeyChallenge: await importHmacKey(passkeyChallengeBytes),
  };
}

async function readOrCreateAccountSecurityMasterKey(env: Env): Promise<Uint8Array> {
  const existing = await readAccountSecurityMasterKey(env);
  if (existing) return existing;
  const generated = crypto.getRandomValues(new Uint8Array(ACCOUNT_SECURITY_KEY_BYTES));
  const stored: AccountSecurityKeyFile = {
    version: ACCOUNT_SECURITY_KEY_VERSION,
    key: base64Url(generated),
  };
  // R2 条件写处理多个冷 isolate 同时首次启用账号安全；竞争失败后读取胜出的同一个安装级 key。
  const created = await env.ASSETS_BUCKET.put(ACCOUNT_SECURITY_KEY_OBJECT, `${JSON.stringify(stored)}\n`, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (created) return generated;
  const raced = await readAccountSecurityMasterKey(env);
  if (raced) return raced;
  throw new Error("account security key is unavailable");
}

async function readAccountSecurityMasterKey(env: Env): Promise<Uint8Array | null> {
  const object = await env.ASSETS_BUCKET.get(ACCOUNT_SECURITY_KEY_OBJECT);
  if (!object) return null;
  const raw = textDecoder.decode(await object.arrayBuffer());
  const parsed = JSON.parse(raw) as Partial<AccountSecurityKeyFile>;
  // R2 系统对象一旦损坏必须 fail closed；自动重建会让既有 TOTP/恢复码/Passkey challenge 全部不可验证。
  if (parsed.version !== ACCOUNT_SECURITY_KEY_VERSION || typeof parsed.key !== "string") {
    throw new Error("invalid account security key");
  }
  const key = base64UrlToArrayBuffer(parsed.key);
  if (key.byteLength !== ACCOUNT_SECURITY_KEY_BYTES) {
    throw new Error("invalid account security key");
  }
  return new Uint8Array(key);
}

async function importAesGcmKey(keyBytes: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function importHmacKey(keyBytes: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function deriveKeyBytes(key: CryptoKey, info: string): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: textEncoder.encode(ACCOUNT_SECURITY_KEY_SALT),
    info: textEncoder.encode(info),
  }, key, ACCOUNT_SECURITY_KEY_BYTES * 8);
}

export function resetAccountSecurityKeyRingForTest(): void {
  accountSecurityKeyRingPromise = null;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
