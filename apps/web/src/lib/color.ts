/**
 * 颜色工具（用于把配置项的颜色用于 UI 展示）。
 *
 * 背景：
 * - 分类/状态的颜色来自「设置 → 数据配置」：可能是 `hsl(...)`、`#RRGGBB` 等
 * - Tailwind 的 `/xx` 透明度写法只适用于 token/class；这里需要把任意颜色转成“带透明度”的 CSS 颜色
 */

function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 1;
  return Math.min(1, Math.max(0, alpha));
}

function hexToRgba(hex: string, alpha: number): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;

  const raw = m[1];
  if (!raw) return null;
  const expanded =
    raw.length === 3 ? raw.split("").map((c) => `${c}${c}`).join("") : raw;

  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return null;

  return `rgba(${r}, ${g}, ${b}, ${clampAlpha(alpha)})`;
}

function hslToHslWithAlpha(hsl: string, alpha: number): string | null {
  const m = /^hsl\((.*)\)$/i.exec(hsl.trim());
  if (!m) return null;

  const inside = m[1]?.trim();
  if (!inside) return null;

  const [base] = inside.split("/"); // 支持 `hsl(... / a)` 形式
  const baseTrimmed = base?.trim();
  if (!baseTrimmed) return null;

  return `hsl(${baseTrimmed} / ${clampAlpha(alpha)})`;
}

/**
 * 将颜色字符串转为“带透明度”的 CSS 颜色（用于背景/边框）。
 *
 * 支持：
 * - `hsl(...)`
 * - `#RGB` / `#RRGGBB`
 *
 * 不支持时返回 null（调用方自行兜底）。
 */
export function colorWithAlpha(color: string, alpha: number): string | null {
  const trimmed = color.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("#")) return hexToRgba(trimmed, alpha);
  if (/^hsl\(/i.test(trimmed)) return hslToHslWithAlpha(trimmed, alpha);

  return null;
}

/** 分类色来自用户配置，保留色相作为底色，并让小字随主题前景保持可读。 */
export function categoryBadgeStyle(color: string) {
  return {
    backgroundColor: colorWithAlpha(color, 0.1) ?? undefined,
    borderColor: colorWithAlpha(color, 0.2) ?? undefined,
    color: `color-mix(in srgb, ${color} 32%, hsl(var(--foreground)))`,
  };
}
