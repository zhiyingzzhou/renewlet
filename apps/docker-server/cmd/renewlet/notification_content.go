package main

// notification_content.go 将订阅投影转换为可发送的通知内容。
//
// 架构位置：调度器、手动运行和测试发送共享同一套内容构建，确保历史记录、渠道文本和前端预览口径一致。
// 这里刻意按 date-only 计算提醒窗口，因为扣费日是用户本地业务日期，不应被 UTC instant 或 DST 影响。
//
// 注意： 调整 item type 或文案分组会影响所有渠道文本和 notification job result schema。
import (
	"strings"
	"time"

	"github.com/zhiyingzzhou/renewlet/apps/docker-server/internal/subscriptionderived"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const notificationSubscriptionPageSize = 500

// listNotificationSubscriptions 只保留给用户主动页面、手动运行、导出和预览等显式读取场景；后台 cron 必须走候选查询。
func listNotificationSubscriptions(app core.App, userID string) ([]notificationSubscription, error) {
	return listNotificationSubscriptionsByFilter(app, "user = {:user}", dbx.Params{"user": userID})
}

func listNotificationSubscriptionsByFilter(app core.App, filter string, params dbx.Params) ([]notificationSubscription, error) {
	subscriptions := []notificationSubscription{}
	for offset := 0; ; offset += notificationSubscriptionPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", filter, "-created", notificationSubscriptionPageSize, offset, params)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			subscriptions = append(subscriptions, notificationSubscriptionFromRecord(row))
		}
		if len(rows) < notificationSubscriptionPageSize {
			return subscriptions, nil
		}
	}
}

func listNotificationScheduleCandidateSubscriptions(app core.App, userID string, settings appSettings, schedule localScheduleOccurrence, includeExpired bool) ([]notificationSubscription, error) {
	params := dbx.Params{
		"user":      userID,
		"disabled":  disabledReminderDays,
		"localDate": schedule.ScheduledLocalDate,
		"maxDate":   addDateOnly(schedule.ScheduledLocalDate, maxReminderDays),
	}
	branches := []string{
		"user = {:user} && status != 'paused' && status != 'cancelled' && reminderDays != {:disabled} && nextBillingDate >= {:localDate} && nextBillingDate <= {:maxDate}",
		"user = {:user} && status != 'paused' && status != 'cancelled' && reminderDays != {:disabled} && trialEndDate >= {:localDate} && trialEndDate <= {:maxDate}",
	}
	if includeExpired && settings.ShowExpired {
		branches = append(branches, "user = {:user} && status != 'paused' && status != 'cancelled' && reminderDays != {:disabled} && nextBillingDate < {:localDate}")
	}
	branches = append(branches, "user = {:user} && costSharingCollectionReminderEnabled = true && costSharingNextCollectionReminderDate != '' && costSharingNextCollectionReminderDate <= {:localDate}")
	// 每个分支都对应独立索引候选；cron 热路径不解析 costSharing JSON，精确日期和成员周期由 collector 统一过滤。
	return listNotificationSubscriptionsByIndexedBranches(app, branches, params)
}

func listNotificationSubscriptionsByIndexedBranches(app core.App, filters []string, params dbx.Params) ([]notificationSubscription, error) {
	out := []notificationSubscription{}
	seen := map[string]struct{}{}
	for _, filter := range filters {
		rows, err := listNotificationSubscriptionsByFilter(app, filter, params)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if _, ok := seen[row.ID]; ok {
				continue
			}
			seen[row.ID] = struct{}{}
			out = append(out, row)
		}
	}
	return out, nil
}

func listRepeatReminderCandidateSubscriptions(app core.App, userID string, settings appSettings, now time.Time) ([]notificationSubscription, error) {
	localDate := todayDateOnly(now, settings.Timezone)
	params := dbx.Params{
		"user":      userID,
		"disabled":  disabledReminderDays,
		"localDate": localDate,
		"maxDate":   addDateOnly(localDate, maxReminderDays),
	}
	filter := "user = {:user} && status != 'paused' && status != 'cancelled' && reminderDays != {:disabled} && repeatReminderEnabled = true && " +
		"((nextBillingDate >= {:localDate} && nextBillingDate <= {:maxDate}) || (status = 'trial' && trialEndDate >= {:localDate} && trialEndDate <= {:maxDate}))"
	// 非日常窗口每分钟只允许读取 repeat 候选；否则 D1 rows read 和 PocketBase I/O 会随订阅总量线性放大。
	return listNotificationSubscriptionsByFilter(app, filter, params)
}

func notificationSubscriptionFromRecord(row *core.Record) notificationSubscription {
	return notificationSubscription{
		ID:                     row.Id,
		Name:                   row.GetString("name"),
		LogoURL:                row.GetString("logo"),
		Price:                  moneyForRecord(row.Get("price")),
		Currency:               row.GetString("currency"),
		Status:                 row.GetString("status"),
		BillingCycle:           row.GetString("billingCycle"),
		CustomDays:             row.GetInt("customDays"),
		CustomCycleUnit:        row.GetString("customCycleUnit"),
		OneTimeTermCount:       row.GetInt("oneTimeTermCount"),
		OneTimeTermUnit:        row.GetString("oneTimeTermUnit"),
		StartDate:              row.GetString("startDate"),
		NextBillingDate:        row.GetString("nextBillingDate"),
		TrialEndDate:           row.GetString("trialEndDate"),
		ReminderDays:           row.GetInt("reminderDays"),
		RepeatReminderEnabled:  row.GetBool("repeatReminderEnabled"),
		RepeatReminderInterval: normalizeRepeatReminderInterval(row.GetString("repeatReminderInterval")),
		RepeatReminderWindow:   normalizeRepeatReminderWindow(row.GetString("repeatReminderWindow")),
		CostSharing:            notificationCostSharingFromRecord(row),
	}
}

func notificationCostSharingFromRecord(row *core.Record) costSharingPayload {
	payload, ok := costSharingPayloadFromValue(row.Get("costSharing"))
	if !ok {
		return costSharingPayload{}
	}
	return payload
}

func normalizeNotificationReminderDays(value int) int {
	if value < 0 || value > maxReminderDays {
		return defaultNotificationReminderDays
	}
	return value
}

func isInheritReminderDays(value int) bool {
	return value == inheritReminderDays
}

func isDisabledReminderDays(value int) bool {
	return value == disabledReminderDays
}

// 暂停和取消只停用普通续费、固定期限到期、过期与 repeat 提醒；家庭共享收款提醒不调用此资格判断，保持独立责任流。
func isSubscriptionReminderEligible(sub notificationSubscription) bool {
	return subscriptionderived.OrdinaryRemindersAllowed(sub.Status)
}

func effectiveReminderDays(sub notificationSubscription, settings appSettings) (int, bool) {
	// -2/-1/0 是跨 Wallos 导入、前端表单、Go/PocketBase 和 Cloudflare 的提醒哨兵；通知历史只输出解析后的非负天数。
	if isDisabledReminderDays(sub.ReminderDays) {
		return 0, false
	}
	if isInheritReminderDays(sub.ReminderDays) {
		return normalizeNotificationReminderDays(settings.NotificationReminderDays), true
	}
	if sub.ReminderDays < 0 || sub.ReminderDays > maxReminderDays {
		return defaultNotificationReminderDays, true
	}
	return sub.ReminderDays, true
}

// buildTestNotification 构造测试通知内容。
func buildTestNotification(now time.Time, settings appSettings, locale appLocale) notificationMessage {
	return notificationMessage{
		Title:      serverText(locale, "notification.content.testTitle"),
		Content:    serverText(locale, "notification.content.testBody"),
		Timestamp:  formatNotificationTime(now, settings.Timezone),
		Items:      []notificationContentItem{},
		HasPayload: true,
	}
}

// buildDueNotification 根据当前时间和用户时区构造到期提醒。
func buildDueNotification(now time.Time, settings appSettings, subscriptions []notificationSubscription, includeExpired bool, locale appLocale) notificationMessage {
	localDate := todayDateOnly(now, settings.Timezone)
	items := collectNotificationItems(localDate, settings, subscriptions, includeExpired)
	return buildNotificationContent(now, settings, items, locale)
}

// buildDueNotificationForLocalDate 按指定本地日期构造提醒。
func buildDueNotificationForLocalDate(localDate string, now time.Time, settings appSettings, subscriptions []notificationSubscription, includeExpired bool, locale appLocale) notificationMessage {
	items := collectNotificationItems(localDate, settings, subscriptions, includeExpired)
	return buildNotificationContent(now, settings, items, locale)
}

func buildDueNotificationForSchedule(schedule localScheduleOccurrence, now time.Time, settings appSettings, subscriptions []notificationSubscription, includeExpired bool, locale appLocale) notificationMessage {
	items := collectNotificationItemsForSchedule(schedule, settings, subscriptions, includeExpired)
	return buildNotificationContent(now, settings, items, locale)
}

func collectNotificationItemsForSchedule(schedule localScheduleOccurrence, settings appSettings, subscriptions []notificationSubscription, includeExpired bool) []notificationContentItem {
	items := []notificationContentItem{}
	if schedule.ScheduledLocalTime == settings.NotificationTimeLocal {
		items = append(items, collectNotificationItems(schedule.ScheduledLocalDate, settings, subscriptions, includeExpired)...)
	}
	items = append(items, collectRepeatNotificationItems(schedule, settings, subscriptions)...)
	return items
}

// collectNotificationItems 收集指定本地日期应该提醒的项目。
// 为什么用 date-only 差值：订阅扣费日是业务日期，不应受 UTC instant 或 DST 切换影响。
func collectNotificationItems(localDate string, settings appSettings, subscriptions []notificationSubscription, includeExpired bool) []notificationContentItem {
	items := []notificationContentItem{}
	for _, sub := range subscriptions {
		if isValidDateOnly(sub.NextBillingDate) {
			items = append(items, collectSubscriptionReminderItems(localDate, settings, sub, includeExpired)...)
			if !(sub.BillingCycle == "one-time" && sub.OneTimeTermCount <= 0) {
				items = append(items, collectCostSharingCollectionReminderItems(localDate, settings, sub)...)
			}
		}

		items = append(items, collectTrialReminderItems(localDate, settings, sub)...)
	}
	return items
}

func collectSubscriptionReminderItems(localDate string, settings appSettings, sub notificationSubscription, includeExpired bool) []notificationContentItem {
	if !isSubscriptionReminderEligible(sub) || isDisabledReminderDays(sub.ReminderDays) {
		// -2 表示单订阅静默；只关闭普通续费/到期提醒，不影响独立的家庭共享收款提醒。
		return []notificationContentItem{}
	}
	reminderDays, ok := effectiveReminderDays(sub, settings)
	if !ok {
		return []notificationContentItem{}
	}
	daysUntilNext := daysBetweenDateOnly(localDate, sub.NextBillingDate)
	if sub.BillingCycle == "one-time" && sub.OneTimeTermCount <= 0 {
		// one-time 买断记录没有权益到期日；购买日不能被通知系统解释成续费或过期边界。
		return []notificationContentItem{}
	}
	if sub.BillingCycle == "one-time" {
		if daysUntilNext == reminderDays {
			return []notificationContentItem{newNotificationContentItem("expiry", sub, sub.NextBillingDate, daysUntilNext, reminderDays, nil)}
		}
		if daysUntilNext < 0 && settings.ShowExpired && includeExpired {
			return []notificationContentItem{newNotificationContentItem("expired", sub, sub.NextBillingDate, daysUntilNext, reminderDays, nil)}
		}
		return []notificationContentItem{}
	}
	if daysUntilNext < 0 {
		if settings.ShowExpired && includeExpired {
			return []notificationContentItem{newNotificationContentItem("expired", sub, sub.NextBillingDate, daysUntilNext, reminderDays, nil)}
		}
		return []notificationContentItem{}
	}
	if daysUntilNext == reminderDays {
		return []notificationContentItem{newNotificationContentItem("renewal", sub, sub.NextBillingDate, daysUntilNext, reminderDays, nil)}
	}
	return []notificationContentItem{}
}

func collectTrialReminderItems(localDate string, settings appSettings, sub notificationSubscription) []notificationContentItem {
	if !isSubscriptionReminderEligible(sub) || isDisabledReminderDays(sub.ReminderDays) || sub.Status != "trial" || !isValidDateOnly(sub.TrialEndDate) {
		return []notificationContentItem{}
	}
	reminderDays, ok := effectiveReminderDays(sub, settings)
	if !ok {
		return []notificationContentItem{}
	}
	daysUntilTrialEnd := daysBetweenDateOnly(localDate, sub.TrialEndDate)
	if daysUntilTrialEnd != reminderDays {
		return []notificationContentItem{}
	}
	return []notificationContentItem{newNotificationContentItem("trial", sub, sub.TrialEndDate, daysUntilTrialEnd, reminderDays, nil)}
}

func collectCostSharingCollectionReminderItems(localDate string, settings appSettings, sub notificationSubscription) []notificationContentItem {
	reminderDays, ok := effectiveCostSharingCollectionReminderDays(sub, settings)
	if !ok {
		return []notificationContentItem{}
	}
	items := make([]notificationContentItem, 0, len(sub.CostSharing.Members))
	for _, member := range sub.CostSharing.Members {
		targetDate, ok := costSharingCollectionTargetForLocalDate(member, sub, localDate, reminderDays)
		if !ok {
			continue
		}
		daysUntilTarget := daysBetweenDateOnly(localDate, targetDate)
		amount, currency, ok := costSharingCollectionAmountForMember(sub, member)
		if !ok {
			continue
		}
		items = append(items, newCostSharingNotificationContentItem(sub, member.Name, amount, currency, targetDate, daysUntilTarget, reminderDays))
	}
	return items
}

func effectiveCostSharingCollectionReminderDays(sub notificationSubscription, settings appSettings) (int, bool) {
	reminder := sub.CostSharing.CollectionReminder
	if !sub.CostSharing.Enabled || len(sub.CostSharing.Members) == 0 || reminder == nil || !reminder.Enabled || reminder.ReminderDays == nil {
		return 0, false
	}
	// 收款提醒独立于普通 reminderDays：订阅 -2 静默不关闭家庭收款，-1 只继承全局提醒天数。
	days := *reminder.ReminderDays
	if isInheritReminderDays(days) {
		return normalizeNotificationReminderDays(settings.NotificationReminderDays), true
	}
	if days < 0 || days > maxReminderDays {
		return 0, false
	}
	return days, true
}

func costSharingCollectionTargetForLocalDate(member costSharingMember, sub notificationSubscription, localDate string, reminderDays int) (string, bool) {
	reminder := sub.CostSharing.CollectionReminder
	if reminder == nil {
		return "", false
	}
	anchor := costSharingMemberCollectionAnchor(member, sub.StartDate)
	if anchor == "" {
		return "", false
	}
	targetThreshold := addDateOnly(localDate, reminderDays)
	targetDate, ok := nextCostSharingCollectionTargetDate(anchor, costSharingCollectionBillingFromNotificationSubscription(sub), targetThreshold)
	if !ok || daysBetweenDateOnly(localDate, targetDate) != reminderDays {
		return "", false
	}
	return targetDate, true
}

func costSharingCollectionBillingFromNotificationSubscription(sub notificationSubscription) costSharingCollectionBilling {
	return costSharingCollectionBilling{
		BillingCycle:     sub.BillingCycle,
		CustomDays:       sub.CustomDays,
		CustomCycleUnit:  sub.CustomCycleUnit,
		OneTimeTermCount: sub.OneTimeTermCount,
		OneTimeTermUnit:  sub.OneTimeTermUnit,
		StartDate:        sub.StartDate,
		NextBillingDate:  sub.NextBillingDate,
	}
}

func costSharingCollectionAmountForMember(sub notificationSubscription, member costSharingMember) (string, string, bool) {
	currency := strings.TrimSpace(member.Currency)
	if currency == "" {
		currency = sub.Currency
	}
	if sub.CostSharing.SplitMode == "custom" {
		if member.CustomAmount == nil {
			return "", "", false
		}
		// custom 模式只使用成员配置的金额和币种；后端不猜汇率，也不把订阅币种强行换算过去。
		return moneyForRecord(*member.CustomAmount), currency, true
	}
	participantCount := len(sub.CostSharing.Members) + 1
	return divideMoneyString(sub.Price, participantCount), sub.Currency, true
}

func collectRepeatNotificationItems(schedule localScheduleOccurrence, settings appSettings, subscriptions []notificationSubscription) []notificationContentItem {
	scheduledInstant, err := time.Parse(time.RFC3339, schedule.ScheduledInstantUTC)
	if err != nil {
		return []notificationContentItem{}
	}
	items := []notificationContentItem{}
	for _, sub := range subscriptions {
		if !isSubscriptionReminderEligible(sub) || isDisabledReminderDays(sub.ReminderDays) {
			// 重复提醒依赖首次提醒窗口；静默订阅不能绕过主通知入口进入重复调度。
			continue
		}
		if sub.BillingCycle == "one-time" {
			// one-time 固定服务期只走首轮到期提醒；重复提醒仍保留给会自动/手动续费的周期订阅和 trial。
			continue
		}
		if !sub.RepeatReminderEnabled {
			continue
		}
		reminderDays, ok := effectiveReminderDays(sub, settings)
		if !ok {
			continue
		}
		repeat := &repeatReminderSnapshot{
			Interval: normalizeRepeatReminderInterval(sub.RepeatReminderInterval),
			Window:   normalizeRepeatReminderWindow(sub.RepeatReminderWindow),
		}
		if isValidDateOnly(sub.NextBillingDate) && repeatReminderOccurrenceMatches(scheduledInstant, settings, reminderDays, sub.NextBillingDate, repeat) {
			items = append(items, newNotificationContentItem("renewal", sub, sub.NextBillingDate, daysBetweenDateOnly(schedule.ScheduledLocalDate, sub.NextBillingDate), reminderDays, repeat))
		}
		if sub.Status == "trial" && isValidDateOnly(sub.TrialEndDate) && repeatReminderOccurrenceMatches(scheduledInstant, settings, reminderDays, sub.TrialEndDate, repeat) {
			items = append(items, newNotificationContentItem("trial", sub, sub.TrialEndDate, daysBetweenDateOnly(schedule.ScheduledLocalDate, sub.TrialEndDate), reminderDays, repeat))
		}
	}
	return items
}

func newNotificationContentItem(itemType string, sub notificationSubscription, targetDate string, daysUntil int, reminderDays int, repeat *repeatReminderSnapshot) notificationContentItem {
	status := normalizeSubscriptionStatus(sub.Status)
	if itemType == "trial" {
		status = "trial"
	}
	return notificationContentItem{
		Type:           itemType,
		SubscriptionID: sub.ID,
		Name:           sub.Name,
		LogoURL:        sub.LogoURL,
		Price:          sub.Price,
		Currency:       sub.Currency,
		Status:         status,
		TargetDate:     targetDate,
		ReminderDays:   reminderDays,
		DaysUntil:      daysUntil,
		RepeatReminder: repeat,
	}
}

func newCostSharingNotificationContentItem(sub notificationSubscription, memberName string, amount string, currency string, targetDate string, daysUntil int, reminderDays int) notificationContentItem {
	item := newNotificationContentItem("costSharing", sub, targetDate, daysUntil, reminderDays, nil)
	item.CostSharing = &notificationCostSharingPayload{
		MemberName: memberName,
		Amount:     moneyForRecord(amount),
		Currency:   currency,
	}
	return item
}

func repeatReminderOccurrenceMatches(scheduledInstant time.Time, settings appSettings, reminderDays int, targetDate string, repeat *repeatReminderSnapshot) bool {
	targetInstant, err := getScheduleInstant(targetDate, settings.NotificationTimeLocal, settings.Timezone)
	if err != nil {
		return false
	}
	firstInstant, err := getScheduleInstant(addDateOnly(targetDate, -reminderDays), settings.NotificationTimeLocal, settings.Timezone)
	if err != nil {
		return false
	}
	if !scheduledInstant.After(firstInstant) || scheduledInstant.After(targetInstant) {
		return false
	}
	windowStart := firstInstant
	if duration, full := repeatReminderWindowDuration(repeat.Window); !full {
		candidate := targetInstant.Add(-duration)
		if candidate.After(windowStart) {
			windowStart = candidate
		}
	}
	if scheduledInstant.Before(windowStart) {
		return false
	}
	elapsed := scheduledInstant.Sub(firstInstant)
	interval := repeatReminderIntervalDuration(repeat.Interval)
	return interval > 0 && elapsed%interval == 0
}

// buildNotificationContent 将提醒项分组为可读消息。
func buildNotificationContent(now time.Time, settings appSettings, items []notificationContentItem, locale appLocale) notificationMessage {
	renewals := []string{}
	expiries := []string{}
	trials := []string{}
	expired := []string{}
	collections := []string{}
	for _, item := range items {
		line := formatNotificationItemLine(item, locale)
		switch item.Type {
		case "expiry":
			expiries = append(expiries, line)
		case "trial":
			trials = append(trials, line)
		case "expired":
			expired = append(expired, line)
		case "costSharing":
			collections = append(collections, line)
		default:
			renewals = append(renewals, line)
		}
	}

	blocks := []string{}
	if len(renewals) > 0 {
		blocks = append(blocks, serverText(locale, "notification.content.renewalBlock")+"\n"+strings.Join(renewals, "\n"))
	}
	if len(expiries) > 0 {
		blocks = append(blocks, serverText(locale, "notification.content.expiryBlock")+"\n"+strings.Join(expiries, "\n"))
	}
	if len(trials) > 0 {
		blocks = append(blocks, serverText(locale, "notification.content.trialBlock")+"\n"+strings.Join(trials, "\n"))
	}
	if len(expired) > 0 {
		blocks = append(blocks, serverText(locale, "notification.content.expiredBlock")+"\n"+strings.Join(expired, "\n"))
	}
	if len(collections) > 0 {
		blocks = append(blocks, serverText(locale, "notification.content.costSharingBlock")+"\n"+strings.Join(collections, "\n"))
	}
	hasPayload := len(blocks) > 0
	content := serverText(locale, "notification.content.empty")
	if hasPayload {
		content = strings.Join(blocks, "\n\n")
	}
	return notificationMessage{
		Title:      serverText(locale, "notification.content.title"),
		Content:    content,
		Timestamp:  formatNotificationTime(now, settings.Timezone),
		Items:      items,
		HasPayload: hasPayload,
	}
}

func formatNotificationItemLine(item notificationContentItem, locale appLocale) string {
	extra := serverFormat(locale, "notification.content.reminderDays", map[string]interface{}{"days": item.ReminderDays})
	if item.Type == "trial" {
		extra = serverFormat(locale, "notification.content.trialReminderDays", map[string]interface{}{"days": item.ReminderDays})
	} else if item.Type == "expiry" {
		extra = serverFormat(locale, "notification.content.expiryReminderDays", map[string]interface{}{"days": item.ReminderDays})
	} else if item.Type == "expired" {
		extra = serverText(locale, "notification.content.expiredStatus")
	} else if item.Type == "costSharing" && item.CostSharing != nil {
		extra = serverFormat(locale, "notification.content.costSharingReminderDays", map[string]interface{}{
			"member": item.CostSharing.MemberName,
			"days":   item.ReminderDays,
		})
	}
	if item.RepeatReminder != nil {
		extra += serverText(locale, "notification.content.repeatSeparator") + formatRepeatReminderText(item.RepeatReminder.Interval, locale)
	}
	amount := item.Price
	currency := item.Currency
	if item.Type == "costSharing" && item.CostSharing != nil {
		amount = item.CostSharing.Amount
		currency = item.CostSharing.Currency
	}
	return serverFormat(locale, "notification.content.itemLine", map[string]interface{}{
		"name":       item.Name,
		"targetDate": item.TargetDate,
		"amount":     formatAmount(amount),
		"currency":   currency,
		"extra":      extra,
	})
}

func formatRepeatReminderText(interval string, locale appLocale) string {
	hours := repeatReminderIntervalHours(interval)
	return serverFormat(locale, "notification.content.repeatEvery", map[string]interface{}{"hours": hours})
}

func formatAmount(amount string) string {
	return moneyForRecord(amount)
}

func formatNotificationTime(now time.Time, timezone string) string {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = time.UTC
		timezone = "UTC"
	}
	return now.In(loc).Format("2006-01-02 15:04:05") + " " + timezone
}

func normalizeSubscriptionStatus(status string) string {
	switch status {
	case "trial", "active", "paused", "cancelled":
		return status
	default:
		return "active"
	}
}
