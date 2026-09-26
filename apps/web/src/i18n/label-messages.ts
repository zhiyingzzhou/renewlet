import { BUILT_IN_LABELS, type BuiltInLabelKey } from "@/i18n/built-in-labels";
import { LABEL_LOCALES, withDerivedLabels, type LocalizedLabels } from "@/i18n/locales";
import { translate } from "@/i18n/messages";

/**
 * labelsFromCatalog 将产品内置标签从 Lingui catalog 固化成 LocalizedLabels。
 *
 * 只有产品预置选项走这里；用户自定义配置和导入来源原文仍保留持久化 labels() 数据形状。
 * 返回值会被持久化，所以只保留 LABEL_LOCALES；其它界面语言在显示时经当前 catalog 翻译。
 */
export function labelsFromCatalog(key: BuiltInLabelKey): LocalizedLabels {
  const entry = BUILT_IN_LABELS[key];
  const stored = Object.fromEntries(LABEL_LOCALES.map((locale) => [locale, entry[locale]])) as LocalizedLabels;
  return withDerivedLabels(stored, (locale) => {
    const translated = translate(locale, key);
    return translated === key ? stored["en-US"] : translated;
  });
}
