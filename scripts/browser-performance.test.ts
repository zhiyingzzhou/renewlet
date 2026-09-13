import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_APPLY_SUBSCRIPTION_LIMIT, importApplyRequestSchema } from "../packages/shared/src/schemas/import-export";
import {
  comparePerformanceReports, performanceFixture, performanceInteractions, performancePages,
  performanceReportSchema, performanceSampleCount, sha256, summarize, summarizeReport,
  type PerformanceReport, type PerformanceSample,
} from "./browser-performance";
import { serverDiagnosticFailures } from "./server-diagnostics";

function report(): PerformanceReport {
  const samples: PerformanceSample[] = [];
  for (const project of ["performance-desktop", "performance-mobile"]) {
    const scenarios = [
      ...performancePages.flatMap((scenario) => [
        { scenario, cache: "cold-document" as const }, { scenario, cache: "warm-spa" as const },
        { scenario, cache: "warm-document" as const },
      ]),
      ...performanceInteractions.map((scenario) => ({ scenario, cache: "interaction" as const })),
    ];
    for (const scenario of scenarios) {
      for (let iteration = 0; iteration < performanceSampleCount; iteration += 1) {
        samples.push({
          ...scenario, project, iteration, browser: "fixture-chromium", viewport: { width: 1280, height: 720 }, errors: [],
          metrics: {
            durationMs: 100, longTaskMs: 0, longTasks: 0, layoutShiftScore: 0, domNodes: 100,
            requests: 3, apiRequests: 1, responseBodyBytes: 300, pendingRequests: 0, abortedReads: 0,
          },
        });
      }
    }
  }
  return {
    version: 6, artifactHash: "artifact", status: "passed", samples, failures: [],
    environment: {
      revision: "revision", worktreeHash: "tree", lockHash: "lock", node: "node", packageManager: "pnpm", go: "go",
      host: "host", os: "os", cpu: "cpu", architecture: "arch", fixtureDay: "2026-09-07", fixtureHash: "fixture",
      runtime: "docker-production-preview", cachePolicy: "http-cache-enabled;seeded-exchange-rates;warm-spa-keeps-query-and-modules",
      locale: "zh-CN", timezone: "Asia/Shanghai",
    },
  };
}

test("summaries keep cold and warm groups separate and use median and nearest-rank P75", () => {
  assert.deepEqual(summarize([10, 4, 1, 5, 3, 7, 6, 9, 8, 2]), { count: 10, median: 5.5, p75: 8 });
  assert.equal(Object.keys(summarizeReport(report())).length, 38);
  assert.throws(() => summarize([1, 2]), /at least 10/);
  assert.throws(() => summarize(Array.from({ length: 10 }, () => Number.NaN)), /finite/);
});

test("native content-ready measurements reject retired clock and polling formats", () => {
  for (const version of [1, 2, 3, 4, 5]) assert.equal(performanceReportSchema.safeParse({ ...report(), version }).success, false);
  const missingWarmDocument = report();
  missingWarmDocument.samples = missingWarmDocument.samples.filter((sample) => sample.cache !== "warm-document");
  assert.throws(() => summarizeReport(missingWarmDocument), /warm-document/);
});

test("server diagnostics invalidate samples even when all browser assertions passed", () => {
  const chunks = ["[WebServer] \u001b[31mER", "ROR scheduler failed\u001b[0m\n", "[WebServer] [console.warn] capture failed\n"];
  const failures = serverDiagnosticFailures(chunks.join(""));
  assert.deepEqual(failures, ["[WebServer] ERROR scheduler failed", "[WebServer] [console.warn] capture failed"]);
  assert.deepEqual(serverDiagnosticFailures("[WebServer] INFO ready\n$ eslint --max-warnings 0\n"), []);
  const candidate = report();
  candidate.failures.push(...failures);
  assert.throws(() => summarizeReport(candidate), /Failed runs/);
});

test("failures, skipped groups and duplicate iterations cannot become a baseline", () => {
  for (const corrupt of [
    (value: PerformanceReport) => { value.status = "failed"; },
    (value: PerformanceReport) => { value.failures.push("console error"); },
    (value: PerformanceReport) => { value.samples.pop(); },
    (value: PerformanceReport) => { const sample = value.samples[0]; if (sample) sample.errors.push("HTTP 500"); },
    (value: PerformanceReport) => { const sample = value.samples[0]; if (sample) sample.metrics = null; },
    (value: PerformanceReport) => { const sample = value.samples[0]; if (sample) sample.iteration = 1; },
  ]) {
    const value = report();
    corrupt(value);
    assert.throws(() => summarizeReport(value));
  }
});

test("comparison rejects different environments and requires remeasurement above 10 percent", () => {
  const baseline = report();
  const candidate = report();
  candidate.environment.revision = "candidate";
  candidate.environment.worktreeHash = "candidate-tree";
  candidate.artifactHash = "candidate-artifact";
  assert.deepEqual(comparePerformanceReports(baseline, candidate).regressions, []);
  for (const sample of candidate.samples) if (sample.metrics) sample.metrics.durationMs = 111;
  assert.equal(comparePerformanceReports(baseline, candidate).regressions.length, 76);
  candidate.environment.fixtureHash = "different-data";
  assert.throws(() => comparePerformanceReports(baseline, candidate), /environments/);
});

test("browser differences and malformed metrics are not silently compared", () => {
  const baseline = report();
  const candidate = report();
  const sample = candidate.samples[0];
  if (!sample || !sample.metrics) throw new Error("Missing test sample");
  sample.viewport.width += 1;
  assert.throws(() => comparePerformanceReports(baseline, candidate), /viewport/);
  sample.metrics.durationMs = -1;
  assert.equal(performanceReportSchema.safeParse(candidate).success, false);
});

test("fixture preserves the shared thousand-row distribution and fingerprints date changes", () => {
  const first = performanceFixture("2026-09-07");
  assert.equal(first.length, 1000);
  assert.equal(first.filter((record) => record.status === "trial").length, 200);
  assert.equal(first.filter((record) => record.autoRenew).length, 500);
  assert.equal(first[0]?.nextBillingDate, "2026-09-08");
  assert.equal("id" in (first[0] ?? {}), false);
  assert.equal(sha256(JSON.stringify(first)), sha256(JSON.stringify(performanceFixture("2026-09-07"))));
  assert.notEqual(sha256(JSON.stringify(first)), sha256(JSON.stringify(performanceFixture("2026-09-08"))));
});

test("fixture uses unique import identities and fits the existing apply batches without raising limits", () => {
  const subscriptions = performanceFixture("2026-09-07");
  assert.equal(new Set(subscriptions.map((record) => record.extra.import.sourceId)).size, subscriptions.length);
  const request = (batch: typeof subscriptions) => ({ payload: { source: "renewlet", subscriptions: batch }, conflictMode: "skip" });
  assert.equal(importApplyRequestSchema.safeParse(request(subscriptions)).success, false);
  let checked = 0;
  for (let offset = 0; offset < subscriptions.length; offset += IMPORT_APPLY_SUBSCRIPTION_LIMIT) {
    const parsed = importApplyRequestSchema.parse(request(subscriptions.slice(offset, offset + IMPORT_APPLY_SUBSCRIPTION_LIMIT)));
    checked += parsed.payload.subscriptions.length;
  }
  assert.equal(checked, 1000);
  assert.deepEqual(subscriptions.map((record) => record.extra), performanceFixture("2026-09-07").map((record) => record.extra));
});
