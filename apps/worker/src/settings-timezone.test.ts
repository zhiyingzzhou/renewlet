import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getSettingsTimezone } from "./db";
import type { Env } from "./types";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL)");
  const env = { DB: {
    prepare: (sql: string) => ({ bind: (...params: SQLInputValue[]) => ({
      first: async () => db.prepare(sql).get(...params) ?? null,
    }) }),
  } } as unknown as Env;
  const save = (id: string, value: string) => db.prepare("INSERT OR REPLACE INTO settings VALUES (?, ?)").run(id, value);
  return { db, env, save };
}

describe("collection time zone projection", () => {
  it("isolates owners and observes the next committed time zone without sharing account data", async () => {
    const { db, env, save } = fixture();
    try {
      save("first", JSON.stringify({ timezone: "Asia/Shanghai", telegramBotToken: "private-test-token" }));
      save("second", JSON.stringify({ timezone: "America/New_York" }));
      expect(await getSettingsTimezone(env, "first")).toBe("Asia/Shanghai");
      expect(await getSettingsTimezone(env, "second")).toBe("America/New_York");
      save("first", JSON.stringify({ timezone: "UTC" }));
      expect(await getSettingsTimezone(env, "first")).toBe("UTC");
      expect(await getSettingsTimezone(env, "absent")).toBe("UTC");
      save("first", "{}");
      expect(await getSettingsTimezone(env, "first")).toBe("UTC");
    } finally { db.close(); }
  });

  it.each(["{", "null", "[]", '"UTC"', '{"timezone":null}', '{"timezone":2}', '{"timezone":"Invalid/Zone"}'])(
    "rejects invalid stored projection %s", async (value) => {
      const { db, env, save } = fixture();
      try {
        save("owner", value);
        await expect(getSettingsTimezone(env, "owner")).rejects.toThrow();
      } finally { db.close(); }
    },
  );
});
