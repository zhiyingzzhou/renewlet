package main

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	subscriptionCollectionLimit = 5000
	subscriptionReadPageSize    = 500
)

type subscriptionCollectionListResponse struct {
	Subscriptions []subscriptionCollectionItemResponse `json:"subscriptions"`
	NextCursor    *string                              `json:"nextCursor"`
	Total         int64                                `json:"total"`
}

type subscriptionCollectionResponse struct {
	Subscriptions []subscriptionCollectionItemResponse `json:"subscriptions"`
}

type subscriptionIndexResponse struct {
	Subscriptions []subscriptionCollectionItemResponse `json:"subscriptions"`
	Total         int64                                `json:"total"`
}

type subscriptionExportResponse struct {
	Subscriptions []subscriptionDetailResponse `json:"subscriptions"`
}

type subscriptionCollectionItemResponse struct {
	ID                           string                 `json:"id"`
	Name                         string                 `json:"name"`
	Logo                         *string                `json:"logo,omitempty"`
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
	ReminderDays                 int                    `json:"reminderDays"`
	CostSharing                  map[string]interface{} `json:"costSharing,omitempty"`
}

type subscriptionFacetsResponse struct {
	Total          int64            `json:"total"`
	CategoryCounts map[string]int64 `json:"categoryCounts"`
	Tags           []string         `json:"tags"`
	VisibleCount   int64            `json:"visibleCount"`
	HiddenCount    int64            `json:"hiddenCount"`
	ExpiredCount   int64            `json:"expiredCount"`
	LifetimeCount  int64            `json:"lifetimeCount"`
}

func handleSubscriptionsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	query, err := parseSubscriptionListQuery(e.Request.URL.Query())
	if err != nil {
		if errors.Is(err, errInvalidPrivateSubscriptionCursor) {
			return apiErrorJSON(e, http.StatusBadRequest, "INVALID_CURSOR", serverText(locale, "common.invalidRequestParameters"), nil)
		}
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	page, err := listSubscriptionRecordsForQuery(app, e.Auth.Id, query, subscriptionQueryToday(app, e.Auth, query))
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionCollectionListResponse{
		Subscriptions: subscriptionCollectionItemsFromRecords(page.Rows),
		NextCursor:    page.NextCursor,
		Total:         page.Total,
	})
}

func handleSubscriptionsIndex(app core.App, e *core.RequestEvent) error {
	query, err := parseSubscriptionIndexQuery(e.Request.URL.Query())
	if err != nil {
		return e.BadRequestError(serverText(requestLocale(e.Request), "common.invalidRequestParameters"), err)
	}
	page, err := boundedSubscriptionCollection(app, e, query)
	if err != nil {
		return err
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionIndexResponse{
		Subscriptions: subscriptionCollectionItemsFromRecords(page.Rows),
		Total:         page.Total,
	})
}

func handleSubscriptionsAnalytics(app core.App, e *core.RequestEvent) error {
	return writeSubscriptionCollection(app, e, subscriptionListQuery{})
}

func handleSubscriptionsCalendar(app core.App, e *core.RequestEvent) error {
	values := e.Request.URL.Query()
	for key, entries := range values {
		if (key != "from" && key != "to") || len(entries) != 1 {
			return e.BadRequestError(serverText(requestLocale(e.Request), "common.invalidRequestParameters"), nil)
		}
	}
	from := strings.TrimSpace(values.Get("from"))
	to := strings.TrimSpace(values.Get("to"))
	if !isValidDateOnly(from) || !isValidDateOnly(to) || from > to {
		return e.BadRequestError(serverText(requestLocale(e.Request), "common.invalidRequestParameters"), nil)
	}
	return writeSubscriptionCollection(app, e, subscriptionListQuery{
		NextBillingFrom: from,
		NextBillingTo:   to,
	})
}

func writeSubscriptionCollection(app core.App, e *core.RequestEvent, query subscriptionListQuery) error {
	page, err := boundedSubscriptionCollection(app, e, query)
	if err != nil {
		return err
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionCollectionResponse{
		Subscriptions: subscriptionCollectionItemsFromRecords(page.Rows),
	})
}

func boundedSubscriptionCollection(app core.App, e *core.RequestEvent, query subscriptionListQuery) (subscriptionListPage, error) {
	locale := requestLocale(e.Request)
	page, exceeded, err := boundedSubscriptionRecordsForQuery(
		app,
		e.Auth.Id,
		query,
		subscriptionQueryToday(app, e.Auth, query),
		subscriptionCollectionLimit,
	)
	if err != nil {
		return subscriptionListPage{}, e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if exceeded {
		// 第 5001 条只用于证明结果不完整；响应永远不能把前 5000 条伪装成完整集合。
		return subscriptionListPage{}, apiErrorJSON(
			e,
			http.StatusUnprocessableEntity,
			"SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED",
			serverText(locale, "common.invalidRequestParameters"),
			map[string]int{"limit": subscriptionCollectionLimit},
		)
	}
	return page, nil
}

func handleSubscriptionRead(app core.App, e *core.RequestEvent) error {
	record, err := findOwnedSubscription(app, e)
	if err != nil {
		return e.NotFoundError(serverText(requestLocale(e.Request), "subscription.notFound"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionResponse{Subscription: subscriptionAPIFromRecord(record)})
}

func handleSubscriptionsExport(app core.App, e *core.RequestEvent) error {
	rows, err := listOwnedSubscriptionRecords(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	subscriptions := make([]subscriptionDetailResponse, 0, len(rows))
	for _, row := range rows {
		subscriptions = append(subscriptions, subscriptionAPIFromRecord(row))
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionExportResponse{Subscriptions: subscriptions})
}

func handleSubscriptionsFacets(app core.App, e *core.RequestEvent) error {
	var counts struct {
		Total         int64 `db:"total"`
		VisibleCount  int64 `db:"visible_count"`
		HiddenCount   int64 `db:"hidden_count"`
		ExpiredCount  int64 `db:"expired_count"`
		LifetimeCount int64 `db:"lifetime_count"`
	}
	today := subscriptionQueryToday(app, e.Auth, subscriptionListQuery{})
	err := app.DB().NewQuery(`SELECT COUNT(*) AS total,
		COALESCE(SUM(CASE WHEN public_hidden = 0 THEN 1 ELSE 0 END), 0) AS visible_count,
		COALESCE(SUM(CASE WHEN public_hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden_count,
		COALESCE(SUM(CASE WHEN status = 'expired' OR (status IN ('active', 'trial') AND next_billing_date < {:today}) THEN 1 ELSE 0 END), 0) AS expired_count,
		COALESCE(SUM(CASE WHEN billing_cycle = 'one-time' AND COALESCE(one_time_term_count, 0) <= 0 THEN 1 ELSE 0 END), 0) AS lifetime_count
		FROM subscription_list_index WHERE user_id = {:user}`).Bind(dbx.Params{"user": e.Auth.Id, "today": today}).One(&counts)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	var categories []struct {
		Category string `db:"category"`
		Count    int64  `db:"count"`
	}
	err = app.DB().NewQuery(`SELECT category, COUNT(*) AS count FROM subscription_list_index
		WHERE user_id = {:user} GROUP BY category`).Bind(dbx.Params{"user": e.Auth.Id}).All(&categories)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	tagRows := []struct {
		Tag string `db:"tag"`
	}{}
	err = app.DB().NewQuery(`SELECT tag FROM subscription_tags WHERE user_id = {:user}
		GROUP BY tag ORDER BY lower(tag), tag`).Bind(dbx.Params{"user": e.Auth.Id}).All(&tagRows)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	categoryCounts := make(map[string]int64, len(categories))
	for _, row := range categories {
		categoryCounts[row.Category] = row.Count
	}
	tags := make([]string, 0, len(tagRows))
	for _, row := range tagRows {
		tags = append(tags, row.Tag)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionFacetsResponse{
		Total:          counts.Total,
		CategoryCounts: categoryCounts,
		Tags:           tags,
		VisibleCount:   counts.VisibleCount,
		HiddenCount:    counts.HiddenCount,
		ExpiredCount:   counts.ExpiredCount,
		LifetimeCount:  counts.LifetimeCount,
	})
}

func subscriptionQueryToday(app core.App, user *core.Record, query subscriptionListQuery) string {
	if query.Cursor != nil {
		// 后续页必须沿用首屏的日界线；跨午夜重新判定会让同一记录换组，导致 cursor 链漏项或重复。
		return query.Cursor.AsOf
	}
	return todayDateOnly(time.Now(), currentUserSettingsTimezone(app, user))
}

func subscriptionCollectionItemsFromRecords(records []*core.Record) []subscriptionCollectionItemResponse {
	items := make([]subscriptionCollectionItemResponse, 0, len(records))
	for _, record := range records {
		items = append(items, subscriptionCollectionAPIFromRecord(record))
	}
	return items
}

func subscriptionCollectionAPIFromRecord(record *core.Record) subscriptionCollectionItemResponse {
	billingCycle := record.GetString("billingCycle")
	out := subscriptionCollectionItemResponse{
		ID:                           record.Id,
		Name:                         record.GetString("name"),
		Logo:                         trimmedSubscriptionString(record.GetString("logo")),
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
		AutoCalculateNextBillingDate: billingCycle != "one-time" && record.GetBool("autoCalculateNextBillingDate"),
		TrialEndDate:                 trimmedSubscriptionString(record.GetString("trialEndDate")),
		ReminderDays:                 record.GetInt("reminderDays"),
	}
	if billingCycle == "custom" {
		out.CustomDays = record.GetInt("customDays")
		out.CustomCycleUnit = strings.TrimSpace(record.GetString("customCycleUnit"))
	}
	if billingCycle == "one-time" && record.GetInt("oneTimeTermCount") > 0 {
		out.OneTimeTermCount = record.GetInt("oneTimeTermCount")
		out.OneTimeTermUnit = strings.TrimSpace(record.GetString("oneTimeTermUnit"))
	}
	if costSharing := subscriptionRecordJSONMap(record, "costSharing"); len(costSharing) > 0 {
		out.CostSharing = costSharing
	}
	return out
}

func trimmedSubscriptionString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func listOwnedSubscriptionRecords(app core.App, userID string) ([]*core.Record, error) {
	rows := []*core.Record{}
	for offset := 0; ; offset += subscriptionReadPageSize {
		page, err := app.FindRecordsByFilter("subscriptions", "user = {:user}", "-created,-id", subscriptionReadPageSize, offset, dbx.Params{"user": userID})
		if err != nil {
			return nil, err
		}
		rows = append(rows, page...)
		if len(page) < subscriptionReadPageSize {
			return rows, nil
		}
	}
}
