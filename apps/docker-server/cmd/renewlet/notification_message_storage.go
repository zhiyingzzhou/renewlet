package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const notificationMessageMigration = "notification_message_snapshots_v1"
const notificationMessageRecoveryPoint = "renewlet_pre_notification_message_snapshots_v1.zip"
const notificationMessageChunkRunes = 8192

func notificationMessageHistoryExists(app core.App) (bool, error) {
	exists, err := sqliteObjectExists(app, "table", "notification_jobs")
	if err != nil || !exists {
		return false, err
	}
	var row struct {
		Exists bool `db:"exists"`
	}
	err = app.DB().NewQuery(`SELECT EXISTS(SELECT 1 FROM notification_jobs WHERE json_type(result, '$.message') IS NOT NULL) AS "exists"`).One(&row)
	return row.Exists, err
}

func ensureNotificationMessageTable(app core.App) error {
	// 正文属于私有审计快照，不暴露 PocketBase collection API；删除任务时由外键一起清理。
	_, err := app.DB().NewQuery(`CREATE TABLE IF NOT EXISTS notification_job_messages (
		job_id TEXT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
		chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
		content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8192),
		PRIMARY KEY (job_id, chunk_index)
	)`).Execute()
	return err
}

func splitNotificationJobMessage(payload []byte) (json.RawMessage, []string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return nil, nil, err
	}
	message, exists := fields["message"]
	if !exists {
		return payload, nil, nil
	}
	parts := notificationMessageParts(message)
	delete(fields, "message")
	fields["messageChunkCount"] = json.RawMessage(strconv.Itoa(len(parts)))
	metadata, err := json.Marshal(fields)
	return metadata, parts, err
}

func notificationMessageParts(message []byte) []string {
	// Go、Worker 和一次性 SQL 迁移都按 Unicode 码点分段；不切断 emoji，也不按压缩率赌字段能装下。
	runes := []rune(string(message))
	parts := make([]string, 0, (len(runes)+notificationMessageChunkRunes-1)/notificationMessageChunkRunes)
	for start := 0; start < len(runes); start += notificationMessageChunkRunes {
		parts = append(parts, string(runes[start:min(start+notificationMessageChunkRunes, len(runes))]))
	}
	return parts
}

func writeNotificationJobMessage(app core.App, jobID string, parts []string) error {
	if _, err := app.DB().NewQuery("DELETE FROM notification_job_messages WHERE job_id = {:job}").Bind(dbx.Params{"job": jobID}).Execute(); err != nil {
		return err
	}
	// 每批最多 16 段，连同 JSON 转义仍远低于 D1 单值限制；SQL 数量随快照字节增长，而不是每条订阅一条 SQL。
	for start := 0; start < len(parts); start += 16 {
		payload, err := json.Marshal(parts[start:min(start+16, len(parts))])
		if err != nil {
			return err
		}
		_, err = app.DB().NewQuery(`INSERT INTO notification_job_messages (job_id, chunk_index, content)
			SELECT {:job}, {:offset} + CAST(key AS INTEGER), value FROM json_each({:parts})`).
			Bind(dbx.Params{"job": jobID, "offset": start, "parts": string(payload)}).Execute()
		if err != nil {
			return err
		}
	}
	return nil
}

func restoreNotificationJobMessage(metadata []byte, parts []string) (json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(metadata, &fields); err != nil {
		return json.RawMessage("{}"), nil
	}
	countJSON, exists := fields["messageChunkCount"]
	if !exists {
		// 空/坏历史仍按原公开契约出站；已转换运行时不接受旧的内嵌 message 形状。
		return json.RawMessage("{}"), nil
	}
	var count int
	if err := json.Unmarshal(countJSON, &count); err != nil || count <= 0 || count != len(parts) {
		return nil, errors.New("notification message snapshot is incomplete")
	}
	message := json.RawMessage(strings.Join(parts, ""))
	if !json.Valid(message) {
		return nil, errors.New("notification message snapshot is invalid")
	}
	delete(fields, "messageChunkCount")
	fields["message"] = message
	return json.Marshal(fields)
}

func migrateNotificationJobMessages(app core.App) error {
	// v0.2.95 的历史条目仍保存数字金额；沿用既有金额迁移的六位小数规则，仅在排他转换中切换成字符串。
	if _, err := app.DB().NewQuery(`UPDATE notification_jobs SET result = json_set(result, '$.message.items', json((
		SELECT json_group_array(json(CASE WHEN json_type(value, '$.price') IN ('integer', 'real')
			THEN json_set(value, '$.price', rtrim(rtrim(printf('%.6f', json_extract(value, '$.price')), '0'), '.'))
			ELSE value END)) FROM json_each(result, '$.message.items')
	))) WHERE EXISTS (SELECT 1 FROM json_each(result, '$.message.items') WHERE json_type(value, '$.price') IN ('integer', 'real'))`).Execute(); err != nil {
		return err
	}
	// 只在启动迁移账本里转换一次；原 result 清除前逐条核对完整 JSON 语义，失败连同 marker 回滚。
	lastID := ""
	for {
		var rows []struct {
			ID     string `db:"id"`
			Result string `db:"result"`
		}
		if err := app.DB().NewQuery("SELECT id, COALESCE(result, '{}') AS result FROM notification_jobs WHERE id > {:id} ORDER BY id LIMIT 100").Bind(dbx.Params{"id": lastID}).All(&rows); err != nil {
			return err
		}
		for _, row := range rows {
			metadata, parts, err := splitNotificationJobMessage([]byte(row.Result))
			if err != nil {
				return fmt.Errorf("migrate notification job %s: %w", row.ID, err)
			}
			if len(parts) == 0 {
				continue
			}
			if err := writeNotificationJobMessage(app, row.ID, parts); err != nil {
				return err
			}
			restored, err := restoreNotificationJobMessage(metadata, parts)
			if err != nil {
				return err
			}
			// 字段顺序不是业务语义；逐字段比较避免 JSON 对象重新编码改变键序时产生假失败。
			var before, after map[string]json.RawMessage
			if err := json.Unmarshal([]byte(row.Result), &before); err != nil {
				return err
			}
			if err := json.Unmarshal(restored, &after); err != nil {
				return err
			}
			canonicalBefore, err := json.Marshal(before)
			if err != nil {
				return err
			}
			canonicalAfter, err := json.Marshal(after)
			if err != nil {
				return err
			}
			if string(canonicalBefore) != string(canonicalAfter) {
				return errors.New("notification migration changed snapshot")
			}
			if _, err := app.DB().NewQuery("UPDATE notification_jobs SET result = {:result} WHERE id = {:id}").Bind(dbx.Params{"result": string(metadata), "id": row.ID}).Execute(); err != nil {
				return err
			}
		}
		if len(rows) < 100 {
			break
		}
		lastID = rows[len(rows)-1].ID
	}
	return nil
}

func preflightNotificationJobMessages(app core.App) error {
	var row struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM notification_jobs WHERE result IS NOT NULL AND NOT json_valid(result)").One(&row); err != nil {
		return err
	}
	if row.Count != 0 {
		return errors.New("notification message migration found invalid JSON")
	}
	return nil
}

func verifyNotificationMessageTable(app core.App) error {
	var row struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM pragma_table_info('notification_job_messages') WHERE name IN ('job_id', 'chunk_index', 'content')").One(&row); err != nil {
		return err
	}
	if row.Count != 3 {
		return errors.New("notification message table schema is incomplete")
	}
	return nil
}

func notificationMessageGuardStatements() map[string]string {
	statements := make(map[string]string, 2)
	for _, operation := range []string{"INSERT", "UPDATE OF result"} {
		suffix := "insert"
		if operation != "INSERT" {
			suffix = "update"
		}
		name := "renewlet_notification_message_contract_" + suffix
		statements[name] = `CREATE TRIGGER ` + name + ` BEFORE ` + operation + ` ON notification_jobs FOR EACH ROW
			WHEN json_type(NEW.result, '$.message') IS NOT NULL OR length(CAST(NEW.result AS BLOB)) > 65536
			BEGIN SELECT RAISE(ABORT, 'NOTIFICATION_MESSAGE_STORAGE_CONTRACT_INVALID'); END`
	}
	return statements
}

func installNotificationMessageGuards(app core.App) error {
	// 一次性转换后数据库拒绝旧写入；不在读取或定时任务中检测、重写历史格式。
	for _, statement := range notificationMessageGuardStatements() {
		if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
			return err
		}
	}
	return nil
}

func verifyNotificationMessageGuards(app core.App) error {
	// 已完成升级的启动只核对两条 guard，不重复扫描或回填历史消息。
	for name, expected := range notificationMessageGuardStatements() {
		var row struct {
			SQL string `db:"sql"`
		}
		if err := app.DB().NewQuery("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = {:name}").Bind(dbx.Params{"name": name}).One(&row); err != nil {
			return err
		}
		if strings.Join(strings.Fields(row.SQL), " ") != strings.Join(strings.Fields(expected), " ") {
			return errors.New("notification message storage guard drift")
		}
	}
	return nil
}
