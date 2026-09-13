-- 任务结果只拥有调度与渠道状态；完整消息独立分段，保持历史正文而不放宽任务 JSON 预算。
CREATE TABLE notification_job_messages (
  job_id TEXT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8192),
  PRIMARY KEY (job_id, chunk_index)
);

-- 历史数字金额复用 0030 的六位小数转换规则；只转换条目金额，原始正文不重新渲染。
UPDATE notification_jobs SET result_json = json_set(result_json, '$.message.items', json((
  SELECT json_group_array(json(CASE WHEN json_type(value, '$.price') IN ('integer', 'real')
    THEN json_set(value, '$.price', rtrim(rtrim(printf('%.6f', json_extract(value, '$.price')), '0'), '.'))
    ELSE value END)) FROM json_each(result_json, '$.message.items')
))) WHERE EXISTS (
  SELECT 1 FROM json_each(result_json, '$.message.items') WHERE json_type(value, '$.price') IN ('integer', 'real')
);

CREATE TABLE _renewlet_notification_messages_before AS
SELECT id, json_extract(result_json, '$.message') AS message
FROM notification_jobs WHERE json_type(result_json, '$.message') IS NOT NULL;

WITH RECURSIVE parts(job_id, chunk_index) AS (
  SELECT id, 0 FROM _renewlet_notification_messages_before
  UNION ALL
  SELECT parts.job_id, parts.chunk_index + 1
  FROM parts JOIN _renewlet_notification_messages_before AS original ON original.id = parts.job_id
  WHERE (parts.chunk_index + 1) * 8192 < length(original.message)
)
INSERT INTO notification_job_messages (job_id, chunk_index, content)
SELECT parts.job_id, parts.chunk_index, substr(original.message, parts.chunk_index * 8192 + 1, 8192)
FROM parts JOIN _renewlet_notification_messages_before AS original ON original.id = parts.job_id;

-- 校验实际写入后的分段，再删除旧内嵌消息；迁移由既有 D1 migration 事务整组提交或回滚。
CREATE TABLE _renewlet_notification_messages_verified (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO _renewlet_notification_messages_verified
SELECT original.message = (
  SELECT group_concat(content, '') FROM (
    SELECT content FROM notification_job_messages WHERE job_id = original.id ORDER BY chunk_index
  )
) FROM _renewlet_notification_messages_before AS original;

UPDATE notification_jobs SET result_json = json_set(
  json_remove(result_json, '$.message'), '$.messageChunkCount',
  (SELECT COUNT(*) FROM notification_job_messages WHERE job_id = notification_jobs.id)
) WHERE id IN (SELECT id FROM _renewlet_notification_messages_before);

DROP TABLE _renewlet_notification_messages_verified;
DROP TABLE _renewlet_notification_messages_before;

-- 停写窗口完成后拒绝旧程序继续写内嵌正文，不提供双格式运行路径。
CREATE TRIGGER renewlet_notification_message_contract_insert
BEFORE INSERT ON notification_jobs
FOR EACH ROW
WHEN json_type(NEW.result_json, '$.message') IS NOT NULL OR length(CAST(NEW.result_json AS BLOB)) > 65536
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_MESSAGE_STORAGE_CONTRACT_INVALID');
END;

CREATE TRIGGER renewlet_notification_message_contract_update
BEFORE UPDATE OF result_json ON notification_jobs
FOR EACH ROW
WHEN json_type(NEW.result_json, '$.message') IS NOT NULL OR length(CAST(NEW.result_json AS BLOB)) > 65536
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_MESSAGE_STORAGE_CONTRACT_INVALID');
END;
