import { defineConfig } from "@lingui/conf";
import { FALLBACK_LOCALE, SOURCE_LOCALE, SUPPORTED_LOCALES } from "@renewlet/shared/i18n-config";

// catalog domain 是人工维护的 i18n 边界；同一 domain 可汇总多个 descriptor，检查器和生成脚本据此校验 PO 与类型化生成物。
const catalogDomains = [
  "common",
  "legal",
  "custom-config",
  "subscription",
  "auth",
  "settings",
  "settings-access-security",
  "public-status",
  "notification",
  "labels",
  "admin",
  "error",
] as const;

export default defineConfig({
  locales: [...SUPPORTED_LOCALES],
  sourceLocale: SOURCE_LOCALE,
  fallbackLocales: { default: FALLBACK_LOCALE },
  catalogs: catalogDomains.map((domain) => ({
    path: `src/i18n/catalogs/{locale}/${domain}`,
    include: domain === "settings"
      ? ["src/i18n/descriptors/settings.ts", "src/i18n/descriptors/settings-display.ts"]
      : [`src/i18n/descriptors/${domain}.ts`],
  })),
});
