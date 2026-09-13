package main

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func loadNotificationHistoryJobs(app core.App, userID, status string, limit, offset int) ([]notificationHistoryJob, error) {
	filter := "user = {:user}"
	params := dbx.Params{"user": userID, "limit": limit, "offset": offset}
	if status != "all" {
		filter += " AND status = {:status}"
		params["status"] = status
	}
	var rows []struct {
		ID         string         `db:"id"`
		LocalDate  string         `db:"scheduledLocalDate"`
		LocalTime  string         `db:"scheduledLocalTime"`
		Timezone   string         `db:"timeZone"`
		Instant    string         `db:"scheduledInstantUtc"`
		Status     string         `db:"status"`
		Attempts   int            `db:"attempts"`
		LastError  string         `db:"lastError"`
		Result     string         `db:"result"`
		Created    string         `db:"created"`
		Updated    string         `db:"updated"`
		ChunkIndex sql.NullInt64  `db:"chunk_index"`
		Content    sql.NullString `db:"content"`
	}
	// 先按账号分页，再在同一个 SQLite 读快照里连接消息；不能先读旧状态、再读另一轮重试的新正文。
	err := app.DB().NewQuery(`WITH page AS (
		SELECT * FROM notification_jobs WHERE ` + filter + ` ORDER BY scheduledInstantUtc DESC, created DESC LIMIT {:limit} OFFSET {:offset}
	) SELECT page.*, messages.chunk_index, messages.content FROM page
	LEFT JOIN notification_job_messages AS messages ON messages.job_id = page.id
	ORDER BY page.scheduledInstantUtc DESC, page.created DESC, page.id, messages.chunk_index`).Bind(params).All(&rows)
	if err != nil {
		return nil, err
	}
	jobs := make([]notificationHistoryJob, 0)
	for start := 0; start < len(rows); {
		row := rows[start]
		parts := []string{}
		end := start
		for end < len(rows) && rows[end].ID == row.ID {
			part := rows[end]
			if part.ChunkIndex.Valid {
				if part.ChunkIndex.Int64 != int64(len(parts)) || !part.Content.Valid {
					return nil, fmt.Errorf("notification message %s has a missing part", row.ID)
				}
				parts = append(parts, part.Content.String)
			}
			end++
		}
		payload, err := restoreNotificationJobMessage([]byte(row.Result), parts)
		if err != nil {
			return nil, err
		}
		result := normalizeNotificationHistoryResult(payload)
		created, err := types.ParseDateTime(row.Created)
		if err != nil {
			return nil, err
		}
		updated, err := types.ParseDateTime(row.Updated)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, notificationHistoryJob{
			ID: row.ID, ScheduledLocalDate: row.LocalDate, ScheduledLocalTime: row.LocalTime,
			TimeZone: row.Timezone, ScheduledInstantUTC: row.Instant, Status: row.Status, Attempts: row.Attempts,
			LastError: nullableString(row.LastError), Result: result,
			CreatedAt: created.Time().UTC().Format(time.RFC3339), UpdatedAt: updated.Time().UTC().Format(time.RFC3339),
		})
		start = end
	}
	return jobs, nil
}

func latestNotificationHistoryJob(app core.App, userID, status string) (*notificationHistoryJob, error) {
	jobs, err := loadNotificationHistoryJobs(app, userID, status, 1, 0)
	if err != nil || len(jobs) == 0 {
		return nil, err
	}
	return &jobs[0], nil
}
