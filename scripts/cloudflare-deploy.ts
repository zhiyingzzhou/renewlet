#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { LOCALE_PREFERENCES } from "@renewlet/shared/i18n-config";
import {
  captureBookmark,
  deploymentRecoveryCommand,
  validateBookmark,
  writeDeploymentCheckpointEvidence,
  writeDeploymentRecoveryHint,
} from "./cloudflare-d1-checkpoint";
import { createD1OperationsClient } from "./cloudflare-d1-operations";
import {
  createMaintenanceWranglerConfig,
  isJsonObject,
  readWranglerConfig,
  writeWranglerConfig,
  type WranglerConfig,
} from "./cloudflare-wrangler-config";
import { SUBSCRIPTION_DERIVED_BACKFILL_NAME } from "./cloudflare-derived-backfill-state";
import { readActiveWorkerDeployment, type ActiveDeployment } from "./cloudflare-worker-deployment";

import { assertWorkerCrons, maintenanceCheckpoint, workerControlRequest, type MaintenanceCheckpoint } from "./cloudflare-maintenance";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const drainWindowMs = 15 * 60 * 1000;

interface D1TriggerDefinition {
  name: string;
  sql: string;
}

interface DeployOptions {
  configPath: string;
  maintenanceConfigPath: string;
}

interface RecoveryOptions extends DeployOptions {
  bookmark: string;
  workerVersion: string;
}

export interface DeploymentOperations {
  prepare(): Promise<void>;
  ensureQueues(): Promise<void>;
  readActiveDeployment(): Promise<ActiveDeployment | undefined>;
  readAppliedExclusiveMigrations(names: readonly string[]): Promise<Set<string>>;
  readPendingDerivedBackfill(): Promise<boolean>;
  captureBookmark(): Promise<string>;
  deployMaintenance(context: MaintenanceCheckpoint): Promise<ActiveDeployment>;
  waitForBackgroundDrain(): Promise<void>;
  applyMigrations(): Promise<void>;
  verifyDatabase(names: readonly string[]): Promise<void>;
  deployNormal(): Promise<ActiveDeployment>;
  restoreWorker(versionId: string): Promise<void>;
  restoreDatabase(bookmark: string): Promise<void>;
  recordCheckpoint(bookmark: string, versionId?: string): void;
  recordRecoveryHint(bookmark: string, versionId: string): void;
}

export function exclusiveMigrationNames(): string[] {
  return readdirSync(resolve(repoRoot, "apps/worker/migrations"))
    .filter((name) => /^\d{4}_exclusive_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

function combineFailure(primary: unknown, containment: unknown, action: string): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const containmentMessage = containment instanceof Error ? containment.message : String(containment);
  return new Error(`${primaryMessage}\n${action} also failed: ${containmentMessage}`);
}

async function restoreBeforeDatabaseWrite(
  operations: DeploymentOperations,
  previous: ActiveDeployment,
  failure: unknown,
): Promise<never> {
  try {
    await operations.restoreWorker(previous.versionId);
  } catch (restoreError) {
    throw combineFailure(failure, restoreError, "Restoring the previous Worker");
  }
  throw failure;
}

async function containAfterDatabaseWrite(
  operations: DeploymentOperations,
  bookmark: string,
  previous: ActiveDeployment,
  failure: unknown,
): Promise<never> {
  operations.recordRecoveryHint(bookmark, previous.versionId);
  try {
    await operations.deployMaintenance({ workerVersion: previous.versionId, bookmark });
  } catch (maintenanceError) {
    throw combineFailure(failure, maintenanceError, "Re-deploying maintenance mode");
  }
  throw failure;
}

/** 排他 migration 或 v5 派生回填都必须在旧后台完全排空后首次写 D1；写入后任何失败都保持 fail-closed。 */
export async function runCloudflareDeployment(operations: DeploymentOperations, names: readonly string[]): Promise<void> {
  await operations.prepare();
  await operations.ensureQueues();

  const active = await operations.readActiveDeployment();
  const previous = active && { versionId: active.maintenance?.workerVersion ?? active.versionId };
  const applied = await operations.readAppliedExclusiveMigrations(names);
  const exclusive = names.some((name) => !applied.has(name)) || await operations.readPendingDerivedBackfill();
  let bookmark: string;
  let maintenanceVersion: string | undefined;
  if (previous && (exclusive || active?.maintenance)) {
    // 首次发布只在排空后冻结恢复点；重跑时已封存的 bookmark 可能早于部分提交，必须原样沿用。
    const checkpoint = active?.maintenance ?? { workerVersion: previous.versionId };
    try {
      const maintenance = await operations.deployMaintenance(checkpoint);
      if (maintenance.versionId === previous.versionId) throw new Error("Maintenance deployment did not replace the previous Worker version");
      maintenanceVersion = maintenance.versionId;
      await operations.waitForBackgroundDrain();
      bookmark = checkpoint.bookmark ?? await operations.captureBookmark();
      if (!checkpoint.bookmark) {
        maintenanceVersion = (await operations.deployMaintenance({ ...checkpoint, bookmark })).versionId;
      }
    } catch (error) {
      if (checkpoint.bookmark) {
        operations.recordRecoveryHint(checkpoint.bookmark, previous.versionId);
        throw error;
      }
      return await restoreBeforeDatabaseWrite(operations, previous, error);
    }
  } else {
    bookmark = await operations.captureBookmark();
  }
  operations.recordCheckpoint(bookmark, previous?.versionId);

  // migration runner 的 Feed prepare 是本轮首次 D1 写入；调用一旦开始就不能假设失败前没有部分提交。
  try {
    await operations.applyMigrations();
    await operations.verifyDatabase(names);
    const normal = await operations.deployNormal();
    if (maintenanceVersion !== undefined && normal.versionId === maintenanceVersion) {
      throw new Error("Final Cloudflare deployment is still serving the maintenance Worker version");
    }
    await operations.verifyDatabase(names);
  } catch (error) {
    if (previous === undefined) throw error;
    await containAfterDatabaseWrite(operations, bookmark, previous, error);
  }
}

/** 人工恢复入口固定先恢复 D1，再回滚 Worker；反向顺序会让旧代码立即写入新数据契约。 */
export async function runCloudflareRecovery(operations: DeploymentOperations, options: RecoveryOptions): Promise<void> {
  await operations.prepare();
  await operations.ensureQueues();
  await operations.deployMaintenance({ workerVersion: options.workerVersion, bookmark: options.bookmark });
  await operations.waitForBackgroundDrain();
  await operations.restoreDatabase(options.bookmark);
  try {
    await operations.restoreWorker(options.workerVersion);
  } catch (error) {
    try {
      await operations.deployMaintenance({ workerVersion: options.workerVersion, bookmark: options.bookmark });
    } catch (maintenanceError) {
      throw combineFailure(error, maintenanceError, "Re-deploying maintenance mode after recovery");
    }
    throw error;
  }
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runCommand(command: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", () => reject(new Error(`Unable to start ${command}`)));
    child.on("close", (status: number | null) => resolvePromise({ status, stdout, stderr }));
  });
}

function commandFailure(command: string, result: CommandResult): Error {
  const detail = [result.stderr.trim(), result.stdout.trim()].find((value) => value.length > 0);
  return new Error(detail ? `${command} failed: ${detail}` : `${command} failed`);
}

async function runPnpm(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return await runCommand("pnpm", args, environment);
}

async function requirePnpm(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  const result = await runPnpm(args, environment);
  if (result.status !== 0) throw commandFailure(`pnpm ${args.join(" ")}`, result);
  return result;
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function parseD1NameRow(value: unknown): string {
  if (!isJsonObject(value) || typeof value["name"] !== "string") {
    throw new Error("Cloudflare D1 migration query returned an invalid row");
  }
  return value["name"];
}

function parseD1CountRow(value: unknown): number {
  if (!isJsonObject(value) || typeof value["count"] !== "number" || !Number.isSafeInteger(value["count"])) {
    throw new Error("Cloudflare D1 invariant query returned an invalid count");
  }
  return value["count"];
}

function parseD1TriggerRow(value: unknown): D1TriggerDefinition {
  if (!isJsonObject(value) || typeof value["name"] !== "string" || typeof value["sql"] !== "string") {
    throw new Error("Cloudflare D1 trigger query returned an invalid row");
  }
  return { name: value["name"], sql: value["sql"] };
}

function normalizeD1TriggerSQL(value: string): string {
  return value.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

/** guard 以排他迁移的最终定义为准；替换必须在同一份迁移中先 DROP 再 CREATE，不能放宽线上漂移校验。 */
export function exclusiveMigrationTriggerDefinitions(names: readonly string[]): Map<string, string> {
  const definitions = new Map<string, string>();
  const triggerPattern = new RegExp(
    String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([A-Za-z][A-Za-z0-9_]*)\s*;|(CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z][A-Za-z0-9_]*)\b[\s\S]*?\bEND\s*;)`,
    "gi",
  );
  for (const name of [...names].sort()) {
    if (!/^\d{4}_exclusive_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(`Invalid exclusive migration name: ${name}`);
    }
    const migration = readFileSync(resolve(repoRoot, "apps/worker/migrations", name), "utf8");
    const dropped = new Set<string>();
    for (const match of migration.matchAll(triggerPattern)) {
      const droppedName = match[1];
      if (droppedName) {
        dropped.add(droppedName);
        continue;
      }
      const triggerName = match[3];
      const sql = match[2];
      if (!triggerName || !sql || (definitions.has(triggerName) && !dropped.has(triggerName))) {
        throw new Error(`Exclusive migration trigger definition is ambiguous: ${triggerName ?? name}`);
      }
      definitions.set(triggerName, normalizeD1TriggerSQL(sql));
      dropped.delete(triggerName);
    }
    if (dropped.size > 0) {
      throw new Error(`Exclusive migration must recreate dropped triggers: ${[...dropped].join(", ")}`);
    }
  }
  return definitions;
}

// 数据校验与运行时共享语言集合；trigger 仍单独对照不可变迁移全文，新增语言不能悄悄绕过数据库升级。
export const settingsLocaleInvariantQuery = `SELECT COUNT(*) AS count FROM settings WHERE CASE
  WHEN json_valid(settings_json) = 0 THEN 1
  WHEN json_type(settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(settings_json, '$.localePreference') NOT IN (${LOCALE_PREFERENCES.map((locale) => `'${locale.replaceAll("'", "''")}'`).join(", ")}) THEN 1
  ELSE 0 END = 1`;

/** 同名 trigger 也必须逐定义一致，marker 和对象数量都不能证明数据库 guard 未被弱化。 */
export function assertD1TriggerDefinitions(
  expected: ReadonlyMap<string, string>,
  actual: readonly D1TriggerDefinition[],
): void {
  const actualByName = new Map<string, string>();
  for (const trigger of actual) {
    if (actualByName.has(trigger.name)) throw new Error(`Cloudflare D1 trigger ${trigger.name} is duplicated`);
    actualByName.set(trigger.name, normalizeD1TriggerSQL(trigger.sql));
  }
  for (const [name, sql] of expected) {
    const actualSQL = actualByName.get(name);
    if (actualSQL === undefined) throw new Error(`Cloudflare D1 trigger ${name} is missing`);
    if (actualSQL !== sql) throw new Error(`Cloudflare D1 trigger ${name} definition drifted`);
  }
  if (actualByName.size !== expected.size) {
    throw new Error("Cloudflare D1 returned unexpected exclusive migration triggers");
  }
}

function configuredQueueConsumers(config: WranglerConfig): WranglerConfig[] {
  const queues = config["queues"];
  if (!isJsonObject(queues) || !Array.isArray(queues["consumers"])) return [];
  return queues["consumers"].filter(isJsonObject);
}

function requiredString(config: WranglerConfig, key: string, context: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${context} must define ${key}`);
  return value.trim();
}

function optionalNumber(config: WranglerConfig, key: string): number | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Queue consumer ${key} must be a number`);
  return value;
}

function appendNumberFlag(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}

function workerConsumerExists(payload: unknown, workerName: string): boolean {
  return Array.isArray(payload) && payload.some((consumer) => isJsonObject(consumer)
    && consumer["type"] === "worker"
    && (consumer["script_name"] === workerName || consumer["script"] === workerName || consumer["service"] === workerName));
}

async function reconcileQueueConsumers(configPath: string, enabled: boolean): Promise<void> {
  const config = readWranglerConfig(configPath);
  const workerName = requiredString(config, "name", "Wrangler config");
  const consumers = configuredQueueConsumers(config);
  const queues = new Map(consumers.map(consumer => [requiredString(consumer, "queue", "Queue consumer"), consumer]));
  // DLQ 可能残留旧版本的消费者；仅解绑这个 Worker，在恢复时只启用正常配置明确列出的队列。
  for (const consumer of consumers) {
    const dlq = consumer["dead_letter_queue"];
    if (typeof dlq === "string" && !queues.has(dlq)) queues.set(dlq, { queue: dlq });
  }
  for (const consumer of queues.values()) {
    const queue = requiredString(consumer, "queue", "Queue consumer");
    const exists = async () => {
      const listed = await requirePnpm(["exec", "wrangler", "queues", "consumer", "worker", "list", queue, "--json", "--config", configPath]);
      const consumers = parseJson(listed.stdout, "Wrangler Queue consumer list");
      if (!Array.isArray(consumers) || consumers.some((entry) => !isJsonObject(entry)
        || entry["type"] !== "worker" || [entry["script_name"], entry["script"], entry["service"]].every((name) => typeof name !== "string"))) {
        throw new Error("Invalid Worker Queue consumer list");
      }
      return workerConsumerExists(consumers, workerName);
    };
    const shouldConsume = enabled && consumers.includes(consumer);
    if (await exists() === shouldConsume) continue;
    if (!shouldConsume) {
      await requirePnpm(["exec", "wrangler", "queues", "consumer", "worker", "remove", queue, workerName, "--config", configPath]);
      if (await exists()) throw new Error(`Queue consumer still attached: ${queue}`);
      continue;
    }
    const args = ["exec", "wrangler", "queues", "consumer", "worker", "add", queue, workerName, "--config", configPath];
    appendNumberFlag(args, "--batch-size", optionalNumber(consumer, "max_batch_size"));
    appendNumberFlag(args, "--batch-timeout", optionalNumber(consumer, "max_batch_timeout"));
    appendNumberFlag(args, "--message-retries", optionalNumber(consumer, "max_retries"));
    appendNumberFlag(args, "--max-concurrency", optionalNumber(consumer, "max_concurrency"));
    appendNumberFlag(args, "--retry-delay-secs", optionalNumber(consumer, "retry_delay"));
    const deadLetterQueue = consumer["dead_letter_queue"];
    if (typeof deadLetterQueue === "string" && deadLetterQueue.length > 0) args.push("--dead-letter-queue", deadLetterQueue);
    await requirePnpm(args);
    if (!await exists()) throw new Error(`Queue consumer not restored: ${queue}`);
  }
}

function deploymentSummary(bookmark: string, versionId?: string): string {
  return [
    "### Renewlet Cloudflare deployment state",
    "",
    `D1 checkpoint: \`${bookmark}\``,
    `Previous Worker version: ${versionId ? `\`${versionId}\`` : "none (first install)"}`,
    "",
  ].join("\n");
}

function createOperations(options: DeployOptions): DeploymentOperations {
  const environment: NodeJS.ProcessEnv = { ...process.env, CI_WRANGLER_CONFIG: options.configPath };
  const d1 = createD1OperationsClient({ target: "remote", configPath: options.configPath });

  const config = readWranglerConfig(options.configPath);
  const access = { accountId: environment["CLOUDFLARE_ACCOUNT_ID"]?.trim() ?? "",
    apiToken: environment["CLOUDFLARE_API_TOKEN"]?.trim() ?? "", workerName: requiredString(config, "name", "Wrangler config") };
  const control = (path: string, init?: RequestInit) => workerControlRequest(access.accountId, access.apiToken, access.workerName, path, init);
  const readActiveDeployment = async (): Promise<ActiveDeployment | undefined> => {
    const active = await readActiveWorkerDeployment(access);
    if (!active) return undefined;
    const maintenance = maintenanceCheckpoint(await control(`versions/${active.versionId}`));
    return maintenance ? { ...active, maintenance } : active;
  };
  const restoreTriggers = async () => {
    await reconcileQueueConsumers(options.configPath, true);
    const triggers = config["triggers"];
    const crons = isJsonObject(triggers) ? triggers["crons"] : [];
    if (!Array.isArray(crons) || crons.some((cron) => typeof cron !== "string")) throw new Error("Invalid configured Cron triggers");
    assertWorkerCrons(await control("schedules"), crons as string[]);
  };

  const readAppliedExclusiveMigrations = async (names: readonly string[]): Promise<Set<string>> => {
    const table = await d1.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
      [],
      parseD1NameRow,
    );
    if (table.length === 0 || names.length === 0) return new Set<string>();
    const placeholders = names.map(() => "?").join(", ");
    const rows = await d1.query(
      `SELECT name FROM d1_migrations WHERE name IN (${placeholders})`,
      names,
      parseD1NameRow,
    );
    return new Set(rows);
  };

  const readPendingDerivedBackfill = async (): Promise<boolean> => {
    // 这里只做 marker 快速门禁决定是否停写；列签名、派生不变量和外键仍由回填脚本完整校验，避免部署前重复全量扫描。
    const table = await d1.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subscription_derived_backfills' LIMIT 1",
      [],
      parseD1NameRow,
    );
    if (table.length === 0) return true;
    const marker = await d1.query(
      "SELECT name FROM subscription_derived_backfills WHERE name = ? LIMIT 1",
      [SUBSCRIPTION_DERIVED_BACKFILL_NAME],
      parseD1NameRow,
    );
    return marker.length === 0;
  };

  const deploy = async (configPath: string, message: string): Promise<ActiveDeployment> => {
    const result = await requirePnpm(["exec", "wrangler", "deploy", "--message", message, "--config", configPath]);
    const published = /^Current Version ID:\s*([a-zA-Z0-9-]+)\s*$/m.exec(result.stdout)?.[1];
    const active = await readActiveDeployment();
    if (!published || active?.versionId !== published) throw new Error("Published Worker version does not match the active deployment");
    return active;
  };

  return {
    async prepare() {
      await requirePnpm(["exec", "node", "scripts/prepare-cloudflare-local-headers.mjs", "--check-production"]);
      const normal = readWranglerConfig(options.configPath);
      writeWranglerConfig(options.maintenanceConfigPath, createMaintenanceWranglerConfig(normal));
    },
    async ensureQueues() {
      await requirePnpm(["cloudflare:queues:ensure"], environment);
    },
    readActiveDeployment,
    readAppliedExclusiveMigrations,
    readPendingDerivedBackfill,
    async captureBookmark() {
      return await captureBookmark(options.configPath);
    },
    async deployMaintenance(context) {
      const maintenance = createMaintenanceWranglerConfig(config);
      maintenance["vars"] = { ...(isJsonObject(maintenance["vars"]) ? maintenance["vars"] : {}),
        RENEWLET_RECOVERY_WORKER: context.workerVersion, ...(context.bookmark ? { RENEWLET_RECOVERY_BOOKMARK: context.bookmark } : {}) };
      writeWranglerConfig(options.maintenanceConfigPath, maintenance);
      const active = await deploy(options.maintenanceConfigPath, "Renewlet exclusive migration maintenance mode");
      if (active.maintenance?.workerVersion !== context.workerVersion || active.maintenance.bookmark !== context.bookmark) {
        throw new Error("Active Worker does not carry the expected maintenance checkpoint");
      }
      await control("schedules", { method: "PUT", body: "[]" });
      assertWorkerCrons(await control("schedules"), []);
      await reconcileQueueConsumers(options.configPath, false);
      return active;
    },
    async waitForBackgroundDrain() {
      console.log("Waiting 15 minutes for in-flight Cron and Queue invocations to drain.");
      await sleep(drainWindowMs);
    },
    async applyMigrations() {
      await requirePnpm(["cloudflare:migrations:apply", "--config", options.configPath], environment);
    },
    async verifyDatabase(names) {
      const applied = await readAppliedExclusiveMigrations(names);
      if (names.some((name) => !applied.has(name))) throw new Error("Cloudflare D1 exclusive migration marker is missing");
      const invalid = await d1.query(
        settingsLocaleInvariantQuery,
        [],
        parseD1CountRow,
      );
      if (invalid.at(0) !== 0) throw new Error("Cloudflare D1 settings locale invariant failed");
      const expectedTriggers = exclusiveMigrationTriggerDefinitions(names);
      if (expectedTriggers.size > 0) {
        const placeholders = [...expectedTriggers].map(() => "?").join(", ");
        const guards = await d1.query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders}) ORDER BY name`,
          [...expectedTriggers.keys()],
          parseD1TriggerRow,
        );
        // marker 只证明 migration 跑过；完整定义比较才能阻止同名 trigger 被手工弱化后继续部署。
        assertD1TriggerDefinitions(expectedTriggers, guards);
      }
    },
    async deployNormal() {
      const active = await deploy(options.configPath, "Renewlet normal service");
      if (active.maintenance) throw new Error("Final Worker still serves maintenance mode");
      await restoreTriggers();
      return active;
    },
    async restoreWorker(versionId) {
      await requirePnpm([
        "exec", "wrangler", "rollback", versionId, "--yes", "--message", "Restore Renewlet before exclusive D1 migration", "--config", options.configPath,
      ]);
      await requirePnpm(["exec", "wrangler", "triggers", "deploy", "--config", options.configPath]);
      await restoreTriggers();
      const active = await readActiveDeployment();
      if (active?.versionId !== versionId) throw new Error("Previous Worker version was not restored");
    },
    async restoreDatabase(bookmark) {
      await requirePnpm([
        "exec", "wrangler", "d1", "time-travel", "restore", "DB", `--bookmark=${validateBookmark(bookmark)}`, "--config", options.configPath,
      ]);
    },
    recordCheckpoint(bookmark, versionId) {
      const outputPath = process.env["GITHUB_OUTPUT"];
      const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
      if (outputPath && summaryPath) {
        const checkpointOptions = {
          configPath: options.configPath,
          maintenanceConfigPath: options.maintenanceConfigPath,
          ...(versionId === undefined ? {} : { workerVersion: versionId }),
        };
        writeDeploymentCheckpointEvidence(bookmark, outputPath, summaryPath, checkpointOptions);
      } else {
        console.log(deploymentSummary(bookmark, versionId));
      }
    },
    recordRecoveryHint(bookmark, versionId) {
      const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
      const recoveryOptions = {
        configPath: options.configPath,
        maintenanceConfigPath: options.maintenanceConfigPath,
        workerVersion: versionId,
      };
      if (summaryPath) writeDeploymentRecoveryHint(bookmark, summaryPath, recoveryOptions);
      console.error(`D1 recovery must precede Worker rollback: ${deploymentRecoveryCommand(bookmark, recoveryOptions)}`);
    },
  };
}

type CliOptions = ({ mode: "deploy" } & DeployOptions) | ({ mode: "recover" } & RecoveryOptions);

function safeWorkerVersion(value: string): string {
  if (!/^[A-Za-z0-9-]{10,128}$/.test(value)) throw new Error("--worker-version is invalid");
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let index = 0;
  let mode: "deploy" | "recover" = "deploy";
  if (argv[0] === "deploy" || argv[0] === "recover") {
    mode = argv[0];
    index = 1;
  }
  let configPath = "wrangler.jsonc";
  let maintenanceConfigPath: string | undefined;
  let bookmark: string | undefined;
  let workerVersion: string | undefined;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--config", "--maintenance-config", "--bookmark", "--worker-version"].includes(argument ?? "") || !value) {
      throw new Error("Usage: cloudflare-deploy.ts [deploy | recover] [--config <path>] [--maintenance-config <path>] [--bookmark <bookmark> --worker-version <id>]");
    }
    if (argument === "--config") configPath = value;
    else if (argument === "--maintenance-config") maintenanceConfigPath = value;
    else if (argument === "--bookmark") bookmark = validateBookmark(value);
    else workerVersion = safeWorkerVersion(value);
    index += 1;
  }
  const resolvedConfig = resolve(repoRoot, configPath);
  const resolvedMaintenance = resolve(repoRoot, maintenanceConfigPath ?? "wrangler.maintenance.generated.jsonc");
  if (resolvedConfig === resolvedMaintenance) throw new Error("Normal and maintenance Wrangler configs must use different paths");
  if (mode === "deploy") return { mode, configPath: resolvedConfig, maintenanceConfigPath: resolvedMaintenance };
  if (!bookmark || !workerVersion) throw new Error("recover requires --bookmark and --worker-version");
  return { mode, configPath: resolvedConfig, maintenanceConfigPath: resolvedMaintenance, bookmark, workerVersion };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const operations = createOperations(options);
  if (options.mode === "recover") {
    await runCloudflareRecovery(operations, options);
    return;
  }
  await runCloudflareDeployment(operations, exclusiveMigrationNames());
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
