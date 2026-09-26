/**
 * 自定义配置领域规范化。
 *
 * 目标：
 * - 把来自 localStorage/SQLite JSON 的未知输入收敛成稳定的 `CustomConfig`。
 * - 确保内置支付方式、货币支持范围等业务约束不会被 UI 或脏数据绕过。
 *
 * 注意： 这里是客户端和服务端都应遵循的配置边界。新增配置分组时，
 * 需要同步更新 API schema、默认值和 Provider 更新函数。
 */
import {
  DEFAULT_CUSTOM_CONFIG,
  getConfigItemLabel,
  normalizeCategories,
  normalizeCurrencies,
  normalizePaymentMethods,
  normalizeStatuses,
  type ConfigItem,
  type CustomConfig,
} from "@/types/config";
import { LABEL_LOCALES, type Locale, type LocalizedLabels } from "@/i18n/locales";

/** 判断 value 是否为普通对象（排除数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 判断未知输入是否为合法配置项。 */
export function isConfigItem(value: unknown): value is ConfigItem {
  if (!isRecord(value)) return false;
  const { id, value: itemValue, labels: itemLabels, color, icon, enabled } = value;
  // 配置项要么完整可用，要么丢回默认值；保留半残结构会污染下拉、筛选和保存 payload。
  if (typeof id !== "string" || id.length === 0) return false;
  if (typeof itemValue !== "string" || itemValue.length === 0) return false;
  if (!isLocalizedLabels(itemLabels)) return false;
  if (typeof color !== "undefined" && typeof color !== "string") return false;
  if (typeof icon !== "undefined" && typeof icon !== "string") return false;
  if (typeof enabled !== "undefined" && typeof enabled !== "boolean") return false;
  return true;
}

/** 将未知输入规范化为 ConfigItem[]，不合法时返回 fallback。 */
function asConfigItemArray(value: unknown, fallback: ConfigItem[]): ConfigItem[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter(isConfigItem);
  // 只要数组里混入脏项就整体回退，避免用户配置顺序和默认项合并后出现半可信状态。
  return items.length === value.length ? items : fallback;
}

function isLocalizedLabels(value: unknown): value is LocalizedLabels {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([locale, label]) => (LABEL_LOCALES as readonly string[]).includes(locale) && typeof label === "string" && label.length > 0)
    && typeof value["zh-CN"] === "string"
    && typeof value["en-US"] === "string";
}

/** 将未知 JSON 输入转换为合法 CustomConfig，缺失字段用默认值补齐。 */
export function normalizeCustomConfig(value: unknown): CustomConfig {
  if (!isRecord(value)) return DEFAULT_CUSTOM_CONFIG;

  return {
    categories: normalizeCategories(asConfigItemArray(value["categories"], DEFAULT_CUSTOM_CONFIG.categories)),
    statuses: normalizeStatuses(asConfigItemArray(value["statuses"], DEFAULT_CUSTOM_CONFIG.statuses)),
    paymentMethods: normalizePaymentMethods(
      asConfigItemArray(value["paymentMethods"], DEFAULT_CUSTOM_CONFIG.paymentMethods),
    ),
    currencies: normalizeCurrencies(
      asConfigItemArray(value["currencies"], DEFAULT_CUSTOM_CONFIG.currencies),
    ),
  };
}

export function getConfigItemDisplayLabel(item: ConfigItem, locale: Locale): string {
  return getConfigItemLabel(item, locale);
}
