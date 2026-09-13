import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { cronJobResultResponseSchema } from "@renewlet/shared/schemas/notifications";
import { createCronJobResult, createNotificationJob, finalizeNotificationJob, getNotificationJob, readJobChannels } from "./notification-jobs";
import { readNotificationHistoryRows, splitNotificationJobMessage } from "./notification-message-storage";
import type { Env } from "./types";
import upgradeFixtures from "../../../packages/shared/src/contract-fixtures/notification-message-upgrade-fixtures.json";

const migration = readFileSync(new URL("../migrations/0041_exclusive_notification_message_snapshots.sql", import.meta.url), "utf8");
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function databaseFixture(migrate = true) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql") && name < "0041_exclusive_notification_message_snapshots.sql").sort()) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
    VALUES ('owner', 'owner@example.test', 'Owner', 'user', '', '', ''), ('other', 'other@example.test', 'Other', 'user', '', '', '')`);
  if (migrate) database.exec(migration);
  const queries: string[] = [];
  // 本地真实 SQLite 执行相同 SQL 和事务；不是 D1 元数据或云端性能模拟结果。
  function prepare(sql: string, params: SQLInputValue[] = []): D1PreparedStatement {
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      all: async () => { queries.push(sql); return { success: true, results: database.prepare(sql).all(...params), meta: {} }; },
      first: async () => { queries.push(sql); return database.prepare(sql).get(...params) ?? null; },
      run: async () => { queries.push(sql); const result = database.prepare(sql).run(...params); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
    } as unknown as D1PreparedStatement;
  }
  const env = { DB: {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      database.exec("BEGIN");
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket } satisfies Env;
  return { database, env, queries };
}

function largeResult(size: number) {
  const settings = createDefaultAppSettings();
  settings.timezone = "UTC";
  settings.enabledChannels = ["webhook"];
  return cronJobResultResponseSchema.parse(createCronJobResult({
    reason: null, force: false, windowMinutes: 2, triggeredAtUtc: "2026-09-08T08:00:00Z",
    schedule: { scheduledLocalDate: "2026-09-08", scheduledLocalTime: "08:00", timeZone: "UTC", scheduledInstantUtc: "2026-09-08T08:00:00Z" },
    settings, locale: "zh-CN",
    message: {
      title: "Renewlet", content: "中文🌏\n".repeat(size), timestamp: "2026-09-08 08:00 UTC", hasPayload: true,
      items: Array.from({ length: size }, (_, index) => ({ type: "renewal", subscriptionId: `sub${index}`, name: `订阅🌏${index}`, price: "12.50", currency: "CNY", status: "active", targetDate: "2026-09-11", reminderDays: 3, daysUntil: 3 })),
    },
    channels: { attempted: ["webhook"], succeeded: ["webhook"], failed: [] },
  }));
}

describe("notification message snapshot storage", () => {
  it.each(upgradeFixtures.fixtures)("converts the actual $version result without changing message text", async (fixture) => {
    const { env, database } = databaseFixture(false);
    const { row } = await createNotificationJob(env, "owner", fixture.result.schedule, "failed", 2);
    database.prepare("UPDATE notification_jobs SET result_json = ? WHERE id = ?").run(JSON.stringify(fixture.result), row?.id ?? "");
    database.exec(`BEGIN; ${migration} COMMIT;`);
    const expected = structuredClone(fixture.result);
    for (const item of expected.message.items) { if (typeof item.price === "number") item.price = "12.5"; }
    const [history] = await readNotificationHistoryRows(env, "owner", "all", 20);
    expect(JSON.parse(history?.result_json ?? "{}")).toEqual(expected);
    expect(cronJobResultResponseSchema.safeParse(JSON.parse(history?.result_json ?? "{}"))).toMatchObject({ success: true });
    expect(readJobChannels(await getNotificationJob(env, "owner", fixture.result.schedule))).toEqual(fixture.result.channels);
  });

  it("rolls back a failed historical conversion before publishing the new storage", async () => {
    const { env, database } = databaseFixture(false);
    const original = largeResult(1000);
    const { row } = await createNotificationJob(env, "owner", original.schedule, "failed", 2);
    database.prepare("UPDATE notification_jobs SET result_json = ? WHERE id = ?").run(JSON.stringify(original), row?.id ?? "");
    database.exec("CREATE TRIGGER fail_upgrade BEFORE UPDATE ON notification_jobs BEGIN SELECT RAISE(ABORT, 'injected upgrade failure'); END");
    database.exec("BEGIN");
    expect(() => database.exec(migration)).toThrow("injected upgrade failure");
    database.exec("ROLLBACK");
    expect(JSON.parse((await getNotificationJob(env, "owner", original.schedule))?.result_json ?? "{}")).toEqual(original);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'notification_job_messages'").get()).toBeUndefined();
    database.exec("DROP TRIGGER fail_upgrade");
    database.exec(`BEGIN; ${migration} COMMIT;`);
    expect(JSON.parse((await readNotificationHistoryRows(env, "owner", "all", 20))[0]?.result_json ?? "{}")).toEqual(original);
  });

  it.each([10, 100, 1000, 5000])("persists all %i items without increasing the job budget", async (size) => {
    const { env, database, queries } = databaseFixture();
    const result = largeResult(size);
    const { row } = await createNotificationJob(env, "owner", result.schedule, "sending", 1);
    await finalizeNotificationJob(env, row, "owner", result.schedule, "sent", 1, null, result);
    const stored = await getNotificationJob(env, "owner", result.schedule);
    expect(stored?.status).toBe("sent");
    expect(new TextEncoder().encode(stored?.result_json).length).toBeLessThanOrEqual(65536);
    expect(stored && JSON.parse(stored.result_json)).not.toHaveProperty("message");
    queries.length = 0;
    const history = await readNotificationHistoryRows(env, "owner", "all", 20);
    expect(queries).toHaveLength(1);
    expect(JSON.parse(history[0]?.result_json ?? "{}")).toEqual(result);
    expect(await readNotificationHistoryRows(env, "other", "all", 20)).toEqual([]);
    expect(() => database.prepare("UPDATE notification_jobs SET result_json = ? WHERE user_id = 'owner'").run(JSON.stringify(result))).toThrow("NOTIFICATION_MESSAGE_STORAGE_CONTRACT_INVALID");
    database.prepare("DELETE FROM users WHERE id = ?").run("owner");
    expect(database.prepare("SELECT COUNT(*) AS count FROM notification_job_messages").get()?.["count"]).toBe(0);
  });

  it("rolls back snapshot replacement when the final status write fails", async () => {
    const { env, database } = databaseFixture();
    const original = largeResult(1000);
    const { row } = await createNotificationJob(env, "owner", original.schedule, "sending", 1);
    await finalizeNotificationJob(env, row, "owner", original.schedule, "failed", 1, "failed", original);
    database.exec(`CREATE TRIGGER fail_final_status BEFORE UPDATE ON notification_jobs BEGIN SELECT RAISE(ABORT, 'injected final failure'); END`);
    await expect(finalizeNotificationJob(env, row, "owner", original.schedule, "sent", 2, null, largeResult(5000))).rejects.toThrow("injected final failure");
    expect((await getNotificationJob(env, "owner", original.schedule))?.status).toBe("failed");
    expect(JSON.parse((await readNotificationHistoryRows(env, "owner", "all", 20))[0]?.result_json ?? "{}")).toEqual(original);
  });

  it("converts the old stored shape atomically and keeps the public snapshot unchanged", async () => {
    const { env, database } = databaseFixture(false);
    const original = largeResult(1000);
    const { row } = await createNotificationJob(env, "owner", original.schedule, "failed", 2);
    database.prepare("UPDATE notification_jobs SET result_json = ? WHERE id = ?").run(JSON.stringify(original), row?.id ?? "");
    database.exec(`BEGIN; ${migration} COMMIT;`);
    const history = await readNotificationHistoryRows(env, "owner", "all", 20);
    expect(JSON.parse(history[0]?.result_json ?? "{}")).toEqual(original);
    expect(readJobChannels(await getNotificationJob(env, "owner", original.schedule))).toEqual(original.channels);
    expect(() => database.exec(migration)).toThrow();
    expect(await readNotificationHistoryRows(env, "owner", "all", 20)).toEqual(history);
  });

  it("does not accept a missing message part as an empty historical result", async () => {
    const { env, database } = databaseFixture();
    const original = largeResult(1000);
    const { row } = await createNotificationJob(env, "owner", original.schedule, "sending", 1);
    await finalizeNotificationJob(env, row, "owner", original.schedule, "sent", 1, null, original);
    expect(splitNotificationJobMessage(original).parts.length).toBeGreaterThan(1);
    database.exec("DELETE FROM notification_job_messages WHERE chunk_index = 1");
    await expect(readNotificationHistoryRows(env, "owner", "all", 20)).rejects.toThrow("missing part");
  });
});
