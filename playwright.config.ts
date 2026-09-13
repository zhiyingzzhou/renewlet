/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { capturePerformanceEnvironment, performanceSampleCount } from "./scripts/browser-performance";

// 这个根层配置经常被编辑器作为独立文件打开；文件级 Node types 避免 TS Server
// 还没关联 tsconfig.playwright.json 时误报 process/node 内置类型缺失。
const env = process.env;
const performanceMode = env.RENEWLET_E2E_PERFORMANCE === "1";
const profilingMode = env.RENEWLET_E2E_PROFILE === "1";
const previousDist = env.RENEWLET_E2E_PREVIOUS_DIST;
if (previousDist && performanceMode) throw new Error("Deployment upgrade journeys must run separately from performance samples");
if (profilingMode && !performanceMode) throw new Error("RENEWLET_E2E_PROFILE requires the isolated performance fixture");
// 根包由 Playwright 按 CommonJS 加载；指纹根目录跟随配置文件，不依赖调用者 cwd。
const performanceEnvironment = performanceMode ? capturePerformanceEnvironment(__dirname) : undefined;

// Playwright 会为 reporter 设置 FORCE_COLOR；继承 NO_COLOR 会让 Node 在每个 webServer 子进程重复打印冲突告警。
delete env.NO_COLOR;
delete env.no_color;

// 本地 E2E 依赖 127.0.0.1 上的 Go server 和 Vite。继承用户代理配置时，
// localhost 请求可能被转发到外部代理，导致 healthcheck 或 API 等待随机失败。
for (const key of ["NO_PROXY", "no_proxy"]) {
  const values = new Set(
    (env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add("127.0.0.1");
  values.add("localhost");
  values.add("::1");
  env[key] = Array.from(values).join(",");
}

const proxyEnv = {
  NO_PROXY: env.NO_PROXY ?? "",
  no_proxy: env.no_proxy ?? "",
};

const e2eServerPort = 43190;
const e2eClientPort = 45173;
const e2eServerURL = `http://127.0.0.1:${e2eServerPort}`;
const e2eClientURL = `http://127.0.0.1:${e2eClientPort}`;
const adminStorageState = "e2e/.auth/admin.json";
const browserExecutablePath = env.RENEWLET_E2E_BROWSER_EXECUTABLE?.trim();
// 本地可能遇到 Playwright CDN/TLS 被代理拦截；只在显式传入时用系统浏览器，CI 仍使用 hermetic 浏览器。
const localBrowserFallback = browserExecutablePath ? { launchOptions: { executablePath: browserExecutablePath } } : {};

// 端口必须保持拆分：43190 只给 PocketBase/Go API，浏览器页面只从 45173 的 Vite 入口进入。
// 如果把 baseURL 指到后端端口，headed 调试会看到 PocketBase UI 而不是 Renewlet 前端。
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // 性能样本不能自动重试到变绿；原始失败与不足十次的分组必须保留。
  retries: performanceMode ? 0 : env.CI ? 1 : 0,
  metadata: performanceEnvironment ? { performance: performanceEnvironment } : {},
  // CPU/commit 诊断不能生成可被比较器接受的生产耗时报告。
  reporter: performanceMode && !profilingMode ? [["list"], ["./e2e/support/performance-reporter.ts"]] : [
    ["list"], ["html", { open: "never" }],
    ["./e2e/support/server-diagnostics-reporter.ts", { outputFile: resolve(__dirname, "test-results/server-diagnostics.json") }],
  ],
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: e2eClientURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    screenshot: performanceMode ? "off" : "only-on-failure",
    trace: performanceMode ? "off" : "retain-on-failure",
    video: performanceMode ? "off" : "retain-on-failure",
    ...localBrowserFallback,
  },
  webServer: [
    {
      // 每次清空 e2e 数据目录，让 setup project 拥有唯一的初始化状态；不复用旧 server
      // 可以避免 storage state 与 PocketBase SQLite 数据跨测试轮次串味。
      command: `rm -rf ./pb_data_e2e && go run ./cmd/renewlet serve --http=127.0.0.1:${e2eServerPort} --dir=./pb_data_e2e`,
      cwd: "./apps/docker-server",
      env: {
        ...proxyEnv,
        SETUP_ENABLED: "true",
        GOMEMLIMIT: "128MiB",
      },
      url: `${e2eServerURL}/api/app/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      // Go 与 Vite 都可能在 stdout 输出诊断；两条流都交给 reporter，不能仅依赖页面 console 事件。
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // 性能模式重建生产产物；普通 E2E 仍重建 optimizer，不复用开发机残留缓存。
      command: performanceMode || previousDist
        ? `${profilingMode ? "pnpm --filter @renewlet/client exec vite build --sourcemap" : "pnpm --filter @renewlet/client build"} && pnpm --dir apps/web exec vite preview --host 127.0.0.1 --port ${e2eClientPort} --strictPort`
        : `pnpm --dir apps/web exec vite --force --host 127.0.0.1 --port ${e2eClientPort} --strictPort`,
      env: {
        ...proxyEnv,
        VITE_DEV_PROXY_TARGET: e2eServerURL,
        ...(performanceMode || previousDist ? { VITE_RENEWLET_RUNTIME: "docker" } : {}),
      },
      url: e2eClientURL,
      reuseExistingServer: false,
      timeout: performanceMode || previousDist ? 300_000 : 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      testIgnore: ["**/cloudflare-check/**", "**/performance.setup.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    ...(performanceMode ? [{
      name: "performance-probe",
      testMatch: "**/performance-probe.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    }, {
      name: "performance-seed",
      dependencies: ["setup", "performance-probe"],
      testMatch: "**/performance.setup.ts",
      use: { ...devices["Desktop Chrome"] },
    }] : []),
    // setup 通过真实 Renewlet UI 生成登录态；业务项目只消费 storage state，
    // 这样每个 spec 独立验证旅程，又不重复穿过首次安装流程。
    {
      name: performanceMode ? "performance-desktop" : "desktop",
      dependencies: [performanceMode ? "performance-seed" : "setup"],
      repeatEach: performanceMode && !profilingMode ? performanceSampleCount : 1,
      testMatch: previousDist ? ["**/version-upgrade.spec.ts"] : performanceMode ? ["**/performance.spec.ts"] : [
        "**/calendar-feed-management.spec.ts",
        "**/subscriptions.spec.ts",
        "**/settings.spec.ts",
        "**/statistics.spec.ts",
        "**/release-smoke.spec.ts",
        "**/route-progress.spec.ts",
        "**/report-exchange-rates.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminStorageState,
      },
    },
    {
      name: performanceMode ? "performance-mobile" : "mobile",
      dependencies: [performanceMode ? "performance-seed" : "setup"],
      repeatEach: performanceMode && !profilingMode ? performanceSampleCount : 1,
      testMatch: previousDist ? ["**/version-upgrade.spec.ts"] : performanceMode ? ["**/performance.spec.ts"] : ["**/mobile-*.spec.ts", "**/route-progress.spec.ts", "**/report-exchange-rates.spec.ts"],
      use: {
        ...devices["Pixel 5"],
        storageState: adminStorageState,
      },
    },
  ],
});
