#!/usr/bin/env node
/**
 * Cloudflare D1 migration runner.
 *
 * 触发时机：本地 Worker 启动、`pnpm deploy`、自管 Cloudflare workflow 和稳定版生产部署。
 * 前置依赖：显式选择 local/remote；remote 需要 Wrangler 登录或 Cloudflare API token/account。
 * 状态流：迁移守卫 -> Feed 持久保护 -> migration -> Feed 恢复 -> v5 派生回填 -> 外键校验。
 * 任一步失败都必须阻断 Worker 更新；各持久阶段可由下一次部署从数据库状态安全重放。
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { checkCloudflareMigrationSafety } from "./check-cloudflare-migration-safety.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const retryablePatterns = [
  /\[code:\s*7429\]/i,
  /D1 DB storage operation exceeded timeout/i,
  /Network connection lost/i,
  /storage (?:operation )?(?:which )?caused object to be reset/i,
  /reset because its code was updated/i,
  /\boverloaded\b/i,
  /(?:Cloudflare API|HTTP|status(?: code)?)\D+(?:429|5\d\d)\b/i,
];

function usage() {
  return [
    "Usage: node scripts/apply-cloudflare-d1-migrations.mjs (--local | --remote) [--config <path>]",
    "",
    "Protects calendar Feeds, applies D1 migrations, backfills derived state, and verifies foreign keys.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { configPath: undefined, target: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local" || arg === "--remote") {
      if (options.target) throw new Error(`Specify exactly one D1 target.\n${usage()}`);
      options.target = arg.slice(2);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path.");
      options.configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!options.target) throw new Error(`A D1 target is required.\n${usage()}`);
  return options;
}

function readNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function readPositiveIntEnv(name, fallback) {
  const value = readNonNegativeIntEnv(name, fallback);
  if (value < 1) throw new Error(`${name} must be at least 1.`);
  return value;
}

function wranglerArgs(options) {
  const args = ["exec", "wrangler", "d1", "migrations", "apply", "DB", `--${options.target}`];
  if (options.configPath) args.push("--config", options.configPath);
  return args;
}

function derivedBackfillArgs(options) {
  const args = ["exec", "tsx", "scripts/backfill-cloudflare-subscription-derived-state.ts", `--${options.target}`];
  if (options.configPath) args.push("--config", options.configPath);
  return args;
}

function calendarFeedProtectionArgs(options, phase) {
  const args = ["exec", "tsx", "scripts/protect-cloudflare-calendar-feeds.ts", `--${options.target}`, "--phase", phase];
  if (options.configPath) args.push("--config", options.configPath);
  return args;
}

function foreignKeyCheckArgs(options) {
  const args = ["exec", "wrangler", "d1", "execute", "DB", `--${options.target}`, "--command", "PRAGMA foreign_key_check", "--json"];
  if (options.configPath) args.push("--config", options.configPath);
  return args;
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
}

function isRetryableD1MigrationFailure(output) {
  return retryablePatterns.some((pattern) => pattern.test(output));
}

function runWranglerMigration(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let settled = false;
    const result = { status: null, signal: null, stdout: "", stderr: "", error: undefined };

    child.stdout.on("data", (chunk) => {
      result.stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      result.stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      result.status = 1;
      result.error = error;
      process.stderr.write(`${error.message}\n`);
      resolvePromise(result);
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      result.status = status;
      result.signal = signal;
      resolvePromise(result);
    });
  });
}

function retryDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (delay <= 0) return 0;
  return delay + Math.floor(Math.random() * Math.max(1, delay * 0.25));
}

function exitCode(result) {
  return typeof result.status === "number" && result.status !== null ? result.status : 1;
}

function assertForeignKeyCheck(result) {
  if (result.status !== 0) throw new Error("Cloudflare D1 foreign key check command failed.");
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("Cloudflare D1 foreign key check returned invalid Wrangler JSON.");
  }
  const results = Array.isArray(payload) ? payload : [payload];
  if (results.length === 0 || results.some((item) => item?.success !== true || !Array.isArray(item.results))) {
    throw new Error("Cloudflare D1 foreign key check returned an unsuccessful Wrangler result.");
  }
  if (results.some((item) => item.results.length > 0)) {
    throw new Error("Cloudflare D1 foreign key check found violations.");
  }
}

async function runPostMigrationSteps(options) {
  // Feed 是不可推导事实，必须先恢复并校验；其后的集合与调度状态都能从 subscriptions 重建。
  const restoreFeeds = await runWranglerMigration(calendarFeedProtectionArgs(options, "restore"));
  if (restoreFeeds.status !== 0) throw new Error("Cloudflare D1 calendar Feed restore failed.");
  const backfill = await runWranglerMigration(derivedBackfillArgs(options));
  if (backfill.status !== 0) throw new Error("Cloudflare D1 derived-state backfill failed.");
  const foreignKeys = await runWranglerMigration(foreignKeyCheckArgs(options));
  assertForeignKeyCheck(foreignKeys);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // 守卫必须先于 Feed prepare 的首个远端写入，避免 CI 路径绕过 check:deploy 后污染 D1。
  checkCloudflareMigrationSafety(repoRoot);
  const prepareFeeds = await runWranglerMigration(calendarFeedProtectionArgs(options, "prepare"));
  if (prepareFeeds.status !== 0) throw new Error("Cloudflare D1 calendar Feed backup failed.");
  const args = wranglerArgs(options);
  if (options.target === "local") {
    const result = await runWranglerMigration(args);
    if (result.status !== 0) {
      console.error("Local D1 migrations failed.");
      process.exit(exitCode(result));
    }
    await runPostMigrationSteps(options);
    return;
  }
  const maxAttempts = readPositiveIntEnv("RENEWLET_D1_MIGRATION_MAX_ATTEMPTS", 5);
  const baseDelayMs = readNonNegativeIntEnv("RENEWLET_D1_MIGRATION_RETRY_BASE_MS", 1000);
  const maxDelayMs = readNonNegativeIntEnv("RENEWLET_D1_MIGRATION_RETRY_MAX_MS", 15000);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runWranglerMigration(args);
    if (result.status === 0) {
      await runPostMigrationSteps(options);
      return;
    }

    const output = commandOutput(result);
    const retryable = isRetryableD1MigrationFailure(output);
    if (!retryable) {
      console.error("Cloudflare D1 migrations failed with a non-retryable error.");
      process.exit(exitCode(result));
    }

    if (attempt >= maxAttempts) {
      console.error(`Cloudflare D1 migrations failed after ${attempt} attempts.`);
      process.exit(exitCode(result));
    }

    // 远端 D1 migration 依赖 Cloudflare API；只重试平台瞬时 reset/超时，真实 SQL/权限/config 错误不能被吞掉。
    const delay = retryDelayMs(attempt, baseDelayMs, maxDelayMs);
    console.error(`Cloudflare D1 migrations hit a retryable error; retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts}).`);
    await sleep(delay);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
