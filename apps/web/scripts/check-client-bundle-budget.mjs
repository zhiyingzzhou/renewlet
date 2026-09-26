#!/usr/bin/env node

/**
 * 客户端压缩预算按 manifest 静态闭包计费：入口 + 单个当前语言 + CSS，以及每条路由的完整静态依赖。
 * chunk 名只用于报告；依赖禁入读取 Vite 生成的 module graph，避免自动分包改名绕过守卫。
 */
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(workspaceRoot, "dist");
const manifest = JSON.parse(readFileSync(join(distRoot, ".vite/manifest.json"), "utf8"));
const moduleGraph = JSON.parse(readFileSync(join(distRoot, ".vite/module-graph.json"), "utf8"));
const locales = JSON.parse(readFileSync(resolve(workspaceRoot, "../../packages/shared/data/i18n-config.json"), "utf8")).supportedLocales;
const catalogEntryKey = (locale) => `src/i18n/catalog-loaders/${locale}.ts`;
const privateRouteKeys = new Set([
  "src/pages/dashboard.tsx",
  "src/pages/subscriptions.tsx",
  "src/pages/calendar.tsx",
  "src/pages/statistics.tsx",
  "src/pages/settings.tsx",
  "src/pages/admin/users.tsx",
]);
const budgets = {
  // 相比 510 KB gzip / 431 KB Brotli 基线分别下降 21.6% / 20.2%。
  startup: { gzip: 400000, brotli: 344000 },
  route: { gzip: 400000, brotli: 345000 },
};
const forbiddenStartupModules = [
  ["Recharts", (id) => id.includes("node_modules/recharts/")],
  ["JSZip", (id) => id.includes("node_modules/jszip/")],
  ["sql.js", (id) => id.includes("node_modules/sql.js/")],
  ["完整 settings 模型", (id) => id.endsWith("apps/web/src/types/subscription.ts")],
];
const forbiddenLazyDialogShellModules = [
  ["高级筛选面板", (id) => id.endsWith("apps/web/src/components/subscription-advanced-filter-content.tsx")],
  ["批量公开可见性工具栏", (id) => id.endsWith("apps/web/src/components/subscription-bulk-visibility-toolbar.tsx")],
  ["react-image-crop", (id) => id.includes("node_modules/react-image-crop/")],
  ["qrcode.react", (id) => id.includes("node_modules/qrcode.react/")],
  ["AI 草稿编辑器", (id) => id.endsWith("apps/web/src/components/ai-recognition/ai-draft-editor-panel.tsx")],
  ["ImportPreview", (id) => id.endsWith("apps/web/src/components/import-preview-panel.tsx")],
  ["JSZip", (id) => id.includes("node_modules/jszip/")],
  ["sql.js", (id) => id.includes("node_modules/sql.js/")],
];

const compressedSizeCache = new Map();
function compressedSizes(file) {
  const cached = compressedSizeCache.get(file);
  if (cached) return cached;
  const content = readFileSync(join(distRoot, file));
  const sizes = {
    gzip: gzipSync(content, { level: 9 }).byteLength,
    brotli: brotliCompressSync(content, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
  compressedSizeCache.set(file, sizes);
  return sizes;
}

function collectStaticClosure(key, closure = { keys: new Set(), files: new Set() }) {
  if (closure.keys.has(key)) return closure;
  const entry = manifest[key];
  if (!entry) throw new Error(`Client bundle manifest is missing ${key}`);
  closure.keys.add(key);
  if (typeof entry.file === "string") closure.files.add(entry.file);
  for (const cssFile of entry.css ?? []) closure.files.add(cssFile);
  for (const importedKey of entry.imports ?? []) collectStaticClosure(importedKey, closure);
  return closure;
}

function mergeClosures(...closures) {
  return closures.reduce(
    (merged, closure) => {
      for (const key of closure.keys) merged.keys.add(key);
      for (const file of closure.files) merged.files.add(file);
      return merged;
    },
    { keys: new Set(), files: new Set() },
  );
}

function sumCompressed(files) {
  const total = { gzip: 0, brotli: 0 };
  for (const file of files) {
    const sizes = compressedSizes(file);
    total.gzip += sizes.gzip;
    total.brotli += sizes.brotli;
  }
  return total;
}

function assertBudget(label, actual, budget) {
  const exceeded = ["gzip", "brotli"].filter((format) => actual[format] > budget[format]);
  console.log(`${label}: gzip=${actual.gzip} B, brotli=${actual.brotli} B`);
  if (exceeded.length > 0) {
    throw new Error(
      `${label} exceeds ${exceeded.join("/")} budget `
        + `(limits: gzip=${budget.gzip} B, brotli=${budget.brotli} B)`,
    );
  }
}

function modulesForFiles(files) {
  return [...files].flatMap((file) => moduleGraph[file] ?? []);
}

function assertStartupDependencies(locale, closure) {
  const modules = modulesForFiles(closure.files);
  const forbidden = forbiddenStartupModules.filter(([, matches]) => modules.some(matches));
  if (forbidden.length > 0) {
    throw new Error(`${locale} startup closure includes forbidden modules: ${forbidden.map(([label]) => label).join(", ")}`);
  }
  const otherLocales = locales.filter((candidate) => candidate !== locale);
  const unexpectedCatalogs = modules.filter((id) => otherLocales.some((candidate) => (
    id.includes(`apps/web/src/i18n/catalogs/${candidate}/`)
    || id.endsWith(`apps/web/src/i18n/catalog-loaders/${candidate}.ts`)
  )));
  if (unexpectedCatalogs.length > 0) {
    throw new Error(`${locale} startup closure includes non-current locale catalog: ${unexpectedCatalogs[0]}`);
  }
}

function assertLazyDialogShellDependencies(routeKey, files) {
  const modules = modulesForFiles(files);
  const forbidden = forbiddenLazyDialogShellModules.filter(([, matches]) => modules.some(matches));
  if (forbidden.length > 0) {
    throw new Error(
      `${routeKey} synchronous route shell includes lazy dialog modules: `
        + forbidden.map(([label]) => label).join(", "),
    );
  }
}

const manifestEntries = Object.entries(manifest);
const appEntry = manifestEntries.find(([, entry]) => entry.isEntry && entry.file.endsWith(".js"));
if (!appEntry) throw new Error("Client bundle manifest has no JavaScript application entry");
const appClosure = collectStaticClosure(appEntry[0]);
const privateShellKey = "src/components/private-app-shell.tsx";
if (!manifest[privateShellKey]) throw new Error("Client bundle manifest has no private application shell entry");
const privateShellClosure = collectStaticClosure(privateShellKey);

for (const locale of locales) {
  const localeKey = catalogEntryKey(locale);
  if (!manifest[localeKey]) throw new Error(`Client bundle manifest has no ${locale} catalog entry`);
  const startupClosure = mergeClosures(appClosure, collectStaticClosure(localeKey));
  const startupSizes = sumCompressed(startupClosure.files);
  console.log(`${locale} startup files: ${[...startupClosure.files].sort().join(", ")}`);
  assertStartupDependencies(locale, startupClosure);
  assertBudget(`${locale} startup closure`, startupSizes, budgets.startup);
}

const routeClosures = manifestEntries
  .filter(([key, entry]) => entry.isDynamicEntry && /(?:^|\/)src\/pages\//.test(key))
  .map(([key]) => ({
    key,
    closure: privateRouteKeys.has(key)
      ? mergeClosures(collectStaticClosure(key), privateShellClosure)
      : collectStaticClosure(key),
  }))
  .map(({ key, closure }) => ({ key, files: closure.files, ...sumCompressed(closure.files) }))
  .sort((left, right) => right.gzip - left.gzip || right.brotli - left.brotli);
if (routeClosures.length === 0) throw new Error("Client bundle manifest has no lazy route entries");
for (const route of routeClosures) assertLazyDialogShellDependencies(route.key, route.files);
const largestRoute = routeClosures[0];
console.log(`largest route files (${largestRoute.key}): ${[...largestRoute.files].sort().join(", ")}`);
assertBudget(`largest complete route closure (${largestRoute.key})`, largestRoute, budgets.route);
