package main

import (
	"errors"

	"github.com/pocketbase/pocketbase/core"
)

var errSubscriptionRenewCostSharingInvalid = errors.New("SUBSCRIPTION_RENEW_COST_SHARING_INVALID")

func restartCostSharingMemberDates(record *core.Record, updates []subscriptionRenewMemberDate) error {
	payload, enabled := costSharingPayloadFromValue(record.Get("costSharing"))
	if !enabled {
		if len(updates) > 0 {
			return errSubscriptionRenewCostSharingInvalid
		}
		return nil
	}
	indices := make(map[string]int, len(payload.Members))
	for index, member := range payload.Members {
		indices[member.ID] = index
	}
	// owner 和版本已在事务内核验；只合并现有成员的显式日期，不允许借续订替换成员、分摊金额或提醒配置。
	for _, update := range updates {
		index, exists := indices[update.ID]
		if !exists {
			return errSubscriptionRenewCostSharingInvalid
		}
		payload.Members[index].JoinedDate = update.JoinedDate
	}
	if !costSharingMemberJoinedDatesWithinRange(payload, costSharingCollectionBillingFromRecord(record)) {
		return errSubscriptionRenewCostSharingInvalid
	}
	if len(updates) > 0 {
		record.Set("costSharing", payload)
	}
	return nil
}
