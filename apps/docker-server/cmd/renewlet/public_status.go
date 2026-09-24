package main

// public_status.go 管理公开展示页。
//
// 架构位置：
//   - 登录态 API 负责生成、复制、金额开关和撤销公开页 URL。
//   - 公开 API 只靠高熵 token 定位用户，并返回严格 allowlist 的订阅状态投影。
//   - 私有 Logo 通过公开资产代理读取，代理每次都重新校验 token、owner 和可见订阅引用。
import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	publicStatusSubscriptionLimit = 500
)

// publicStatusPageStatus 是登录用户设置页看到的公开展示页状态。
// PageURL 是唯一可复制凭据；token 不拆字段出站，避免进入 settings/export 等持久配置。
type publicStatusPageStatus struct {
	Enabled      bool   `json:"enabled"`
	CreatedAt    string `json:"createdAt,omitempty"`
	PageURL      string `json:"pageUrl,omitempty"`
	ShowPrices   bool   `json:"showPrices"`
	HideExpired  bool   `json:"hideExpired"`
	HideLifetime bool   `json:"hideLifetime"`
	UpdatedAt    string `json:"updatedAt,omitempty"`
}

// publicStatusPageStatusResponse 保持 settings 页读取的 root key；前端 schema 依赖 publicStatusPage 包裹层。
type publicStatusPageStatusResponse struct {
	PublicStatusPage publicStatusPageStatus `json:"publicStatusPage"`
}

// publicStatusPageCreateStatus 是创建/复用 token 后的完整状态。
type publicStatusPageCreateStatus struct {
	Enabled      bool   `json:"enabled"`
	CreatedAt    string `json:"createdAt"`
	PageURL      string `json:"pageUrl"`
	ShowPrices   bool   `json:"showPrices"`
	HideExpired  bool   `json:"hideExpired"`
	HideLifetime bool   `json:"hideLifetime"`
	UpdatedAt    string `json:"updatedAt"`
}

// publicStatusPageCreateResponse 与读取响应保持同一 root key，避免创建后缓存写入需要单独分支。
type publicStatusPageCreateResponse struct {
	PublicStatusPage publicStatusPageCreateStatus `json:"publicStatusPage"`
}

// publicStatusPageCreateRequest 只允许空对象；公开 token 始终由服务端生成。
type publicStatusPageCreateRequest struct{}

// publicStatusPageUpdateRequest 只允许切换金额公开开关，不允许客户端提交 token 或 URL。
type publicStatusPageUpdateRequest struct {
	ShowPrices   bool `json:"showPrices"`
	HideExpired  bool `json:"hideExpired"`
	HideLifetime bool `json:"hideLifetime"`
}

// publicStatusResponse 是公开 API 的 allowlist 投影，不能直接返回订阅 record。
type publicStatusResponse struct {
	Page          publicStatusPageView           `json:"page"`
	Subscriptions []publicStatusSubscriptionView `json:"subscriptions"`
}

// publicStatusPageView 描述公开页元信息；Currency 只有 showPrices=true 时才出现。
type publicStatusPageView struct {
	Title             string                   `json:"title"`
	ShowPrices        bool                     `json:"showPrices"`
	Currency          string                   `json:"currency,omitempty"`
	ExchangeRateBasis *exchangeRatePublicBasis `json:"exchangeRateBasis,omitempty"`
	AsOf              string                   `json:"asOf"`
	GeneratedAt       string                   `json:"generatedAt"`
	Truncated         bool                     `json:"truncated"`
}

// publicStatusSubscriptionView 是公开订阅字段白名单。
// 不包含订阅 id、备注、支付方式、提醒策略、tags、website、extra 或用户信息。
type publicStatusSubscriptionView struct {
	Name             string                   `json:"name"`
	Logo             string                   `json:"logo,omitempty"`
	Category         publicStatusCategoryView `json:"category"`
	Status           string                   `json:"status"`
	StartDate        *string                  `json:"startDate"`
	NextBillingDate  *string                  `json:"nextBillingDate"`
	UpdatedAt        string                   `json:"updatedAt"`
	Price            *string                  `json:"price,omitempty"`
	Currency         string                   `json:"currency,omitempty"`
	BillingCycle     string                   `json:"billingCycle,omitempty"`
	CustomDays       int                      `json:"customDays,omitempty"`
	CustomCycleUnit  string                   `json:"customCycleUnit,omitempty"`
	OneTimeTermCount int                      `json:"oneTimeTermCount,omitempty"`
	OneTimeTermUnit  string                   `json:"oneTimeTermUnit,omitempty"`
}

// publicStatusCategoryView 只暴露展示标签和颜色，隐藏用户自定义配置的其它原始字段。
type publicStatusCategoryView struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Color string `json:"color,omitempty"`
}

// publicStatusCategoryResolver 把分类 value 映射成当前 locale 下的公开展示标签。
type publicStatusCategoryResolver struct {
	locale  appLocale
	byValue map[string]customConfigItem
}

func handlePublicStatusPageStatus(app core.App, e *core.RequestEvent) error {
	record, err := findPublicStatusPageForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, publicStatusPageStatusResponse{PublicStatusPage: publicStatusPageStatusFromRecord(e.Request, record)})
}

func handlePublicStatusPageCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if _, err := decodeStrictJSON[publicStatusPageCreateRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := ensurePublicStatusPage(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	// 创建接口可重复调用；已存在 token 时只回显状态，避免刷新页面意外轮换公开 URL。
	return apiSuccessJSON(e, http.StatusOK, publicStatusPageCreateResponse{PublicStatusPage: publicStatusPageCreateStatus{
		Enabled:      true,
		CreatedAt:    record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		PageURL:      publicStatusPageURL(e.Request, record.GetString("token")),
		ShowPrices:   record.GetBool("showPrices"),
		HideExpired:  record.GetBool("hideExpired"),
		HideLifetime: record.GetBool("hideLifetime"),
		UpdatedAt:    record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}})
}

func handlePublicStatusPageUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[publicStatusPageUpdateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := findPublicStatusPageForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if record == nil {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	record.Set("showPrices", body.ShowPrices)
	record.Set("hideExpired", body.HideExpired)
	record.Set("hideLifetime", body.HideLifetime)
	if err := app.Save(record); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, publicStatusPageStatusResponse{PublicStatusPage: publicStatusPageStatusFromRecord(e.Request, record)})
}

func handlePublicStatusPageDelete(app core.App, e *core.RequestEvent) error {
	record, err := findPublicStatusPageForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	if record != nil {
		// 撤销公开页只删除 token record；订阅自身 publicHidden 设置保留，便于用户之后重新开启沿用可见性选择。
		if err := app.Delete(record); err != nil {
			return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
		}
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func handlePublicStatusRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	token := strings.TrimSpace(e.Request.PathValue("token"))
	feed, err := findPublicStatusPageByToken(app, token)
	if err != nil {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	response, err := buildPublicStatusResponse(app, e.Request, feed)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setPublicStatusHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, response)
}

func handlePublicStatusAssetRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	token := strings.TrimSpace(e.Request.PathValue("token"))
	assetID := strings.TrimSpace(e.Request.PathValue("assetId"))
	page, err := findPublicStatusPageByToken(app, token)
	if err != nil || assetID == "" {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	asset, err := app.FindRecordById("assets", assetID)
	if err != nil || asset.GetString("user") != page.GetString("user") {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	if ok, err := publicStatusAssetIsReferenced(app, page.GetString("user"), assetID); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	} else if !ok {
		// 公开资产 URL 不能成为同用户资产枚举器；只有可见订阅实际引用的 Logo 才能被 token 读取。
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	return writeAssetRecord(app, e, asset, "no-store", true)
}

func findPublicStatusPageForUser(app core.App, userID string) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter("public_status_pages", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errorsIsNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	return record, nil
}

func findPublicStatusPageByToken(app core.App, token string) (*core.Record, error) {
	if !publicStatusTokenRe.MatchString(token) {
		return nil, sql.ErrNoRows
	}
	record, err := app.FindFirstRecordByFilter("public_status_pages", "token = {:token}", dbx.Params{"token": token})
	if err != nil {
		// 公开页是 bearer URL；无效、撤销和猜测 token 一律同类 404，避免泄漏 token 是否接近有效。
		return nil, sql.ErrNoRows
	}
	return record, nil
}

func ensurePublicStatusPage(app core.App, userID string) (*core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("public_status_pages")
	if err != nil {
		return nil, err
	}
	record, err := findPublicStatusPageForUser(app, userID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		record = core.NewRecord(collection)
		record.Set("user", userID)
		token, err := newCalendarFeedToken()
		if err != nil {
			return nil, err
		}
		record.Set("token", token)
		record.Set("showPrices", false)
	}
	if err := app.Save(record); err != nil {
		return nil, err
	}
	return record, nil
}

func publicStatusPageStatusFromRecord(request *http.Request, record *core.Record) publicStatusPageStatus {
	if record == nil {
		return publicStatusPageStatus{Enabled: false, ShowPrices: false, HideExpired: false, HideLifetime: false}
	}
	return publicStatusPageStatus{
		Enabled:      true,
		CreatedAt:    record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		PageURL:      publicStatusPageURL(request, record.GetString("token")),
		ShowPrices:   record.GetBool("showPrices"),
		HideExpired:  record.GetBool("hideExpired"),
		HideLifetime: record.GetBool("hideLifetime"),
		UpdatedAt:    record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}
}

func publicStatusPageURL(request *http.Request, token string) string {
	return externalRequestURL(request, "/status/"+token, nil)
}

func publicStatusAssetURL(request *http.Request, token string, assetID string) string {
	return externalRequestURL(request, "/api/public/status/"+token+"/assets/"+assetID, nil)
}

func buildPublicStatusResponse(app core.App, request *http.Request, page *core.Record) (publicStatusResponse, error) {
	userID := page.GetString("user")
	settings, err := publicStatusSettingsForUser(app, userID)
	if err != nil {
		return publicStatusResponse{}, err
	}
	// 公开状态页属于访客界面；分类标签跟随本次请求，不继承页面 owner 的账号内容语言。
	resolver := newPublicStatusCategoryResolver(app, userID, requestLocale(request))
	now := time.Now().UTC()
	today := todayDateOnly(now, settings.Timezone)
	items, truncated, err := listPublicStatusSubscriptions(app, request, page, resolver, today)
	if err != nil {
		return publicStatusResponse{}, err
	}
	showPrices := page.GetBool("showPrices")
	view := publicStatusPageView{
		Title:      "Renewlet",
		ShowPrices: showPrices,
		// AsOf 是 owner 账号时区下的 date-only；匿名前端不得从 UTC GeneratedAt 猜测业务日期。
		AsOf:        today,
		GeneratedAt: now.Format(time.RFC3339),
		Truncated:   truncated,
	}
	if showPrices {
		view.Currency = effectivePublicStatusCurrency(settings)
		basis := exchangeRatePublicBasisForUser(app, userID, now)
		view.ExchangeRateBasis = &basis
	}
	return publicStatusResponse{
		Page:          view,
		Subscriptions: items,
	}, nil
}

func listPublicStatusSubscriptions(app core.App, request *http.Request, page *core.Record, resolver publicStatusCategoryResolver, today string) ([]publicStatusSubscriptionView, bool, error) {
	userID := page.GetString("user")
	token := page.GetString("token")
	publicHidden := false
	// 公开页复用私有默认集合顺序，但不复用私有 cursor；created/id 仍只参与内部排序，不能进入公开 allowlist。
	rows, err := listSubscriptionRecordsInDefaultOrder(app, userID, today, publicStatusSubscriptionLimit, &publicHidden, page.GetBool("hideExpired"), page.GetBool("hideLifetime"))
	if err != nil {
		return nil, false, err
	}
	truncated := len(rows) > publicStatusSubscriptionLimit
	if truncated {
		rows = rows[:publicStatusSubscriptionLimit]
	}
	items := make([]publicStatusSubscriptionView, 0, len(rows))
	for _, row := range rows {
		items = append(items, publicStatusSubscriptionFromRecord(request, token, row, resolver, page.GetBool("showPrices"), today))
	}
	return items, truncated, nil
}

func publicStatusSubscriptionFromRecord(request *http.Request, token string, row *core.Record, resolver publicStatusCategoryResolver, showPrices bool, today string) publicStatusSubscriptionView {
	item := publicStatusSubscriptionView{
		Name:      row.GetString("name"),
		Logo:      publicStatusLogoURL(request, token, row.GetString("logo")),
		Category:  resolver.Category(row.GetString("category")),
		Status:    publicStatusEffectiveStatus(row, today),
		StartDate: nullableStringPointer(row.GetString("startDate")),
		UpdatedAt: row.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}
	if row.GetString("billingCycle") != "one-time" || row.GetInt("oneTimeTermCount") > 0 {
		item.NextBillingDate = nullableStringPointer(row.GetString("nextBillingDate"))
	}
	if showPrices {
		oneTimeTermCount := row.GetInt("oneTimeTermCount")
		price := moneyForRecord(row.Get("price"))
		item.Price = &price
		item.Currency = row.GetString("currency")
		item.BillingCycle = row.GetString("billingCycle")
		if row.GetInt("customDays") > 0 {
			item.CustomDays = row.GetInt("customDays")
		}
		if row.GetString("customCycleUnit") != "" {
			item.CustomCycleUnit = row.GetString("customCycleUnit")
		}
		if oneTimeTermCount > 0 && row.GetString("oneTimeTermUnit") != "" {
			item.OneTimeTermCount = oneTimeTermCount
			item.OneTimeTermUnit = row.GetString("oneTimeTermUnit")
		}
	}
	return item
}

func nullableStringPointer(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func effectivePublicStatusCurrency(settings appSettings) string {
	if settings.PublicStatusCurrency != "inherit" && settingsCurrencyRe.MatchString(settings.PublicStatusCurrency) {
		return settings.PublicStatusCurrency
	}
	if settingsCurrencyRe.MatchString(settings.DefaultCurrency) {
		return settings.DefaultCurrency
	}
	return "CNY"
}

func publicStatusEffectiveStatus(row *core.Record, today string) string {
	status := row.GetString("status")
	if status == "expired" {
		return "expired"
	}
	if row.GetString("billingCycle") == "one-time" && row.GetInt("oneTimeTermCount") <= 0 {
		return status
	}
	// 公开页是状态面板，必须沿用站内“有效状态”口径；过期兼容只改出站投影，不回写用户数据。
	if (status == "active" || status == "trial") && isValidDateOnly(row.GetString("nextBillingDate")) && row.GetString("nextBillingDate") < today {
		return "expired"
	}
	return status
}

func publicStatusLogoURL(request *http.Request, token string, value string) string {
	logo := strings.TrimSpace(value)
	if logo == "" {
		return ""
	}
	if privateAssetPathRe.MatchString(logo) {
		assetID := strings.TrimPrefix(logo, "/api/app/assets/")
		return publicStatusAssetURL(request, token, assetID)
	}
	return logo
}

func publicStatusAssetIsReferenced(app core.App, userID string, assetID string) (bool, error) {
	logo := "/api/app/assets/" + assetID
	record, err := app.FindFirstRecordByFilter(
		"subscriptions",
		"user = {:user} && publicHidden = false && logo = {:logo}",
		dbx.Params{"user": userID, "logo": logo},
	)
	if err != nil {
		if errorsIsNoRows(err) {
			return false, nil
		}
		return false, err
	}
	return record != nil, nil
}

func publicStatusSettingsForUser(app core.App, userID string) (appSettings, error) {
	settings := defaultAppSettings()
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return settings, nil
		}
		return appSettings{}, err
	}
	return settingsFromRecord(record)
}

func newPublicStatusCategoryResolver(app core.App, userID string, locale appLocale) publicStatusCategoryResolver {
	resolver := publicStatusCategoryResolver{
		locale:  locale,
		byValue: map[string]customConfigItem{},
	}
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		return resolver
	}
	config, err := customConfigFromValue(record.Get("config"))
	if err != nil {
		return resolver
	}
	for _, item := range config.Categories {
		resolver.byValue[item.Value] = item
	}
	return resolver
}

func (r publicStatusCategoryResolver) Category(value string) publicStatusCategoryView {
	item, ok := r.byValue[value]
	if ok {
		return publicStatusCategoryView{
			Value: value,
			Label: publicStatusLocalizedConfigLabel(item.Labels, r.locale, value),
			Color: item.Color,
		}
	}
	if key, ok := calendarFeedBuiltInCategoryLabelKey(value); ok {
		return publicStatusCategoryView{Value: value, Label: serverText(r.locale, key)}
	}
	return publicStatusCategoryView{Value: value, Label: value}
}

func publicStatusLocalizedConfigLabel(labels customConfigLabels, locale appLocale, fallback string) string {
	if locale == localeEnUS {
		if labels.EnUS != "" {
			return labels.EnUS
		}
		if labels.ZhCN != "" {
			return labels.ZhCN
		}
		return fallback
	}
	if labels.ZhCN != "" {
		return labels.ZhCN
	}
	if labels.EnUS != "" {
		return labels.EnUS
	}
	return fallback
}

func setPublicStatusHeaders(headers http.Header) {
	headers.Set("Cache-Control", "no-store")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Robots-Tag", "noindex, nofollow")
}
