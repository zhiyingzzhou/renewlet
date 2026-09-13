package main

// notification_types.go 定义通知链路的内部领域类型和 API DTO。
//
// 架构位置：这些 struct 是 route、调度器、渠道发送和历史响应之间的唯一共享契约。
// RawMessage 只用于跨边界保留原始 JSON，真正进入业务逻辑前仍会严格解码到命名 struct。
//
// 注意： 新增渠道、job result 字段或 sent/skipped 响应结构时，必须同步前端 Zod schema 与历史面板测试。
import (
	"encoding/json"
	"errors"
	"sync"
	"time"
)

const (
	notificationStatusSending = "sending"
	notificationStatusSent    = "sent"
	notificationStatusFailed  = "failed"
	notificationStatusSkipped = "skipped"

	legacyWebhookHeadersExample = `{"Authorization": "Bearer your-token", "Content-Type": "application/json"}`
	legacyWebhookPayloadExample = `{"title": "{title}", "content": "{content}", "timestamp": "{timestamp}"}`

	disabledReminderDays            = -2
	inheritReminderDays             = -1
	defaultNotificationReminderDays = 3
	maxReminderDays                 = 3650
	// 默认 plain 表示不发送 Telegram parse_mode；HTML 只能通过 formatter 固定模板输出。
	telegramMessageFormatPlain      = "plain"
	telegramMessageFormatHTML       = "html"
	dingtalkMessageTypeMarkdown     = "markdown"
	dingtalkMessageTypeText         = "text"
	dingtalkTitleTemplateMaxRunes   = 500
	dingtalkContentTemplateMaxRunes = 20000
	discordContentMaxRunes          = 2000
)

var (
	notificationCronMu sync.Mutex
	knownChannels      = map[string]struct{}{
		"telegram":   {},
		"notifyx":    {},
		"webhook":    {},
		"dingtalk":   {},
		"wechat":     {},
		"email":      {},
		"bark":       {},
		"serverchan": {},
		"discord":    {},
		"pushplus":   {},
	}
)

// appSettings 是 settings JSON 字段的后端强类型表示。
// 注意： 字段必须与前端 DEFAULT_SETTINGS/settings schema 同步，否则临时测试配置和持久化设置会分叉。
type appSettings struct {
	AdminUsername                      string                    `json:"adminUsername"`
	ThemeMode                          string                    `json:"themeMode"`
	ThemeVariant                       string                    `json:"themeVariant"`
	ThemeCustomColor                   themeCustomColor          `json:"themeCustomColor"`
	ShowExpired                        bool                      `json:"showExpired"`
	LocalePreference                   string                    `json:"localePreference"`
	DefaultCurrency                    string                    `json:"defaultCurrency"`
	PublicStatusCurrency               string                    `json:"publicStatusCurrency"`
	SubscriptionPriceReferenceEnabled  bool                      `json:"subscriptionPriceReferenceEnabled"`
	SubscriptionPriceReferenceCurrency string                    `json:"subscriptionPriceReferenceCurrency"`
	ExchangeRateProvider               string                    `json:"exchangeRateProvider"`
	BuiltInIconSources                 builtInIconSourceSettings `json:"builtInIconSources"`
	OnlineIconSources                  onlineIconSourceSettings  `json:"onlineIconSources"`
	AIRecognition                      aiRecognitionSettings     `json:"aiRecognition"`
	MonthlyBudget                      string                    `json:"monthlyBudget"`
	Timezone                           string                    `json:"timezone"`
	NotificationTimeLocal              string                    `json:"notificationTimeLocal"`
	NotificationReminderDays           int                       `json:"notificationReminderDays"`
	EnabledChannels                    []string                  `json:"enabledChannels"`
	TestPhone                          string                    `json:"testPhone"`
	TelegramBotToken                   string                    `json:"telegramBotToken"`
	TelegramChatID                     string                    `json:"telegramChatId"`
	TelegramMessageFormat              string                    `json:"telegramMessageFormat"`
	NotifyxAPIKey                      string                    `json:"notifyxApiKey"`
	WebhookURL                         string                    `json:"webhookUrl"`
	WebhookMethod                      string                    `json:"webhookMethod"`
	WebhookHeaders                     string                    `json:"webhookHeaders"`
	WebhookPayload                     string                    `json:"webhookPayload"`
	DingTalkWebhookURL                 string                    `json:"dingtalkWebhookUrl"`
	DingTalkSecret                     string                    `json:"dingtalkSecret"`
	DingTalkKeyword                    string                    `json:"dingtalkKeyword"`
	DingTalkMessageType                string                    `json:"dingtalkMessageType"`
	DingTalkTitleTemplate              string                    `json:"dingtalkTitleTemplate"`
	DingTalkContentTemplate            string                    `json:"dingtalkContentTemplate"`
	WechatWebhookURL                   string                    `json:"wechatWebhookUrl"`
	WechatMessageType                  string                    `json:"wechatMessageType"`
	WechatAddModeTag                   bool                      `json:"wechatAddModeTag"`
	WechatAtPhones                     string                    `json:"wechatAtPhones"`
	WechatAtAll                        bool                      `json:"wechatAtAll"`
	SMTPHost                           string                    `json:"smtpHost"`
	SMTPPort                           string                    `json:"smtpPort"`
	SMTPSecure                         bool                      `json:"smtpSecure"`
	SMTPUser                           string                    `json:"smtpUser"`
	SMTPPassword                       string                    `json:"smtpPassword"`
	SMTPFrom                           string                    `json:"smtpFrom"`
	SMTPReplyTo                        string                    `json:"smtpReplyTo"`
	NotifyMultipleAddresses            bool                      `json:"notifyMultipleAddresses"`
	RecipientEmail                     string                    `json:"recipientEmail"`
	BarkServerURL                      string                    `json:"barkServerUrl"`
	BarkDeviceKey                      string                    `json:"barkDeviceKey"`
	BarkSilentPush                     bool                      `json:"barkSilentPush"`
	ServerChanSendKey                  string                    `json:"serverchanSendKey"`
	DiscordWebhookURL                  string                    `json:"discordWebhookUrl"`
	DiscordBotUsername                 string                    `json:"discordBotUsername"`
	DiscordBotAvatarURL                string                    `json:"discordBotAvatarUrl"`
	PushPlusToken                      string                    `json:"pushplusToken"`
}

type themeCustomColor struct {
	H float64 `json:"h"`
	S float64 `json:"s"`
	L float64 `json:"l"`
}

// notificationSubscription 是通知计算所需的订阅投影。
// 它刻意不复用完整订阅模型，减少通知任务对 UI 字段的耦合。
type notificationSubscription struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	LogoURL                string `json:"-"`
	Price                  string `json:"price"`
	Currency               string `json:"currency"`
	Status                 string `json:"status"`
	BillingCycle           string `json:"billingCycle"`
	CustomDays             int    `json:"customDays,omitempty"`
	CustomCycleUnit        string `json:"customCycleUnit,omitempty"`
	OneTimeTermCount       int    `json:"oneTimeTermCount,omitempty"`
	OneTimeTermUnit        string `json:"oneTimeTermUnit,omitempty"`
	StartDate              string `json:"startDate,omitempty"`
	NextBillingDate        string `json:"nextBillingDate"`
	TrialEndDate           string `json:"trialEndDate,omitempty"`
	ReminderDays           int    `json:"reminderDays"`
	RepeatReminderEnabled  bool   `json:"repeatReminderEnabled"`
	RepeatReminderInterval string `json:"repeatReminderInterval"`
	RepeatReminderWindow   string `json:"repeatReminderWindow"`
	// 通知投影读取完整 costSharing JSON；索引镜像只负责把候选行带进 collector。
	CostSharing costSharingPayload
}

type repeatReminderSnapshot struct {
	Interval string `json:"interval"`
	Window   string `json:"window"`
}

// notificationContentItem 是一条实际会进入通知内容和历史 result 的提醒项。
type notificationContentItem struct {
	Type           string                          `json:"type"`
	SubscriptionID string                          `json:"subscriptionId"`
	Name           string                          `json:"name"`
	LogoURL        string                          `json:"-"`
	Price          string                          `json:"price"`
	Currency       string                          `json:"currency"`
	Status         string                          `json:"status"`
	TargetDate     string                          `json:"targetDate"`
	ReminderDays   int                             `json:"reminderDays"`
	DaysUntil      int                             `json:"daysUntil"`
	RepeatReminder *repeatReminderSnapshot         `json:"repeatReminder,omitempty"`
	CostSharing    *notificationCostSharingPayload `json:"costSharing,omitempty"`
}

type notificationCostSharingPayload struct {
	MemberName string `json:"memberName"`
	// Amount/Currency 是通知历史事实：equal 为订阅币种，custom 为成员配置币种，后端不做汇率猜测。
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

// notificationMessage 是渠道发送层消费的统一消息。
type notificationMessage struct {
	Title      string                    `json:"title"`
	Content    string                    `json:"content"`
	Timestamp  string                    `json:"timestamp"`
	Items      []notificationContentItem `json:"items,omitempty"`
	HasPayload bool                      `json:"hasPayload"`
}

type channelFailure struct {
	Channel string                `json:"channel"`
	Error   string                `json:"error"`
	Details *upstreamErrorDetails `json:"details,omitempty"`
}

type sendSummary struct {
	Attempted []string         `json:"attempted"`
	Succeeded []string         `json:"succeeded"`
	Failed    []channelFailure `json:"failed"`
}

type jobChannels struct {
	Attempted []string         `json:"attempted"`
	Succeeded []string         `json:"succeeded"`
	Failed    []channelFailure `json:"failed"`
}

type localScheduleOccurrence struct {
	ScheduledLocalDate  string `json:"scheduledLocalDate"`
	ScheduledLocalTime  string `json:"scheduledLocalTime"`
	TimeZone            string `json:"timeZone"`
	ScheduledInstantUTC string `json:"scheduledInstantUtc"`
}

type localScheduleDecision struct {
	localScheduleOccurrence
	Due    bool
	Reason string
}

type upcomingNotificationBatch struct {
	localScheduleOccurrence
	Items []notificationContentItem `json:"items"`
}

type notificationOverview struct {
	NextCheck        localScheduleOccurrence     `json:"nextCheck"`
	NextContentBatch *upcomingNotificationBatch  `json:"nextContentBatch"`
	Blockers         []string                    `json:"blockers"`
	EnabledChannels  []string                    `json:"enabledChannels"`
	UpcomingDays     int                         `json:"upcomingDays"`
	UpcomingBatches  []upcomingNotificationBatch `json:"upcomingBatches"`
}

// notificationCronOptions 控制 cron/manual run 的执行策略。
// Force/DryRun/MaxRetries 用于测试和恢复失败任务，不应暴露给普通定时 tick 以外的路径随意修改。
type notificationCronOptions struct {
	Now                 time.Time
	Force               bool
	DryRun              bool
	WindowMinutes       int
	MaxRetries          int
	StaleSendingMinutes int
}

type notificationCronUserResult struct {
	UserID string `json:"userId"`
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

type notificationCronResult struct {
	NowUTC    string                       `json:"nowUtc"`
	Force     bool                         `json:"force"`
	DryRun    bool                         `json:"dryRun"`
	Processed int                          `json:"processed"`
	Sent      int                          `json:"sent"`
	Skipped   int                          `json:"skipped"`
	Failed    int                          `json:"failed"`
	Results   []notificationCronUserResult `json:"results"`
}

type notificationTestRequest struct {
	Channel  string          `json:"channel"`
	Settings json.RawMessage `json:"settings,omitempty"`
}

// Validate 校验通知测试请求。
// Settings 使用 RawMessage 是为了允许“未保存设置”临时覆盖，但真正解析仍由 settings schema 完成。
func (r *notificationTestRequest) Validate(locale appLocale) error {
	if _, ok := knownChannels[r.Channel]; !ok {
		return errors.New(serverText(locale, "notification.channelInvalid"))
	}
	if rawJSONIsNull(r.Settings) {
		return errors.New(serverText(locale, "notification.settingsInvalid"))
	}
	return nil
}

type notificationRunRequest struct {
	Force    bool            `json:"force,omitempty"`
	Settings json.RawMessage `json:"settings,omitempty"`
}

// Validate 校验手动运行请求。
// 显式传 null settings 比省略字段更可能是调用方 bug，因此在边界拒绝。
func (r *notificationRunRequest) Validate(locale appLocale) error {
	if rawJSONIsNull(r.Settings) {
		return errors.New(serverText(locale, "notification.settingsInvalid"))
	}
	return nil
}

type notificationRunSkippedResponse struct {
	Sent   bool   `json:"sent"`
	Reason string `json:"reason"`
}

type notificationRunSentResponse struct {
	Sent    bool        `json:"sent"`
	Summary sendSummary `json:"summary"`
}

type notificationHistorySummaryResponse struct {
	NextCheck        localScheduleOccurrence    `json:"nextCheck"`
	NextContentBatch *upcomingNotificationBatch `json:"nextContentBatch"`
	Blockers         []string                   `json:"blockers"`
	EnabledChannels  []string                   `json:"enabledChannels"`
	UpcomingDays     int                        `json:"upcomingDays"`
	LatestJob        *notificationHistoryJob    `json:"latestJob"`
	LatestFailedJob  *notificationHistoryJob    `json:"latestFailedJob"`
}

type notificationHistoryPageResponse struct {
	Jobs    []notificationHistoryJob `json:"jobs"`
	Status  string                   `json:"status"`
	Limit   int                      `json:"limit"`
	Offset  int                      `json:"offset"`
	HasMore bool                     `json:"hasMore"`
}

type notificationOverviewResponse struct {
	Summary  notificationHistorySummaryResponse `json:"summary"`
	Upcoming []upcomingNotificationBatch        `json:"upcoming"`
}

type notificationJobResultSettings struct {
	Timezone              string   `json:"timezone"`
	Locale                string   `json:"locale"`
	NotificationTimeLocal string   `json:"notificationTimeLocal"`
	EnabledChannels       []string `json:"enabledChannels"`
	ShowExpired           bool     `json:"showExpired"`
}

type notificationJobResultMessage struct {
	Title      string                    `json:"title"`
	Content    string                    `json:"content"`
	Timestamp  string                    `json:"timestamp"`
	HasPayload bool                      `json:"hasPayload"`
	Items      []notificationContentItem `json:"items"`
}

type notificationJobMetadata struct {
	Source         string                        `json:"source"`
	Reason         *string                       `json:"reason"`
	Force          bool                          `json:"force"`
	WindowMinutes  int                           `json:"windowMinutes"`
	TriggeredAtUTC string                        `json:"triggeredAtUtc"`
	Schedule       localScheduleOccurrence       `json:"schedule"`
	Settings       notificationJobResultSettings `json:"settings"`
	Channels       jobChannels                   `json:"channels"`
}

// 重试只读取有界元数据；公开 DTO 在历史查询时连接完整消息，不复用持久化结构充当响应契约。
type notificationJobResult struct {
	notificationJobMetadata
	Message notificationJobResultMessage `json:"message"`
}

type notificationJobStoredResult struct {
	notificationJobMetadata
	MessageChunkCount int `json:"messageChunkCount"`
}

// notificationHistoryJob 是前端历史面板消费的任务 DTO。
// Result 保持 RawMessage 输出，是为了保留 `{}` 与 cron result union 的 wire shape。
type notificationHistoryJob struct {
	ID                  string          `json:"id"`
	ScheduledLocalDate  string          `json:"scheduledLocalDate"`
	ScheduledLocalTime  string          `json:"scheduledLocalTime"`
	TimeZone            string          `json:"timeZone"`
	ScheduledInstantUTC string          `json:"scheduledInstantUtc"`
	Status              string          `json:"status"`
	Attempts            int             `json:"attempts"`
	LastError           *string         `json:"lastError"`
	Result              json.RawMessage `json:"result"`
	CreatedAt           string          `json:"createdAt"`
	UpdatedAt           string          `json:"updatedAt"`
}

type telegramSendMessageRequest struct {
	ChatID             string                      `json:"chat_id"`
	Text               string                      `json:"text"`
	ParseMode          string                      `json:"parse_mode,omitempty"`
	LinkPreviewOptions *telegramLinkPreviewOptions `json:"link_preview_options,omitempty"`
}

type telegramLinkPreviewOptions struct {
	IsDisabled bool `json:"is_disabled"`
}

type notifyxSendRequest struct {
	Title       string `json:"title"`
	Content     string `json:"content"`
	Description string `json:"description"`
}

type wechatMarkdownMessage struct {
	Content string `json:"content"`
}

type wechatTextMessage struct {
	Content             string   `json:"content"`
	MentionedMobileList []string `json:"mentioned_mobile_list"`
}

type wechatMarkdownRequest struct {
	MsgType  string                `json:"msgtype"`
	Markdown wechatMarkdownMessage `json:"markdown"`
}

type wechatTextRequest struct {
	MsgType string            `json:"msgtype"`
	Text    wechatTextMessage `json:"text"`
}

type webhookDefaultPayload struct {
	Title     string `json:"title"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
}

type dingTalkMarkdownMessage struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

type dingTalkTextMessage struct {
	Content string `json:"content"`
}

type dingTalkMarkdownRequest struct {
	MsgType  string                  `json:"msgtype"`
	Markdown dingTalkMarkdownMessage `json:"markdown"`
}

type dingTalkTextRequest struct {
	MsgType string              `json:"msgtype"`
	Text    dingTalkTextMessage `json:"text"`
}

type dingTalkSendResponse struct {
	ErrCode *int   `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

type serverChanSendRequest struct {
	Title string `json:"title"`
	Desp  string `json:"desp"`
}

type serverChanSendResponse struct {
	Code    *int   `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail"`
}

type discordAllowedMentions struct {
	Parse []string `json:"parse"`
}

type discordWebhookRequest struct {
	Content         string                 `json:"content"`
	AllowedMentions discordAllowedMentions `json:"allowed_mentions"`
	Username        string                 `json:"username,omitempty"`
	AvatarURL       string                 `json:"avatar_url,omitempty"`
}

type pushPlusSendRequest struct {
	Token    string `json:"token"`
	Title    string `json:"title"`
	Content  string `json:"content"`
	Template string `json:"template"`
}

type pushPlusSendResponse struct {
	Code *int   `json:"code"`
	Msg  string `json:"msg"`
	Data string `json:"data"`
}

// 默认设置用于注册、补建和后台缺行兜底；语言始终保存 auto，当前请求语言不得注入账号设置。
func defaultAppSettings() appSettings {
	return appSettings{
		AdminUsername:                      "admin",
		ThemeMode:                          "dark",
		ThemeVariant:                       "emerald",
		ThemeCustomColor:                   themeCustomColor{H: 160, S: 84, L: 39},
		ShowExpired:                        true,
		LocalePreference:                   string(autoLocalePreference),
		DefaultCurrency:                    "CNY",
		PublicStatusCurrency:               "inherit",
		SubscriptionPriceReferenceEnabled:  false,
		SubscriptionPriceReferenceCurrency: "default",
		ExchangeRateProvider:               "frankfurter",
		BuiltInIconSources:                 defaultBuiltInIconSourceSettings(),
		OnlineIconSources:                  defaultOnlineIconSourceSettings(),
		AIRecognition: aiRecognitionSettings{
			ProviderType:           aiProviderTypeOpenAI,
			TransportProtocol:      aiProtocolOpenAIChat,
			Model:                  "",
			ModelInputMode:         "select",
			BaseURL:                "",
			APIKey:                 "",
			DefaultThinkingControl: nil,
		},
		MonthlyBudget:            "1500",
		Timezone:                 "UTC",
		NotificationTimeLocal:    "08:00",
		NotificationReminderDays: defaultNotificationReminderDays,
		EnabledChannels:          []string{},
		TestPhone:                "",
		TelegramMessageFormat:    telegramMessageFormatPlain,
		WebhookMethod:            "POST",
		DingTalkMessageType:      dingtalkMessageTypeMarkdown,
		DingTalkTitleTemplate:    "",
		DingTalkContentTemplate:  "",
		WechatMessageType:        "text",
		BarkServerURL:            "https://api.day.app",
		DiscordWebhookURL:        "",
		DiscordBotUsername:       "",
		DiscordBotAvatarURL:      "",
		PushPlusToken:            "",
	}
}
