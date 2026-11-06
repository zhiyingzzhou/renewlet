package main

import (
	"errors"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

func validateSubscriptionBalanceWrite(amount, currency optionalJSONField[string]) error {
	// 缺席保留、双 null 清空；只改一半会把旧金额换成另一种单位，必须在 PATCH 合并前拒绝。
	if amount.Set != currency.Set || amount.Null != currency.Null {
		return errors.New("SUBSCRIPTION_BALANCE_PAIR_INVALID")
	}
	if !amount.Set || amount.Null {
		return nil
	}
	if _, err := canonicalMoneyString(amount.Value); err != nil {
		return errors.New("SUBSCRIPTION_BALANCE_INVALID")
	}
	if !currencyCodeRe.MatchString(strings.TrimSpace(currency.Value)) {
		return errors.New("SUBSCRIPTION_BALANCE_CURRENCY_INVALID")
	}
	return nil
}

func applySubscriptionBalanceWrite(record *core.Record, amount, currency optionalJSONField[string]) error {
	if err := validateSubscriptionBalanceWrite(amount, currency); err != nil {
		return err
	}
	if !amount.Set {
		return nil
	}
	if amount.Null {
		record.Set("balance", "")
		record.Set("balanceCurrency", "")
		return nil
	}
	record.Set("balance", amount.Value)
	record.Set("balanceCurrency", currency.Value)
	return normalizeSubscriptionBalanceRecord(record)
}

func normalizeSubscriptionBalanceRecord(record *core.Record) error {
	// PocketBase 可选 TextField 用空串表示未记录；API 输出省略两项，"0" 则仍是有效快照。
	amount := record.GetString("balance")
	currency := strings.TrimSpace(record.GetString("balanceCurrency"))
	if amount == "" && currency == "" {
		return nil
	}
	value, err := canonicalMoneyString(amount)
	if err != nil || !currencyCodeRe.MatchString(currency) {
		return errors.New("SUBSCRIPTION_BALANCE_INVALID")
	}
	record.Set("balance", value)
	record.Set("balanceCurrency", currency)
	return nil
}
