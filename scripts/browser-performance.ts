import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { arch, cpus, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildSubscriptionPerformanceScenario } from "../packages/shared/src/contract-fixtures";
import { performanceExchangeRateCache } from "../e2e/support/exchange-rate-fixture";

export const performanceSampleCount = 10;
export const performancePages = ["dashboard", "subscriptions", "statistics", "calendar", "settings"] as const;
export const performanceInteractions = ["search", "scroll", "dialog", "calendar-switch"] as const;
export const performanceMetrics = [
  "durationMs", "longTaskMs", "longTasks", "layoutShiftScore", "domNodes",
  "requests", "apiRequests", "responseBodyBytes", "pendingRequests", "abortedReads",
] as const;

const metricsSchema = z.object({
  durationMs: z.number().nonnegative(),
  longTaskMs: z.number().nonnegative(),
  longTasks: z.number().int().nonnegative(),
  layoutShiftScore: z.number().nonnegative(),
  domNodes: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  apiRequests: z.number().int().nonnegative(),
  responseBodyBytes: z.number().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  abortedReads: z.number().int().nonnegative(),
});

export const performanceSampleSchema = z.object({
  project: z.string(),
  scenario: z.string(),
  cache: z.enum(["cold-document", "warm-spa", "warm-document", "interaction"]),
  iteration: z.number().int().nonnegative(),
  browser: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  metrics: metricsSchema.nullable(),
  errors: z.array(z.string()),
});
export type PerformanceSample = z.infer<typeof performanceSampleSchema>;
export type PerformanceMetrics = z.infer<typeof metricsSchema>;

export const performanceEnvironmentSchema = z.object({
  revision: z.string(), worktreeHash: z.string(), lockHash: z.string(),
  node: z.string(), packageManager: z.string(), go: z.string(), host: z.string(),
  os: z.string(), cpu: z.string(), architecture: z.string(),
  fixtureDay: z.string(), fixtureHash: z.string(),
  runtime: z.literal("docker-production-preview"),
  cachePolicy: z.literal("http-cache-enabled;seeded-exchange-rates;warm-spa-keeps-query-and-modules"),
  locale: z.literal("zh-CN"), timezone: z.literal("Asia/Shanghai"),
});
export type PerformanceEnvironment = z.infer<typeof performanceEnvironmentSchema>;

export const performanceReportSchema = z.object({
  version: z.literal(6), environment: performanceEnvironmentSchema, artifactHash: z.string(),
  status: z.string(), samples: z.array(performanceSampleSchema), failures: z.array(z.string()),
});
export type PerformanceReport = z.infer<typeof performanceReportSchema>;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function performanceFixture(day: string) {
  const nextDay = new Date(`${day}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const billingDate = nextDay.toISOString().slice(0, 10);
  return buildSubscriptionPerformanceScenario(1000).initial.map((record) => {
    const { index: _index, id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...subscription } = record;
    return {
      ...subscription, logo: null, costSharing: null,
      extra: { import: { source: "renewlet", sourceId: record.id, confidence: "high" } },
      oneTimeTermCount: null, oneTimeTermUnit: null,
      // 保留规模和字段分布，只平移日期，避免采样期间自动续订改写夹具；日期与最终输入一并指纹化。
      startDate: day, nextBillingDate: billingDate,
      trialEndDate: record.status === "trial" ? billingDate : null,
    };
  });
}

export function worktreeHash(root: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const hash = createHash("sha256").update(git("rev-parse", "HEAD")).update(git("diff", "HEAD", "--binary"));
  // 新增测试/采集文件尚未提交时也属于基线，不能只记录 HEAD 或 tracked diff。
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean).sort();
  for (const path of untracked) hash.update(path).update("\0").update(readFileSync(join(root, path)));
  return hash.digest("hex");
}

export function capturePerformanceEnvironment(root: string): PerformanceEnvironment {
  // 跨午夜的交替采样必须复用同一天夹具；显式日期仍写入报告并参与输入指纹。
  const fixtureDay = z.iso.date().parse(process.env["RENEWLET_PERFORMANCE_DAY"] ?? new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()));
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    worktreeHash: worktreeHash(root), lockHash: sha256(readFileSync(join(root, "pnpm-lock.yaml"))),
    node: process.version, packageManager: process.env["npm_config_user_agent"] ?? "unknown",
    go: execFileSync("go", ["env", "GOVERSION"], { cwd: join(root, "apps/docker-server"), encoding: "utf8" }).trim(),
    host: hostname(), os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? "unknown", architecture: arch(),
    fixtureDay, fixtureHash: sha256(JSON.stringify([performanceFixture(fixtureDay), performanceExchangeRateCache(fixtureDay)])),
    runtime: "docker-production-preview",
    cachePolicy: "http-cache-enabled;seeded-exchange-rates;warm-spa-keeps-query-and-modules",
    locale: "zh-CN", timezone: "Asia/Shanghai",
  };
}

export function buildArtifactHash(directory: string): string {
  const hash = createHash("sha256");
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else hash.update(path).update("\0").update(readFileSync(join(directory, path)));
    }
  };
  visit("");
  return hash.digest("hex");
}

export function summarize(values: readonly number[]) {
  if (values.length < performanceSampleCount || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Performance summaries require at least 10 finite, nonnegative samples");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  const p75 = sorted[Math.ceil(sorted.length * 0.75) - 1];
  if (upper === undefined || lower === undefined || p75 === undefined) throw new Error("Missing quantile input");
  return { count: sorted.length, median: sorted.length % 2 === 0 ? (lower + upper) / 2 : upper, p75 };
}

export function summarizeReport(report: PerformanceReport) {
  if (report.status !== "passed" || report.failures.length > 0) throw new Error("Failed runs cannot become a performance baseline");
  const summaries: Record<string, Record<string, ReturnType<typeof summarize>>> = {};
  for (const project of ["performance-desktop", "performance-mobile"]) {
    const scenarios = [
      ...performancePages.flatMap((page) => [`${page}/cold-document`, `${page}/warm-spa`, `${page}/warm-document`]),
      ...performanceInteractions.map((scenario) => `${scenario}/interaction`),
    ];
    for (const scenario of scenarios) {
      const key = `${project}/${scenario}`;
      const samples = report.samples.filter((sample) => `${sample.project}/${sample.scenario}/${sample.cache}` === key);
      if (samples.length !== performanceSampleCount || new Set(samples.map((sample) => sample.iteration)).size !== performanceSampleCount) {
        throw new Error(`Incomplete or duplicate performance group: ${key}`);
      }
      const metrics = samples.map((sample) => {
        if (sample.errors.length > 0 || sample.metrics === null) throw new Error(`Invalid sample in ${key}`);
        return sample.metrics;
      });
      summaries[key] = Object.fromEntries(performanceMetrics.map((metric) => [metric, summarize(metrics.map((sample) => sample[metric]))]));
    }
  }
  if (report.samples.length !== Object.keys(summaries).length * performanceSampleCount) throw new Error("Unexpected performance samples");
  return summaries;
}

export function comparePerformanceReports(baseline: PerformanceReport, candidate: PerformanceReport) {
  const { revision: _baseRevision, worktreeHash: _baseTree, ...baseEnvironment } = baseline.environment;
  const { revision: _nextRevision, worktreeHash: _nextTree, ...nextEnvironment } = candidate.environment;
  if (JSON.stringify(baseEnvironment) !== JSON.stringify(nextEnvironment)) throw new Error("Performance environments do not match");
  const before = summarizeReport(baseline);
  const after = summarizeReport(candidate);
  const regressions: string[] = [];
  for (const [key, previous] of Object.entries(before)) {
    const current = after[key];
    if (!current) throw new Error(`Missing candidate scenario: ${key}`);
    const baseSamples = baseline.samples.filter((sample) => `${sample.project}/${sample.scenario}/${sample.cache}` === key);
    const nextSamples = candidate.samples.filter((sample) => `${sample.project}/${sample.scenario}/${sample.cache}` === key);
    const configurations = [...baseSamples, ...nextSamples].map((sample) => JSON.stringify([sample.browser, sample.viewport]));
    if (new Set(configurations).size !== 1) throw new Error(`Browser or viewport differs in ${key}`);
    for (const quantile of ["median", "p75"] as const) {
      const previousValue = previous["durationMs"]?.[quantile];
      const currentValue = current["durationMs"]?.[quantile];
      if (previousValue === undefined || currentValue === undefined) throw new Error("Missing duration summary");
      if (currentValue > previousValue * 1.1) regressions.push(`${key} ${quantile}: ${previousValue} -> ${currentValue} ms`);
    }
  }
  return { regressions, before, after };
}
