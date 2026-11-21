package subscriptionderived

import "fmt"

// Snapshot 是订阅事实行中影响派生计数的最小投影。
type Snapshot struct {
	UserID                string
	Status                string
	AutoRenew             bool
	RepeatReminderEnabled bool
}

// Delta 同时驱动固定状态统计和 scheduler 计数，避免两条写路径各自解释订阅状态。
type Delta struct {
	Total          int
	Trial          int
	Active         int
	Expired        int
	Paused         int
	Cancelled      int
	AutoRenew      int
	RepeatReminder int
}

// Between 计算指定用户在一次订阅 mutation 前后的派生计数变化。
func Between(before *Snapshot, after *Snapshot, userID string) (Delta, error) {
	beforeContribution, err := contributionForUser(before, userID)
	if err != nil {
		return Delta{}, err
	}
	afterContribution, err := contributionForUser(after, userID)
	if err != nil {
		return Delta{}, err
	}
	return Delta{
		Total:          afterContribution.Total - beforeContribution.Total,
		Trial:          afterContribution.Trial - beforeContribution.Trial,
		Active:         afterContribution.Active - beforeContribution.Active,
		Expired:        afterContribution.Expired - beforeContribution.Expired,
		Paused:         afterContribution.Paused - beforeContribution.Paused,
		Cancelled:      afterContribution.Cancelled - beforeContribution.Cancelled,
		AutoRenew:      afterContribution.AutoRenew - beforeContribution.AutoRenew,
		RepeatReminder: afterContribution.RepeatReminder - beforeContribution.RepeatReminder,
	}, nil
}

func contributionForUser(snapshot *Snapshot, userID string) (Delta, error) {
	if snapshot == nil || snapshot.UserID != userID {
		return Delta{}, nil
	}
	contribution := Delta{Total: 1}
	switch snapshot.Status {
	case "trial":
		contribution.Trial = 1
	case "active":
		contribution.Active = 1
	case "expired":
		contribution.Expired = 1
	case "paused":
		contribution.Paused = 1
	case "cancelled":
		contribution.Cancelled = 1
	default:
		return Delta{}, fmt.Errorf("unsupported subscription status %q", snapshot.Status)
	}
	if snapshot.AutoRenew {
		contribution.AutoRenew = 1
	}
	if snapshot.RepeatReminderEnabled && OrdinaryRemindersAllowed(snapshot.Status) {
		contribution.RepeatReminder = 1
	}
	return contribution, nil
}

// OrdinaryRemindersAllowed 只控制订阅自身的提醒；家庭收款按未完成责任独立投递。
func OrdinaryRemindersAllowed(status string) bool {
	return status != "paused" && status != "cancelled"
}
