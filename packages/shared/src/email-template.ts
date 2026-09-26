import zhCatalog from "../data/server-i18n/active.zh-CN.json";
import enCatalog from "../data/server-i18n/active.en-US.json";
import ruCatalog from "../data/server-i18n/active.ru-RU.json";
import { FALLBACK_LOCALE, type Locale, type RepeatReminderInterval, type RepeatReminderWindow } from "./runtime";
import { renderEmailTemplate } from "./email-template-render";
import { moneyToNumber, type MoneyString } from "./money";

export const EMAIL_MAX_HTML_BYTES = 100 * 1024;
const EMAIL_COMPACT_TEXT_RUNES = 12_000;

type ServerCatalog = Record<string, string>;

const SERVER_CATALOGS: Record<Locale, ServerCatalog> = {
  "zh-CN": zhCatalog,
  "en-US": enCatalog,
  "ru-RU": ruCatalog,
};

export interface NotificationEmailSettings {
  themeVariant: string;
  themeCustomColor: {
    h: number;
    s: number;
    l: number;
  };
}

/** 通知邮件中的单条提醒；Go 与 Worker 都用它生成同语义 HTML+Text 邮件。 */
export interface NotificationEmailItem {
  type: "renewal" | "trial" | "expired" | "expiry" | string;
  subscriptionId?: string;
  name: string;
  logoUrl?: string;
  price: MoneyString;
  currency: string;
  status: string;
  targetDate: string;
  reminderDays: number;
  daysUntil?: number;
  repeatReminder?: {
    interval: RepeatReminderInterval | string;
    window: RepeatReminderWindow | string;
  };
  costSharing?: {
    memberName: string;
    amount: MoneyString;
    currency: string;
  };
}

/** 渠道层传入邮件模板的统一消息，不包含任何 SMTP token 或 provider 响应。 */
export interface NotificationEmailMessage {
  title: string;
  content: string;
  timestamp: string;
  hasPayload: boolean;
  items: NotificationEmailItem[];
}

export interface BuildNotificationEmailOptions {
  locale: Locale;
  appUrl?: string;
}

export interface NotificationEmail {
  subject: string;
  text: string;
  html: string;
}

/** 邮件 HTML 主题色是内联样式输入；必须控制在模板可预测的颜色 token 内。 */
export interface EmailTheme {
  primary: string;
  primaryText: string;
  primarySoft: string;
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  muted: string;
}

export interface EmailBrand {
  name: string;
  headerMark: EmailBrandMark;
}

export interface EmailBrandMark {
  size: number;
  radius: number;
  background: string;
  border: string;
  foreground: string;
  accent: string;
  topWidth: number;
  topHeight: number;
  topRadius: number;
  dotSize: number;
  dotRadius: number;
  gap: number;
  rowGap: number;
  bottomWidth: number;
  bottomHeight: number;
  bottomRadius: number;
  bottomInset: number;
}

export interface EmailCopy {
  brandTagline: string;
  generated: string;
  noReminders: string;
  testNotification: string;
  reminderItems: string;
  message: string;
  emptyDetails: string;
  generatedAt: string;
  footer: string;
  truncated: string;
  upcomingRenewals: string;
  upcomingExpiries: string;
  trialEnding: string;
  expired: string;
  collectionReminders: string;
  billingDate: string;
  expiryDate: string;
  trialEnds: string;
  expiredSince: string;
  collectionDate: string;
  updateNextBillingDate: string;
  collectFrom: string;
  dayBefore: string;
  daysBefore: string;
  repeatEvery: string;
  preheaderItems: string;
  ctaViewSubscriptions: string;
  ctaOpenSettings: string;
}

export interface EmailTemplateData {
  layoutMode: EmailLayoutMode;
  lang: Locale;
  title: string;
  preheader: string;
  statusLabel: string;
  summary: EmailSummaryPanel;
  messagePanel: EmailMessagePanel | null;
  groups: EmailTemplateGroup[];
  cta: EmailCta | null;
  showCardBottomPadding: boolean;
  timestamp: string;
  copy: EmailCopy;
  theme: EmailTheme;
  brand: EmailBrand;
}

export type EmailLayoutMode = "reminder-list" | "test-status" | "empty-message" | "compact-message";

export interface EmailSummaryPanel {
  eyebrow: string;
  value: string;
  label: string;
  detail: string;
  rows: EmailSummaryRow[];
}

export interface EmailSummaryRow {
  label: string;
  value: string;
}

export interface EmailMessagePanel {
  label: string;
  lines: string[];
}

export interface EmailTemplateGroup {
  label: string;
  count: number;
  items: EmailTemplateItem[];
}

export interface EmailTemplateItem {
  name: string;
  dateLabel: string;
  targetDate: string;
  amount: string;
  currency: string;
  detail: string;
}

export interface EmailCta {
  url: string;
  label: string;
}

/**
 * 构建通知邮件的 subject/text/html 三件套。
 *
 * HTML 超过体积上限时会退回 compact 版本；这是为了兼容邮箱客户端和 Worker/Go 两个发送路径的内存预算。
 */
export function buildNotificationEmail(
  settings: NotificationEmailSettings,
  message: NotificationEmailMessage,
  options: BuildNotificationEmailOptions,
): NotificationEmail {
  const data = buildEmailTemplateData(settings, message, options, false);
  let html = renderEmailTemplate(data);
  if (utf8ByteLength(html) > EMAIL_MAX_HTML_BYTES) {
    html = renderEmailTemplate(buildEmailTemplateData(settings, message, options, true));
  }
  return {
    subject: message.title,
    text: `${message.content}\n\n${message.timestamp}`,
    html,
  };
}

function buildEmailTemplateData(
  settings: NotificationEmailSettings,
  input: NotificationEmailMessage,
  options: BuildNotificationEmailOptions,
  compact: boolean,
): EmailTemplateData {
  const locale = options.locale;
  const copy = loadEmailCopy(locale);
  const itemCount = input.items.length;
  const hasReminderItems = itemCount > 0;
  const layoutMode = emailLayoutMode(input, compact);
  const message = compact
    ? { ...input, items: [], content: compactEmailContent(input.content, copy) }
    : input;
  const theme = emailThemeFromSettings(settings);
  const groups = message.items.length > 0 ? buildEmailTemplateGroups(message.items, copy) : [];
  const statusLabel = emailStatusLabel(itemCount, input.hasPayload, copy);
  const messagePanel = layoutMode === "empty-message" || layoutMode === "compact-message"
    ? { label: copy.message, lines: splitEmailContentLines(message.content, copy) }
    : null;
  const cta = emailCtaFromAppUrl(options.appUrl ?? "", hasReminderItems, copy);
  return {
    layoutMode,
    lang: locale,
    title: input.title,
    preheader: emailPreheader(input, copy),
    statusLabel,
    summary: emailSummaryPanel(itemCount, groups, statusLabel, message, copy),
    messagePanel,
    groups,
    cta,
    showCardBottomPadding: cta === null,
    timestamp: input.timestamp,
    copy,
    theme,
    brand: emailBrand(),
  };
}

function emailLayoutMode(input: NotificationEmailMessage, compact: boolean): EmailLayoutMode {
  if (compact) return "compact-message";
  if (input.items.length > 0) return "reminder-list";
  return input.hasPayload ? "test-status" : "empty-message";
}

function loadEmailCopy(locale: Locale): EmailCopy {
  const text = (key: string) => serverText(locale, key);
  return {
    brandTagline: text("email.brandTagline"),
    generated: text("email.generated"),
    noReminders: text("email.noReminders"),
    testNotification: text("email.testNotification"),
    reminderItems: text("email.reminderItems"),
    message: text("email.message"),
    emptyDetails: text("email.emptyDetails"),
    generatedAt: text("email.generatedAt"),
    footer: text("email.footer"),
    truncated: text("email.truncated"),
    upcomingRenewals: text("email.upcomingRenewals"),
    upcomingExpiries: text("email.upcomingExpiries"),
    trialEnding: text("email.trialEnding"),
    expired: text("email.expired"),
    collectionReminders: text("email.collectionReminders"),
    billingDate: text("email.billingDate"),
    expiryDate: text("email.expiryDate"),
    trialEnds: text("email.trialEnds"),
    expiredSince: text("email.expiredSince"),
    collectionDate: text("email.collectionDate"),
    updateNextBillingDate: text("email.updateNextBillingDate"),
    collectFrom: text("email.collectFrom"),
    dayBefore: text("email.dayBefore"),
    daysBefore: text("email.daysBefore"),
    repeatEvery: text("email.repeatEvery"),
    preheaderItems: text("email.preheaderItems"),
    ctaViewSubscriptions: text("email.ctaViewSubscriptions"),
    ctaOpenSettings: text("email.ctaOpenSettings"),
  };
}

function buildEmailTemplateGroups(items: NotificationEmailItem[], copy: EmailCopy): EmailTemplateGroup[] {
  const grouped: Record<string, NotificationEmailItem[]> = { renewal: [], expiry: [], trial: [], expired: [], costSharing: [] };
  for (const item of items) {
    // 邮件不会渲染 logo URL；外链图片会让邮件客户端暴露私有资产或第三方请求痕迹。
    const itemType = grouped[item.type] ? item.type : "renewal";
    grouped[itemType]?.push(item);
  }
  return (["renewal", "expiry", "trial", "expired", "costSharing"] as const)
    .map((itemType) => {
      const rawItems = grouped[itemType] ?? [];
      return {
        label: emailGroupLabel(itemType, copy),
        count: rawItems.length,
        items: rawItems.map((item) => ({
          name: item.name,
          dateLabel: emailItemDateLabel(item.type, copy),
          targetDate: item.targetDate,
          amount: formatAmount(emailItemAmount(item)),
          currency: emailItemCurrency(item),
          detail: emailItemDetail(item, copy),
        })),
      };
    })
    .filter((group) => group.count > 0);
}

function emailStatusLabel(itemCount: number, hasPayload: boolean, copy: EmailCopy): string {
  if (itemCount === 0 && !hasPayload) return copy.noReminders;
  if (itemCount === 0) return copy.testNotification;
  return copy.generated;
}

function emailSummaryPanel(
  itemCount: number,
  groups: EmailTemplateGroup[],
  statusLabel: string,
  message: NotificationEmailMessage,
  copy: EmailCopy,
): EmailSummaryPanel {
  const hasReminderItems = itemCount > 0;
  return {
    eyebrow: statusLabel,
    value: String(itemCount),
    label: hasReminderItems ? copy.reminderItems : statusLabel,
    detail: hasReminderItems ? formatCatalogCopy(copy.preheaderItems, { count: itemCount }) : firstNonEmptyLine(message.content) || message.title,
    rows: emailSummaryRows(itemCount, groups, copy),
  };
}

function emailSummaryRows(itemCount: number, groups: EmailTemplateGroup[], copy: EmailCopy): EmailSummaryRow[] {
  if (groups.length === 0) return itemCount === 0 ? [] : [{ label: copy.reminderItems, value: String(itemCount) }];
  return groups.map((group) => ({ label: group.label, value: String(group.count) }));
}

function emailCtaFromAppUrl(rawAppUrl: string, hasReminderItems: boolean, copy: EmailCopy): EmailCta | null {
  const appUrl = rawAppUrl.trim();
  if (!appUrl) return null;
  try {
    const parsed = new URL(appUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const targetPath = hasReminderItems ? "/subscriptions" : "/settings";
    const basePath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = basePath ? `${basePath}${targetPath}` : targetPath;
    parsed.search = "";
    parsed.hash = "";
    return { url: parsed.toString(), label: hasReminderItems ? copy.ctaViewSubscriptions : copy.ctaOpenSettings };
  } catch {
    return null;
  }
}

function emailThemeFromSettings(settings: NotificationEmailSettings): EmailTheme {
  const [h, s, l] = emailThemeHsl(settings);
  const primary = hslToHex(h, s, l);
  return {
    primary,
    primaryText: contrastTextForHsl(h, s, l),
    primarySoft: hslToHex(h, Math.min(s, 50), 95),
    background: "#F5F7F6",
    surface: "#FFFFFF",
    surfaceMuted: "#F8FAF9",
    border: "#E6EAE8",
    text: "#0F172A",
    muted: "#64748B",
  };
}

function emailBrand(): EmailBrand {
  const base = {
    background: "#111720",
    border: "#26313D",
    foreground: "#F8FAFC",
    accent: "#10B981",
  };
  return {
    name: "Renewlet",
    headerMark: {
      ...base,
      size: 28,
      radius: 7,
      topWidth: 13,
      topHeight: 4,
      topRadius: 2,
      dotSize: 4,
      dotRadius: 2,
      gap: 3,
      rowGap: 6,
      bottomWidth: 15,
      bottomHeight: 3,
      bottomRadius: 2,
      bottomInset: 2,
    },
  };
}

function emailThemeHsl(settings: NotificationEmailSettings): [number, number, number] {
  switch (settings.themeVariant.trim()) {
    case "ocean":
      return [210, 90, 45];
    case "sunset":
      return [25, 95, 48];
    case "lavender":
      return [270, 70, 55];
    case "rose":
      return [340, 75, 50];
    case "custom":
      if (validEmailCustomColor(settings.themeCustomColor)) {
        return [settings.themeCustomColor.h, settings.themeCustomColor.s, settings.themeCustomColor.l];
      }
      break;
  }
  return [160, 84, 39];
}

function validEmailCustomColor(color: NotificationEmailSettings["themeCustomColor"]): boolean {
  return [color.h, color.s, color.l].every(Number.isFinite)
    && color.h >= 0 && color.h <= 360
    && color.s >= 0 && color.s <= 100
    && color.l >= 0 && color.l <= 100;
}

function emailPreheader(message: NotificationEmailMessage, copy: EmailCopy): string {
  if (message.items.length > 0) return formatCatalogCopy(copy.preheaderItems, { count: message.items.length });
  return firstNonEmptyLine(message.content) || message.title;
}

function firstNonEmptyLine(input: string): string {
  for (const line of input.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function emailGroupLabel(itemType: string, copy: EmailCopy): string {
  if (itemType === "costSharing") return copy.collectionReminders;
  if (itemType === "expiry") return copy.upcomingExpiries;
  if (itemType === "trial") return copy.trialEnding;
  if (itemType === "expired") return copy.expired;
  return copy.upcomingRenewals;
}

function emailItemDateLabel(itemType: string, copy: EmailCopy): string {
  if (itemType === "costSharing") return copy.collectionDate;
  if (itemType === "expiry") return copy.expiryDate;
  if (itemType === "trial") return copy.trialEnds;
  if (itemType === "expired") return copy.expiredSince;
  return copy.billingDate;
}

function emailItemDetail(item: NotificationEmailItem, copy: EmailCopy): string {
  if (item.type === "costSharing" && item.costSharing) {
    return formatCatalogCopy(copy.collectFrom, { member: item.costSharing.memberName, days: item.reminderDays });
  }
  if (item.type === "expired") return copy.updateNextBillingDate;
  if (item.repeatReminder && copy.repeatEvery) {
    return formatCatalogCopy(copy.repeatEvery, { hours: repeatReminderIntervalHours(item.repeatReminder.interval) });
  }
  if (item.reminderDays === 1 && copy.dayBefore) {
    return formatCatalogCopy(copy.dayBefore, { days: item.reminderDays });
  }
  return formatCatalogCopy(copy.daysBefore, { days: item.reminderDays });
}

function emailItemAmount(item: NotificationEmailItem): MoneyString {
  return item.type === "costSharing" && item.costSharing ? item.costSharing.amount : item.price;
}

function emailItemCurrency(item: NotificationEmailItem): string {
  return item.type === "costSharing" && item.costSharing ? item.costSharing.currency : item.currency;
}

function splitEmailContentLines(input: string, copy: EmailCopy): string[] {
  const lines = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim().split("\n");
  return lines.length === 0 || (lines.length === 1 && lines[0] === "") ? [copy.emptyDetails] : lines;
}

function compactEmailContent(input: string, copy: EmailCopy): string {
  const chars = [...input];
  if (chars.length <= EMAIL_COMPACT_TEXT_RUNES) return input;
  return `${chars.slice(0, EMAIL_COMPACT_TEXT_RUNES).join("").trim()}\n\n${copy.truncated}`;
}

function repeatReminderIntervalHours(interval: string): number {
  const match = /^(\d+)h$/.exec(interval);
  return match?.[1] ? Number.parseInt(match[1], 10) : 1;
}

function formatCatalogCopy(message: string, params: Record<string, string | number>): string {
  return message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

function formatAmount(amount: MoneyString | number): string {
  const numericAmount = moneyToNumber(amount);
  if (!Number.isFinite(numericAmount)) return String(amount);
  return numericAmount.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function serverText(locale: Locale, key: string): string {
  return SERVER_CATALOGS[locale]?.[key] ?? SERVER_CATALOGS[FALLBACK_LOCALE][key] ?? key;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let hue = h % 360;
  if (hue < 0) hue += 360;
  const saturation = clamp01(s / 100);
  const lightness = clamp01(l / 100);
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lightness - c / 2;
  let rgb: [number, number, number] = [0, 0, 0];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((value) => Math.round((value + m) * 255)) as [number, number, number];
}

function contrastTextForHsl(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l).map((value) => value / 255) as [number, number, number];
  const luminance = 0.2126 * linearizedRgb(r) + 0.7152 * linearizedRgb(g) + 0.0722 * linearizedRgb(b);
  return luminance > 0.52 ? "#111827" : "#FFFFFF";
}

function linearizedRgb(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toHex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}
