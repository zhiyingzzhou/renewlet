/**
 * 前端 i18n 类型化生成物。
 *
 * Lingui descriptor/PO 是产品文案事实源；本脚本生成静态 MessageKey union，以及持久化配置需要的
 * 轻量双语内置 label 数据。运行时 catalog 仍只通过当前 locale 的动态聚合入口加载。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import ts from "typescript";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const i18nConfig = JSON.parse(fs.readFileSync(path.join(rootDir, "packages/shared/data/i18n-config.json"), "utf8"));
const catalogDir = path.join(rootDir, "apps/web/src/i18n/catalogs");
const catalogKeysPath = path.join(rootDir, "apps/web/src/i18n/catalog-keys.ts");
const builtInLabelsPath = path.join(rootDir, "apps/web/src/i18n/built-in-labels.ts");
const clientSourceDir = path.join(rootDir, "apps/web/src");
const labelMessagesModule = "@/i18n/label-messages";
const locales = i18nConfig.supportedLocales;
// Must match LABEL_LOCALES in apps/web/src/i18n/locales.ts: persisted custom-config labels stay bilingual,
// other UI locales translate built-in labels through their Lingui catalog at display time.
const PERSISTED_LABEL_LOCALES = ["zh-CN", "en-US"];
const sourceLocale = i18nConfig.sourceLocale;
const domains = [
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
];
const poFormatter = formatter({ origins: false });
const checkOnly = process.argv.includes("--check");

function readCatalog(locale, domain) {
  const filePath = path.join(catalogDir, locale, `${domain}.po`);
  const parsed = poFormatter.parse(fs.readFileSync(filePath, "utf8"), {
    locale,
    sourceLocale,
    filename: filePath,
  });
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([, entry]) => !entry.obsolete)
      .map(([key, entry]) => [key, entry.translation ?? entry.message ?? ""]),
  );
}

function catalogKeysSource() {
  const keys = [...new Set(domains.flatMap((domain) => Object.keys(readCatalog(sourceLocale, domain))))].sort();
  return [
    "// 由 scripts/generate-i18n-artifacts.mjs 生成；MessageKey 是前端静态翻译 helper 的唯一 key union。",
    "export const MESSAGE_KEYS = [",
    ...keys.map((key) => `  ${JSON.stringify(key)},`),
    "] as const;",
    "",
    "export type MessageKey = (typeof MESSAGE_KEYS)[number];",
    "",
  ].join("\n");
}

function sourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(filePath, files);
    } else if (
      /\.tsx?$/.test(entry.name)
      && !/\.(?:test|spec)\.tsx?$/.test(entry.name)
      && !entry.name.endsWith(".d.ts")
      && filePath !== builtInLabelsPath
    ) {
      files.push(filePath);
    }
  }
  return files;
}

function labelsFromCatalogBindings(sourceFile) {
  const named = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== labelMessagesModule
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName?.text ?? binding.name.text) === "labelsFromCatalog") {
          named.add(binding.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { named, namespaces };
}

function isLabelsFromCatalogCall(node, bindings) {
  if (ts.isIdentifier(node.expression)) {
    return bindings.named.has(node.expression.text);
  }
  return ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "labelsFromCatalog"
    && ts.isIdentifier(node.expression.expression)
    && bindings.namespaces.has(node.expression.expression.text);
}

function builtInLabelKeys() {
  const keys = new Set();
  for (const filePath of sourceFiles(clientSourceDir)) {
    const sourceFile = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    // 生成物只追踪生产源码对规范模块的真实依赖，避免同名局部函数或测试 fixture 扩大首包标签集合。
    const bindings = labelsFromCatalogBindings(sourceFile);
    if (bindings.named.size === 0 && bindings.namespaces.size === 0) continue;
    function visit(node) {
      if (ts.isCallExpression(node) && isLabelsFromCatalogCall(node, bindings)) {
        const key = node.arguments[0];
        if (!key || !ts.isStringLiteralLike(key)) {
          throw new Error(`${path.relative(rootDir, filePath)} must call labelsFromCatalog with a static string key.`);
        }
        keys.add(key.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return [...keys].sort();
}

function builtInLabelsSource() {
  const catalogs = Object.fromEntries(locales.map((locale) => [locale, readCatalog(locale, "labels")]));
  const keys = builtInLabelKeys();
  for (const key of keys) {
    for (const locale of locales) {
      if (!catalogs[locale][key]) {
        throw new Error(`labels.po is missing built-in label ${key} for ${locale}.`);
      }
    }
  }
  return [
    "// 由 scripts/generate-i18n-artifacts.mjs 从 Lingui labels.po 生成；不要手工编辑。",
    'import type { LocalizedLabels } from "@/i18n/locales";',
    "",
    "export const BUILT_IN_LABELS = {",
    ...keys.map((key) => {
      const localized = PERSISTED_LABEL_LOCALES.map((locale) => `${JSON.stringify(locale)}: ${JSON.stringify(catalogs[locale][key] ?? "")}`).join(", ");
      return `  ${JSON.stringify(key)}: { ${localized} },`;
    }),
    "} as const satisfies Record<string, LocalizedLabels>;",
    "",
    "export type BuiltInLabelKey = keyof typeof BUILT_IN_LABELS;",
    "",
  ].join("\n");
}

function emit(filePath, source) {
  if (checkOnly) {
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== source) {
      console.error(`${path.relative(rootDir, filePath)} is out of sync. Run \`pnpm --filter @renewlet/client i18n:extract\`.`);
      process.exitCode = 1;
    }
    return;
  }
  fs.writeFileSync(filePath, source);
  console.log(`generated ${path.relative(rootDir, filePath)}.`);
}

emit(catalogKeysPath, catalogKeysSource());
emit(builtInLabelsPath, builtInLabelsSource());
