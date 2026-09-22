package main

// subscription_list_filters.go 只在 owner-scoped 派生投影上筛选和分页，再一次性回表读取完整事实记录。
// 私有分页的 cursor 只裁当前页并保留 exact total；bounded 集合只统计到上限加一，用于证明结果是否完整。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	subscriptionListDefaultLimit       = 50
	subscriptionListMaxLimit           = 100
	subscriptionListScanPageSize       = 500
	subscriptionListSearchMaxLength    = 200
	subscriptionPrivateCursorMaxLength = 512
	subscriptionPaymentMethodNoneValue = "__none"
)

var errInvalidPrivateSubscriptionCursor = errors.New("invalid private subscription cursor")

type subscriptionListQuery struct {
	Limit           int
	Cursor          *privateSubscriptionCursorPayload
	Search          string
	Categories      []string
	Tags            []string
	BillingCycles   []string
	PaymentMethods  []string
	Currencies      []string
	Status          string
	PaymentType     string
	NextBillingFrom string
	NextBillingTo   string
	Pinned          *bool
	PublicHidden    *bool
	ReminderMode    string
	RepeatReminder  *bool
	HideExpired     bool
	HideLifetime    bool
}

type subscriptionListPage struct {
	Rows       []*core.Record
	NextCursor *string
	Total      int64
}

func parseSubscriptionListQuery(values url.Values) (subscriptionListQuery, error) {
	return parseSubscriptionCollectionQuery(values, true)
}

func parseSubscriptionIndexQuery(values url.Values) (subscriptionListQuery, error) {
	return parseSubscriptionCollectionQuery(values, false)
}

func parseSubscriptionCollectionQuery(values url.Values, paginated bool) (subscriptionListQuery, error) {
	for key := range values {
		if isSubscriptionCollectionFilterKey(key) || paginated && (key == "limit" || key == "cursor") {
			continue
		}
		return subscriptionListQuery{}, fmt.Errorf("unsupported subscription query parameter %q", key)
	}
	limit := subscriptionListDefaultLimit
	var err error
	if paginated {
		if rawLimits, ok := values["limit"]; ok && (len(rawLimits) != 1 || strings.TrimSpace(rawLimits[0]) == "") {
			return subscriptionListQuery{}, errors.New("invalid limit query value")
		}
		limit, err = parsePositiveQueryInt(values.Get("limit"), subscriptionListDefaultLimit, 1, subscriptionListMaxLimit)
	}
	if err != nil {
		return subscriptionListQuery{}, err
	}
	query := subscriptionListQuery{Limit: limit}
	if paginated {
		rawCursors, hasCursor := values["cursor"]
		if !hasCursor {
			return parseSubscriptionCollectionFilters(values, query)
		}
		if len(rawCursors) != 1 || strings.TrimSpace(rawCursors[0]) == "" {
			return subscriptionListQuery{}, errors.New("invalid cursor query value")
		}
		rawCursor := strings.TrimSpace(rawCursors[0])
		if len(rawCursor) > subscriptionPrivateCursorMaxLength {
			return subscriptionListQuery{}, errInvalidPrivateSubscriptionCursor
		}
		cursor, err := parsePrivateSubscriptionCursorPayload(rawCursor)
		if err != nil {
			return subscriptionListQuery{}, fmt.Errorf("%w: %v", errInvalidPrivateSubscriptionCursor, err)
		}
		query.Cursor = &cursor
	}
	return parseSubscriptionCollectionFilters(values, query)
}

func parseSubscriptionCollectionFilters(values url.Values, query subscriptionListQuery) (subscriptionListQuery, error) {
	var err error
	if query.Search, err = parseSubscriptionListSingle(values, "q", subscriptionListSearchMaxLength, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Categories, err = parseSubscriptionListStrings(values["category"], 50, 80, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Tags, err = parseSubscriptionListStrings(values["tag"], 100, 40, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.BillingCycles, err = parseSubscriptionListStrings(values["billingCycle"], 7, 40, isValidBillingCycle); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.PaymentMethods, err = parseSubscriptionListStrings(values["paymentMethod"], 200, 80, isValidSubscriptionListPaymentMethod); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Currencies, err = parseSubscriptionListStrings(values["currency"], 50, 3, isSubscriptionListCurrency); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Status, err = parseSubscriptionListSingle(values, "status", 40, isValidSubscriptionStatus); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.PaymentType, err = parseSubscriptionListSingle(values, "paymentType", 24, isSubscriptionListPaymentType); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingFrom, err = parseSubscriptionListSingle(values, "nextBillingFrom", 10, isValidDateOnly); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingTo, err = parseSubscriptionListSingle(values, "nextBillingTo", 10, isValidDateOnly); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingFrom != "" && query.NextBillingTo != "" && query.NextBillingFrom > query.NextBillingTo {
		return subscriptionListQuery{}, errors.New("invalid next billing range")
	}
	if query.Pinned, err = parseSubscriptionListBool(values, "pinned"); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.PublicHidden, err = parseSubscriptionListBool(values, "publicHidden"); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.ReminderMode, err = parseSubscriptionListSingle(values, "reminderMode", 20, isSubscriptionListReminderMode); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.RepeatReminder, err = parseSubscriptionListBool(values, "repeatReminder"); err != nil {
		return subscriptionListQuery{}, err
	}
	return query, nil
}

func isSubscriptionCollectionFilterKey(key string) bool {
	switch key {
	case "q", "category", "tag", "billingCycle", "paymentMethod", "currency", "status", "paymentType",
		"nextBillingFrom", "nextBillingTo", "pinned", "publicHidden", "reminderMode", "repeatReminder":
		return true
	default:
		return false
	}
}

func listSubscriptionRecordsForQuery(app core.App, userID string, query subscriptionListQuery, today string) (subscriptionListPage, error) {
	// 该入口的查询预算固定为一次投影页查询和一次批量事实回表；禁止恢复逐 ID PocketBase 查询。
	projectedRows, total, err := projectedSubscriptionPage(app, userID, query, today, subscriptionProjectionExactPage, 0)
	if err != nil {
		return subscriptionListPage{}, err
	}
	pageIDs := subscriptionProjectionIDs(projectedRows)
	rows, err := getSubscriptionRecordsByIDs(app, userID, pageIDs)
	if err != nil {
		return subscriptionListPage{}, err
	}
	var nextCursor *string
	if len(rows) > query.Limit {
		rows = rows[:query.Limit]
		cursor := encodePrivateSubscriptionCursor(projectedRows[query.Limit-1], today)
		nextCursor = &cursor
	}
	return subscriptionListPage{Rows: rows, NextCursor: nextCursor, Total: total}, nil
}

func listSubscriptionRecordsInDefaultOrder(
	app core.App,
	userID string,
	today string,
	limit int,
	publicHidden *bool,
	hideExpired bool,
	hideLifetime bool,
) ([]*core.Record, error) {
	projectedRows, _, err := projectedSubscriptionPage(app, userID, subscriptionListQuery{
		Limit: limit, PublicHidden: publicHidden, HideExpired: hideExpired, HideLifetime: hideLifetime,
	}, today, subscriptionProjectionOrderedWindow, 0)
	if err != nil {
		return nil, err
	}
	return getSubscriptionRecordsByIDs(app, userID, subscriptionProjectionIDs(projectedRows))
}

func boundedSubscriptionRecordsForQuery(
	app core.App,
	userID string,
	query subscriptionListQuery,
	today string,
	limit int,
) (subscriptionListPage, bool, error) {
	query.Cursor = nil
	query.Limit = limit
	// bounded 集合只需要区分 <=5000 与 5001；投影层不得继续统计或排序第 5001 条之后的数据。
	projectedRows, total, err := projectedSubscriptionPage(
		app, userID, query, today, subscriptionProjectionBoundedCollection, limit+1,
	)
	if err != nil {
		return subscriptionListPage{}, false, err
	}
	// 超限只需要投影总数即可判定，不能先把 5001 条完整 PocketBase 记录搬进内存再丢弃。
	if total > int64(limit) {
		return subscriptionListPage{Total: total}, true, nil
	}
	rows, err := getSubscriptionRecordsByIDs(app, userID, subscriptionProjectionIDs(projectedRows))
	if err != nil {
		return subscriptionListPage{}, false, err
	}
	return subscriptionListPage{Rows: rows, Total: total}, false, nil
}

func projectedSubscriptionPage(
	app core.App,
	userID string,
	query subscriptionListQuery,
	today string,
	mode subscriptionProjectionMode,
	candidateLimit int,
) ([]subscriptionListIndexRow, int64, error) {
	base := subscriptionProjectionBaseQuery(userID, query)
	if query.Search != "" {
		base.conditions = append(base.conditions, "instr(idx.search_text_lower, {:search}) > 0")
		base.params["search"] = strings.ToLower(strings.TrimSpace(query.Search))
	}
	if query.Status != "" {
		base.conditions = append(base.conditions, `(CASE
			WHEN idx.status = 'expired' THEN 'expired'
			WHEN idx.billing_cycle = 'one-time' AND idx.one_time_term_count <= 0 THEN idx.status
			WHEN idx.status IN ('active', 'trial') AND idx.next_billing_date < {:today} THEN 'expired'
			ELSE idx.status
		END) = {:status}`)
		base.params["status"] = query.Status
	}
	if query.HideExpired {
		base.conditions = append(base.conditions, "NOT (idx.status = 'expired' OR (idx.status IN ('active', 'trial') AND idx.next_billing_date < {:today}))")
	}
	if query.HideLifetime {
		base.conditions = append(base.conditions, "NOT (idx.billing_cycle = 'one-time' AND idx.one_time_term_count <= 0)")
	}
	base.params["today"] = today
	rows, err := runSubscriptionProjectionPage(app, base, query.Limit+1, query.Cursor, mode, candidateLimit)
	if err != nil {
		return nil, 0, err
	}
	if len(rows) == 0 {
		return []subscriptionListIndexRow{}, 0, nil
	}
	total := int64(rows[0].TotalCount)
	page := make([]subscriptionListIndexRow, 0, len(rows))
	for _, row := range rows {
		if row.SubscriptionID != "" {
			page = append(page, row)
		}
	}
	return page, total, nil
}

type subscriptionProjectionBase struct {
	conditions []string
	params     dbx.Params
}

func subscriptionProjectionBaseQuery(userID string, query subscriptionListQuery) subscriptionProjectionBase {
	base := subscriptionProjectionBase{
		conditions: []string{"idx.user_id = {:user}"},
		params:     dbx.Params{"user": userID},
	}
	appendSQLInCondition(&base, "idx.category", "category", query.Categories)
	appendSQLInCondition(&base, "idx.billing_cycle", "billingCycle", query.BillingCycles)
	appendSQLInCondition(&base, "idx.currency", "currency", query.Currencies)
	appendSQLPaymentMethodCondition(&base, query.PaymentMethods)
	appendSQLPaymentTypeCondition(&base, query.PaymentType)
	appendSQLTagCondition(&base, query.Tags)
	if query.NextBillingFrom != "" || query.NextBillingTo != "" {
		// PocketBase 投影用 0 表示长期买断服务期；日期范围只筛真实续费/到期事件，不能把购买日占位值算进去。
		base.conditions = append(base.conditions, "NOT (idx.billing_cycle = 'one-time' AND idx.one_time_term_count <= 0)")
	}
	if query.NextBillingFrom != "" {
		base.conditions = append(base.conditions, "idx.next_billing_date >= {:nextBillingFrom}")
		base.params["nextBillingFrom"] = query.NextBillingFrom
	}
	if query.NextBillingTo != "" {
		base.conditions = append(base.conditions, "idx.next_billing_date <= {:nextBillingTo}")
		base.params["nextBillingTo"] = query.NextBillingTo
	}
	if query.Pinned != nil {
		base.conditions = append(base.conditions, "idx.pinned = {:pinned}")
		base.params["pinned"] = boolToSQLiteInt(*query.Pinned)
	}
	if query.PublicHidden != nil {
		base.conditions = append(base.conditions, "idx.public_hidden = {:publicHidden}")
		base.params["publicHidden"] = boolToSQLiteInt(*query.PublicHidden)
	}
	appendSQLReminderModeCondition(&base, query.ReminderMode)
	if query.RepeatReminder != nil {
		base.conditions = append(base.conditions, "idx.repeat_reminder_enabled = {:repeatReminder}")
		base.params["repeatReminder"] = boolToSQLiteInt(*query.RepeatReminder)
	}
	return base
}

type subscriptionProjectionPagePlan struct {
	SQL    string
	Params dbx.Params
}

type subscriptionProjectionMode int

const (
	subscriptionProjectionExactPage subscriptionProjectionMode = iota
	subscriptionProjectionBoundedCollection
	subscriptionProjectionOrderedWindow
)

func buildSubscriptionProjectionPagePlan(
	base subscriptionProjectionBase,
	limit int,
	cursor *privateSubscriptionCursorPayload,
	mode subscriptionProjectionMode,
	candidateLimit int,
) subscriptionProjectionPagePlan {
	pageConditions := []string{"1 = 1"}
	params := dbx.Params{}
	for key, value := range base.params {
		params[key] = value
	}
	if cursor != nil {
		// 四个分支逐项对应 pinned DESC、inactive ASC、created DESC、id DESC，cursor 条件不能遗漏任何排序键。
		pageConditions = append(pageConditions, `(idx.pinned < {:cursorPinned}
			OR (idx.pinned = {:cursorPinned} AND idx.inactive > {:cursorInactive})
			OR (idx.pinned = {:cursorPinned} AND idx.inactive = {:cursorInactive} AND idx.created_at < {:cursorCreatedAt})
			OR (idx.pinned = {:cursorPinned} AND idx.inactive = {:cursorInactive} AND idx.created_at = {:cursorCreatedAt} AND idx.subscription_id < {:cursorID}))`)
		params["cursorPinned"] = cursor.Pinned
		params["cursorInactive"] = cursor.Inactive
		params["cursorCreatedAt"] = cursor.CreatedAt
		params["cursorID"] = cursor.ID
	}
	params["limit"] = limit
	withPrefix := ""
	filteredSource := "subscription_list_index AS idx"
	filteredConditions := strings.Join(base.conditions, " AND ")
	if mode == subscriptionProjectionBoundedCollection {
		params["candidateLimit"] = candidateLimit
		// bounded 先任取最多 5001 条完整匹配候选，再计算动态生命周期并排序；超限分支只需证明集合不完整。
		withPrefix = fmt.Sprintf(`candidates AS MATERIALIZED (
			SELECT subscription_id, user_id, pinned, created_at, status, billing_cycle,
				one_time_term_count, next_billing_date
			FROM subscription_list_index AS idx
			WHERE %s
			LIMIT {:candidateLimit}
		), `, filteredConditions)
		filteredSource = "candidates AS idx"
		filteredConditions = "1 = 1"
	}
	// exact page 和 ordered window 必须从完整过滤集排序；状态与后续页共同使用 cursor 冻结的 asOf。
	filteredCTE := fmt.Sprintf(`%sfiltered AS (
			SELECT subscription_id, user_id, pinned, created_at,
				CASE
					WHEN idx.status IN ('expired', 'paused', 'cancelled') THEN 1
					WHEN idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0 THEN 0
					WHEN idx.status IN ('active', 'trial') AND idx.next_billing_date < {:today} THEN 1
					ELSE 0
				END AS inactive
				FROM %s
				WHERE %s
		)`, withPrefix, filteredSource, filteredConditions)
	if mode == subscriptionProjectionOrderedWindow {
		query := fmt.Sprintf(`WITH %s
			SELECT idx.subscription_id, idx.user_id, idx.pinned, idx.created_at, idx.inactive,
				0 AS total_count
			FROM filtered AS idx
			WHERE %s
			ORDER BY idx.pinned DESC, idx.inactive ASC, idx.created_at DESC, idx.subscription_id DESC
			LIMIT {:limit}`, filteredCTE, strings.Join(pageConditions, " AND "))
		return subscriptionProjectionPagePlan{SQL: query, Params: params}
	}
	query := fmt.Sprintf(`WITH %s, page AS (
			SELECT * FROM filtered AS idx
			WHERE %s
			ORDER BY idx.pinned DESC, idx.inactive ASC, idx.created_at DESC, idx.subscription_id DESC
			LIMIT {:limit}
		), totals AS (
			SELECT COUNT(*) AS total_count FROM filtered
		)
			SELECT COALESCE(page.subscription_id, '') AS subscription_id, COALESCE(page.user_id, '') AS user_id,
			COALESCE(page.pinned, 0) AS pinned, COALESCE(page.created_at, '') AS created_at,
			COALESCE(page.inactive, 0) AS inactive,
			totals.total_count
			FROM totals LEFT JOIN page ON 1 = 1
				ORDER BY page.pinned DESC, page.inactive ASC, page.created_at DESC, page.subscription_id DESC`, filteredCTE, strings.Join(pageConditions, " AND "))
	return subscriptionProjectionPagePlan{SQL: query, Params: params}
}

func runSubscriptionProjectionPage(
	app core.App,
	base subscriptionProjectionBase,
	limit int,
	cursor *privateSubscriptionCursorPayload,
	mode subscriptionProjectionMode,
	candidateLimit int,
) ([]subscriptionListIndexRow, error) {
	plan := buildSubscriptionProjectionPagePlan(base, limit, cursor, mode, candidateLimit)
	var rows []subscriptionListIndexRow
	err := app.DB().NewQuery(plan.SQL).
		Bind(plan.Params).
		All(&rows)
	return rows, err
}

func appendSQLInCondition(base *subscriptionProjectionBase, column string, prefix string, values []string) {
	if len(values) == 0 {
		return
	}
	placeholders := make([]string, 0, len(values))
	for index, value := range values {
		key := prefix + strconv.Itoa(index)
		placeholders = append(placeholders, "{:"+key+"}")
		base.params[key] = value
	}
	base.conditions = append(base.conditions, column+" IN ("+strings.Join(placeholders, ", ")+")")
}

func appendSQLPaymentMethodCondition(base *subscriptionProjectionBase, values []string) {
	if len(values) == 0 {
		return
	}
	parts := []string{}
	concrete := []string{}
	for _, value := range values {
		if value == subscriptionPaymentMethodNoneValue {
			parts = append(parts, "idx.payment_method = ''")
		} else {
			concrete = append(concrete, value)
		}
	}
	if len(concrete) > 0 {
		placeholders := make([]string, 0, len(concrete))
		for index, value := range concrete {
			key := "paymentMethod" + strconv.Itoa(index)
			placeholders = append(placeholders, "{:"+key+"}")
			base.params[key] = value
		}
		parts = append(parts, "idx.payment_method IN ("+strings.Join(placeholders, ", ")+")")
	}
	base.conditions = append(base.conditions, "("+strings.Join(parts, " OR ")+")")
}

func appendSQLPaymentTypeCondition(base *subscriptionProjectionBase, paymentType string) {
	switch paymentType {
	case "auto":
		base.conditions = append(base.conditions, "idx.billing_cycle != 'one-time' AND idx.auto_renew = 1")
	case "manual":
		base.conditions = append(base.conditions, "idx.billing_cycle != 'one-time' AND idx.auto_renew = 0")
	case "one-time-buyout":
		// PocketBase 数字字段的空值会落为 0；<= 0 与 Worker D1 的 NULL/历史非正值语义对齐。
		base.conditions = append(base.conditions, "idx.billing_cycle = 'one-time' AND idx.one_time_term_count <= 0")
	case "one-time-fixed-term":
		base.conditions = append(base.conditions, "idx.billing_cycle = 'one-time' AND idx.one_time_term_count > 0")
	}
}

func appendSQLTagCondition(base *subscriptionProjectionBase, values []string) {
	if len(values) == 0 {
		return
	}
	parts := make([]string, 0, len(values))
	for index, tag := range values {
		keyNorm := "tagNorm" + strconv.Itoa(index)
		keyValue := "tag" + strconv.Itoa(index)
		parts = append(parts, "(tag.tag_norm = {:"+keyNorm+"} AND tag.tag = {:"+keyValue+"})")
		base.params[keyNorm] = strings.ToLower(tag)
		base.params[keyValue] = tag
	}
	base.conditions = append(base.conditions, `EXISTS (
		SELECT 1 FROM subscription_tags AS tag
		WHERE tag.user_id = idx.user_id
			AND tag.subscription_id = idx.subscription_id
			AND (`+strings.Join(parts, " OR ")+`)
	)`)
}

func appendSQLReminderModeCondition(base *subscriptionProjectionBase, mode string) {
	switch mode {
	case "disabled":
		base.conditions = append(base.conditions, "idx.reminder_days = -2")
	case "inherit":
		base.conditions = append(base.conditions, "idx.reminder_days = -1")
	case "custom":
		base.conditions = append(base.conditions, "idx.reminder_days >= 0")
	}
}

func subscriptionProjectionIDs(rows []subscriptionListIndexRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.SubscriptionID != "" {
			ids = append(ids, row.SubscriptionID)
		}
	}
	return ids
}

func subscriptionRecordStringSlice(record *core.Record, name string) []string {
	data, err := jsonBytesFromValue(record.Get(name))
	if err != nil || len(data) == 0 {
		return []string{}
	}
	var values []string
	if err := json.Unmarshal(data, &values); err != nil || values == nil {
		return []string{}
	}
	return values
}

func parseSubscriptionListStrings(values []string, maxItems int, maxLength int, validate func(string) bool) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > maxItems {
		return nil, errors.New("too many query values")
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || len(value) > maxLength {
			return nil, errors.New("invalid query value")
		}
		if validate != nil && !validate(value) {
			return nil, errors.New("invalid query value")
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out, nil
}

func parseSubscriptionListSingle(values url.Values, name string, maxLength int, validate func(string) bool) (string, error) {
	rawValues := values[name]
	if len(rawValues) == 0 {
		return "", nil
	}
	if len(rawValues) > 1 {
		return "", errors.New("duplicate query value")
	}
	value := strings.TrimSpace(rawValues[0])
	if value == "" || len(value) > maxLength {
		return "", errors.New("invalid query value")
	}
	if validate != nil && !validate(value) {
		return "", errors.New("invalid query value")
	}
	return value, nil
}

func parseSubscriptionListBool(values url.Values, name string) (*bool, error) {
	rawValues := values[name]
	if len(rawValues) == 0 {
		return nil, nil
	}
	if len(rawValues) > 1 {
		return nil, errors.New("duplicate boolean query value")
	}
	var parsed bool
	switch strings.TrimSpace(rawValues[0]) {
	case "true", "1":
		parsed = true
	case "false", "0":
		parsed = false
	default:
		return nil, errors.New("invalid boolean query value")
	}
	return &parsed, nil
}

func isValidSubscriptionListPaymentMethod(value string) bool {
	return value == subscriptionPaymentMethodNoneValue || (strings.TrimSpace(value) == value && value != "")
}

func isSubscriptionListCurrency(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, char := range value {
		if char < 'A' || char > 'Z' {
			return false
		}
	}
	return true
}

func isSubscriptionListPaymentType(value string) bool {
	switch value {
	case "auto", "manual", "one-time-buyout", "one-time-fixed-term":
		return true
	default:
		return false
	}
}

func isSubscriptionListReminderMode(value string) bool {
	switch value {
	case "disabled", "inherit", "custom":
		return true
	default:
		return false
	}
}
