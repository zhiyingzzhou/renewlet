package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"
	"github.com/pocketbase/pocketbase/tools/types"
)

var errSubscriptionWriteConflict = errors.New("SUBSCRIPTION_WRITE_CONFLICT")
var errPublicVisibilityIndex = errors.New("SUBSCRIPTION_PUBLIC_INDEX_INCONSISTENT")

type subscriptionBulkPublicVisibilitySelection struct {
	IDs        []string `json:"ids,omitempty"`
	Categories []string `json:"categories,omitempty"`
}

type subscriptionBulkPublicVisibilityRequest struct {
	Selection    subscriptionBulkPublicVisibilitySelectionInput `json:"selection"`
	PublicHidden optionalJSONField[bool]                        `json:"publicHidden"`
	DryRun       optionalJSONField[bool]                        `json:"dryRun"`
}

type subscriptionBulkPublicVisibilitySelectionInput struct {
	IDs        optionalJSONField[[]string] `json:"ids"`
	Categories optionalJSONField[[]string] `json:"categories"`
}

type subscriptionBulkPublicVisibilityResponse struct {
	MatchedCount int      `json:"matchedCount"`
	ChangedCount int      `json:"changedCount"`
	SkippedCount int      `json:"skippedCount"`
	FailedIDs    []string `json:"failedIds"`
}

type publicVisibilityTarget struct {
	ID               string `db:"id" json:"id"`
	User             string `db:"user" json:"user"`
	PublicHidden     bool   `db:"publicHidden" json:"publicHidden"`
	Updated          string `db:"updated" json:"updated"`
	Status           string `db:"status" json:"status"`
	NextBillingDate  string `db:"nextBillingDate" json:"nextBillingDate"`
	BillingCycle     string `db:"billingCycle" json:"billingCycle"`
	OneTimeTermCount int    `db:"oneTimeTermCount" json:"oneTimeTermCount"`
}

const visibilityColumns = "s.id, s.user, s.publicHidden, s.updated, s.status, s.nextBillingDate, s.billingCycle, s.oneTimeTermCount"

func handleBulkPublicVisibility(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionBulkPublicVisibilityRequest](e.Request, locale)
	if err != nil || !body.PublicHidden.Set || body.PublicHidden.Null || body.DryRun.Null {
		return e.BadRequestError(serverText(locale, "common.invalidRequestBody"), err)
	}
	// 与 shared 严格互斥联合一致：显式 null 也是已提供字段，不能当作省略而接受两种选择范围。
	if body.Selection.IDs.Set == body.Selection.Categories.Set || body.Selection.IDs.Null || body.Selection.Categories.Null {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	selection := subscriptionBulkPublicVisibilitySelection{IDs: body.Selection.IDs.Value, Categories: body.Selection.Categories.Value}
	if (len(selection.IDs) == 0 && len(selection.Categories) == 0) || len(selection.IDs) > subscriptionCollectionLimit || len(selection.Categories) > 2 {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	for _, id := range selection.IDs {
		if value := strings.TrimSpace(id); value == "" || utf8.RuneCountInString(value) > 80 {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
	}
	for _, category := range selection.Categories {
		if category != "expired" && category != "lifetime" {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
	}
	selection.IDs = uniqueNonEmptyStrings(trimVisibilityIDs(selection.IDs)...)
	rows, err := readPublicVisibilityTargets(app, e.Auth.Id, selection, subscriptionQueryToday(app, e.Auth, subscriptionListQuery{}))
	if err != nil {
		return publicVisibilityError(app, e, err)
	}
	if len(rows) > subscriptionCollectionLimit {
		return apiErrorJSON(e, http.StatusUnprocessableEntity, "SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED", serverText(locale, "common.invalidRequestParameters"), map[string]int{"limit": subscriptionCollectionLimit})
	}
	changed := make([]publicVisibilityTarget, 0, len(rows))
	matched := make(map[string]bool, len(rows))
	for _, row := range rows {
		matched[row.ID] = true
		if row.PublicHidden != body.PublicHidden.Value {
			changed = append(changed, row)
		}
	}
	failed := []string{}
	for _, id := range selection.IDs {
		if !matched[id] {
			failed = append(failed, id)
		}
	}
	if !body.DryRun.Value {
		if err := writePublicVisibility(app, e.Auth.Id, changed, body.PublicHidden.Value); err != nil {
			return publicVisibilityError(app, e, err)
		}
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionBulkPublicVisibilityResponse{len(rows), len(changed), len(rows) - len(changed), failed})
}

func trimVisibilityIDs(ids []string) []string {
	result := make([]string, len(ids))
	for i, id := range ids {
		result[i] = strings.TrimSpace(id)
	}
	return result
}

func readPublicVisibilityTargets(app core.App, userID string, selection subscriptionBulkPublicVisibilitySelection, today string) ([]publicVisibilityTarget, error) {
	rows := []publicVisibilityTarget{}
	params := dbx.Params{"user": userID, "today": today}
	query := "SELECT " + visibilityColumns + " FROM subscriptions AS s WHERE s.user = {:user}"
	if len(selection.IDs) > 0 {
		ids, err := json.Marshal(selection.IDs)
		if err != nil {
			return nil, err
		}
		params["ids"] = string(ids)
		// JSON 目标表必须驱动 ID 点查；允许优化器先遍历 owner 索引会把每个目标重复扫描成 O(n²)。
		query = "SELECT " + visibilityColumns + " FROM json_each({:ids}) AS selected CROSS JOIN subscriptions AS s ON s.id = selected.value WHERE s.user = {:user} ORDER BY CAST(selected.key AS INTEGER)"
	} else {
		clauses := []string{}
		for _, category := range uniqueNonEmptyStrings(selection.Categories...) {
			if category == "expired" {
				clauses = append(clauses, "(s.status = 'expired' OR (s.status IN ('active', 'trial') AND s.nextBillingDate < {:today}))")
			}
			if category == "lifetime" {
				clauses = append(clauses, "(s.billingCycle = 'one-time' AND s.oneTimeTermCount <= 0)")
			}
		}
		query += " AND (" + strings.Join(clauses, " OR ") + ") ORDER BY s.created DESC, s.id DESC LIMIT 5001"
	}
	err := app.DB().NewQuery(query).Bind(params).All(&rows)
	return rows, err
}

func writePublicVisibility(app core.App, userID string, rows []publicVisibilityTarget, publicHidden bool) error {
	if len(rows) == 0 {
		return nil
	}
	if len(rows) > subscriptionCollectionLimit {
		return errors.New("visibility mutation exceeds limit")
	}
	for _, row := range rows {
		if row.User != userID {
			return errSubscriptionWriteConflict
		}
	}
	payload, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	params := dbx.Params{"rows": string(payload), "user": userID, "target": boolToSQLiteInt(publicHidden), "now": types.NowDateTime().String()}
	// 单条公开性 PATCH 与批量命令共用事务；只写事实公开列和投影，不重建标签、统计或通知调度。
	// PocketBase 时间必须使用 DateTime.String；RFC3339 直写会破坏原始快照和后续日期解析的一致性。
	return app.RunInTransaction(func(txApp core.App) error {
		var counts struct {
			Facts      int `db:"facts"`
			Projection int `db:"projection"`
		}
		err := txApp.DB().NewQuery(`SELECT COUNT(*) AS facts,
			COALESCE(SUM(CASE WHEN i.user_id = s.user AND i.public_hidden = s.publicHidden THEN 1 ELSE 0 END), 0) AS projection
			FROM json_each({:rows}) AS expected CROSS JOIN subscriptions AS s ON s.id = json_extract(expected.value, '$.id')
			LEFT JOIN subscription_list_index AS i ON i.subscription_id = s.id WHERE s.user = {:user}
			AND s.publicHidden IS json_extract(expected.value, '$.publicHidden') AND s.updated IS json_extract(expected.value, '$.updated')
			AND s.status IS json_extract(expected.value, '$.status') AND s.nextBillingDate IS json_extract(expected.value, '$.nextBillingDate')
			AND s.billingCycle IS json_extract(expected.value, '$.billingCycle') AND s.oneTimeTermCount IS json_extract(expected.value, '$.oneTimeTermCount')`).Bind(params).One(&counts)
		if err != nil {
			return err
		}
		if counts.Facts != len(rows) {
			return errSubscriptionWriteConflict
		}
		if counts.Projection != len(rows) {
			return errPublicVisibilityIndex
		}
		for _, sql := range []string{
			`UPDATE subscriptions SET publicHidden = {:target}, updated = {:now} WHERE user = {:user} AND id IN (SELECT json_extract(value, '$.id') FROM json_each({:rows}))`,
			`UPDATE subscription_list_index SET public_hidden = {:target}, updated_at = {:now} WHERE user_id = {:user} AND subscription_id IN (SELECT json_extract(value, '$.id') FROM json_each({:rows}))`,
		} {
			result, err := txApp.DB().NewQuery(sql).Bind(params).Execute()
			if err != nil {
				return err
			}
			count, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if count != int64(len(rows)) {
				return errPublicVisibilityIndex
			}
		}
		var applied struct {
			Count int `db:"count"`
		}
		if err := txApp.DB().NewQuery(`SELECT COUNT(*) AS count FROM json_each({:rows}) AS selected
            CROSS JOIN subscriptions AS s ON s.id=json_extract(selected.value, '$.id')
            JOIN subscription_list_index AS i ON i.subscription_id=s.id
            WHERE s.user={:user} AND i.user_id=s.user AND s.publicHidden={:target} AND i.public_hidden=s.publicHidden
              AND s.updated={:now} AND i.updated_at=s.updated`).Bind(params).One(&applied); err != nil {
			return err
		}
		if applied.Count != len(rows) {
			return errPublicVisibilityIndex
		}
		return nil
	})
}

func visibilityTargetFromRecord(record *core.Record) publicVisibilityTarget {
	return publicVisibilityTarget{record.Id, record.GetString("user"), record.GetBool("publicHidden"), record.GetDateTime("updated").String(), record.GetString("status"), record.GetString("nextBillingDate"), record.GetString("billingCycle"), record.GetInt("oneTimeTermCount")}
}

func handleSinglePublicVisibilityUpdate(app core.App, e *core.RequestEvent, record *core.Record, target optionalJSONField[bool]) error {
	if target.Null {
		return e.BadRequestError(serverText(requestLocale(e.Request), "common.invalidRequestParameters"), nil)
	}
	if record.GetBool("publicHidden") != target.Value {
		if err := writePublicVisibility(app, e.Auth.Id, []publicVisibilityTarget{visibilityTargetFromRecord(record)}, target.Value); err != nil {
			return publicVisibilityError(app, e, err)
		}
		current, err := findOwnedSubscription(app, e)
		if err != nil {
			return publicVisibilityError(app, e, err)
		}
		record = current
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionResponse{Subscription: subscriptionAPIFromRecord(record)})
}

func publicVisibilityError(app core.App, e *core.RequestEvent, err error) error {
	locale := requestLocale(e.Request)
	if errors.Is(err, errSubscriptionWriteConflict) {
		return apiErrorJSON(e, http.StatusConflict, "SUBSCRIPTION_WRITE_CONFLICT", serverText(locale, "subscription.visibilityConflict"), nil)
	}
	requestID := security.RandomString(16)
	app.Logger().Error("subscription_public_visibility_failed", "requestId", requestID, "error", err)
	return apiErrorJSON(e, http.StatusInternalServerError, "SUBSCRIPTION_PUBLIC_VISIBILITY_FAILED", serverText(locale, "subscription.visibilityFailed"), map[string]string{"requestId": requestID})
}
