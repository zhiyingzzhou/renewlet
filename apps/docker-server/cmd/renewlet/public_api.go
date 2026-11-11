package main

// public_api.go 实现通用只读 Public API。
//
// 架构位置：
//   - 登录态 `/api/app/api-tokens` 只负责 token 生命周期管理。
//   - 公开 `/api/public/v1/*` 只接受 `Authorization: Bearer rlt_*`，不读取 session、日历 token 或公开页 token。
import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	publicAPITokenRandomBytes  = 32
	publicAPITokenPrefix       = "rlt_"
	publicAPITokenPrefixLength = 12
	publicAPIDueDefaultDays    = 30
	publicAPIDueMaxDays        = 366
	publicAPIDueResultLimit    = 500
)

var publicAPITokenRe = regexp.MustCompile(`^rlt_[A-Za-z0-9_-]{43}$`)
var bearerTokenHeaderRe = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)
var errPublicAPIInvalidCursor = errors.New("invalid public api cursor")

type apiTokenDTO struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	TokenPrefix string   `json:"tokenPrefix"`
	Scopes      []string `json:"scopes"`
	CreatedAt   string   `json:"createdAt"`
	LastUsedAt  *string  `json:"lastUsedAt,omitempty"`
}

type apiTokensListResponse struct {
	Tokens []apiTokenDTO `json:"tokens"`
}

type apiTokenCreateRequest struct {
	Name string `json:"name"`
}

func (r *apiTokenCreateRequest) Validate(locale appLocale) error {
	r.Name = strings.TrimSpace(r.Name)
	if r.Name == "" || len([]rune(r.Name)) > 80 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

type apiTokenCreateResponse struct {
	Token      apiTokenDTO `json:"token"`
	PlainToken string      `json:"plainToken"`
}

type publicAPIAuthContext struct {
	UserID string
	Scopes []string
}

type publicAPIMeResponse struct {
	Scopes []string `json:"scopes"`
}

type publicAPISubscriptionResponse struct {
	ID                           string                 `json:"id"`
	Name                         string                 `json:"name"`
	Logo                         *string                `json:"logo,omitempty"`
	Balance                      *string                `json:"balance,omitempty"`
	BalanceCurrency              *string                `json:"balanceCurrency,omitempty"`
	Price                        string                 `json:"price"`
	Currency                     string                 `json:"currency"`
	BillingCycle                 string                 `json:"billingCycle"`
	CustomDays                   int                    `json:"customDays,omitempty"`
	CustomCycleUnit              string                 `json:"customCycleUnit,omitempty"`
	OneTimeTermCount             int                    `json:"oneTimeTermCount,omitempty"`
	OneTimeTermUnit              string                 `json:"oneTimeTermUnit,omitempty"`
	Category                     string                 `json:"category"`
	Status                       string                 `json:"status"`
	Pinned                       bool                   `json:"pinned"`
	PublicHidden                 bool                   `json:"publicHidden"`
	PaymentMethod                *string                `json:"paymentMethod,omitempty"`
	StartDate                    *string                `json:"startDate"`
	NextBillingDate              string                 `json:"nextBillingDate"`
	AutoRenew                    bool                   `json:"autoRenew"`
	AutoCalculateNextBillingDate bool                   `json:"autoCalculateNextBillingDate"`
	TrialEndDate                 *string                `json:"trialEndDate,omitempty"`
	Website                      *string                `json:"website,omitempty"`
	Notes                        *string                `json:"notes,omitempty"`
	Tags                         []string               `json:"tags"`
	ReminderDays                 int                    `json:"reminderDays"`
	RepeatReminderEnabled        bool                   `json:"repeatReminderEnabled"`
	RepeatReminderInterval       string                 `json:"repeatReminderInterval"`
	RepeatReminderWindow         string                 `json:"repeatReminderWindow"`
	CostSharing                  map[string]interface{} `json:"costSharing,omitempty"`
	Extra                        map[string]interface{} `json:"extra"`
	CreatedAt                    string                 `json:"createdAt,omitempty"`
	UpdatedAt                    string                 `json:"updatedAt,omitempty"`
}

type publicAPISubscriptionEnvelope struct {
	Subscription publicAPISubscriptionResponse `json:"subscription"`
}

type publicAPISubscriptionsResponse struct {
	Subscriptions []publicAPISubscriptionResponse `json:"subscriptions"`
	NextCursor    *string                         `json:"nextCursor"`
	Total         int64                           `json:"total,omitempty"`
}

type publicAPIStatusResponse struct {
	GeneratedAt string           `json:"generatedAt"`
	Total       int64            `json:"total"`
	ByStatus    map[string]int64 `json:"byStatus"`
}

type publicAPIDueItem struct {
	DueDate      string                        `json:"dueDate"`
	DueType      string                        `json:"dueType"`
	Subscription publicAPISubscriptionResponse `json:"subscription"`
}

type publicAPIDueResponse struct {
	Days        int                `json:"days"`
	GeneratedAt string             `json:"generatedAt"`
	Items       []publicAPIDueItem `json:"items"`
}

func handleAPITokensList(app core.App, e *core.RequestEvent) error {
	rows, err := app.FindRecordsByFilter("api_tokens", "user = {:user}", "-created,-id", 200, 0, dbx.Params{"user": e.Auth.Id})
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	tokens := make([]apiTokenDTO, 0, len(rows))
	for _, row := range rows {
		tokens = append(tokens, apiTokenDTOFromRecord(row))
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, apiTokensListResponse{Tokens: tokens})
}

func handleAPITokenCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[apiTokenCreateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, plainToken, err := createAPITokenRecord(app, e.Auth.Id, body.Name)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	// 明文 token 只在创建响应出现一次；列表和数据库都只保留 prefix/hash。
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusCreated, apiTokenCreateResponse{
		Token:      apiTokenDTOFromRecord(record),
		PlainToken: plainToken,
	})
}

func handleAPITokenDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findAPITokenForUser(app, e.Auth.Id, strings.TrimSpace(e.Request.PathValue("id")))
	if err != nil {
		return e.NotFoundError(serverText(locale, "common.notFound"), err)
	}
	// 删除 token 是 Public API 鉴权安全边界；hash 行消失后，外部保存的旧明文只能得到 401。
	if err := app.Delete(record); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func handlePublicAPIMe(app core.App, e *core.RequestEvent) error {
	auth, err := authenticatePublicAPIRequest(app, e)
	if err != nil {
		return publicAPIAuthError(e, err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, publicAPIMeResponse{Scopes: auth.Scopes})
}

func handlePublicAPISubscriptionsList(app core.App, e *core.RequestEvent) error {
	auth, err := authenticatePublicAPIRequest(app, e)
	if err != nil {
		return publicAPIAuthError(e, err)
	}
	locale := requestLocale(e.Request)
	limit, err := parsePositiveQueryInt(e.Request.URL.Query().Get("limit"), 50, 1, 100)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	response, err := publicAPISubscriptionsForUser(app, auth.UserID, limit, e.Request.URL.Query().Get("cursor"))
	if err != nil {
		if errors.Is(err, errPublicAPIInvalidCursor) {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
		}
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, response)
}

func handlePublicAPISubscriptionDetail(app core.App, e *core.RequestEvent) error {
	auth, err := authenticatePublicAPIRequest(app, e)
	if err != nil {
		return publicAPIAuthError(e, err)
	}
	record, err := findSubscriptionForPublicAPI(app, auth.UserID, strings.TrimSpace(e.Request.PathValue("id")))
	if err != nil {
		return e.NotFoundError(serverText(requestLocale(e.Request), "subscription.notFound"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, publicAPISubscriptionEnvelope{
		Subscription: publicAPISubscriptionFromRecord(record),
	})
}

func handlePublicAPIStatus(app core.App, e *core.RequestEvent) error {
	auth, err := authenticatePublicAPIRequest(app, e)
	if err != nil {
		return publicAPIAuthError(e, err)
	}
	response, err := publicAPIStatusForUser(app, auth.UserID)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, response)
}

func handlePublicAPIDue(app core.App, e *core.RequestEvent) error {
	auth, err := authenticatePublicAPIRequest(app, e)
	if err != nil {
		return publicAPIAuthError(e, err)
	}
	locale := requestLocale(e.Request)
	days, err := parsePositiveQueryInt(e.Request.URL.Query().Get("days"), publicAPIDueDefaultDays, 1, publicAPIDueMaxDays)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	response, err := publicAPIDueForUser(app, auth.UserID, days)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, response)
}

func publicAPISubscriptionsForUser(app core.App, userID string, limit int, rawCursor string) (publicAPISubscriptionsResponse, error) {
	filter := "user = {:user}"
	params := dbx.Params{"user": userID}
	if cursorText := strings.TrimSpace(rawCursor); cursorText != "" {
		cursor, err := parsePublicSubscriptionCursorPayload(cursorText)
		if err != nil {
			return publicAPISubscriptionsResponse{}, errPublicAPIInvalidCursor
		}
		filter = "user = {:user} && (created < {:createdAt} || (created = {:createdAt} && id < {:id}))"
		params["createdAt"] = cursor.CreatedAt
		params["id"] = cursor.ID
	}
	rows, err := app.FindRecordsByFilter("subscriptions", filter, "-created,-id", limit+1, 0, params)
	if err != nil {
		return publicAPISubscriptionsResponse{}, err
	}
	pageRows := rows
	var nextCursor *string
	if len(rows) > limit {
		pageRows = rows[:limit]
		cursor := encodePublicSubscriptionCursor(pageRows[len(pageRows)-1])
		nextCursor = &cursor
	}
	subscriptions := make([]publicAPISubscriptionResponse, 0, len(pageRows))
	for _, record := range pageRows {
		subscriptions = append(subscriptions, publicAPISubscriptionFromRecord(record))
	}
	total, err := app.CountRecords("subscriptions", dbx.HashExp{"user": userID})
	if err != nil {
		return publicAPISubscriptionsResponse{}, err
	}
	return publicAPISubscriptionsResponse{Subscriptions: subscriptions, NextCursor: nextCursor, Total: total}, nil
}

func publicAPIStatusForUser(app core.App, userID string) (publicAPIStatusResponse, error) {
	byStatus := map[string]int64{
		"trial":     0,
		"active":    0,
		"expired":   0,
		"paused":    0,
		"cancelled": 0,
	}
	var total int64
	for status := range byStatus {
		count, err := app.CountRecords("subscriptions", dbx.HashExp{"user": userID, "status": status})
		if err != nil {
			return publicAPIStatusResponse{}, err
		}
		byStatus[status] = count
		total += count
	}
	return publicAPIStatusResponse{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Total:       total,
		ByStatus:    byStatus,
	}, nil
}

func publicAPIDueForUser(app core.App, userID string, days int) (publicAPIDueResponse, error) {
	settings, err := publicStatusSettingsForUser(app, userID)
	if err != nil {
		return publicAPIDueResponse{}, err
	}
	return publicAPIDueForUserWithSettings(app, userID, days, settings)
}

func publicAPIDueForUserWithSettings(app core.App, userID string, days int, settings appSettings) (publicAPIDueResponse, error) {
	today := todayDateOnly(time.Now().UTC(), settings.Timezone)
	through := addDateOnly(today, days)
	rows, err := app.FindRecordsByFilter(
		"subscriptions",
		"user = {:user} && ((nextBillingDate >= {:today} && nextBillingDate <= {:through}) || (trialEndDate >= {:today} && trialEndDate <= {:through}))",
		"nextBillingDate,trialEndDate,-created,-id",
		// Public API due 是摘要入口而非导出接口；结果设硬上限，避免外部轮询把单次响应放大。
		publicAPIDueResultLimit,
		0,
		dbx.Params{"user": userID, "today": today, "through": through},
	)
	if err != nil {
		return publicAPIDueResponse{}, err
	}
	return publicAPIDueResponse{
		Days:        days,
		GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Items:       publicAPIDueItemsFromRecords(rows, today, through),
	}, nil
}

func publicAPINextDueForUserWithSettings(app core.App, userID string, settings appSettings) (*publicAPIDueItem, error) {
	today := todayDateOnly(time.Now().UTC(), settings.Timezone)
	// Telegram /next 只需要第一条，但仍复用 Public API due item 契约；先按 owner 和未来日期缩小候选，再用同一 dueType 规则裁掉买断项。
	rows, err := app.FindRecordsByFilter(
		"subscriptions",
		"user = {:user} && ((status = 'trial' && trialEndDate >= {:today}) || (nextBillingDate >= {:today} && (billingCycle != 'one-time' || oneTimeTermCount > 0)))",
		"nextBillingDate,trialEndDate,-created,-id",
		publicAPIDueResultLimit,
		0,
		dbx.Params{"user": userID, "today": today},
	)
	if err != nil {
		return nil, err
	}
	items := publicAPIDueItemsFromRecords(rows, today, "9999-12-31")
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].DueDate == items[j].DueDate {
			return publicAPISubscriptionName(items[i].Subscription) < publicAPISubscriptionName(items[j].Subscription)
		}
		return items[i].DueDate < items[j].DueDate
	})
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

func createAPITokenRecord(app core.App, userID string, name string) (*core.Record, string, error) {
	collection, err := app.FindCollectionByNameOrId("api_tokens")
	if err != nil {
		return nil, "", err
	}
	for attempt := 0; attempt < 3; attempt++ {
		plainToken, err := newPlainAPIToken()
		if err != nil {
			return nil, "", err
		}
		record := core.NewRecord(collection)
		record.Set("user", userID)
		record.Set("name", name)
		record.Set("tokenHash", hashPublicAPIToken(plainToken))
		record.Set("tokenPrefix", plainToken[:publicAPITokenPrefixLength])
		record.Set("scopes", []string{"read"})
		record.Set("lastUsedAt", "")
		if err := app.Save(record); err != nil {
			if attempt < 2 && strings.Contains(err.Error(), "idx_api_tokens_token_hash_unique") {
				continue
			}
			return nil, "", err
		}
		return record, plainToken, nil
	}
	return nil, "", errors.New("api token collision")
}

func findAPITokenForUser(app core.App, userID string, id string) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter(
		"api_tokens",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": id, "user": userID},
	)
	if err != nil {
		return nil, err
	}
	return record, nil
}

func authenticatePublicAPIRequest(app core.App, e *core.RequestEvent) (publicAPIAuthContext, error) {
	token := bearerTokenFromRequest(e.Request)
	if !publicAPITokenRe.MatchString(token) {
		return publicAPIAuthContext{}, sql.ErrNoRows
	}
	hash := hashPublicAPIToken(token)
	record, err := app.FindFirstRecordByFilter(
		"api_tokens",
		"tokenHash = {:tokenHash}",
		dbx.Params{"tokenHash": hash},
	)
	if err != nil {
		return publicAPIAuthContext{}, sql.ErrNoRows
	}
	scopes, err := apiTokenScopesFromValue(record.Get("scopes"))
	if err != nil || !apiTokenHasReadScope(scopes) {
		return publicAPIAuthContext{}, sql.ErrNoRows
	}
	userID := record.GetString("user")
	user, err := app.FindRecordById("users", userID)
	if err != nil || user.GetBool("banned") {
		return publicAPIAuthContext{}, sql.ErrNoRows
	}
	now := time.Now().UTC()
	if shouldTouchAuditTimestamp(record.GetString("lastUsedAt"), now) {
		// lastUsedAt 只服务 token 使用审计；Public API 鉴权仍只看 hash、scope、owner 和用户状态。
		record.Set("lastUsedAt", now.Format(time.RFC3339Nano))
		if err := app.Save(record); err != nil {
			return publicAPIAuthContext{}, err
		}
	}
	return publicAPIAuthContext{UserID: userID, Scopes: []string{"read"}}, nil
}

func publicAPIAuthError(e *core.RequestEvent, err error) error {
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiErrorJSON(e, http.StatusUnauthorized, "PUBLIC_API_UNAUTHORIZED", serverText(requestLocale(e.Request), "auth.loginRequired"), nil)
}

func findSubscriptionForPublicAPI(app core.App, userID string, id string) (*core.Record, error) {
	return app.FindFirstRecordByFilter(
		"subscriptions",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": id, "user": userID},
	)
}

func publicAPISubscriptionFromRecord(record *core.Record) publicAPISubscriptionResponse {
	billingCycle := record.GetString("billingCycle")
	out := publicAPISubscriptionResponse{
		ID:                           record.Id,
		Name:                         record.GetString("name"),
		Logo:                         trimmedSubscriptionString(record.GetString("logo")),
		Balance:                      trimmedSubscriptionString(record.GetString("balance")),
		BalanceCurrency:              trimmedSubscriptionString(record.GetString("balanceCurrency")),
		Price:                        moneyForRecord(record.Get("price")),
		Currency:                     record.GetString("currency"),
		BillingCycle:                 billingCycle,
		Category:                     record.GetString("category"),
		Status:                       record.GetString("status"),
		Pinned:                       record.GetBool("pinned"),
		PublicHidden:                 record.GetBool("publicHidden"),
		PaymentMethod:                trimmedSubscriptionString(record.GetString("paymentMethod")),
		StartDate:                    trimmedSubscriptionString(record.GetString("startDate")),
		NextBillingDate:              record.GetString("nextBillingDate"),
		AutoRenew:                    billingCycle != "one-time" && record.GetBool("autoRenew"),
		AutoCalculateNextBillingDate: record.GetBool("autoCalculateNextBillingDate"),
		TrialEndDate:                 trimmedSubscriptionString(record.GetString("trialEndDate")),
		Website:                      trimmedSubscriptionString(record.GetString("website")),
		Notes:                        trimmedSubscriptionString(record.GetString("notes")),
		Tags:                         subscriptionRecordStringSlice(record, "tags"),
		ReminderDays:                 record.GetInt("reminderDays"),
		RepeatReminderEnabled:        record.GetBool("repeatReminderEnabled"),
		RepeatReminderInterval:       normalizeRepeatReminderInterval(record.GetString("repeatReminderInterval")),
		RepeatReminderWindow:         normalizeRepeatReminderWindow(record.GetString("repeatReminderWindow")),
		Extra:                        subscriptionRecordJSONMap(record, "extra"),
	}
	if billingCycle == "custom" {
		out.CustomDays = maxInt(1, record.GetInt("customDays"))
		out.CustomCycleUnit = strings.TrimSpace(record.GetString("customCycleUnit"))
	}
	if billingCycle == "one-time" && record.GetInt("oneTimeTermCount") > 0 {
		out.OneTimeTermCount = record.GetInt("oneTimeTermCount")
		out.OneTimeTermUnit = strings.TrimSpace(record.GetString("oneTimeTermUnit"))
	}
	if costSharing := subscriptionRecordJSONMap(record, "costSharing"); len(costSharing) > 0 {
		out.CostSharing = costSharing
	}
	if !record.GetDateTime("created").IsZero() {
		out.CreatedAt = record.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
	}
	if !record.GetDateTime("updated").IsZero() {
		out.UpdatedAt = record.GetDateTime("updated").Time().UTC().Format(time.RFC3339Nano)
	}
	return out
}

func publicAPIDueItemsFromRecords(rows []*core.Record, today string, through string) []publicAPIDueItem {
	items := []publicAPIDueItem{}
	for _, row := range rows {
		if dueType := publicAPIDueType(row, today, through); dueType != "" {
			items = append(items, publicAPIDueItem{
				DueDate:      publicAPIDueDate(row, dueType),
				DueType:      dueType,
				Subscription: publicAPISubscriptionFromRecord(row),
			})
		}
	}
	return items
}

func publicAPIDueType(row *core.Record, today string, through string) string {
	if row.GetString("status") == "trial" {
		if date := strings.TrimSpace(row.GetString("trialEndDate")); date >= today && date <= through {
			return "trial"
		}
	}
	date := strings.TrimSpace(row.GetString("nextBillingDate"))
	if date < today || date > through {
		return ""
	}
	if row.GetString("billingCycle") == "one-time" {
		if row.GetInt("oneTimeTermCount") <= 0 {
			return ""
		}
		return "expiry"
	}
	return "renewal"
}

func publicAPIDueDate(row *core.Record, dueType string) string {
	if dueType == "trial" {
		return row.GetString("trialEndDate")
	}
	return row.GetString("nextBillingDate")
}

func apiTokenDTOFromRecord(record *core.Record) apiTokenDTO {
	return apiTokenDTO{
		ID:          record.Id,
		Name:        record.GetString("name"),
		TokenPrefix: record.GetString("tokenPrefix"),
		Scopes:      []string{"read"},
		CreatedAt:   recordTimeString(record, "created"),
		LastUsedAt:  optionalRecordString(record, "lastUsedAt"),
	}
}

func optionalRecordString(record *core.Record, field string) *string {
	value := strings.TrimSpace(record.GetString(field))
	if value == "" {
		return nil
	}
	return &value
}

func apiTokenScopesFromValue(value interface{}) ([]string, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(strings.TrimSpace(string(data))) == 0 {
		return nil, err
	}
	var scopes []string
	if err := json.Unmarshal(data, &scopes); err != nil {
		return nil, err
	}
	return scopes, nil
}

func apiTokenHasReadScope(scopes []string) bool {
	for _, scope := range scopes {
		if scope == "read" {
			return true
		}
	}
	return false
}

func newPlainAPIToken() (string, error) {
	data := make([]byte, publicAPITokenRandomBytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return publicAPITokenPrefix + base64.RawURLEncoding.EncodeToString(data), nil
}

func hashPublicAPIToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func bearerTokenFromRequest(request *http.Request) string {
	header := strings.TrimSpace(request.Header.Get("Authorization"))
	match := bearerTokenHeaderRe.FindStringSubmatch(header)
	if len(match) != 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func setPublicAPIHeaders(headers http.Header) {
	headers.Set("Cache-Control", "no-store")
	headers.Set("X-Content-Type-Options", "nosniff")
}
