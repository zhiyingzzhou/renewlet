package main

// app_data_routes.go 承载 Docker/Go 运行面的 Renewlet 产品数据 API。
//
// 前端业务数据统一走 `/api/app/*`，不再按 Docker/Cloudflare 分叉到 PocketBase collection REST。
// Route 只处理严格 JSON、owner 查询和响应 DTO；最终写入仍交给 PocketBase hooks 做持久层规范化。
import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type settingsResponse struct {
	Settings     publicAppSettings                         `json:"settings"`
	SecretStatus map[string]settingsSecretConfiguredStatus `json:"secretStatus"`
}

type customConfigResponse struct {
	Config customConfigPayload `json:"config"`
}

type publicSubscriptionCursorPayload struct {
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

type privateSubscriptionCursorPayload struct {
	Version   int    `json:"v"`
	AsOf      string `json:"asOf"`
	Pinned    int    `json:"pinned"`
	Inactive  int    `json:"inactive"`
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

type uploadedAssetItem struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	Kind         string `json:"kind"`
	OriginalName string `json:"originalName,omitempty"`
	MimeType     string `json:"mimeType,omitempty"`
	SizeBytes    *int   `json:"sizeBytes,omitempty"`
	Created      string `json:"created,omitempty"`
	Updated      string `json:"updated,omitempty"`
}

type uploadedAssetsPageResponse struct {
	Items      []uploadedAssetItem `json:"items"`
	Page       int                 `json:"page"`
	TotalPages int                 `json:"totalPages"`
}

type uploadAssetResponse struct {
	URL string `json:"url"`
}

// 与 Cloudflare Worker 的上传 envelope 口径一致：multipart 头部最多放宽 64KiB，不能把 2MiB 文件限额变成大 body 入口。
const maxAssetUploadBodyBytes = maxImageBytes + 64*1024

type assetInUseDetails struct {
	UsageCount             int64 `json:"usageCount"`
	SubscriptionLogoCount  int64 `json:"subscriptionLogoCount"`
	PaymentMethodIconCount int64 `json:"paymentMethodIconCount"`
}

type subscriptionWriteRequest struct {
	Name                         optionalJSONField[string]                 `json:"name"`
	Logo                         optionalJSONField[string]                 `json:"logo"`
	Price                        optionalJSONField[string]                 `json:"price"`
	Currency                     optionalJSONField[string]                 `json:"currency"`
	BillingCycle                 optionalJSONField[string]                 `json:"billingCycle"`
	CustomDays                   optionalJSONField[int]                    `json:"customDays"`
	CustomCycleUnit              optionalJSONField[string]                 `json:"customCycleUnit"`
	OneTimeTermCount             optionalJSONField[int]                    `json:"oneTimeTermCount"`
	OneTimeTermUnit              optionalJSONField[string]                 `json:"oneTimeTermUnit"`
	Category                     optionalJSONField[string]                 `json:"category"`
	Status                       optionalJSONField[string]                 `json:"status"`
	Pinned                       optionalJSONField[bool]                   `json:"pinned"`
	PublicHidden                 optionalJSONField[bool]                   `json:"publicHidden"`
	PaymentMethod                optionalJSONField[string]                 `json:"paymentMethod"`
	StartDate                    optionalJSONField[string]                 `json:"startDate"`
	NextBillingDate              optionalJSONField[string]                 `json:"nextBillingDate"`
	AutoRenew                    optionalJSONField[bool]                   `json:"autoRenew"`
	AutoCalculateNextBillingDate optionalJSONField[bool]                   `json:"autoCalculateNextBillingDate"`
	TrialEndDate                 optionalJSONField[string]                 `json:"trialEndDate"`
	Website                      optionalJSONField[string]                 `json:"website"`
	Notes                        optionalJSONField[string]                 `json:"notes"`
	Tags                         optionalJSONField[[]string]               `json:"tags"`
	ReminderDays                 optionalJSONField[int]                    `json:"reminderDays"`
	RepeatReminderEnabled        optionalJSONField[bool]                   `json:"repeatReminderEnabled"`
	RepeatReminderInterval       optionalJSONField[string]                 `json:"repeatReminderInterval"`
	RepeatReminderWindow         optionalJSONField[string]                 `json:"repeatReminderWindow"`
	CostSharing                  optionalJSONField[map[string]interface{}] `json:"costSharing"`
	Extra                        optionalJSONField[map[string]interface{}] `json:"extra"`
}

type optionalJSONField[T any] struct {
	Set   bool
	Null  bool
	Value T
}

// subscription PATCH 必须区分缺字段、显式 null 和零值；普通指针结构体会把三者合并掉。
func (f *optionalJSONField[T]) UnmarshalJSON(data []byte) error {
	f.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		f.Null = true
		var zero T
		f.Value = zero
		return nil
	}
	return json.Unmarshal(data, &f.Value)
}

func handleSettingsRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	_, settings, err := ensureSettingsRecord(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, newSettingsResponse(settings))
}

func handleSettingsUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	// settings 是 JSON merge 边界：先保留 raw payload，再由 shared merge 规则决定哪些字段可写。
	raw, err := readLimitedJSONBody(e.Request.Body)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}

	record, current, err := settingsRecordOrDefault(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}

	next, err := mergeSettingsRequest(current, raw, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := demoModePolicy.RejectSettingsSecretMutation(e, current, next); err != nil {
		return err
	}
	if err := rejectInstalledTelegramBotSettingsChange(app, e.Auth.Id, current, next); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	var saved appSettings
	var validationErr error
	err = app.RunInTransaction(func(txApp core.App) error {
		if record == nil {
			record, err = createSettingsRecord(txApp, e.Auth.Id, next)
			if err != nil {
				return err
			}
		} else {
			record.Set("settings", next)
			if err := txApp.Save(record); err != nil {
				validationErr = err
				return err
			}
		}
		if costSharingScheduleSettingsChanged(current, next) {
			if err := refreshCostSharingCollectionReminderMirrorsForUser(txApp, e.Auth.Id, next, costSharingCollectionReminderReferenceDate(next, time.Now().UTC())); err != nil {
				return err
			}
		}
		if subscriptionScheduleSettingsChanged(current, next) {
			if _, err := refreshSubscriptionSchedulerState(txApp, e.Auth.Id, false); err != nil {
				return err
			}
		}
		saved, err = settingsFromRecord(record)
		return err
	})
	if err != nil {
		if validationErr != nil {
			return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", validationErr), validationErr)
		}
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, newSettingsResponse(saved))
}

func subscriptionScheduleSettingsChanged(before appSettings, after appSettings) bool {
	return before.NotificationTimeLocal != after.NotificationTimeLocal || costSharingScheduleSettingsChanged(before, after)
}

func costSharingScheduleSettingsChanged(before appSettings, after appSettings) bool {
	return before.Timezone != after.Timezone ||
		before.NotificationReminderDays != after.NotificationReminderDays
}

func handleCustomConfigRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	config := customConfigPayload{
		Categories:     []customConfigItem{},
		Statuses:       []customConfigItem{},
		PaymentMethods: []customConfigItem{},
		Currencies:     []customConfigItem{},
	}
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": e.Auth.Id})
	if err == nil && record != nil {
		config, err = customConfigFromValue(record.Get("config"))
		if err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		if err := normalizeCustomConfigPayload(&config); err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, customConfigResponse{Config: config})
}

func handleCustomConfigUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[customConfigResponse](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := normalizeCustomConfigPayload(&body.Config); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}

	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": e.Auth.Id})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if record == nil {
		collection, err := app.FindCollectionByNameOrId("custom_configs")
		if err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		record = core.NewRecord(collection)
		record.Set("user", e.Auth.Id)
	}
	record.Set("config", body.Config)
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return apiSuccessJSON(e, http.StatusOK, customConfigResponse{Config: body.Config})
}

func handleSubscriptionCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionWriteRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	record := core.NewRecord(collection)
	record.Set("user", e.Auth.Id)
	if err := applySubscriptionWriteRequest(record, body, true); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return apiSuccessJSON(e, http.StatusCreated, subscriptionResponse{Subscription: subscriptionAPIFromRecord(record)})
}

func handleSubscriptionUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionWriteRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !body.HasChanges() {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	record, err := findOwnedSubscription(app, e)
	if err != nil {
		return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
	}
	withoutVisibility := body
	withoutVisibility.PublicHidden = optionalJSONField[bool]{}
	if body.PublicHidden.Set && !withoutVisibility.HasChanges() {
		return handleSinglePublicVisibilityUpdate(app, e, record, body.PublicHidden)
	}
	if err := applySubscriptionWriteRequest(record, body, false); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionResponse{Subscription: subscriptionAPIFromRecord(record)})
}

func handleSubscriptionDelete(app core.App, e *core.RequestEvent) error {
	record, err := findOwnedSubscription(app, e)
	if err != nil {
		return e.NotFoundError(serverText(requestLocale(e.Request), "subscription.notFound"), err)
	}
	if err := app.Delete(record); err != nil {
		return e.BadRequestError(serverText(requestLocale(e.Request), "common.invalidRequestParameters"), err)
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func handleAssetUpload(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	// multipart envelope 只放宽表单头部开销；真实文件大小仍由 maxImageBytes 和持久层 MIME 白名单兜底。
	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, maxAssetUploadBodyBytes)
	if err := e.Request.ParseMultipartForm(maxImageBytes + 1024); err != nil {
		return e.BadRequestError(serverText(locale, "asset.uploadChooseImage"), err)
	}
	kind := strings.TrimSpace(e.Request.FormValue("kind"))
	if kind != "logo" && kind != "icon" {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	files, err := e.FindUploadedFiles("file")
	if err != nil || len(files) == 0 {
		return e.BadRequestError(serverText(locale, "asset.uploadChooseImage"), err)
	}
	if len(files) > 1 {
		return e.BadRequestError(serverText(locale, "asset.invalidImageSize"), nil)
	}
	collection, err := app.FindCollectionByNameOrId("assets")
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	record := core.NewRecord(collection)
	record.Set("user", e.Auth.Id)
	record.Set("kind", kind)
	// 文件内容白名单和 MIME 以 normalizeAssetRecord 为准；route 不信任浏览器 Content-Type 或扩展名。
	record.Set("file", files[0])
	if err := app.Save(record); err != nil {
		return e.BadRequestError(serverText(locale, "asset.invalidImageType"), err)
	}
	return apiSuccessJSON(e, http.StatusCreated, uploadAssetResponse{URL: "/api/app/assets/" + record.Id})
}

func handleAssetsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	kind := "logo"
	if e.Request.URL.Query().Get("kind") == "icon" {
		kind = "icon"
	}
	page, err := parsePositiveQueryInt(e.Request.URL.Query().Get("page"), 1, 1, 1_000_000)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	perPage, err := parsePositiveQueryInt(e.Request.URL.Query().Get("perPage"), 48, 1, 96)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	offset := (page - 1) * perPage
	// 资产列表是私有 Logo 选择器的数据源；user + kind 同查，避免把上传接口变成跨用户枚举器。
	rows, err := app.FindRecordsByFilter("assets", "user = {:user} && kind = {:kind}", "-updated", perPage, offset, dbx.Params{"user": e.Auth.Id, "kind": kind})
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	total, err := app.CountRecords("assets", dbx.HashExp{"user": e.Auth.Id, "kind": kind})
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	items := make([]uploadedAssetItem, 0, len(rows))
	for _, record := range rows {
		items = append(items, uploadedAssetItemFromRecord(record))
	}
	return apiSuccessJSON(e, http.StatusOK, uploadedAssetsPageResponse{
		Items:      items,
		Page:       page,
		TotalPages: int((total + int64(perPage) - 1) / int64(perPage)),
	})
}

func handleAssetDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return e.BadRequestError(serverText(locale, "asset.idInvalid"), nil)
	}
	record, err := app.FindRecordById("assets", id)
	if err != nil || record.GetString("user") != e.Auth.Id {
		// 删除和读取一样对越权返回 404，避免资产 ID 被拿来枚举其他用户上传记录。
		return e.NotFoundError(serverText(locale, "asset.missing"), err)
	}

	usage, err := countAssetReferences(app, e.Auth.Id, record.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if usage.UsageCount > 0 {
		// 上传图标有两个持久引用入口；删除只阻止，不替用户改订阅或支付方式配置。
		return apiErrorJSON(e, http.StatusConflict, "ASSET_IN_USE", serverText(locale, "asset.inUse"), usage)
	}

	if err := app.Delete(record); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func countAssetReferences(app core.App, userID string, assetID string) (assetInUseDetails, error) {
	assetURL := "/api/app/assets/" + assetID
	subscriptionLogoCount, err := app.CountRecords("subscriptions", dbx.HashExp{"user": userID, "logo": assetURL})
	if err != nil {
		return assetInUseDetails{}, err
	}
	paymentMethodIconCount, err := countPaymentMethodIconReferences(app, userID, assetURL)
	if err != nil {
		return assetInUseDetails{}, err
	}
	return assetInUseDetails{
		UsageCount:             subscriptionLogoCount + paymentMethodIconCount,
		SubscriptionLogoCount:  subscriptionLogoCount,
		PaymentMethodIconCount: paymentMethodIconCount,
	}, nil
}

func countPaymentMethodIconReferences(app core.App, userID string, assetURL string) (int64, error) {
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	config, err := customConfigFromValue(record.Get("config"))
	if err != nil {
		return 0, err
	}
	if err := normalizeCustomConfigPayload(&config); err != nil {
		return 0, err
	}
	var count int64
	for _, item := range config.PaymentMethods {
		if item.Icon == assetURL {
			count++
		}
	}
	return count, nil
}

func readLimitedJSONBody(reader io.Reader) (json.RawMessage, error) {
	if reader == nil {
		return nil, errEmptyJSONBody
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxJSONBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxJSONBodyBytes {
		return nil, errors.New("JSON body too large")
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, errEmptyJSONBody
	}
	return json.RawMessage(data), nil
}

func findOwnedSubscription(app core.App, e *core.RequestEvent) (*core.Record, error) {
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	return app.FindFirstRecordByFilter(
		"subscriptions",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": subscriptionID, "user": e.Auth.Id},
	)
}

func (r subscriptionWriteRequest) HasChanges() bool {
	return r.Name.Set || r.Logo.Set || r.Price.Set || r.Currency.Set || r.BillingCycle.Set || r.CustomDays.Set ||
		r.CustomCycleUnit.Set || r.OneTimeTermCount.Set || r.OneTimeTermUnit.Set || r.Category.Set || r.Status.Set ||
		r.Pinned.Set || r.PublicHidden.Set || r.PaymentMethod.Set || r.StartDate.Set || r.NextBillingDate.Set ||
		r.AutoRenew.Set || r.AutoCalculateNextBillingDate.Set || r.TrialEndDate.Set || r.Website.Set || r.Notes.Set ||
		r.Tags.Set || r.ReminderDays.Set || r.RepeatReminderEnabled.Set || r.RepeatReminderInterval.Set ||
		r.RepeatReminderWindow.Set || r.CostSharing.Set || r.Extra.Set
}

func applySubscriptionWriteRequest(record *core.Record, body subscriptionWriteRequest, create bool) error {
	if err := setStringRecordField(record, "name", body.Name, create, false, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "logo", body.Logo, false, true, true); err != nil {
		return err
	}
	if err := setMoneyRecordField(record, "price", body.Price, create); err != nil {
		return err
	}
	if err := setStringRecordField(record, "currency", body.Currency, create, false, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "billingCycle", body.BillingCycle, create, false, true); err != nil {
		return err
	}
	if err := setIntRecordField(record, "customDays", body.CustomDays, false, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "customCycleUnit", body.CustomCycleUnit, false, true, true); err != nil {
		return err
	}
	if err := setIntRecordField(record, "oneTimeTermCount", body.OneTimeTermCount, false, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "oneTimeTermUnit", body.OneTimeTermUnit, false, true, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "category", body.Category, create, false, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "status", body.Status, create, false, true); err != nil {
		return err
	}
	if err := setBoolRecordField(record, "pinned", body.Pinned, false); err != nil {
		return err
	}
	if err := setBoolRecordField(record, "publicHidden", body.PublicHidden, false); err != nil {
		return err
	}
	if err := setStringRecordField(record, "paymentMethod", body.PaymentMethod, false, true, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "startDate", body.StartDate, false, true, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "nextBillingDate", body.NextBillingDate, create, false, true); err != nil {
		return err
	}
	if err := setBoolRecordField(record, "autoRenew", body.AutoRenew, false); err != nil {
		return err
	}
	if err := setBoolRecordField(record, "autoCalculateNextBillingDate", body.AutoCalculateNextBillingDate, create); err != nil {
		return err
	}
	if err := setStringRecordField(record, "trialEndDate", body.TrialEndDate, false, true, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "website", body.Website, false, true, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "notes", body.Notes, false, true, false); err != nil {
		return err
	}
	if err := setStringSliceRecordField(record, "tags", body.Tags, false); err != nil {
		return err
	}
	if err := setIntRecordField(record, "reminderDays", body.ReminderDays, create, false); err != nil {
		return err
	}
	if err := setBoolRecordField(record, "repeatReminderEnabled", body.RepeatReminderEnabled, create); err != nil {
		return err
	}
	if err := setStringRecordField(record, "repeatReminderInterval", body.RepeatReminderInterval, create, false, true); err != nil {
		return err
	}
	if err := setStringRecordField(record, "repeatReminderWindow", body.RepeatReminderWindow, create, false, true); err != nil {
		return err
	}
	if err := setNullableMapRecordField(record, "costSharing", body.CostSharing, false); err != nil {
		return err
	}
	if err := setMapRecordField(record, "extra", body.Extra, false); err != nil {
		return err
	}
	if create {
		if !body.Tags.Set {
			record.Set("tags", []string{})
		}
		if !body.Extra.Set {
			record.Set("extra", emptyJSONPayload{})
		}
		if !body.CostSharing.Set {
			record.Set("costSharing", emptyJSONPayload{})
		}
	}
	return nil
}

func setStringRecordField(record *core.Record, name string, field optionalJSONField[string], required bool, nullable bool, trim bool) error {
	if !field.Set {
		if required {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		return nil
	}
	if field.Null {
		if !nullable {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		record.Set(name, "")
		return nil
	}
	value := field.Value
	if trim {
		value = strings.TrimSpace(value)
	}
	record.Set(name, value)
	return nil
}

func setMoneyRecordField(record *core.Record, name string, field optionalJSONField[string], required bool) error {
	if !field.Set {
		if required {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		return nil
	}
	if field.Null {
		return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
	}
	value, err := canonicalMoneyString(field.Value)
	if err != nil {
		return fmt.Errorf("%s_INVALID", strings.ToUpper(name))
	}
	record.Set(name, value)
	return nil
}

func setIntRecordField(record *core.Record, name string, field optionalJSONField[int], required bool, nullable bool) error {
	if !field.Set {
		if required {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		return nil
	}
	if field.Null {
		if !nullable {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		record.Set(name, 0)
		return nil
	}
	record.Set(name, field.Value)
	return nil
}

func setBoolRecordField(record *core.Record, name string, field optionalJSONField[bool], required bool) error {
	if !field.Set {
		if required {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		return nil
	}
	if field.Null {
		return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
	}
	record.Set(name, field.Value)
	return nil
}

func setStringSliceRecordField(record *core.Record, name string, field optionalJSONField[[]string], required bool) error {
	if !field.Set {
		if required {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		return nil
	}
	if field.Null {
		return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
	}
	record.Set(name, field.Value)
	return nil
}

func setMapRecordField(record *core.Record, name string, field optionalJSONField[map[string]interface{}], required bool) error {
	if !field.Set {
		if required {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		return nil
	}
	if field.Null {
		return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
	}
	record.Set(name, field.Value)
	return nil
}

func setNullableMapRecordField(record *core.Record, name string, field optionalJSONField[map[string]interface{}], required bool) error {
	if !field.Set {
		if required {
			return fmt.Errorf("%s_REQUIRED", strings.ToUpper(name))
		}
		return nil
	}
	if field.Null {
		record.Set(name, emptyJSONPayload{})
		return nil
	}
	record.Set(name, field.Value)
	return nil
}

func parsePositiveQueryInt(value string, fallback int, min int, max int) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < min || parsed > max {
		return 0, errors.New("invalid integer query")
	}
	return parsed, nil
}

func parsePublicSubscriptionCursorPayload(value string) (publicSubscriptionCursorPayload, error) {
	var cursor publicSubscriptionCursorPayload
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return cursor, err
	}
	if err := json.Unmarshal(data, &cursor); err != nil {
		return cursor, err
	}
	if strings.TrimSpace(cursor.CreatedAt) == "" || strings.TrimSpace(cursor.ID) == "" {
		return cursor, errors.New("invalid cursor")
	}
	return cursor, nil
}

func encodePublicSubscriptionCursor(record *core.Record) string {
	cursor := publicSubscriptionCursorPayload{
		// PocketBase filter 按 DefaultDateLayout 字符串比较 DateTime；cursor 不能使用对外 API 的 RFC3339 展示格式。
		CreatedAt: record.GetDateTime("created").String(),
		ID:        record.Id,
	}
	data, _ := json.Marshal(cursor)
	return base64.StdEncoding.EncodeToString(data)
}

func parsePrivateSubscriptionCursorPayload(value string) (privateSubscriptionCursorPayload, error) {
	var wire struct {
		Version   int    `json:"v"`
		AsOf      string `json:"asOf"`
		Pinned    *int   `json:"pinned"`
		Inactive  *int   `json:"inactive"`
		CreatedAt string `json:"createdAt"`
		ID        string `json:"id"`
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return privateSubscriptionCursorPayload{}, err
	}
	if err := decodeStrictJSONBytesInto(data, &wire, defaultAppLocale, false); err != nil {
		return privateSubscriptionCursorPayload{}, err
	}
	if wire.Version != 1 || !isValidDateOnly(wire.AsOf) || wire.Pinned == nil || wire.Inactive == nil ||
		(*wire.Pinned != 0 && *wire.Pinned != 1) || (*wire.Inactive != 0 && *wire.Inactive != 1) ||
		strings.TrimSpace(wire.CreatedAt) == "" || strings.TrimSpace(wire.ID) == "" {
		return privateSubscriptionCursorPayload{}, errors.New("invalid private subscription cursor")
	}
	return privateSubscriptionCursorPayload{
		Version: wire.Version, AsOf: wire.AsOf, Pinned: *wire.Pinned, Inactive: *wire.Inactive,
		CreatedAt: wire.CreatedAt, ID: wire.ID,
	}, nil
}

func encodePrivateSubscriptionCursor(row subscriptionListIndexRow, asOf string) string {
	// 私有列表冻结 asOf 并携带全部排序键；Public API 继续使用独立的旧 cursor，避免机器调用契约被 UI 排序演进污染。
	cursor := privateSubscriptionCursorPayload{
		Version: 1, AsOf: asOf, Pinned: row.Pinned, Inactive: row.Inactive,
		CreatedAt: row.CreatedAt, ID: row.SubscriptionID,
	}
	data, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(data)
}

func uploadedAssetItemFromRecord(record *core.Record) uploadedAssetItem {
	var sizeBytes *int
	if size := record.GetInt("sizeBytes"); size > 0 {
		sizeBytes = &size
	}
	return uploadedAssetItem{
		ID:           record.Id,
		URL:          "/api/app/assets/" + record.Id,
		Kind:         record.GetString("kind"),
		OriginalName: strings.TrimSpace(record.GetString("originalName")),
		MimeType:     strings.TrimSpace(record.GetString("mimeType")),
		SizeBytes:    sizeBytes,
		Created:      recordTimeString(record, "created"),
		Updated:      recordTimeString(record, "updated"),
	}
}

func recordTimeString(record *core.Record, field string) string {
	value := record.GetDateTime(field)
	if value.IsZero() {
		return ""
	}
	return value.Time().UTC().Format(time.RFC3339Nano)
}
