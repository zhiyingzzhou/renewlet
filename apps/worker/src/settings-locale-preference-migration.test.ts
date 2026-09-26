import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function openInitialDatabase(userIds: readonly string[]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  const insert = database.prepare(`INSERT INTO users
    (id, email, name, role, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, 'user', 'hash', '', '')`);
  for (const userId of userIds) insert.run(userId, `${userId}@renewlet.test`, userId);
  return database;
}

describe("settings locale preference migration", () => {
  const migrationUrl = new URL("../migrations/0040_exclusive_settings_locale_preference.sql", import.meta.url);

  it("moves legacy locale values without changing unrelated settings", () => {
    const rows = [
      ["legacy-zh", JSON.stringify({ locale: "zh-CN", monthlyBudget: "2333" })],
      ["legacy-en", JSON.stringify({ locale: "en-US" })],
      ["legacy-invalid", JSON.stringify({ locale: "fr-FR" })],
      ["legacy-missing", JSON.stringify({ monthlyBudget: "2333" })],
      ["new-preference", JSON.stringify({ locale: "en-US", localePreference: "zh-CN" })],
    ] as const;
    const database = openInitialDatabase(rows.map(([userId]) => userId));
    const insert = database.prepare("INSERT INTO settings (user_id, settings_json, created_at, updated_at) VALUES (?, ?, '', '')");
    for (const [userId, settingsJson] of rows) insert.run(userId, settingsJson);

    database.exec(readFileSync(migrationUrl, "utf8"));

    const expected = new Map([
      ["legacy-zh", "zh-CN"],
      ["legacy-en", "en-US"],
      ["legacy-invalid", "auto"],
      ["legacy-missing", "auto"],
      ["new-preference", "zh-CN"],
    ]);
    const migrated = database.prepare("SELECT user_id, settings_json FROM settings ORDER BY user_id").all() as Array<{ user_id: string; settings_json: string }>;
    for (const row of migrated) {
      const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
      expect(settings).not.toHaveProperty("locale");
      expect(settings["localePreference"]).toBe(expected.get(row.user_id));
    }

    database.close();
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["array", "[]"],
    ["null", "null"],
    ["duplicate top-level keys", '{"monthlyBudget":"1","monthlyBudget":"2"}'],
  ])("fails closed for %s settings", (_name, settingsJson) => {
    const database = openInitialDatabase(["damaged"]);
    database.prepare("INSERT INTO settings (user_id, settings_json, created_at, updated_at) VALUES (?, ?, '', '')")
      .run("damaged", settingsJson);

    expect(() => database.exec(`BEGIN IMMEDIATE;\n${readFileSync(migrationUrl, "utf8")}\nCOMMIT;`)).toThrow();
    if (database.isTransaction) database.exec("ROLLBACK");
    expect(database.prepare("SELECT settings_json FROM settings WHERE user_id = 'damaged'").get()).toEqual({ settings_json: settingsJson });
    database.close();
  });

  it("installs database guards that reject old or invalid writers", () => {
    const database = openInitialDatabase(["legacy", "missing", "invalid", "duplicate", "valid"]);
    database.exec(readFileSync(migrationUrl, "utf8"));
    const insert = database.prepare("INSERT INTO settings (user_id, settings_json, created_at, updated_at) VALUES (?, ?, '', '')");

    expect(() => insert.run("legacy", JSON.stringify({ locale: "zh-CN" }))).toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);
    expect(() => insert.run("missing", JSON.stringify({ monthlyBudget: "42" }))).toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);
    expect(() => insert.run("invalid", JSON.stringify({ localePreference: "fr-FR" }))).toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);
    expect(() => insert.run("duplicate", '{"localePreference":"auto","monthlyBudget":"1","monthlyBudget":"2"}'))
      .toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);
    expect(() => insert.run("valid", JSON.stringify({ localePreference: "auto", monthlyBudget: "42" }))).not.toThrow();
    expect(() => database.prepare("UPDATE settings SET settings_json = ? WHERE user_id = 'valid'")
      .run(JSON.stringify({ localePreference: "en-US", locale: "zh-CN" }))).toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);
    database.close();
  });

  it("widens the guard to ru-RU without touching existing settings", () => {
    const database = openInitialDatabase(["existing", "russian", "invalid"]);
    database.exec(readFileSync(migrationUrl, "utf8"));
    const insert = database.prepare("INSERT INTO settings (user_id, settings_json, created_at, updated_at) VALUES (?, ?, '', '')");
    const existingSettings = JSON.stringify({ localePreference: "zh-CN", monthlyBudget: "42" });
    insert.run("existing", existingSettings);
    expect(() => insert.run("russian", JSON.stringify({ localePreference: "ru-RU" }))).toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);

    database.exec(readFileSync(new URL("../migrations/0043_settings_locale_preference_ru_ru.sql", import.meta.url), "utf8"));

    expect(() => insert.run("russian", JSON.stringify({ localePreference: "ru-RU" }))).not.toThrow();
    expect(() => insert.run("invalid", JSON.stringify({ localePreference: "fr-FR" }))).toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);
    expect(() => database.prepare("UPDATE settings SET settings_json = ? WHERE user_id = 'russian'")
      .run(JSON.stringify({ localePreference: "ru-RU", locale: "ru-RU" }))).toThrow(/SETTINGS_LOCALE_CONTRACT_INVALID/);
    expect(database.prepare("SELECT settings_json FROM settings WHERE user_id = 'existing'").get()).toEqual({ settings_json: existingSettings });
    database.close();
  });
});
