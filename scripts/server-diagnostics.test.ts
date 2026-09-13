import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ServerDiagnosticsReporter from "../e2e/support/server-diagnostics-reporter";
import { serverDiagnosticFailures } from "./server-diagnostics";

test("build, runtime and forwarded console warning formats share one failure rule", () => {
  const warnings = [
    "[WARNING] build warning", "warning: deprecated setting", "Error: build failed",
    "(node:123) ExperimentalWarning: runtime feature", "[WebServer] (!) oversized chunk",
    "[WebServer] [console.error] failed request",
  ];
  assert.deepEqual(serverDiagnosticFailures(warnings.join("\n")), warnings);
});

test("startup and late diagnostics fail an otherwise passed run across both output streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "renewlet-server-diagnostics-"));
  try {
    const reporter = new ServerDiagnosticsReporter({ outputFile: join(root, "test-results/server-diagnostics.json") });
    reporter.onStdErr("[WebServer] \u001b[31mER");
    reporter.onStdOut("[WebServer] WA");
    reporter.onStdErr(Buffer.from("ROR scheduler failed\u001b[0m\n"));
    reporter.onStdOut(Buffer.from("RN startup warning\n"));
    reporter.onStdErr("[WebServer] [console.warn] discarded document\n");
    assert.deepEqual(await reporter.onEnd({ status: "passed" }), { status: "failed" });
    const report: unknown = JSON.parse(readFileSync(join(root, "test-results/server-diagnostics.json"), "utf8"));
    assert.deepEqual(report, {
      status: "failed", failures: [
        "[WebServer] WARN startup warning", "[WebServer] ERROR scheduler failed", "[WebServer] [console.warn] discarded document",
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("healthy output never changes failed, interrupted or timed-out results into passes", async () => {
  const root = mkdtempSync(join(tmpdir(), "renewlet-server-diagnostics-"));
  try {
    for (const status of ["passed", "failed", "timedout", "interrupted"] as const) {
      const reporter = new ServerDiagnosticsReporter({ outputFile: join(root, "test-results/server-diagnostics.json") });
      reporter.onStdOut("[WebServer] INFO ready\n$ eslint --max-warnings 0\n");
      assert.deepEqual(await reporter.onEnd({ status }), { status });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
