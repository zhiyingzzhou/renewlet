import { readFileSync } from "node:fs";
import { join } from "node:path";

function requireSnippet(content, snippet, context) {
  if (!content.includes(snippet)) throw new Error(`${context} must keep D1 deployment snippet: ${snippet}`);
}

/** workflow 和文档只暴露统一编排入口；排他 migration 与 v5 派生回填的停写顺序由状态机行为测试证明。 */
export function checkCloudflareD1DeployContract(repoRoot) {
  const selfHostedPath = ".github/workflows/cloudflare-worker.yml";
  const releasePath = ".github/workflows/release-publish.yml";
  const selfHosted = readFileSync(join(repoRoot, selfHostedPath), "utf8");
  const release = readFileSync(join(repoRoot, releasePath), "utf8");
  const orchestrator = readFileSync(join(repoRoot, "scripts/cloudflare-deploy.ts"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  for (const snippet of [
    "group: production-cloudflare-${{ github.repository }}\n  cancel-in-progress: false",
    "timeout-minutes: 60",
    "CI_WRANGLER_MAINTENANCE_CONFIG: wrangler.maintenance.generated.jsonc",
  ]) requireSnippet(selfHosted, snippet, selfHostedPath);
  for (const snippet of [
    "group: production-cloudflare-${{ github.repository }}\n      cancel-in-progress: false",
    "timeout-minutes: 60",
    "CI_WRANGLER_MAINTENANCE_CONFIG: wrangler.maintenance.generated.jsonc",
  ]) requireSnippet(release, snippet, releasePath);

  const workflowCommand = "pnpm deploy -- --config \"$CI_WRANGLER_CONFIG\" --maintenance-config \"$CI_WRANGLER_MAINTENANCE_CONFIG\"";
  for (const workflow of [selfHosted, release]) {
    requireSnippet(workflow, workflowCommand, "Cloudflare workflow");
    for (const forbidden of ["cloudflare:migrations:apply", "cloudflare:queues:ensure", "wrangler deploy", "cloudflare-d1-checkpoint.ts"]) {
      if (workflow.includes(forbidden)) {
        throw new Error(`Cloudflare workflows must not duplicate orchestrator operation: ${forbidden}`);
      }
    }
  }

  for (const snippet of [
    "15 * 60 * 1000",
    "retryAll({ delaySeconds: 900 })",
    "recordRecoveryHint",
    "reconcileQueueConsumers(options.configPath, true)",
    "reconcileQueueConsumers(options.configPath, false)",
    "SELECT name, sql FROM sqlite_master",
    "assertD1TriggerDefinitions",
    "readPendingDerivedBackfill",
  ]) {
    const source = snippet.startsWith("retryAll")
      ? readFileSync(join(repoRoot, "apps/worker/src/index.ts"), "utf8")
      : orchestrator;
    requireSnippet(source, snippet, "Cloudflare maintenance state machine");
  }

  if (packageJson.scripts?.deploy !== "tsx scripts/cloudflare-deploy.ts deploy") {
    throw new Error("package.json deploy must delegate to the Cloudflare deployment orchestrator.");
  }
  if (packageJson.scripts?.["cloudflare:deploy:recover"] !== "tsx scripts/cloudflare-deploy.ts recover") {
    throw new Error("package.json recovery must delegate to the Cloudflare deployment orchestrator.");
  }

  const expectedScriptTests = "node --test scripts/*.test.mjs && node --import tsx --test scripts/*.test.ts";
  if (packageJson.scripts?.["test:scripts"] !== expectedScriptTests) {
    throw new Error("package.json test:scripts must run both MJS and TypeScript operations tests.");
  }
  if (packageJson.scripts?.["check:deploy"] !== "node scripts/check-deploy-config.mjs && pnpm test:scripts") {
    throw new Error("package.json check:deploy must run all operations-script tests.");
  }
  if (!packageJson.scripts?.["test:unit"]?.startsWith("pnpm test:scripts && ")) {
    throw new Error("package.json test:unit must include operations-script tests.");
  }

  for (const relativePath of ["docs/cloudflare-workers-deploy.md", "docs/cloudflare-workers-deploy.zh-CN.md"]) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const forbidden of [
      "pnpm cloudflare:migrations:apply",
      "wrangler d1 time-travel restore",
      "wrangler rollback",
    ]) {
      if (content.includes(forbidden)) {
        throw new Error(`${relativePath} must not expose an operation outside the deployment orchestrator: ${forbidden}`);
      }
    }
    requireSnippet(content, "pnpm cloudflare:deploy:recover", relativePath);
    requireSnippet(content, "--bookmark", relativePath);
    requireSnippet(content, "--worker-version", relativePath);
  }
}
