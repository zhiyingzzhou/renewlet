package main

// subscription_renewal.go 是 Go/PocketBase 运行面的订阅续订算法。
//
// 架构位置：shared TypeScript 版本是事实源，Go 版通过同一组 JSON fixture 对齐，
// 供 Docker cron、通知生成前维护和手动续订 API 使用。
//
// 注意：所有输入输出都是 date-only 字符串，不引入服务器本地时区；today 由调用方按用户时区生成。
import (
	"errors"
	"strings"
	"time"
)

type renewalMode string

const (
	renewalModeAuto   renewalMode = "auto"
	renewalModeManual renewalMode = "manual"
	maxAdvanceCycles              = 20000
)

type subscriptionRenewalInput struct {
	BillingCycle                 string
	Status                       string
	StartDate                    string
	NextBillingDate              string
	AutoRenew                    bool
	AutoCalculateNextBillingDate bool
	CustomDays                   int
	CustomCycleUnit              string
}

type subscriptionRenewalResult struct {
	NextBillingDate string
	Status          string
}

func subscriptionRenewalInputFromRecord(record subscriptionRecordReader) subscriptionRenewalInput {
	return subscriptionRenewalInput{
		BillingCycle:                 record.GetString("billingCycle"),
		Status:                       record.GetString("status"),
		StartDate:                    record.GetString("startDate"),
		NextBillingDate:              record.GetString("nextBillingDate"),
		AutoRenew:                    record.GetBool("autoRenew"),
		AutoCalculateNextBillingDate: record.GetBool("autoCalculateNextBillingDate"),
		CustomDays:                   record.GetInt("customDays"),
		CustomCycleUnit:              record.GetString("customCycleUnit"),
	}
}

type subscriptionRecordReader interface {
	GetString(string) string
	GetBool(string) bool
	GetInt(string) int
}

func hasRenewalAnchor(input subscriptionRenewalInput) bool {
	if input.AutoCalculateNextBillingDate {
		return isValidDateOnly(input.StartDate)
	}
	return isValidDateOnly(input.NextBillingDate)
}

func isAutoRenewEligible(input subscriptionRenewalInput, today string) bool {
	// 自动续订只处理已经落后于用户本地 today 的 active/trial 周期订阅，缺省 false 不能被解释成授权。
	return input.AutoRenew &&
		input.BillingCycle != "one-time" &&
		(input.Status == "active" || input.Status == "trial") &&
		isValidDateOnly(input.NextBillingDate) &&
		hasRenewalAnchor(input) &&
		isValidDateOnly(today) &&
		input.NextBillingDate < today
}

func isManualRenewEligible(input subscriptionRenewalInput) bool {
	// 手动续订允许 expired 重新回到 active，但排除 autoRenew=true，避免和维护 cron 同时推进。
	return !input.AutoRenew &&
		input.BillingCycle != "one-time" &&
		(input.Status == "active" || input.Status == "trial" || input.Status == "expired") &&
		isValidDateOnly(input.NextBillingDate) &&
		hasRenewalAnchor(input)
}

func advanceSubscriptionRenewal(input subscriptionRenewalInput, today string, mode renewalMode) (subscriptionRenewalResult, bool, error) {
	switch mode {
	case renewalModeAuto:
		if !isAutoRenewEligible(input, today) {
			return subscriptionRenewalResult{}, false, nil
		}
	case renewalModeManual:
		if !isManualRenewEligible(input) {
			return subscriptionRenewalResult{}, false, nil
		}
	default:
		return subscriptionRenewalResult{}, false, errors.New("SUBSCRIPTION_RENEWAL_MODE_INVALID")
	}

	nextBillingDate, err := advanceBillingDate(input, today, mode)
	if err != nil {
		return subscriptionRenewalResult{}, false, err
	}
	status := input.Status
	if mode == renewalModeManual && status == "expired" {
		status = "active"
	}
	return subscriptionRenewalResult{NextBillingDate: nextBillingDate, Status: status}, true, nil
}

func advanceBillingDate(input subscriptionRenewalInput, today string, mode renewalMode) (string, error) {
	if input.BillingCycle == "one-time" {
		return "", errors.New("SUBSCRIPTION_RENEWAL_ONE_TIME_NOT_RENEWABLE")
	}
	original, err := parseDateOnly(input.NextBillingDate)
	if err != nil {
		return "", err
	}
	todayDate, err := parseDateOnly(today)
	if err != nil {
		return "", err
	}
	anchorValue := input.NextBillingDate
	if input.AutoCalculateNextBillingDate {
		anchorValue = input.StartDate
	}
	anchor, err := parseDateOnly(anchorValue)
	if err != nil {
		return "", err
	}
	threshold := todayDate
	if mode == renewalModeManual && original.After(todayDate) {
		threshold = original
	}
	// 手动续订 strict=true：即使当前日期还没到，也至少推进一期，防止按钮点击后看起来“没有变化”。
	return firstCycleDateAfter(anchor, input, threshold, mode == renewalModeManual)
}

func firstCycleDateAfter(anchor time.Time, input subscriptionRenewalInput, threshold time.Time, strict bool) (string, error) {
	cycleCount := initialCycleCount(anchor, input, threshold, strict)
	// 每次从原锚点夹取目标月底；月份距离已定位目标附近，最多修正一期，不能逐期遍历历史。
	for attempts := 0; attempts < 2; attempts++ {
		if exactDayStep(input) == 0 && cycleCount > maxAdvanceCycles {
			break
		}
		candidate, err := addBillingCyclesDate(anchor, input.BillingCycle, cycleCount, input.CustomDays, input.CustomCycleUnit)
		if err != nil {
			return "", err
		}
		if (!strict && !candidate.Before(threshold)) || (strict && candidate.After(threshold)) {
			value := formatDateOnly(candidate)
			if !isValidDateOnly(value) {
				return "", errors.New("SUBSCRIPTION_RENEWAL_DATE_OUT_OF_RANGE")
			}
			return value, nil
		}
		cycleCount++
	}
	return "", errors.New("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED")
}

func initialCycleCount(anchor time.Time, input subscriptionRenewalInput, threshold time.Time, strict bool) int {
	if dayStep := exactDayStep(input); dayStep > 0 {
		// time.Duration 在跨越约 292 年时饱和；UTC date-only 用 Unix 秒差计算日距，保持与 Temporal 相同边界。
		distance := int((threshold.Unix() - anchor.Unix()) / 86400)
		if strict {
			distance++
		}
		return maxInt(1, (distance+dayStep-1)/dayStep)
	}
	months := (threshold.Year()-anchor.Year())*12 + int(threshold.Month()-anchor.Month())
	step := 1
	switch input.BillingCycle {
	case "quarterly":
		step = 3
	case "semi-annual":
		step = 6
	case "annual":
		step = 12
	case "custom":
		step = maxInt(1, input.CustomDays)
		if input.CustomCycleUnit == "year" {
			step *= 12
		}
	}
	return maxInt(1, (months+step-1)/step)
}

func exactDayStep(input subscriptionRenewalInput) int {
	if input.BillingCycle == "weekly" {
		return 7
	}
	if input.BillingCycle != "custom" {
		return 0
	}
	if input.CustomDays <= 0 {
		return 0
	}
	switch strings.TrimSpace(input.CustomCycleUnit) {
	case "day":
		return input.CustomDays
	case "week":
		return input.CustomDays * 7
	default:
		return 0
	}
}

func addBillingCyclesDate(anchor time.Time, cycle string, cycleCount int, customDays int, customCycleUnit string) (time.Time, error) {
	count := maxInt(1, cycleCount)
	switch cycle {
	case "weekly":
		return anchor.AddDate(0, 0, 7*count), nil
	case "monthly":
		return addDateClamped(anchor, 0, count), nil
	case "quarterly":
		return addDateClamped(anchor, 0, 3*count), nil
	case "semi-annual":
		return addDateClamped(anchor, 0, 6*count), nil
	case "annual":
		return addDateClamped(anchor, count, 0), nil
	case "custom":
		if customDays <= 0 || !isValidCustomCycleUnit(strings.TrimSpace(customCycleUnit)) {
			return time.Time{}, errors.New("SUBSCRIPTION_RENEWAL_CUSTOM_CYCLE_INVALID")
		}
		return addCustomBillingCyclesDate(anchor, customDays*count, customCycleUnit)
	case "one-time":
		return anchor, nil
	default:
		return time.Time{}, errors.New("SUBSCRIPTION_RENEWAL_BILLING_CYCLE_INVALID")
	}
}

func addCustomBillingCyclesDate(anchor time.Time, count int, unit string) (time.Time, error) {
	switch strings.TrimSpace(unit) {
	case "day":
		return anchor.AddDate(0, 0, count), nil
	case "week":
		return anchor.AddDate(0, 0, 7*count), nil
	case "month":
		return addDateClamped(anchor, 0, count), nil
	case "year":
		return addDateClamped(anchor, count, 0), nil
	default:
		return time.Time{}, errors.New("SUBSCRIPTION_RENEWAL_CUSTOM_CYCLE_INVALID")
	}
}

func addDateClamped(anchor time.Time, years int, months int) time.Time {
	// Go AddDate 会把 1 月 31 日 +1 月规范化到 3 月；续订契约需要和 Temporal 一样夹到目标月最后一天。
	year, month, day := anchor.Date()
	totalMonths := int(month) - 1 + months + years*12
	targetYear := year + totalMonths/12
	targetMonthIndex := totalMonths % 12
	if targetMonthIndex < 0 {
		targetMonthIndex += 12
		targetYear--
	}
	targetMonth := time.Month(targetMonthIndex + 1)
	targetDay := minInt(day, daysInMonth(targetYear, targetMonth))
	return time.Date(targetYear, targetMonth, targetDay, 0, 0, 0, 0, time.UTC)
}

func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func parseDateOnly(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed, nil
}

func formatDateOnly(value time.Time) string {
	return value.UTC().Format("2006-01-02")
}
