#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(repoRoot, "scripts/fixtures/cloudflare-upgrades");
const sources = [
  { version: "v0.2.95", commit: "02fec668d65ad6b03ba0321301abf05e17ba28dd", locale: "zh-CN" },
  { version: "v0.2.96", commit: "d2755510203c8eaf7f8454aca22a36885c62a6cc", locale: "fr-FR" },
  { version: "v0.3.21", commit: "dee5d8c8cf055583d9c45eb82a0b41e0cd13e016", locale: "en-US" },
];

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Fixture contains a non-finite SQLite number");
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  throw new Error(`Unsupported SQLite fixture value: ${typeof value}`);
}

function migrationSql(commit, name) {
  return git("show", `${commit}:apps/worker/migrations/${name}`)
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON)\s*;\s*$/gim, "");
}

function dumpDatabase(database, source) {
  const objects = database.prepare(`SELECT type, name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`).all();
  const tables = objects.filter((row) => row.type === "table").map((row) => String(row.name));
  const lines = [
    `-- Immutable Renewlet ${source.version} D1 fixture from commit ${source.commit}.`,
    "PRAGMA foreign_keys = OFF;",
    "BEGIN;",
    ...objects.map((row) => `${String(row.sql).replace(/;\s*$/, "")};`),
  ];
  for (const table of tables) {
    const identifier = quoteIdentifier(table);
    const columns = database.prepare(`PRAGMA table_info(${identifier})`).all().map((row) => String(row.name));
    const columnSql = columns.map(quoteIdentifier).join(", ");
    for (const row of database.prepare(`SELECT * FROM ${identifier}`).all()) {
      lines.push(`INSERT INTO ${identifier} (${columnSql}) VALUES (${columns.map((column) => sqlLiteral(row[column])).join(", ")});`);
    }
  }
  lines.push("COMMIT;", "PRAGMA foreign_keys = ON;", "");
  return lines.join("\n");
}

async function capture(source, releasePath) {
  const resolved = git("rev-parse", `${source.version}^{commit}`).trim();
  if (resolved !== source.commit) throw new Error(`${source.version} moved from pinned commit ${source.commit} to ${resolved}`);
  const packageJson = JSON.parse(git("show", `${source.commit}:package.json`));
  if (`v${packageJson.version}` !== source.version) throw new Error(`${source.version} package version mismatch`);

  const migrations = git("ls-tree", "-r", "--name-only", source.commit, "--", "apps/worker/migrations")
    .trim()
    .split("\n")
    .filter((path) => /^apps\/worker\/migrations\/\d{4}_.+\.sql$/.test(path))
    .map((path) => path.split("/").at(-1))
    .filter((name) => name !== undefined)
    .sort();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const migrationHash = createHash("sha256");
  for (const name of migrations) {
    const sql = migrationSql(source.commit, name);
    migrationHash.update(name).update("\0").update(sql).update("\0");
    database.exec("BEGIN");
    try {
      database.exec(sql);
      database.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)")
        .run(name, "2026-08-25T00:00:00.000Z");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.prepare(`INSERT INTO users
    (id, email, name, role, password_hash, created_at, updated_at)
    VALUES ('usr_fixture', 'fixture@example.com', 'Fixture', 'admin', 'hash', ?, ?)`).run(
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    );
  database.prepare(`INSERT INTO settings (user_id, settings_json, created_at, updated_at)
    VALUES ('usr_fixture', ?, ?, ?)`).run(
      JSON.stringify(releasePath ? { localePreference: "en-US", timezone: "UTC" } : { locale: source.locale, monthlyBudget: "2333" }),
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    );
  database.prepare(`INSERT INTO subscriptions (
    id, user_id, name, price, currency, billing_cycle, category, status, start_date, next_billing_date,
    auto_renew, auto_calculate_next_billing_date, tags_json, reminder_days, repeat_reminder_enabled,
    repeat_reminder_interval, repeat_reminder_window, cost_sharing_json, extra_json, created_at, updated_at
  ) VALUES ('sub_fixture', 'usr_fixture', 'Historical Service', '12.50', 'USD', 'monthly', 'software', 'active',
    '2026-01-24', '2026-08-27', 1, 1, ?, 3, 1, '1h', '72h', '{}', '{}', ?, ?)`).run(
      JSON.stringify([" Work ", "work", "工具"]),
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    );
  database.prepare(`INSERT INTO calendar_feeds
    (id, user_id, scope, subscription_id, token, created_at, updated_at)
    VALUES
      ('feed_all_fixture', 'usr_fixture', 'all', NULL, ?, ?, ?),
      ('feed_sub_fixture', 'usr_fixture', 'subscription', 'sub_fixture', ?, ?, ?)`).run(
      "a".repeat(43),
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
      "s".repeat(43),
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    );
  if (releasePath) {
    // 旧排程、计数和 marker 必须由发行版代码生成；用当前回填器播种会掩盖跨版本错误。
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: releasePath, encoding: "utf8" }).trim();
    if (commit !== source.commit || execFileSync("git", ["status", "--short", "--untracked-files=no"], { cwd: releasePath, encoding: "utf8" }).trim()) {
      throw new Error("Release fixture requires a clean checkout of its pinned commit");
    }
    const columns = database.prepare("PRAGMA table_info(subscriptions)").all().map((row) => quoteIdentifier(row.name));
    const values = columns.map((column) => column === '"id"' ? "'sub_paused'" : column === '"status"' ? "'paused'" : column);
    database.exec(`INSERT INTO subscriptions (${columns}) SELECT ${values} FROM subscriptions WHERE id = 'sub_fixture'`);
    const { runBackfill } = await import(pathToFileURL(join(releasePath, "scripts/backfill-cloudflare-subscription-derived-state.ts")).href);
    await runBackfill({
      query: async (sql, params, parse) => database.prepare(sql).all(...params).map(parse),
      batch: async (statements) => {
        for (const { sql, params } of statements) database.prepare(sql).run(...params ?? []);
        return statements.map(() => ({ success: true, results: [] }));
      },
    }, () => new Date("2026-08-25T12:00:00Z"));
  }
  const fixture = dumpDatabase(database, source);
  database.close();
  const filename = `${source.version}.sql`;
  writeFileSync(join(outputDir, filename), fixture, "utf8");
  return {
    version: source.version,
    sourceCommit: source.commit,
    migrationCount: migrations.length,
    lastMigration: migrations.at(-1),
    migrationSourceSha256: migrationHash.digest("hex"),
    fixture: filename,
    fixtureSha256: sha256(fixture),
  };
}

mkdirSync(outputDir, { recursive: true });
const [v28Checkout, v37Checkout] = process.argv.slice(2);
if (v28Checkout || v37Checkout) {
  if (!v28Checkout || !v37Checkout) throw new Error("Provide both v0.3.28 and v0.3.37 checkout paths");
  const fixtures = [
    await capture({ version: "v0.3.28", commit: "2b3e89dbf7168b5266370c3095676f32f12cbeea" }, resolve(v28Checkout)),
    await capture({ version: "v0.3.37", commit: "2aa8c8e1134d2d9670e888e03e9222c2ce00fbed" }, resolve(v37Checkout)),
  ];
  writeFileSync(join(outputDir, "pause-upgrade.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
} else {
  const manifest = {
    kind: "renewlet-cloudflare-upgrade-fixtures",
    schemaVersion: 1,
    capturedAt: "2026-08-25T00:00:00.000Z",
    fixtures: await Promise.all(sources.map((source) => capture(source))),
  };
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
