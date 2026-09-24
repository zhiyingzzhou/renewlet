import type { ApiAppSettings } from "./schemas/settings";
import { DEFAULT_BUILT_IN_ICON_SOURCES } from "./built-in-icons";
import { DEFAULT_ONLINE_ICON_SOURCES } from "./online-icon-sources";
import { DEFAULT_NOTIFICATION_REMINDER_DAYS } from "./runtime";
import { DEFAULT_LOCALE_PREFERENCE } from "./i18n-config";

export interface DefaultSettingsOptions {
  timezone?: string;
}

export const DEFAULT_CUSTOM_THEME_COLOR = { h: 160, s: 84, l: 39 } as const;

/** 生成完整设置对象；语言固定为 auto，调用方不得手写部分 defaults 或注入请求语言。 */
export function createDefaultAppSettings(options: DefaultSettingsOptions = {}): ApiAppSettings {
  // 默认设置同时服务 PocketBase 首次写入和 D1 空库读取；不能依赖某一端私有字段。
  return {
    adminUsername: "admin",
    themeMode: "dark",
    themeVariant: "emerald",
    themeCustomColor: DEFAULT_CUSTOM_THEME_COLOR,
    localePreference: DEFAULT_LOCALE_PREFERENCE,
    showExpired: true,
    showLunarCalendar: false,
    defaultCurrency: "CNY",
    publicStatusCurrency: "inherit",
    subscriptionPriceReferenceEnabled: false,
    subscriptionPriceReferenceCurrency: "default",
    exchangeRateProvider: "frankfurter",
    builtInIconSources: DEFAULT_BUILT_IN_ICON_SOURCES,
    onlineIconSources: DEFAULT_ONLINE_ICON_SOURCES,
    monthlyBudget: "1500",
    timezone: options.timezone ?? "UTC",
    notificationTimeLocal: "08:00" as ApiAppSettings["notificationTimeLocal"],
    notificationReminderDays: DEFAULT_NOTIFICATION_REMINDER_DAYS,
    enabledChannels: [],
    testPhone: "",
    telegramBotToken: "",
    telegramChatId: "",
    // 默认不发送 Telegram parse_mode；富文本必须由用户显式启用，避免旧 Bot/客户端渲染差异影响通知可读性。
    telegramMessageFormat: "plain",
    notifyxApiKey: "",
    webhookUrl: "",
    webhookMethod: "POST",
    webhookHeaders: "",
    webhookPayload: "",
    dingtalkWebhookUrl: "",
    dingtalkSecret: "",
    dingtalkKeyword: "",
    dingtalkMessageType: "markdown",
    dingtalkTitleTemplate: "",
    dingtalkContentTemplate: "",
    wechatWebhookUrl: "",
    wechatMessageType: "text",
    wechatAddModeTag: false,
    wechatAtPhones: "",
    wechatAtAll: false,
    // 空 SMTP 表示通知邮件未配置；Cloudflare 版不会读取 wrangler 部署级 SMTP secrets 作为 fallback。
    smtpHost: "",
    smtpPort: "",
    smtpSecure: false,
    smtpUser: "",
    smtpPassword: "",
    smtpFrom: "",
    smtpReplyTo: "",
    notifyMultipleAddresses: false,
    recipientEmail: "",
    barkServerUrl: "https://api.day.app",
    barkDeviceKey: "",
    barkSilentPush: false,
    serverchanSendKey: "",
    discordWebhookUrl: "",
    discordBotUsername: "",
    discordBotAvatarUrl: "",
    pushplusToken: "",
    aiRecognition: {
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "",
      modelInputMode: "select",
      baseUrl: "",
      apiKey: "",
      defaultThinkingControl: null,
    },
  };
}
