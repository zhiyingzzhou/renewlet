import { z } from "zod";
import type { D1Client } from "./cloudflare-d1-client";

// v4 已有完整的 owner 投影。仅修停用订阅的 repeat 资格；其它已排队或等待重试的 occurrence 必须沿用原时间。
export async function repairPausedRepeatSchedules(client: D1Client, pageSize: number): Promise<void> {
  let cursor = "";
  const count = `(SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = scheduler.user_id
    AND s.repeat_reminder_enabled = 1 AND s.status NOT IN ('paused', 'cancelled'))`;
  const due = "(SELECT MIN(next_due_at_utc) FROM subscription_repeat_schedule WHERE user_id = scheduler.user_id)";
  for (;;) {
    const owners = await client.query(`SELECT id FROM users WHERE id > ? AND EXISTS (
      SELECT 1 FROM subscriptions s WHERE s.user_id = users.id AND s.status IN ('paused', 'cancelled')
    ) ORDER BY id LIMIT ?`, [cursor, pageSize], z.object({ id: z.string() }).parse);
    const last = owners.at(-1);
    if (!last) return;
    // 分页边界取自订阅事实；即使 DELETE 已提交、后续聚合或响应中断，重跑仍会找到同一账号。
    const params = [cursor, last.id];
    await client.batch([{
      sql: `DELETE FROM subscription_repeat_schedule AS r WHERE r.user_id > ? AND r.user_id <= ?
        AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = r.subscription_id AND s.user_id = r.user_id
          AND s.status IN ('paused', 'cancelled'))`, params,
    }, {
      sql: `UPDATE subscription_scheduler_state AS scheduler SET repeat_reminder_count = ${count},
        next_repeat_notification_due_at_utc = ${due}
        WHERE user_id > ? AND user_id <= ? AND EXISTS (SELECT 1 FROM subscriptions s
          WHERE s.user_id = scheduler.user_id AND s.status IN ('paused', 'cancelled'))
        AND (repeat_reminder_count IS NOT ${count} OR next_repeat_notification_due_at_utc IS NOT ${due})`, params,
    }]);
    cursor = last.id;
    if (owners.length < pageSize) return;
  }
}
