package main

// subscription_routes.go 承载绕过 PocketBase SDK 形状的订阅专用 API。
//
// 这里输出前端稳定 DTO，并把手动续订限制在当前 owner、非自动续订、非 one-time 订阅上。
import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

type subscriptionResponse struct {
	Subscription subscriptionDetailResponse `json:"subscription"`
}

type subscriptionDetailResponse struct {
	subscriptionCollectionItemResponse
	Website                *string                `json:"website,omitempty"`
	Notes                  *string                `json:"notes,omitempty"`
	Tags                   []string               `json:"tags"`
	RepeatReminderEnabled  bool                   `json:"repeatReminderEnabled"`
	RepeatReminderInterval string                 `json:"repeatReminderInterval"`
	RepeatReminderWindow   string                 `json:"repeatReminderWindow"`
	Extra                  map[string]interface{} `json:"extra"`
	CreatedAt              string                 `json:"createdAt,omitempty"`
	UpdatedAt              string                 `json:"updatedAt,omitempty"`
}

var errSubscriptionRenewConflict = errors.New("SUBSCRIPTION_RENEW_CONFLICT")
var errSubscriptionRenewNotAllowed = errors.New("SUBSCRIPTION_RENEW_NOT_ALLOWED")

// handleSubscriptionRenew 按用户选择延续或重开当前订阅；Renewlet 只更新账本状态，不生成付款流水。
func handleSubscriptionRenew(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionRenewRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	id := strings.TrimSpace(e.Request.PathValue("id"))
	var response subscriptionDetailResponse
	// owner 查询与版本检查必须进入同一事务；仅在 Save 内开事务会让两个请求读取同一旧账单日。
	err = app.RunInTransaction(func(tx core.App) error {
		record, err := tx.FindFirstRecordByFilter("subscriptions", "id = {:id} && user = {:user}", dbx.Params{"id": id, "user": e.Auth.Id})
		if err != nil {
			return err
		}
		if record.GetString("nextBillingDate") != body.ExpectedNextBillingDate || record.GetDateTime("updated").Time().UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano) != body.ExpectedUpdatedAt {
			return errSubscriptionRenewConflict
		}
		input := subscriptionRenewalInputFromRecord(record)
		if !isManualRenewEligible(input) {
			return errSubscriptionRenewNotAllowed
		}
		today := todayDateOnly(time.Now(), currentUserSettingsTimezone(tx, e.Auth))
		if body.Mode == "continue" {
			result, ok, err := advanceSubscriptionRenewal(input, today, renewalModeManual)
			if err != nil {
				return e.BadRequestError(serverText(locale, "subscription.renewInvalidDate"), err)
			}
			if !ok {
				return errSubscriptionRenewNotAllowed
			}
			// 服务端拥有日期真相，但不能静默保存与用户确认预览不同的结果（跨午夜或周期修改）。
			if result.NextBillingDate != body.NextBillingDate {
				return errSubscriptionRenewConflict
			}
			record.Set("nextBillingDate", result.NextBillingDate)
			record.Set("status", result.Status)
		} else {
			record.Set("startDate", body.StartDate.Value)
			record.Set("nextBillingDate", body.NextBillingDate)
			record.Set("autoCalculateNextBillingDate", body.AutoCalculateNextBillingDate)
			if record.GetString("status") == "expired" {
				record.Set("status", "active")
			}
		}
		record.Set("price", body.Price)
		record.Set("currency", body.Currency)
		// 续订只写本次确认的字段；余额及家庭共享仍由最新事实和原有 hook/派生事务保护。
		// 校验与落库仍在同一事务内；分开执行才能让输入错误返回 400，而存储故障保持 500。
		if err := tx.Validate(record); err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		if err := tx.SaveNoValidate(record); err != nil {
			return err
		}
		response = subscriptionAPIFromRecord(record)
		return nil
	})
	if errors.Is(err, sql.ErrNoRows) {
		return e.NotFoundError("SUBSCRIPTION_NOT_FOUND", nil)
	}
	if errors.Is(err, errSubscriptionRenewConflict) {
		return apiErrorJSON(e, http.StatusConflict, "SUBSCRIPTION_RENEW_CONFLICT", serverText(locale, "subscription.renewConflict"), nil)
	}
	if errors.Is(err, errSubscriptionRenewNotAllowed) {
		return apiErrorJSON(e, http.StatusBadRequest, "SUBSCRIPTION_RENEW_NOT_ALLOWED", serverText(locale, "subscription.renewNotAllowed"), nil)
	}
	if err != nil {
		var apiErr *router.ApiError
		if errors.As(err, &apiErr) {
			return err
		}
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionResponse{Subscription: response})
}

func subscriptionAPIFromRecord(record *core.Record) subscriptionDetailResponse {
	out := subscriptionDetailResponse{
		subscriptionCollectionItemResponse: subscriptionCollectionAPIFromRecord(record),
		Website:                            trimmedSubscriptionString(record.GetString("website")),
		Notes:                              trimmedSubscriptionString(record.GetString("notes")),
		Tags:                               subscriptionRecordStringSlice(record, "tags"),
		RepeatReminderEnabled:              record.GetBool("repeatReminderEnabled"),
		RepeatReminderInterval:             normalizeRepeatReminderInterval(record.GetString("repeatReminderInterval")),
		RepeatReminderWindow:               normalizeRepeatReminderWindow(record.GetString("repeatReminderWindow")),
		Extra:                              subscriptionRecordJSONMap(record, "extra"),
	}
	if !record.GetDateTime("created").IsZero() {
		out.CreatedAt = record.GetDateTime("created").Time().UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)
	}
	// DTO 与 PocketBase 的毫秒持久化精度一致，避免保存响应与随后读取形成两个版本。
	if !record.GetDateTime("updated").IsZero() {
		out.UpdatedAt = record.GetDateTime("updated").Time().UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)
	}
	return out
}

func subscriptionRecordJSONMap(record *core.Record, name string) map[string]interface{} {
	data, err := jsonBytesFromValue(record.Get(name))
	if err != nil || len(data) == 0 {
		return map[string]interface{}{}
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(data, &decoded); err != nil || decoded == nil {
		return map[string]interface{}{}
	}
	return decoded
}

func currentUserSettingsTimezone(app core.App, user *core.Record) string {
	settings, err := currentUserSettings(app, user)
	if err != nil {
		return defaultAppSettings().Timezone
	}
	return settings.Timezone
}
