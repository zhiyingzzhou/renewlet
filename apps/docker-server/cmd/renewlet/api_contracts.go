package main

// api_contracts.go 定义自定义 HTTP API 的请求/响应边界。
//
// 架构位置：
//   - main.go 的 route handler 只处理鉴权、业务编排和 PocketBase 调用。
//   - 本文件集中放置 DTO、严格 JSON decoder、Validate(locale) 约定和通用错误响应。
//   - 前端 Zod schema 与这里的 struct 字段需要保持一一对应。
//
// 请求解码流转：
//   request.Body -> 限制 1MiB -> DisallowUnknownFields -> 拒绝多余 JSON token
//     -> 若实现 localizedValidator 则调用 Validate(locale)
//
// 注意： 不要把 decoder 放宽成 map 或忽略未知字段；未知字段通常代表前后端契约漂移，应在边界失败。
import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const maxJSONBodyBytes = 1 << 20
const maxEmptyRequestBodyBytes = 1024

var errEmptyJSONBody = errors.New("empty JSON body")
var errNonEmptyRequestBody = errors.New("request body must be empty")

// localizedValidator 是请求体的本地化校验约定。
// Validate 在 JSON 结构通过后执行，用于枚举、邮箱、密码长度等产品语义校验。
type localizedValidator interface {
	Validate(appLocale) error
}

// apiSuccessResponse 是产品 JSON API 的唯一成功 envelope。
// 业务 payload 放在 data 内，错误响应继续走 apiErrorEnvelope，避免前端同时维护双成功形状。
type apiSuccessResponse struct {
	OK   bool `json:"ok"`
	Data any  `json:"data"`
}

// emptyJSONPayload 表示产品 API 的空对象 payload。
// 它用于避免 nil/null 在前端 schema 中被误解成“字段缺失”。
type emptyJSONPayload struct{}

// healthResponse 是 healthcheck 的稳定响应结构。
type healthResponse struct {
	Time string `json:"time"`
}

// appStatusResponse 是认证前 capability 真相源。
// 登录页、setup 页和设置页 demo 限制都从这里读取；真正写入仍由各 route/hook 再次校验。
type appStatusResponse struct {
	SetupRequired bool                  `json:"setupRequired"`
	SetupEnabled  bool                  `json:"setupEnabled"`
	DemoMode      bool                  `json:"demoMode"`
	Turnstile     turnstilePublicConfig `json:"turnstile"`
}

// setupStatusResponse 描述旧 setup 入口是否可用。
// 注意：新前端读取 /api/app/status；保留两字段响应，避免旧探针被 demoMode 额外字段打破。
type setupStatusResponse struct {
	SetupRequired bool `json:"setupRequired"`
	SetupEnabled  bool `json:"setupEnabled"`
}

// setupCreateRequest 是首次初始化管理员的请求体。
type setupCreateRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// authUserResponse 是登录态用户安全视图；密码、tokenKey 和 session metadata 不能出站。
type authUserResponse struct {
	ID     string `json:"id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Banned bool   `json:"banned"`
}

type appSessionTokenResponse struct {
	ExpiresAt string `json:"expiresAt"`
}

type sessionResponse struct {
	Type      string                  `json:"type"`
	Session   appSessionTokenResponse `json:"session"`
	User      authUserResponse        `json:"user"`
	token     string
	csrfToken string
}

type mfaRequiredResponse struct {
	Type      string   `json:"type"`
	TicketID  string   `json:"ticketId"`
	ExpiresAt string   `json:"expiresAt"`
	Methods   []string `json:"methods"`
}

type mfaStatusResponse struct {
	Enabled                bool     `json:"enabled"`
	Methods                []string `json:"methods"`
	RecoveryCodesRemaining int      `json:"recoveryCodesRemaining"`
	PasskeyCount           int      `json:"passkeyCount"`
}

type mfaTotpSetupResponse struct {
	SetupID    string `json:"setupId"`
	Secret     string `json:"secret"`
	OtpauthURL string `json:"otpauthUrl"`
	ExpiresAt  string `json:"expiresAt"`
}

type mfaRecoveryCodesResponse struct {
	Type          string                  `json:"type"`
	Session       appSessionTokenResponse `json:"session"`
	User          authUserResponse        `json:"user"`
	RecoveryCodes []string                `json:"recoveryCodes"`
	token         string
	csrfToken     string
}

type passkeyResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
}

type passkeysResponse struct {
	Passkeys []passkeyResponse `json:"passkeys"`
}

type passkeyWebAuthnOptionsResponse struct {
	ChallengeID string `json:"challengeId"`
	ExpiresAt   string `json:"expiresAt"`
	Options     any    `json:"options"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	// turnstileToken 只保护邮箱密码登录提交；Passkey、MFA 二阶段和首次 setup 不能复用这个字段。
	TurnstileToken string `json:"turnstileToken,omitempty"`
}

func (r *loginRequest) Validate(locale appLocale) error {
	r.Email = strings.TrimSpace(r.Email)
	r.TurnstileToken = strings.TrimSpace(r.TurnstileToken)
	if !isValidEmailAddress(r.Email) || r.Password == "" || len(r.Password) > 72 || len(r.TurnstileToken) > 2048 {
		return errors.New(serverText(locale, "auth.invalidEmailOrPassword"))
	}
	return nil
}

type mfaTotpEnableRequest struct {
	SetupID         string `json:"setupId"`
	Code            string `json:"code"`
	CurrentPassword string `json:"currentPassword"`
}

func (r *mfaTotpEnableRequest) Validate(locale appLocale) error {
	r.SetupID = strings.TrimSpace(r.SetupID)
	r.Code = strings.TrimSpace(r.Code)
	if r.SetupID == "" || !isSixDigitCode(r.Code) || r.CurrentPassword == "" || len(r.CurrentPassword) > 72 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

type mfaCurrentPasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
}

func (r *mfaCurrentPasswordRequest) Validate(locale appLocale) error {
	if r.CurrentPassword == "" || len(r.CurrentPassword) > 72 {
		return errors.New(serverText(locale, "auth.currentPasswordIncorrect"))
	}
	return nil
}

type passkeyRegisterOptionsRequest struct {
	Name            string `json:"name"`
	CurrentPassword string `json:"currentPassword"`
}

func (r *passkeyRegisterOptionsRequest) Validate(locale appLocale) error {
	r.Name = strings.TrimSpace(r.Name)
	if r.Name == "" || len(r.Name) > 80 || r.CurrentPassword == "" || len(r.CurrentPassword) > 72 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

type passkeyRegisterVerifyRequest struct {
	ChallengeID string          `json:"challengeId"`
	Name        string          `json:"name"`
	Response    json.RawMessage `json:"response"`
}

func (r *passkeyRegisterVerifyRequest) Validate(locale appLocale) error {
	r.ChallengeID = strings.TrimSpace(r.ChallengeID)
	r.Name = strings.TrimSpace(r.Name)
	if r.ChallengeID == "" || r.Name == "" || len(r.Name) > 80 || len(r.Response) == 0 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

type mfaVerifyRequest struct {
	Method   string `json:"method"`
	TicketID string `json:"ticketId"`
	Code     string `json:"code,omitempty"`
}

func (r *mfaVerifyRequest) Validate(locale appLocale) error {
	r.Method = strings.TrimSpace(r.Method)
	r.TicketID = strings.TrimSpace(r.TicketID)
	r.Code = strings.TrimSpace(r.Code)
	switch r.Method {
	case mfaMethodTOTP:
		if r.TicketID == "" || !isSixDigitCode(r.Code) {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	case mfaMethodRecoveryCode:
		if r.TicketID == "" || len(r.Code) < 6 || len(r.Code) > 64 {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	default:
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

type passkeyAuthenticateOptionsRequest struct{}

func (r *passkeyAuthenticateOptionsRequest) Validate(locale appLocale) error {
	return nil
}

type passkeyAuthenticateVerifyRequest struct {
	ChallengeID string          `json:"challengeId"`
	Response    json.RawMessage `json:"response"`
}

func (r *passkeyAuthenticateVerifyRequest) Validate(locale appLocale) error {
	r.ChallengeID = strings.TrimSpace(r.ChallengeID)
	if r.ChallengeID == "" || len(r.Response) == 0 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

func isSixDigitCode(value string) bool {
	if len(value) != 6 {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

// Validate 校验首次管理员信息，并在边界处完成 trim。
func (r *setupCreateRequest) Validate(locale appLocale) error {
	r.Name = strings.TrimSpace(r.Name)
	r.Email = strings.TrimSpace(r.Email)
	if r.Name == "" || !isValidEmailAddress(r.Email) || len(r.Password) < 8 {
		return errors.New(serverText(locale, "admin.invalidAdminInfo"))
	}
	return nil
}

// adminUsersResponse 是管理员用户列表响应。
type adminUsersResponse struct {
	Users []userDTO `json:"users"`
}

// adminCreateUserRequest 是管理员创建用户的请求体。
type adminCreateUserRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

// Validate 校验管理员创建用户的请求体。
// 注意： role 是权限边界，新增角色时必须同步前端 schema 和所有防自锁逻辑。
func (r *adminCreateUserRequest) Validate(locale appLocale) error {
	r.Name = strings.TrimSpace(r.Name)
	r.Email = strings.TrimSpace(r.Email)
	if r.Name == "" || !isValidEmailAddress(r.Email) || len(r.Password) < 8 {
		return errors.New(serverText(locale, "admin.invalidUserInfo"))
	}
	if r.Role != "admin" && r.Role != "user" {
		return errors.New(serverText(locale, "admin.invalidRole"))
	}
	return nil
}

// adminUserResponse 是单用户写入后的响应结构。
type adminUserResponse struct {
	User userDTO `json:"user"`
}

// adminPatchUserRequest 是管理员局部更新用户的请求体。
// 指针字段用于区分“未传字段”和“显式传 false/空字符串”。
type adminPatchUserRequest struct {
	Role        *string `json:"role,omitempty"`
	Banned      *bool   `json:"banned,omitempty"`
	NewPassword *string `json:"newPassword,omitempty"`
}

// Validate 校验管理员用户 patch 请求。
// 为什么要求至少一个字段：空 patch 通常意味着前端状态机误触发，应该显式失败。
func (r *adminPatchUserRequest) Validate(locale appLocale) error {
	if r.Role == nil && r.Banned == nil && r.NewPassword == nil {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.Role != nil {
		role := strings.TrimSpace(*r.Role)
		if role != "admin" && role != "user" {
			return errors.New(serverText(locale, "admin.invalidRole"))
		}
		*r.Role = role
	}
	if r.NewPassword != nil {
		if len(*r.NewPassword) < 8 {
			return errors.New(serverText(locale, "admin.passwordTooShort"))
		}
	}
	return nil
}

// accountPasswordRequest 是当前用户修改密码的请求体。
type accountPasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// Validate 校验账号密码修改请求。
func (r *accountPasswordRequest) Validate(locale appLocale) error {
	if r.CurrentPassword == "" || len(r.NewPassword) < 8 {
		return errors.New(serverText(locale, "admin.passwordTooShort"))
	}
	return nil
}

// passwordResetStatusResponse 暴露“邮件找回密码是否启用”的布尔状态。
type passwordResetStatusResponse struct {
	Enabled bool `json:"enabled"`
}

// systemUpdateRequest 是管理员触发页面内更新的空请求体；保留严格 JSON 边界来拒绝意外字段。
type systemUpdateRequest struct{}

// systemRestartRequest 是管理员确认应用已替换二进制后的显式重启请求。
type systemRestartRequest struct{}

// calendarFeedCreateRequest 只允许空对象，用于显式拒绝前端/客户端误传 token 等敏感字段。
type calendarFeedCreateRequest struct{}

// subscriptionRenewRequest 是手动续订的显式 payload；URL id 和当前登录用户仍是 owner 写入边界。
type subscriptionRenewRequest struct {
	ExpectedNextBillingDate      string                    `json:"expectedNextBillingDate"`
	ExpectedUpdatedAt            string                    `json:"expectedUpdatedAt"`
	Mode                         string                    `json:"mode"`
	Price                        string                    `json:"price"`
	Currency                     string                    `json:"currency"`
	StartDate                    optionalJSONField[string] `json:"startDate"`
	NextBillingDate              string                    `json:"nextBillingDate"`
	AutoCalculateNextBillingDate bool                      `json:"autoCalculateNextBillingDate"`
}

func (r *subscriptionRenewRequest) Validate(locale appLocale) error {
	if err := requireDateOnly(r.ExpectedNextBillingDate, "EXPECTED_NEXT_BILLING_DATE"); err != nil {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if len(r.ExpectedUpdatedAt) > 64 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if _, err := time.Parse(time.RFC3339Nano, r.ExpectedUpdatedAt); err != nil {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	r.Mode = strings.TrimSpace(r.Mode)
	if r.Mode != "continue" && r.Mode != "restart" {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	price, err := canonicalMoneyString(r.Price)
	if err != nil {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	r.Price = price
	// shared/Worker 都把货币当作大写 ISO 边界；Docker 不能在这里自动 upper，否则两端会接受不同请求。
	r.Currency = strings.TrimSpace(r.Currency)
	if !currencyCodeRe.MatchString(r.Currency) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.StartDate.Set && !r.StartDate.Null {
		r.StartDate.Value = strings.TrimSpace(r.StartDate.Value)
	}
	r.NextBillingDate = strings.TrimSpace(r.NextBillingDate)
	if r.Mode == "restart" && (!r.StartDate.Set || r.StartDate.Null || r.StartDate.Value == "") {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.StartDate.Set && !r.StartDate.Null && r.StartDate.Value != "" {
		if err := requireDateOnly(r.StartDate.Value, "START_DATE"); err != nil {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	}
	if err := requireDateOnly(r.NextBillingDate, "NEXT_BILLING_DATE"); err != nil {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.StartDate.Set && !r.StartDate.Null && r.StartDate.Value != "" && r.NextBillingDate < r.StartDate.Value {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

type builtInIconProviderCountsResponse struct {
	TheSVG         int `json:"thesvg"`
	Selfhst        int `json:"selfhst"`
	DashboardIcons int `json:"dashboardIcons"`
}

type builtInIconProviderVersionResponse struct {
	SourceRef          string  `json:"sourceRef"`
	DisplayVersion     string  `json:"displayVersion"`
	CommitSHA          *string `json:"commitSha"`
	CommitShortSHA     *string `json:"commitShortSha"`
	CommitDate         *string `json:"commitDate"`
	ReleaseTag         *string `json:"releaseTag"`
	ReleasePublishedAt *string `json:"releasePublishedAt"`
}

type builtInIconIndexProviderStatusResponse struct {
	Provider        string                              `json:"provider"`
	Current         *builtInIconProviderVersionResponse `json:"current"`
	Latest          *builtInIconProviderVersionResponse `json:"latest"`
	IconCount       int                                 `json:"iconCount"`
	CheckedAt       *string                             `json:"checkedAt"`
	RefreshedAt     *string                             `json:"refreshedAt"`
	LastError       *string                             `json:"lastError"`
	Refreshing      bool                                `json:"refreshing"`
	UpdateAvailable bool                                `json:"updateAvailable"`
	Job             *builtInIconRefreshJobResponse      `json:"job,omitempty"`
}

type builtInIconIndexStatusResponse struct {
	Source         string                                   `json:"source"`
	Hash           *string                                  `json:"hash"`
	IconCount      int                                      `json:"iconCount"`
	ProviderCounts builtInIconProviderCountsResponse        `json:"providerCounts"`
	CheckedAt      *string                                  `json:"checkedAt"`
	UpdatedAt      *string                                  `json:"updatedAt"`
	Refreshing     bool                                     `json:"refreshing"`
	Providers      []builtInIconIndexProviderStatusResponse `json:"providers"`
}

type builtInIconIndexProviderCheckResponse struct {
	Status       builtInIconIndexStatusResponse         `json:"status"`
	Provider     builtInIconIndexProviderStatusResponse `json:"provider"`
	ErrorDetails *upstreamErrorDetails                  `json:"errorDetails,omitempty"`
}

type builtInIconRefreshJobResponse struct {
	ID         string  `json:"id"`
	Provider   string  `json:"provider"`
	Status     string  `json:"status"`
	QueuedAt   string  `json:"queuedAt"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	Attempts   int     `json:"attempts"`
	Error      *string `json:"error"`
	IndexHash  *string `json:"indexHash"`
}

type builtInIconIndexProviderRefreshResponse struct {
	Status   builtInIconIndexStatusResponse         `json:"status"`
	Provider builtInIconIndexProviderStatusResponse `json:"provider"`
	Job      builtInIconRefreshJobResponse          `json:"job"`
}

// mediaCandidateResolveRequest 是 Logo/Icon 候选解析的统一入口。
// Docker 与 Cloudflare 必须共享这组字段，避免前端再按运行面拆 favicon/内置图标搜索。
type mediaCandidateResolveRequest struct {
	Kind  string                      `json:"kind"`
	Mode  string                      `json:"mode"`
	Items []mediaCandidateResolveItem `json:"items"`
	Limit *int                        `json:"limit,omitempty"`
}

// Validate 校验 media candidates 请求体，并在边界处完成 trim。
func (r *mediaCandidateResolveRequest) Validate(locale appLocale) error {
	r.Kind = strings.TrimSpace(r.Kind)
	r.Mode = strings.TrimSpace(r.Mode)
	if r.Kind != "logo" && r.Kind != "icon" {
		return errors.New(serverText(locale, "media.kindInvalid"))
	}
	if r.Mode != "auto" && r.Mode != "search" {
		return errors.New(serverText(locale, "media.modeInvalid"))
	}
	if len(r.Items) == 0 || len(r.Items) > mediaResolverCfg.Limits.MaxItems {
		return errors.New(serverText(locale, "media.candidateItemCountInvalid"))
	}
	if r.Limit != nil && *r.Limit <= 0 {
		return errors.New(serverText(locale, "media.candidateItemLimitInvalid"))
	}
	for index := range r.Items {
		item := &r.Items[index]
		item.ID = strings.TrimSpace(item.ID)
		item.Name = strings.TrimSpace(item.Name)
		item.Website = strings.TrimSpace(item.Website)
		if item.ID == "" || len([]rune(item.ID)) > 120 || item.Name == "" || len([]rune(item.Name)) > 120 || len([]rune(item.Website)) > 500 {
			return errors.New(serverText(locale, "media.candidateItemInvalid"))
		}
	}
	return nil
}

// mediaCandidateResolveItem 是单条候选解析输入。
type mediaCandidateResolveItem struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Website string `json:"website,omitempty"`
}

// mediaCandidate 是前端统一展示、导入自动分配和后续 provider 扩展共用的候选模型。
type mediaCandidate struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Source         string  `json:"source"`
	Provider       string  `json:"provider"`
	Label          string  `json:"label"`
	Variant        *string `json:"variant"`
	URL            string  `json:"url"`
	Confidence     string  `json:"confidence"`
	AutoAssignable bool    `json:"autoAssignable"`
	MatchedQuery   string  `json:"matchedQuery"`
	Rank           int     `json:"rank"`
}

// mediaCandidateGroup 按来源分组；best 只指向分组中的首选候选，不额外生成第三类结果。
type mediaCandidateGroup struct {
	Best     *mediaCandidate  `json:"best"`
	BuiltIn  []mediaCandidate `json:"builtIn"`
	AppStore []mediaCandidate `json:"appStore"`
	Favicon  []mediaCandidate `json:"favicon"`
}

// mediaCandidateResolveItemResponse 是单条解析响应。
type mediaCandidateResolveItemResponse struct {
	ID            string              `json:"id"`
	AutoCandidate *mediaCandidate     `json:"autoCandidate"`
	Candidates    mediaCandidateGroup `json:"candidates"`
}

// mediaCandidateResolveResponse 是 media candidates API 响应。
type mediaCandidateResolveResponse struct {
	Items []mediaCandidateResolveItemResponse `json:"items"`
}

// decodeStrictJSON 从 HTTP 请求体解码严格 JSON。
func decodeStrictJSON[T interface{}](request *http.Request, locale appLocale) (T, error) {
	return decodeStrictJSONFromReaderWithLimit[T](request.Body, locale, false, maxJSONBodyBytes)
}

// decodeStrictJSONWithLimit 只给少数大 JSON 入口使用；默认 API 仍保持 1MiB 防滥用上限。
func decodeStrictJSONWithLimit[T interface{}](request *http.Request, locale appLocale, maxBytes int64) (T, error) {
	return decodeStrictJSONFromReaderWithLimit[T](request.Body, locale, false, maxBytes)
}

// decodeOptionalStrictJSON 解码可为空的严格 JSON。
// 手动通知运行允许空 body，因此这里把“空 body”与“非法 JSON”区分开。
func decodeOptionalStrictJSON[T interface{}](request *http.Request, locale appLocale) (T, error) {
	return decodeStrictJSONFromReaderWithLimit[T](request.Body, locale, true, maxJSONBodyBytes)
}

// requireEmptyRequestBody 用于显式无参数动作，避免 `{}` 这种旧 JSON 习惯继续扩大 API 契约面。
func requireEmptyRequestBody(request *http.Request) error {
	if request.Body == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, maxEmptyRequestBodyBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxEmptyRequestBodyBytes {
		return errors.New("request body too large")
	}
	if len(data) > 0 {
		return errNonEmptyRequestBody
	}
	return nil
}

func decodeStrictJSONFromReaderWithLimit[T interface{}](reader io.Reader, locale appLocale, allowEmpty bool, maxBytes int64) (T, error) {
	var zero T
	if reader == nil {
		if allowEmpty {
			return zero, nil
		}
		return zero, errEmptyJSONBody
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return zero, err
	}
	if int64(len(data)) > maxBytes {
		return zero, errors.New("JSON body too large")
	}
	return decodeStrictJSONFromBytes[T](data, locale, allowEmpty)
}

// decodeStrictJSONFromBytes 将字节流解码为强类型请求体。
func decodeStrictJSONFromBytes[T interface{}](data []byte, locale appLocale, allowEmpty bool) (T, error) {
	var body T
	err := decodeStrictJSONBytesInto(data, &body, locale, allowEmpty)
	return body, err
}

// decodeStrictJSONBytesInto 是严格 JSON 解码的核心实现。
// 注意： `decoder.Decode(&extra)` 用于拒绝第二个 JSON token，防止 `{} {}` 这类拼接 body 被部分接受。
func decodeStrictJSONBytesInto(data []byte, target interface{}, locale appLocale, allowEmpty bool) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		if allowEmpty {
			return nil
		}
		return errEmptyJSONBody
	}

	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra struct{}
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON body must contain a single value")
		}
		return err
	}
	if validator, ok := target.(localizedValidator); ok {
		if err := validator.Validate(locale); err != nil {
			return err
		}
	}
	return nil
}

// isValidEmailAddress 用 net/mail 做基础邮箱语义校验。
func isValidEmailAddress(value string) bool {
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return false
	}
	address, err := mail.ParseAddress(value)
	return err == nil && address.Address == value
}

// newAPISuccessResponse 返回产品 JSON API 成功 envelope。
func newAPISuccessResponse(data any) apiSuccessResponse {
	if data == nil {
		data = emptyJSONPayload{}
	}
	return apiSuccessResponse{OK: true, Data: data}
}

// apiSuccessJSON 是 Docker 产品 JSON API 的唯一成功写出 helper；协议型 route 必须显式不用它。
func apiSuccessJSON(e *core.RequestEvent, status int, data any) error {
	return e.JSON(status, newAPISuccessResponse(data))
}

// newAPIEmptySuccessResponse 返回无额外业务数据的成功 envelope。
func newAPIEmptySuccessResponse() apiSuccessResponse {
	return newAPISuccessResponse(emptyJSONPayload{})
}

// apiEmptySuccessJSON 返回 `{ ok:true, data:{} }`，用于无业务 payload 的写入动作。
func apiEmptySuccessJSON(e *core.RequestEvent, status int) error {
	return e.JSON(status, newAPIEmptySuccessResponse())
}

// newHealthResponse 返回带 UTC 时间戳的 healthcheck 响应。
func newHealthResponse() healthResponse {
	return healthResponse{
		Time: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

// newReadyResponse 校验 PocketBase DB 可查询；部署平台 readiness 可用它区别进程存活和数据面就绪。
func newReadyResponse(app core.App) (healthResponse, error) {
	if _, err := app.DB().NewQuery("SELECT 1").Execute(); err != nil {
		return healthResponse{}, err
	}
	return newHealthResponse(), nil
}

// validationErrorMessage 优先透出 Validate 返回的具体错误。
func validationErrorMessage(locale appLocale, fallbackKey string, err error) string {
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		return err.Error()
	}
	return serverText(locale, fallbackKey)
}

// rawJSONIsNull 判断可选 RawMessage 是否显式传入 null。
// 显式 null 与省略字段语义不同：通知临时 settings 传 null 应被视作非法输入。
func rawJSONIsNull(value json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

// jsonBytesFromValue 将 PocketBase JSON 字段的多种运行时形态统一成 bytes。
// 注意： 这里只做格式桥接，真正的 schema 校验必须在调用方继续完成。
func jsonBytesFromValue(value interface{}) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	switch v := value.(type) {
	case json.RawMessage:
		return []byte(v), nil
	case types.JSONRaw:
		return []byte(v), nil
	case []byte:
		return v, nil
	case string:
		return []byte(v), nil
	default:
		return json.Marshal(v)
	}
}
