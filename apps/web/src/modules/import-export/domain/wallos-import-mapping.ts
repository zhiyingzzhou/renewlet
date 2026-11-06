import {
  fromRenewletExportSettingsV1,
  importPayloadSchema,
  type ImportSubscription,
  type RenewletExportV1,
} from "@/lib/api/schemas/import-export";
import { getIntlCurrencySymbol, SUPPORTED_EXCHANGE_RATE_CURRENCIES } from "@/lib/currency-data";
import type { CustomConfig } from "@/types/config";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS, MAX_REMINDER_DAYS, type AppSettings } from "@/types/subscription";
import type { DateOnly } from "@/lib/time/date-only";
import { moneyFromNumber } from "@renewlet/shared/money";
import {
  WALLOS_DEFAULT_CURRENCIES,
  WALLOS_DEFAULT_CURRENCY_BY_ID,
  WALLOS_SYMBOL_DEFAULT_CURRENCY,
  wallosCategoryFromName,
  wallosPaymentMethodValue,
} from "./wallos-import-constants";
import {
  makeConfigItem,
  mergeConfigItem,
  importMessage,
  IMPORT_MESSAGE_CODES,
  normalizeDateOnly,
  normalizeNullableDateOnly,
  normalizeWebsite,
  stableHash,
  toBillingCycleFromDays,
  toBillingCycleFromUnit,
  type ImportBillingCycle,
  type ImportAssetRef,
  type PreparedImport,
  type WallosImportUser,
} from "./import-export-model";

export type WallosTableRow = Record<string, unknown>;
export type ImportAssetSource = Blob | { buffer: ArrayBuffer; mimeType: string };

/**
 * WallosApiPayload 描述用户粘贴或合并的 Wallos API JSON。
 *
 * Wallos 各端点可分开导出，因此 lookup 表都是可选输入；缺失时只能降级映射，不能发起网络补全。
 */
export interface WallosApiPayload {
  subscriptions: WallosTableRow[];
  users?: WallosTableRow[];
  currencies?: unknown;
  categories?: unknown;
  payment_methods?: unknown;
  paymentMethods?: unknown;
  household?: unknown;
  members?: unknown;
}

/**
 * WallosDatabaseModel 是 Worker 从 SQLite/ZIP 中提取的窄模型。
 *
 * 只保留导入映射需要的表和 Logo entry，避免主线程接收完整数据库内容。
 */
export interface WallosDatabaseModel {
  users: WallosImportUser[];
  subscriptions: WallosTableRow[];
  currencies: Map<string, WallosTableRow>;
  categories: Map<string, WallosTableRow>;
  paymentMethods: Map<string, WallosTableRow>;
  members: Map<string, WallosTableRow>;
  logoFiles: Map<string, ImportAssetSource>;
}

/** ImportBuildBaseContext 提供导入映射需要的当前 Renewlet 设置、配置和日期上下文。 */
export interface ImportBuildBaseContext {
  config: CustomConfig;
  settings: AppSettings;
  today: DateOnly | string;
}

interface BuildContext extends ImportBuildBaseContext {
  config: CustomConfig;
  warnings: string[];
  assets: ImportAssetRef[];
  logoFiles: Map<string, ImportAssetSource>;
}

const MAX_IMPORT_NOTES_LENGTH = 5000;
const WALLOS_AUDIT_FIELDS = [
  "id",
  "user_id",
  "cycle",
  "frequency",
  "auto_renew",
  "inactive",
  "notify",
  "notify_days_before",
  "cancellation_date",
  "replacement_subscription_id",
  "currency_id",
  "category_id",
  "payment_method_id",
  "payer_user_id",
] as const;

export function buildFromRenewletExport(
  data: RenewletExportV1,
  context: ImportBuildBaseContext,
  assetFiles = new Map<string, ImportAssetSource>(),
): PreparedImport {
  // Renewlet v1 备份中的资产路径必须先转为本地待上传资产，不能直接把 ZIP 内路径写回订阅 logo。
  const warnings: string[] = [];
  const assets: ImportAssetRef[] = [];
  const subscriptions = data.data.subscriptions.map((subscription, index) => {
    const logo = typeof subscription.logo === "string" ? subscription.logo : undefined;
    const asset = logo ? assetFiles.get(logo) : undefined;
    if (logo && asset) {
      assets.push(makeSubscriptionLogoAssetRef(index, logo.split("/").pop() ?? "renewlet-logo", asset));
    }
    return {
      name: subscription.name,
      logo: asset || isExportAssetPath(logo) ? null : logo ?? null,
      price: subscription.price,
      currency: subscription.currency,
      balance: subscription.balance,
      balanceCurrency: subscription.balanceCurrency,
      billingCycle: subscription.billingCycle,
      customDays: subscription.billingCycle === "custom" ? subscription.customDays : null,
      customCycleUnit: subscription.billingCycle === "custom" ? subscription.customCycleUnit : null,
      category: subscription.category,
      status: subscription.status,
      pinned: subscription.pinned,
      publicHidden: subscription.publicHidden,
      paymentMethod: subscription.paymentMethod ?? null,
      startDate: subscription.startDate,
      nextBillingDate: subscription.nextBillingDate,
      autoRenew: subscription.billingCycle === "one-time" ? false : subscription.autoRenew,
      autoCalculateNextBillingDate: subscription.autoCalculateNextBillingDate,
      trialEndDate: subscription.trialEndDate ?? null,
      website: subscription.website ?? null,
      notes: subscription.notes ?? null,
      tags: subscription.tags ?? [],
      reminderDays: subscription.reminderDays,
      repeatReminderEnabled: subscription.repeatReminderEnabled,
      repeatReminderInterval: subscription.repeatReminderInterval,
      repeatReminderWindow: subscription.repeatReminderWindow,
      extra: {
        ...subscription.extra,
        import: { source: "renewlet", sourceId: subscription.id, confidence: "high" },
      },
    };
  });
  // v1 缺少 locale 表示“不覆盖目标账号语言”，转换结果必须保持局部 settings patch 语义。
  return {
    payload: importPayloadSchema.parse({
      source: "renewlet",
      subscriptions,
      settings: fromRenewletExportSettingsV1(data.data.settings),
      customConfig: prepareRenewletExportCustomConfig(data.data.customConfig, assetFiles, assets),
      exchangeRateSnapshots: data.data.exchangeRateSnapshots,
    }),
    assets,
    warnings,
  };
}

function prepareRenewletExportCustomConfig(
  config: RenewletExportV1["data"]["customConfig"],
  assetFiles: Map<string, ImportAssetSource>,
  assets: ImportAssetRef[],
): RenewletExportV1["data"]["customConfig"] {
  if (!config) return undefined;
  return {
    ...config,
    paymentMethods: config.paymentMethods.map((item, index) => {
      const icon = item.icon?.trim();
      if (!icon) return item;
      const asset = assetFiles.get(icon);
      if (asset) {
        assets.push(makePaymentMethodIconAssetRef(index, icon.split("/").pop() ?? "renewlet-icon", asset));
      }
      if (asset || isExportAssetPath(icon)) {
        const { icon: _icon, ...rest } = item;
        return rest;
      }
      return item;
    }),
  };
}

/**
 * buildFromWallosDatabase 将 Wallos SQLite 模型转换为 Renewlet 导入 payload。
 *
 * 多用户备份默认选择第一个用户；UI 可重新传 wallosUserId 重新解析同一个文件。
 */
export function buildFromWallosDatabase(
  model: WallosDatabaseModel,
  context: ImportBuildBaseContext,
  wallosUserId?: string,
): PreparedImport {
  const selectedUserId = wallosUserId ?? model.users[0]?.id ?? "1";
  const rows = model.subscriptions.filter((row) => {
    const userId = row["user_id"];
    return userId === undefined || String(userId) === selectedUserId;
  });
  const prepared = buildFromWallosRows(rows, context, { ...model, logoFiles: model.logoFiles });
  return { ...prepared, wallosUsers: model.users };
}

/**
 * buildFromWallosRows 映射 Wallos API/DB 订阅行。
 *
 * 映射过程中会增补 customConfig，以便导入后用户能继续编辑 Wallos 分类/付款方式/货币。
 */
export function buildFromWallosRows(
  rows: WallosTableRow[],
  base: ImportBuildBaseContext,
  model: Pick<WallosDatabaseModel, "users" | "currencies" | "categories" | "paymentMethods" | "members" | "logoFiles">,
): PreparedImport {
  const warnings: string[] = [];
  const assets: ImportAssetRef[] = [];
  let config = base.config;
  const context: BuildContext = { ...base, config, warnings, assets, logoFiles: model.logoFiles };
  const subscriptions = rows.map((row, index) => {
    context.config = config;
    const currency = model.currencies.get(String(row["currency_id"] ?? ""));
    const category = model.categories.get(String(row["category_id"] ?? ""));
    const paymentMethod = model.paymentMethods.get(String(row["payment_method_id"] ?? ""));
    const member = model.members.get(String(row["payer_user_id"] ?? ""));
    const mapped = mapWallosRow(row, context, {
      subscriptionIndex: index,
      ...(currency ? { currency } : {}),
      ...(category ? { category } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(member ? { member } : {}),
    });
    config = mapped.config;
    context.config = config;
    return mapped.subscription;
  });
  return {
    payload: importPayloadSchema.parse({ source: "wallos", subscriptions, customConfig: config }),
    assets,
    warnings,
    wallosUsers: model.users,
  };
}

/**
 * buildFromWallosDisplayRows 映射 Wallos 前端表格导出的低置信数据。
 *
 * display 来源没有稳定 ID，只能用名称/URL/周期等字段生成 display hash，并在预览中提示用户确认。
 */
export function buildFromWallosDisplayRows(
  rows: WallosTableRow[],
  base: ImportBuildBaseContext,
): PreparedImport {
  const warnings: string[] = [IMPORT_MESSAGE_CODES.lowConfidenceDisplay];
  const assets: ImportAssetRef[] = [];
  let config = base.config;
  const subscriptions = rows.map((row) => {
    const name = String(row["Name"] ?? "");
    const hash = stableHash(wallosDisplayIdentity(row));
    const categoryName = String(row["Category"] ?? "No category");
    const paymentName = String(row["Payment Method"] ?? "");
    const localWarnings: string[] = [];
    const website = normalizeWebsite(row["URL"], localWarnings);
    const category = wallosCategoryFromName(categoryName);
    const paymentMethod = wallosPaymentMethodValue(paymentName);
    if (category.item) config = { ...config, categories: mergeConfigItem(config.categories, category.item) };
    if (paymentMethod) config = { ...config, paymentMethods: mergeConfigItem(config.paymentMethods, makeConfigItem(paymentMethod, paymentName)) };
    const price = parseDisplayPrice(row["Price"], base, localWarnings);
    config = { ...config, currencies: mergeConfigItem(config.currencies, { ...makeConfigItem(price.currency, price.currency), enabled: true }) };
    const billing = parseDisplayCycle(String(row["Payment Cycle"] ?? "Monthly"), localWarnings);
    const subscription = makeImportSubscription({
      name,
      price: price.amount,
      currency: price.currency,
      category: category.value,
      paymentMethod,
      startDate: null,
      nextBillingDate: normalizeDateOnly(row["Next Payment"], base.today, localWarnings, "wallosDueDate"),
      website,
      notes: [String(row["Notes"] ?? "").trim(), buildDisplayWallosNotes(row)].filter(Boolean).join("\n\n"),
      status: displayStatus(row),
      billing,
      sourceId: `display:${hash}`,
      confidence: "low",
      oneTime: billing.oneTime,
      wallos: row,
      warnings: localWarnings,
    });
    warnings.push(...localWarnings.map((warning) => importMessage("IMPORT_WARNING_FOR_SUBSCRIPTION", name || "Wallos", warning)));
    return subscription;
  });
  return { payload: importPayloadSchema.parse({ source: "wallos", subscriptions, customConfig: config }), assets, warnings };
}

function wallosDisplayIdentity(row: WallosTableRow): string {
  return [
    row["Name"],
    row["URL"],
    row["Category"],
    row["Payment Method"],
    row["Payment Cycle"],
  ].map((value) => String(value ?? "").trim().toLowerCase()).join("\u001f");
}

function mapWallosRow(
  row: WallosTableRow,
  context: BuildContext,
  related: {
    currency?: WallosTableRow | undefined;
    category?: WallosTableRow | undefined;
    paymentMethod?: WallosTableRow | undefined;
    member?: WallosTableRow | undefined;
    subscriptionIndex: number;
  },
): { subscription: ImportSubscription; config: CustomConfig } {
  const localWarnings: string[] = [];
  const name = String(row["name"] ?? "Wallos Subscription").trim() || "Wallos Subscription";
  const currency = wallosCurrency(row, related.currency, context, localWarnings);
  let config = context.config;
  config = { ...config, currencies: mergeConfigItem(config.currencies, { ...makeConfigItem(currency, currency), enabled: true }) };
  const categoryName = String(related.category?.["name"] ?? row["category_name"] ?? "No category");
  const category = wallosCategoryFromName(categoryName);
  if (category.item) config = { ...config, categories: mergeConfigItem(config.categories, category.item) };
  const paymentName = String(related.paymentMethod?.["name"] ?? row["payment_method_name"] ?? "").trim();
  const paymentMethod = wallosPaymentMethodValue(paymentName);
  if (paymentMethod) config = { ...config, paymentMethods: mergeConfigItem(config.paymentMethods, makeConfigItem(paymentMethod, paymentName)) };
  const website = normalizeWebsite(row["url"], localWarnings);
  const logo = String(row["logo"] ?? "").trim();
  const logoAsset = logo ? context.logoFiles.get(logo) : undefined;
  const logoExternal = /^https?:\/\//i.test(logo) ? logo : undefined;
  if (logo && logoAsset) {
    context.assets.push(makeSubscriptionLogoAssetRef(related.subscriptionIndex, logo, logoAsset));
  } else if (logoExternal) {
    localWarnings.push(IMPORT_MESSAGE_CODES.externalLogo);
  } else if (logo) {
    localWarnings.push(IMPORT_MESSAGE_CODES.missingLogoFile);
  }
  const startDate = normalizeNullableDateOnly(row["start_date"], localWarnings, "wallosStartDate");
  const nextBillingDate = normalizeDateOnly(row["next_payment"] ?? row["start_date"], startDate ?? context.today, localWarnings, "wallosDueDate");
  const wallosOnly = buildWallosOnlyNotes(row, related.member);
  const notes = [String(row["notes"] ?? "").trim(), wallosOnly].filter(Boolean).join("\n\n");
  const billing = wallosBilling(row, localWarnings);
  const oneTime = Number(row["cycle"] ?? 0) === 5;
  const subscription = makeImportSubscription({
    name,
    logo: logoExternal,
    price: Number(row["price"] ?? 0) || 0,
    currency,
    category: category.value,
    paymentMethod,
    startDate,
    nextBillingDate,
    website,
    notes,
    status: wallosStatus(row),
    billing,
    reminderDays: wallosReminderDays(row, localWarnings),
    // Wallos auto_renew 是真实续订语义；字段缺失时遵循 Renewlet 默认关闭，不从 cycle 推断 consent。
    autoRenew: row["auto_renew"] !== undefined && Number(row["auto_renew"]) === 1 && Number(row["cycle"] ?? 3) !== 5,
    autoCalculateNextBillingDate: false,
    sourceId: `${String(row["user_id"] ?? "1")}:${String(row["id"] ?? stableHash(JSON.stringify(row)))}`,
    confidence: row["id"] === undefined ? "low" : "high",
    oneTime,
    wallos: row,
    warnings: localWarnings,
  });
  context.warnings.push(...localWarnings.map((warning) => importMessage("IMPORT_WARNING_FOR_SUBSCRIPTION", name || "Wallos", warning)));
  return { subscription, config };
}

function makeImportSubscription(input: {
  name: string;
  price: number;
  currency: string;
  category: string;
  paymentMethod?: string | undefined;
  startDate: DateOnly | string | null;
  nextBillingDate: DateOnly | string;
  website?: string | undefined;
  notes?: string | undefined;
  status: "trial" | "active" | "expired" | "paused" | "cancelled";
  billing: ImportBillingCycle;
  reminderDays?: number | undefined;
  autoRenew?: boolean | undefined;
  autoCalculateNextBillingDate?: boolean | undefined;
  logo?: string | undefined;
  sourceId: string;
  confidence: "high" | "low";
  oneTime?: boolean | undefined;
  wallos: unknown;
  warnings: string[];
}): ImportSubscription {
  const wallosExtra = buildWallosImportAudit(input.wallos, Boolean(input.oneTime));
  return {
    name: input.name,
    logo: input.logo ?? null,
    price: moneyFromNumber(Math.max(0, input.price)),
    currency: input.currency,
    billingCycle: input.billing.billingCycle,
    customDays: input.billing.billingCycle === "custom" ? input.billing.customDays ?? 1 : null,
    customCycleUnit: input.billing.billingCycle === "custom" ? input.billing.customCycleUnit ?? "day" : null,
    category: input.category,
    status: input.status,
    pinned: false,
    publicHidden: false,
    paymentMethod: input.paymentMethod ?? null,
    startDate: input.startDate === null ? null : input.startDate as DateOnly,
    nextBillingDate: input.nextBillingDate as DateOnly,
    autoRenew: input.oneTime ? false : input.autoRenew ?? false,
    autoCalculateNextBillingDate: input.oneTime ? false : input.autoCalculateNextBillingDate ?? false,
    trialEndDate: null,
    website: input.website ?? null,
    notes: truncateImportNotes(input.notes),
    tags: [],
    reminderDays: input.reminderDays ?? 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {
      import: { source: "wallos", sourceId: input.sourceId, confidence: input.confidence },
      wallos: wallosExtra,
    },
  };
}

function buildWallosImportAudit(value: unknown, oneTime: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (isRecord(value)) {
    // Wallos 行可能含超长 notes/logo/url；extra 只保留稳定排障字段，避免 Cloudflare D1 写入和 Go schema 预览校验漂移。
    for (const field of WALLOS_AUDIT_FIELDS) {
      if (value[field] !== undefined) result[field] = value[field];
    }
  }
  if (oneTime) result["oneTime"] = true;
  return result;
}

function truncateImportNotes(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.length > MAX_IMPORT_NOTES_LENGTH ? text.slice(0, MAX_IMPORT_NOTES_LENGTH) : text;
}

function makeSubscriptionLogoAssetRef(subscriptionIndex: number, filename: string, source: ImportAssetSource): ImportAssetRef {
  return source instanceof Blob
    ? { target: { type: "subscriptionLogo", subscriptionIndex }, kind: "logo", filename, blob: source }
    : { target: { type: "subscriptionLogo", subscriptionIndex }, kind: "logo", filename, ...source };
}

function makePaymentMethodIconAssetRef(paymentMethodIndex: number, filename: string, source: ImportAssetSource): ImportAssetRef {
  return source instanceof Blob
    ? { target: { type: "paymentMethodIcon", paymentMethodIndex }, kind: "icon", filename, blob: source }
    : { target: { type: "paymentMethodIcon", paymentMethodIndex }, kind: "icon", filename, ...source };
}

function isExportAssetPath(value: string | undefined): boolean {
  return Boolean(value && /^assets\/[^/][A-Za-z0-9._/-]*$/.test(value) && !value.includes(".."));
}

function wallosBilling(row: WallosTableRow, warnings: string[]): ImportBillingCycle {
  const cycle = Number(row["cycle"] ?? 3);
  const frequency = Math.max(1, Number(row["frequency"] ?? 1) || 1);
  // Wallos cycle=5 是买断/终身授权；Renewlet 用 one-time 表达计费模型，不再伪装成取消订阅。
  if (cycle === 5) {
    warnings.push(IMPORT_MESSAGE_CODES.oneTime);
    return { billingCycle: "one-time" };
  }
  if (cycle === 1) return toBillingCycleFromDays(frequency);
  if (cycle === 2) return toBillingCycleFromUnit(frequency, "week");
  if (cycle === 3) return toBillingCycleFromUnit(frequency, "month");
  if (cycle === 4) return toBillingCycleFromUnit(frequency, "year");
  warnings.push(IMPORT_MESSAGE_CODES.unknownCycle);
  return { billingCycle: "monthly" };
}

function parseDisplayCycle(text: string, warnings: string[]): ImportBillingCycle & { oneTime?: boolean } {
  const lower = text.toLowerCase();
  if (lower.includes("one-time") || lower.includes("one time")) {
    warnings.push(IMPORT_MESSAGE_CODES.oneTime);
    return { billingCycle: "one-time", oneTime: true };
  }
  const every = /every\s+(\d+)/i.exec(text);
  const count = every ? Math.max(1, Number(every[1])) : 1;
  if (lower.includes("day")) return toBillingCycleFromDays(count);
  if (lower.includes("week")) return toBillingCycleFromUnit(count, "week");
  if (lower.includes("year")) return toBillingCycleFromUnit(count, "year");
  return toBillingCycleFromUnit(count, "month");
}

function wallosStatus(row: WallosTableRow): "active" | "paused" | "cancelled" {
  if (Number(row["inactive"] ?? 0) !== 1) return "active";
  if (String(row["cancellation_date"] ?? "").trim() || Number(row["replacement_subscription_id"] ?? 0) > 0) return "cancelled";
  return "paused";
}

function wallosReminderDays(row: WallosTableRow, warnings: string[]): number {
  if (Number(row["notify"] ?? 0) !== 1) {
    warnings.push(IMPORT_MESSAGE_CODES.notifyDisabled);
    // Wallos cron 明确只查询 notify=1；notify=0 不是“默认天数缺失”，而是单订阅不参与通知。
    return DISABLED_REMINDER_DAYS;
  }
  const days = Number(row["notify_days_before"] ?? 3);
  if (days === INHERIT_REMINDER_DAYS) return INHERIT_REMINDER_DAYS;
  return days < 0 ? 0 : Math.min(MAX_REMINDER_DAYS, Math.floor(days));
}

function buildWallosOnlyNotes(row: WallosTableRow, member?: WallosTableRow): string {
  const lines = [
    member?.["name"] || row["payer_user_name"] ? `Wallos paid by: ${String(member?.["name"] ?? row["payer_user_name"])}` : "",
    row["cancellation_date"] || row["cancelation_date"] ? `Wallos cancellation date: ${String(row["cancellation_date"] ?? row["cancelation_date"])}` : "",
    row["replacement_subscription_id"] ? `Wallos replacement subscription id: ${String(row["replacement_subscription_id"])}` : "",
    `Wallos cycle/frequency: ${String(row["cycle"] ?? "")}/${String(row["frequency"] ?? "")}`,
    row["notify"] !== undefined ? `Wallos notifications: ${Number(row["notify"]) === 1 ? "enabled" : "disabled"}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? `Wallos import details:\n${lines.join("\n")}` : "";
}

function buildDisplayWallosNotes(row: WallosTableRow): string {
  const lines = [
    row["Paid By"] ? `Wallos paid by: ${String(row["Paid By"])}` : "",
    row["Cancellation Date"] ? `Wallos cancellation date: ${String(row["Cancellation Date"])}` : "",
    row["Renewal"] ? `Wallos renewal: ${String(row["Renewal"])}` : "",
    row["Notifications"] ? `Wallos notifications: ${String(row["Notifications"])}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? `Wallos import details:\n${lines.join("\n")}` : "";
}

function wallosCurrency(row: WallosTableRow, currencyRow: WallosTableRow | undefined, context: BuildContext, warnings: string[]): string {
  const code = String(currencyRow?.["code"] ?? row["currency_code"] ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return code;
  const currencyId = String(row["currency_id"] ?? "").trim();
  const defaultWallosCurrency = WALLOS_DEFAULT_CURRENCY_BY_ID.get(currencyId);
  if (defaultWallosCurrency) return defaultWallosCurrency;
  const symbol = String(currencyRow?.["symbol"] ?? row["currency_symbol"] ?? "").trim();
  if (symbol) return currencyFromSymbol(symbol, context.config, context.settings.defaultCurrency, warnings);
  if (row["currency_id"] !== undefined) {
    warnings.push(IMPORT_MESSAGE_CODES.onlyCurrencyId);
  }
  return context.settings.defaultCurrency;
}

function parseDisplayPrice(value: unknown, context: ImportBuildBaseContext, warnings: string[]) {
  const text = String(value ?? "");
  const amount = Number.parseFloat(text.replace(/[^\d.-]/g, "")) || 0;
  const explicitCode = text.match(/\b[A-Z]{3}\b/)?.[0];
  if (explicitCode) return { amount, currency: explicitCode };
  const symbol = text.replace(/[\d.,\s+-]/g, "").trim();
  return { amount, currency: currencyFromSymbol(symbol, context.config, context.settings.defaultCurrency, warnings) };
}

function currencyFromSymbol(symbol: string, config: Pick<CustomConfig, "currencies">, fallback: string, warnings: string[]): string {
  const normalizedSymbol = normalizeWallosCurrencySymbol(symbol);
  if (!normalizedSymbol) return fallback;
  const allowed = new Set(config.currencies.filter((currency) => currency.enabled !== false).map((currency) => currency.value.toUpperCase()));
  const wallosCandidates = WALLOS_DEFAULT_CURRENCIES
    .filter((currency) => normalizeWallosCurrencySymbol(currency.symbol) === normalizedSymbol)
    .map((currency) => currency.code);
  const intlCandidates = SUPPORTED_EXCHANGE_RATE_CURRENCIES.filter((code) => {
    return normalizeWallosCurrencySymbol(getIntlCurrencySymbol(code, "zh-CN")) === normalizedSymbol
      || normalizeWallosCurrencySymbol(getIntlCurrencySymbol(code, "en-US")) === normalizedSymbol;
  });
  const unique = [...new Set([...wallosCandidates, ...intlCandidates])];
  if (unique.length === 0) {
    warnings.push(importMessage(IMPORT_MESSAGE_CODES.currencySymbolAmbiguous, normalizedSymbol, fallback.toUpperCase()));
    return fallback;
  }
  const normalizedFallback = fallback.toUpperCase();
  if (unique.includes(normalizedFallback)) return normalizedFallback;
  const enabledCandidates = unique.filter((code) => allowed.has(code));
  const stableDefault = WALLOS_SYMBOL_DEFAULT_CURRENCY.get(normalizedSymbol);
  if (stableDefault && (enabledCandidates.includes(stableDefault) || enabledCandidates.length !== 1) && unique.includes(stableDefault)) {
    return stableDefault;
  }
  const onlyEnabledCandidate = enabledCandidates.length === 1 ? enabledCandidates.at(0) : undefined;
  if (onlyEnabledCandidate) return onlyEnabledCandidate;
  const onlyCandidate = unique.length === 1 ? unique.at(0) : undefined;
  if (onlyCandidate) return onlyCandidate;
  // Wallos UI JSON 只给符号；多义符号必须落到真实候选币种，不能退到候选外的设置默认币种。
  const selected = enabledCandidates.at(0) ?? unique.at(0);
  if (!selected) return fallback;
  warnings.push(importMessage(IMPORT_MESSAGE_CODES.currencySymbolAmbiguous, normalizedSymbol, selected));
  return selected;
}

function normalizeWallosCurrencySymbol(symbol: string): string {
  return symbol.trim().replace(/￥/g, "¥");
}

function displayStatus(row: WallosTableRow): "active" | "paused" | "cancelled" {
  const active = String(row["Active"] ?? "").trim().toLowerCase();
  const state = String(row["State"] ?? "").trim().toLowerCase();
  if (active === "no" || state === "disabled") {
    return row["Cancellation Date"] ? "cancelled" : "paused";
  }
  return "active";
}

export function isWallosApiPayload(value: unknown): value is WallosApiPayload {
  return Boolean(value)
    && typeof value === "object"
    && Array.isArray((value as { subscriptions?: unknown }).subscriptions)
    && (value as { subscriptions: WallosTableRow[] }).subscriptions.some((row) => "next_payment" in row || "cycle" in row);
}

export function isWallosDisplayPayload(value: unknown): value is { subscriptions: WallosTableRow[] } {
  return Boolean(value)
    && typeof value === "object"
    && Array.isArray((value as { subscriptions?: unknown }).subscriptions)
    && isWallosDisplayRows((value as { subscriptions: unknown[] }).subscriptions);
}

export function isWallosDisplayRows(value: unknown): value is WallosTableRow[] {
  return Array.isArray(value)
    && value.some((row) => isRecord(row) && ("Name" in row || "Payment Cycle" in row || "Next Payment" in row));
}

export function wallosUsersFromApiPayload(value: { users?: WallosTableRow[] }): WallosImportUser[] {
  return (value.users ?? []).map((user) => ({
    id: String(user["id"] ?? "1"),
    label: String(user["name"] ?? user["username"] ?? user["email"] ?? `Wallos User ${user["id"] ?? 1}`),
  }));
}

export function rowsById(rows: WallosTableRow[]): Map<string, WallosTableRow> {
  const entries: Array<[string, WallosTableRow]> = [];
  for (const row of rows) {
    const id = String(row["id"] ?? "");
    if (id) entries.push([id, row]);
  }
  return new Map(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
