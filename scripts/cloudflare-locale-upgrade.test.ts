import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LOCALE_PREFERENCES } from "@renewlet/shared/i18n-config";
import {
  assertD1TriggerDefinitions,
  exclusiveMigrationNames,
  exclusiveMigrationTriggerDefinitions,
  runCloudflareDeployment,
  settingsLocaleInvariantQuery,
  type DeploymentOperations,
} from "./cloudflare-deploy";

const migrationsDir = new URL("../apps/worker/migrations/", import.meta.url);
const localeGuardMigration = "0044_exclusive_settings_locale_guard.sql";
const russianMigration = "0043_settings_locale_preference_ru_ru.sql";
const migrationSQL = (name: string) => readFileSync(new URL(name, migrationsDir), "utf8");
const migrationNames = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

function openDatabaseThrough(last: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)");
  for (const name of migrationNames.filter((name) => name <= last)) {
    applyMigration(database, name);
  }
  return database;
}

function appliedMigrations(database: DatabaseSync): Set<string> {
  return new Set(database.prepare("SELECT name FROM d1_migrations").all().map((row) => String(row["name"])));
}

function applyMigration(database: DatabaseSync, name: string): void {
  database.exec("BEGIN");
  try {
    database.exec(migrationSQL(name));
    database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function deploymentFixture(database: DatabaseSync) {
  const events: string[] = [];
  let active = "old-worker";
  let maintenance: Parameters<DeploymentOperations["deployMaintenance"]>[0] | undefined;
  const operations: DeploymentOperations = {
    async prepare() {},
    async ensureQueues() {},
    async readActiveDeployment() { return { versionId: active, ...(maintenance && { maintenance }) }; },
    async readAppliedExclusiveMigrations() { return appliedMigrations(database); },
    async readPendingDerivedBackfill() {
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subscription_derived_backfills'").get();
      if (!table) return true;
      return !database.prepare("SELECT name FROM subscription_derived_backfills WHERE name = 'subscription-derived-state-v5'").get();
    },
    async captureBookmark() { events.push("checkpoint"); return "bookmark"; },
    recordCheckpoint() {},
    recordRecoveryHint() { events.push("recovery-hint"); },
    async deployMaintenance(context) { maintenance = context; events.push("maintenance"); active = `maintenance-${events.length}`; return { versionId: active }; },
    async waitForBackgroundDrain() { events.push("drain"); },
    async applyMigrations() {
      events.push("migrate");
      const applied = appliedMigrations(database);
      for (const name of migrationNames) {
        if (!applied.has(name)) applyMigration(database, name);
      }
      database.prepare(`INSERT INTO subscription_derived_backfills (name, completed_at)
        VALUES ('subscription-derived-state-v5', '2026-08-25T00:00:00.000Z')
        ON CONFLICT(name) DO UPDATE SET completed_at = excluded.completed_at`).run();
    },
    async verifyDatabase(expectedNames) { events.push("verify"); verifyDatabase(database, expectedNames); },
    async deployNormal() { maintenance = undefined; events.push("normal"); active = "new-worker"; return { versionId: active }; },
    async restoreWorker() { events.push("restore-worker"); },
    async restoreDatabase() { events.push("restore-db"); },
  };
  return { operations, events };
}

function verifyDatabase(database: DatabaseSync, names: readonly string[]): void {
  assert.equal(database.prepare(settingsLocaleInvariantQuery).get()?.["count"], 0);
  const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string; sql: string }>;
  const expected = exclusiveMigrationTriggerDefinitions(names);
  assertD1TriggerDefinitions(expected, triggers.filter((trigger) => expected.has(trigger.name)));
}

function insertSettings(database: DatabaseSync, preference: string): string {
  database.exec("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES ('ru', 'ru@example.test', 'ru', 'user', 'hash', '', '')");
  const settings = JSON.stringify({ localePreference: preference, monthlyBudget: "42", timezone: "UTC" });
  database.prepare("INSERT INTO settings (user_id, settings_json, created_at, updated_at) VALUES ('ru', ?, '', '')")
    .run(settings);
  return settings;
}

test("fresh migrations satisfy current locale and full trigger invariants", (context) => {
  const database = openDatabaseThrough(localeGuardMigration);
  context.after(() => database.close());
  const names = exclusiveMigrationNames();
  assert.ok(names.includes(localeGuardMigration));
  insertSettings(database, "auto");
  for (const localePreference of LOCALE_PREFERENCES) {
    database.prepare("UPDATE settings SET settings_json = ? WHERE user_id = 'ru'")
      .run(JSON.stringify({ localePreference }));
    verifyDatabase(database, names);
  }
  assert.throws(() => database.prepare("UPDATE settings SET settings_json = ? WHERE user_id = 'ru'")
    .run('{"localePreference":"fr-FR"}'), /SETTINGS_LOCALE_CONTRACT_INVALID/);

  database.exec("DROP TRIGGER renewlet_settings_locale_contract_update");
  assert.throws(() => verifyDatabase(database, names), /is missing/);
  const guardedSQL = exclusiveMigrationTriggerDefinitions(names).get("renewlet_settings_locale_contract_update");
  assert.ok(guardedSQL);
  database.exec(guardedSQL.replace("'en-US', 'ru-RU'", "'en-US', 'ru-RU', 'fr-FR'"));
  assert.throws(() => verifyDatabase(database, names), /definition drifted/);
});

for (const alreadyAppliedRussianMigration of [false, true]) {
  test(`Russian guard upgrade preserves settings and exits maintenance (0043 applied: ${alreadyAppliedRussianMigration})`, async (context) => {
    const database = openDatabaseThrough(alreadyAppliedRussianMigration ? russianMigration : "0042_public_status_filters.sql");
    context.after(() => database.close());
    const original = insertSettings(database, alreadyAppliedRussianMigration ? "ru-RU" : "en-US");
    const names = exclusiveMigrationNames();
    const { operations, events } = deploymentFixture(database);

    await runCloudflareDeployment(operations, names);
    assert.deepEqual(events, ["maintenance", "drain", "checkpoint", "maintenance", "migrate", "verify", "normal", "verify"]);
    assert.equal(database.prepare("SELECT settings_json FROM settings WHERE user_id = 'ru'").get()?.["settings_json"], original);
    events.length = 0;
    await runCloudflareDeployment(operations, names);
    assert.deepEqual(events, ["checkpoint", "migrate", "verify", "normal", "verify"]);
  });
}

for (const failure of ["after-0043", "0044-marker", "normal-deploy"] as const) {
  test(`interrupted Russian upgrade stays in maintenance and retries from the real ledger: ${failure}`, async (context) => {
    const database = openDatabaseThrough("0042_public_status_filters.sql");
    context.after(() => database.close());
    const original = insertSettings(database, "en-US");
    const { operations, events } = deploymentFixture(database);
    const apply = operations.applyMigrations;
    const deploy = operations.deployNormal;
    if (failure === "after-0043") {
      operations.applyMigrations = async () => {
        events.push("migrate");
        applyMigration(database, russianMigration);
        throw new Error("injected after 0043");
      };
    } else if (failure === "0044-marker") {
      // SQL 与账本同事务；在最后写标记处失败，不能把未提交的 0044 当作完成。
      database.exec(`CREATE TRIGGER fail_locale_marker BEFORE INSERT ON d1_migrations
        WHEN NEW.name = '${localeGuardMigration}'
        BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END`);
    } else {
      operations.deployNormal = async () => { events.push("normal"); throw new Error("injected deploy failure"); };
    }
    const names = exclusiveMigrationNames();
    await assert.rejects(runCloudflareDeployment(operations, names), /injected/);
    assert.deepEqual(events.slice(-2), ["recovery-hint", "maintenance"]);
    assert.ok(!events.includes("restore-worker"));
    assert.ok(appliedMigrations(database).has(russianMigration));
    assert.equal(appliedMigrations(database).has(localeGuardMigration), failure === "normal-deploy");
    assert.equal(database.prepare("SELECT settings_json FROM settings WHERE user_id = 'ru'").get()?.["settings_json"], original);
    if (failure === "0044-marker") database.exec("DROP TRIGGER fail_locale_marker");
    operations.applyMigrations = apply;
    operations.deployNormal = deploy;
    events.length = 0;

    await runCloudflareDeployment(operations, names);
    assert.deepEqual(events, ["maintenance", "drain", "migrate", "verify", "normal", "verify"]);
    assert.deepEqual([...appliedMigrations(database)].sort(), migrationNames);
    assert.equal(database.prepare("SELECT settings_json FROM settings WHERE user_id = 'ru'").get()?.["settings_json"], original);
    verifyDatabase(database, names);
  });
}

test("locale invariant rejects malformed or unsupported settings without losing ru-RU", (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  database.exec("CREATE TABLE settings (settings_json TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO settings VALUES (?)");
  for (const settings of [
    "not-json", "[]", "null", "{}", '{"localePreference":"fr-FR"}',
    '{"localePreference":"ru-RU","locale":"ru-RU"}',
    '{"localePreference":"ru-RU","localePreference":"en-US"}',
  ]) {
    database.exec("DELETE FROM settings");
    insert.run(settings);
    assert.equal(database.prepare(settingsLocaleInvariantQuery).get()?.["count"], 1, settings);
    assert.throws(() => database.exec(`BEGIN;\n${migrationSQL(localeGuardMigration)}\nCOMMIT;`));
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT settings_json FROM settings").get()?.["settings_json"], settings);
  }
});

test("undeclared duplicate trigger definitions remain rejected", () => {
  const legacy = "0040_exclusive_settings_locale_preference.sql";
  assert.throws(() => exclusiveMigrationTriggerDefinitions([legacy, legacy]), /ambiguous/);
});
