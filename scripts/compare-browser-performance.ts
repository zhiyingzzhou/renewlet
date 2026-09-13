import { readFileSync } from "node:fs";
import { comparePerformanceReports, performanceReportSchema } from "./browser-performance";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath || process.argv.length !== 4) {
  throw new Error("Usage: pnpm exec tsx scripts/compare-browser-performance.ts <baseline.json> <candidate.json>");
}
const baseline = performanceReportSchema.parse(JSON.parse(readFileSync(baselinePath, "utf8")));
const candidate = performanceReportSchema.parse(JSON.parse(readFileSync(candidatePath, "utf8")));
const comparison = comparePerformanceReports(baseline, candidate);
console.log(JSON.stringify(comparison, null, 2));
// 首次超过 10% 只证明需要复测，不能自动重试到通过后覆盖原始失败报告。
if (comparison.regressions.length > 0) process.exitCode = 1;
