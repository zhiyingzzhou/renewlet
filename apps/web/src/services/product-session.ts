import { sessionPayloadSchema, type SessionResponse } from "@renewlet/shared/schemas/auth";
import {
  ACCOUNT_LOCALE_PROJECTION_KEY,
  clearAccountLocaleProjection,
} from "@/i18n/account-locale-projection";

/**
 * 产品 session 是浏览器唯一持久登录态；MFA ticket、Passkey challenge 和恢复码明文都不能进入这里。
 * storage 事件只同步已签发 session，避免认证前流程跨 tab 影响当前登录态。
 */
const STORAGE_KEY = "renewlet_app_session";
const CHANGE_EVENT = "renewlet:app-session-change";
const STORAGE_VERSION = 1;
const CSRF_COOKIE_NAME = "renewlet_csrf";
const CSRF_HEADER_NAME = "X-Renewlet-CSRF";

export type ProductSessionData = SessionResponse;

/** 产品 session 是 Docker/Cloudflare 的统一前端缓存；真实认证仍以服务端 token hash 为准。 */
export interface ProductSessionRecord {
  value: ProductSessionData;
  verifiedAt: number;
}

export interface ProductSessionSnapshot {
  userId: string;
  expiresAt: string;
  verifiedAt: number;
}

function parseSessionRecord(value: string | null): ProductSessionRecord | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record["version"] !== STORAGE_VERSION) return null;
    const verifiedAt = record["verifiedAt"];
    if (typeof verifiedAt !== "number" || !Number.isFinite(verifiedAt) || verifiedAt <= 0) return null;
    const parsed = sessionPayloadSchema.safeParse(record["value"]);
    return parsed.success ? { value: parsed.data, verifiedAt } : null;
  } catch {
    return null;
  }
}

export function readProductSessionRecord(): ProductSessionRecord | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const record = parseSessionRecord(localStorage.getItem(STORAGE_KEY));
    if (record) return record;
    localStorage.removeItem(STORAGE_KEY);
    clearAccountLocaleProjection();
    return null;
  } catch {
    return null;
  }
}

export function readProductSession(): ProductSessionData | null {
  return readProductSessionRecord()?.value ?? null;
}

export function isProductSessionFresh(record: ProductSessionRecord | null, maxAgeMs: number): boolean {
  return Boolean(record && Date.now() - record.verifiedAt < maxAgeMs);
}

export function writeProductSession(
  session: ProductSessionData | null,
  options: { verifiedAt?: number } = {},
) {
  if (typeof localStorage === "undefined") return;
  try {
    const previousUserId = parseSessionRecord(localStorage.getItem(STORAGE_KEY))?.value.user.id ?? null;
    const nextUserId = session?.user.id ?? null;
    if (!nextUserId || (previousUserId && previousUserId !== nextUserId)) {
      // 账号语言投影的生命周期从属于产品 session；退出或换号必须先释放，登录页和下一账号才能回到设备语言。
      clearAccountLocaleProjection();
    }
    if (session) {
      // 这里只有完成 MFA 后的产品 session 会持久化；mfa_required ticket 不允许进入 localStorage。
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: STORAGE_VERSION,
        value: session,
        verifiedAt: options.verifiedAt ?? Date.now(),
      }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeProductSession(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === ACCOUNT_LOCALE_PROJECTION_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function getProductCurrentUserId(): string | null {
  return readProductSession()?.user.id ?? null;
}

export function readProductSessionSnapshot(): ProductSessionSnapshot | null {
  const record = readProductSessionRecord();
  if (!record) return null;
  return {
    userId: record.value.user.id,
    expiresAt: record.value.session.expiresAt,
    verifiedAt: record.verifiedAt,
  };
}

export function isSameProductSession(snapshot: ProductSessionSnapshot | null, current: ProductSessionSnapshot | null): boolean {
  return current?.userId === snapshot?.userId && current?.expiresAt === snapshot?.expiresAt;
}

export function clearProductSessionForSnapshot(snapshot: ProductSessionSnapshot | null): void {
  if (!snapshot) return;
  const current = readProductSessionSnapshot();
  if (!current) return;
  // 401 清理只消费请求发出时的非密快照，避免旧请求把刚登录/续签的新 session 清掉。
  if (
    current.userId !== snapshot.userId ||
    current.expiresAt !== snapshot.expiresAt ||
    current.verifiedAt !== snapshot.verifiedAt
  ) {
    return;
  }
  writeProductSession(null);
}

export function getProductCsrfHeader(): Record<string, string> {
  const token = readCookie(CSRF_COOKIE_NAME);
  return token ? { [CSRF_HEADER_NAME]: token } : {};
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName !== name) continue;
    const value = rest.join("=");
    if (!value) return "";
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
