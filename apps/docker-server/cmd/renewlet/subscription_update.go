package main

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

var (
	errSubscriptionEditVersionRequired = errors.New("SUBSCRIPTION_VERSION_REQUIRED")
	errSubscriptionEditConflict        = errors.New("SUBSCRIPTION_EDIT_CONFLICT")
	errSubscriptionResumeDates         = errors.New("SUBSCRIPTION_RESUME_DATES")
)

func handleSubscriptionUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[struct {
		subscriptionWriteRequest
		ExpectedUpdatedAt optionalJSONField[string] `json:"expectedUpdatedAt"`
	}](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	patch := body.subscriptionWriteRequest
	if !patch.HasChanges() || (body.ExpectedUpdatedAt.Set && !patch.Status.Set) {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	withoutVisibility := patch
	withoutVisibility.PublicHidden = optionalJSONField[bool]{}
	if patch.PublicHidden.Set && !withoutVisibility.HasChanges() {
		record, err := findOwnedSubscription(app, e)
		if err != nil {
			return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
		}
		return handleSinglePublicVisibilityUpdate(app, e, record, patch.PublicHidden)
	}
	var response subscriptionDetailResponse

	// 原始版本、归属和状态切换必须在同一事务内判断，否则旧页面会用完整表单覆盖刚刚暂停的记录。
	err = app.RunInTransaction(func(tx core.App) error {
		record, err := findOwnedSubscription(tx, e)
		if err != nil {
			return err
		}
		if patch.Status.Set {
			if !body.ExpectedUpdatedAt.Set {
				return errSubscriptionEditVersionRequired
			}
			if _, err := time.Parse(time.RFC3339Nano, body.ExpectedUpdatedAt.Value); err != nil {
				return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
			}
			if subscriptionRecordVersion(record) != body.ExpectedUpdatedAt.Value {
				return errSubscriptionEditConflict
			}
		}
		paused := record.GetString("status") == "paused"
		if err := applySubscriptionWriteRequest(record, patch, false); err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		status := record.GetString("status")
		if paused && (status == "active" || status == "trial") {
			settings, err := currentUserSettings(tx, e.Auth)
			if err != nil {
				return err
			}
			today := todayDateOnly(time.Now(), settings.Timezone)
			buyout := record.GetString("billingCycle") == "one-time" && record.GetInt("oneTimeTermCount") == 0
			trialEnd := record.GetString("trialEndDate")
			if (!buyout && record.GetString("nextBillingDate") < today) || (status == "trial" && trialEnd != "" && trialEnd < today) {
				return errSubscriptionResumeDates
			}
		}
		validationRecord := record
		withoutStatus := patch
		withoutStatus.Status = optionalJSONField[string]{}
		if patch.Status.Set && !withoutStatus.HasChanges() {
			// 通用校验会按今天重算收款日期。纯状态写入在副本执行完整校验，保存原记录上的状态和既有待收款日期。
			validationRecord = record.Clone()
		}
		if err := tx.Validate(validationRecord); err != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
		}
		if err := tx.SaveNoValidate(record); err != nil {
			return err
		}
		response = subscriptionAPIFromRecord(record)
		return nil
	})
	if errors.Is(err, sql.ErrNoRows) {
		return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
	}
	if errors.Is(err, errSubscriptionEditVersionRequired) {
		return apiErrorJSON(e, 400, "SUBSCRIPTION_VERSION_REQUIRED", serverText(locale, "subscription.editVersionRequired"), nil)
	}
	if errors.Is(err, errSubscriptionEditConflict) {
		return apiErrorJSON(e, 409, "SUBSCRIPTION_EDIT_CONFLICT", serverText(locale, "subscription.editConflict"), nil)
	}
	if errors.Is(err, errSubscriptionResumeDates) {
		return apiErrorJSON(e, 400, "SUBSCRIPTION_RESUME_DATES", serverText(locale, "subscription.resumeDates"), nil)
	}
	if err != nil {
		return err
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionResponse{Subscription: response})
}
