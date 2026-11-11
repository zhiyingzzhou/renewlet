package main

// 续订算法 Go 测试读取 shared JSON fixture；自动/手动续订的 date-only 推进语义必须追随 TypeScript 事实源。

import (
	"encoding/json"
	"os"
	"testing"
)

type subscriptionRenewalFixture struct {
	Name                    string                   `json:"name"`
	Input                   subscriptionRenewalInput `json:"input"`
	Today                   string                   `json:"today"`
	Mode                    renewalMode              `json:"mode"`
	Eligible                bool                     `json:"eligible"`
	ExpectedNextBillingDate string                   `json:"expectedNextBillingDate"`
	ExpectedStatus          string                   `json:"expectedStatus"`
}

func TestSubscriptionRenewalMatchesSharedFixtures(t *testing.T) {
	// Go 版算法不单独发明期望；它必须追 shared fixture，才能证明 Docker 与 Cloudflare 续订口径一致。
	data, err := os.ReadFile("../../../../packages/shared/src/subscription-renewal-fixtures.json")
	if err != nil {
		t.Fatalf("read shared fixtures: %v", err)
	}
	var fixtures []subscriptionRenewalFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("decode shared fixtures: %v", err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			eligible := isAutoRenewEligible(fixture.Input, fixture.Today)
			if fixture.Mode == renewalModeManual {
				eligible = isManualRenewEligible(fixture.Input)
			}
			if eligible != fixture.Eligible {
				t.Fatalf("eligible=%v, want %v", eligible, fixture.Eligible)
			}

			result, ok, err := advanceSubscriptionRenewal(fixture.Input, fixture.Today, fixture.Mode)
			if err != nil {
				t.Fatalf("advance: %v", err)
			}
			if ok != fixture.Eligible {
				t.Fatalf("advanced=%v, want %v", ok, fixture.Eligible)
			}
			if !fixture.Eligible {
				return
			}
			if result.NextBillingDate != fixture.ExpectedNextBillingDate || result.Status != fixture.ExpectedStatus {
				t.Fatalf("result=%+v, want next=%s status=%s", result, fixture.ExpectedNextBillingDate, fixture.ExpectedStatus)
			}
		})
	}
}

func BenchmarkManualRenewalCalendarDistance(b *testing.B) {
	for _, start := range []string{"2026-01-31", "1000-01-31"} {
		b.Run(start, func(b *testing.B) {
			input := subscriptionRenewalInput{BillingCycle: "monthly", StartDate: start, NextBillingDate: start, Status: "expired", AutoCalculateNextBillingDate: true}
			for b.Loop() {
				result, ok, err := advanceSubscriptionRenewal(input, "2026-11-06", renewalModeManual)
				if err != nil || !ok || result.NextBillingDate != "2026-11-30" {
					b.Fatalf("unexpected renewal: %+v %v", result, err)
				}
			}
		})
	}
}
