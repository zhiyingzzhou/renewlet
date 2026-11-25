/**
 * 登录后跳转路径清洗。
 *
 * 目标：
 * - 只允许站内相对路径，拒绝绝对 URL、协议相对 URL、控制字符和 /login 自循环。
 * - 被 proxy、AuthSync、登录页共同复用，避免开放重定向逻辑分叉。
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** 清洗登录后跳转路径，防止开放重定向和登录页自循环。 */
export function sanitizeNextPath(value: string | null | undefined, fallback = "/"): string {
  if (!value) return fallback;
  if (hasControlChars(value)) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  try {
    // 用固定 origin 解析相对路径，能统一处理 search/hash，同时检测是否逃逸本站。
    const parsed = new URL(value, "http://localhost");
    if (parsed.origin !== "http://localhost") return fallback;
    if (parsed.pathname === "/login") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function takeOidcReturn() {
  const url = new URL(window.location.href);
  const state = url.searchParams.get("oidc");
  if (state) {
    url.searchParams.delete("oidc");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }
  return state;
}
