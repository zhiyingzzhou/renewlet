#!/usr/bin/env node

/**
 * 对采集到的 Docker/Worker AI 结果执行同一组语义断言。
 *
 * 用法：node scripts/evaluate-ai-recognition-golden-corpus.mjs --results path/to/results.json
 * results 形状：{ "cases": [{ "id": "...", "subscriptions": [], "warnings": [] }] }
 * provider 调用和图片采集由外部 harness 负责；脚本只比较脱敏结构化结果。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const corpusPath = path.join(repoRoot, "packages/shared/data/ai-recognition-golden-corpus.json");
const resultArgIndex = process.argv.indexOf("--results");
const resultPath = resultArgIndex >= 0 ? process.argv[resultArgIndex + 1] : null;

if (!resultPath) {
  console.error("用法：node scripts/evaluate-ai-recognition-golden-corpus.mjs --results <results.json>");
  process.exit(2);
}

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const result = JSON.parse(await readFile(path.resolve(resultPath), "utf8"));
const resultCases = new Map((Array.isArray(result.cases) ? result.cases : []).map((item) => [item.id, item]));
const failures = [];

for (const testCase of corpus.cases ?? []) {
  const actual = resultCases.get(testCase.id);
  if (!actual) {
    failures.push(`${testCase.id}: missing result`);
    continue;
  }
  const subscriptions = Array.isArray(actual.subscriptions) ? actual.subscriptions : [];
  const warnings = [
    ...(Array.isArray(actual.warnings) ? actual.warnings : []),
    ...subscriptions.flatMap((subscription) => Array.isArray(subscription?.warnings) ? subscription.warnings : []),
  ];
  const expected = testCase.expect ?? {};
  if (subscriptions.length < (expected.atLeastSubscriptions ?? 0)) {
    failures.push(`${testCase.id}: expected at least ${expected.atLeastSubscriptions} subscriptions, got ${subscriptions.length}`);
  }
  for (const field of expected.requiredNonNull ?? []) {
    if (!subscriptions.some((subscription) => subscription?.[field] !== null && subscription?.[field] !== undefined && subscription?.[field] !== "")) {
      failures.push(`${testCase.id}: expected non-null ${field}`);
    }
  }
  for (const field of expected.nullFields ?? []) {
    if (subscriptions.some((subscription) => subscription?.[field] !== null && subscription?.[field] !== undefined)) {
      failures.push(`${testCase.id}: expected null ${field}`);
    }
  }
  for (const warning of expected.requiredWarnings ?? []) {
    if (!warnings.includes(warning)) failures.push(`${testCase.id}: missing warning ${warning}`);
  }
  for (const [field, value] of Object.entries(expected.equals ?? {})) {
    if (!subscriptions.some((subscription) => subscription?.[field] === value)) {
      failures.push(`${testCase.id}: expected ${field}=${JSON.stringify(value)}`);
    }
  }
  const serialized = JSON.stringify({ subscriptions, warnings });
  for (const text of expected.forbiddenText ?? []) {
    if (serialized.includes(text)) failures.push(`${testCase.id}: forbidden text leaked: ${text}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`AI recognition golden corpus passed: ${corpus.cases.length} cases`);
