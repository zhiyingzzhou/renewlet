package main

type subscriptionWriteRequest struct {
	Balance                      optionalJSONField[string]                 `json:"balance"`
	BalanceCurrency              optionalJSONField[string]                 `json:"balanceCurrency"`
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

func (r subscriptionWriteRequest) HasChanges() bool {
	return r.Balance.Set || r.BalanceCurrency.Set || r.Name.Set || r.Logo.Set || r.Price.Set || r.Currency.Set || r.BillingCycle.Set || r.CustomDays.Set ||
		r.CustomCycleUnit.Set || r.OneTimeTermCount.Set || r.OneTimeTermUnit.Set || r.Category.Set || r.Status.Set ||
		r.Pinned.Set || r.PublicHidden.Set || r.PaymentMethod.Set || r.StartDate.Set || r.NextBillingDate.Set ||
		r.AutoRenew.Set || r.AutoCalculateNextBillingDate.Set || r.TrialEndDate.Set || r.Website.Set || r.Notes.Set ||
		r.Tags.Set || r.ReminderDays.Set || r.RepeatReminderEnabled.Set || r.RepeatReminderInterval.Set ||
		r.RepeatReminderWindow.Set || r.CostSharing.Set || r.Extra.Set
}
