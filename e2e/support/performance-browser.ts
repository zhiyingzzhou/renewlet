import type { Page, Request, Response, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { PerformanceMetrics, PerformanceSample, performancePages, performanceInteractions } from "../../scripts/browser-performance";

type MeasurementAction = "navigation" | "click" | "input" | "scroll";

interface BrowserProbe {
  start(mode?: MeasurementAction, target?: string): number;
  hasContent(name: string): boolean;
  stop(): void;
  markReady(): void;
  finish(startedAt: number): Pick<PerformanceMetrics, "durationMs" | "longTaskMs" | "longTasks" | "layoutShiftScore" | "domNodes">;
}

/** 就绪条件在浏览器内逐帧检查并冻结指标，避免 Node 断言退避和协议回传延迟成为页面耗时。 */
export async function waitForPerformanceContent(page: Page, route: typeof performancePages[number] | typeof performanceInteractions[number]) {
  const result = await page.waitForFunction((name) => {
    const ready = window.__renewletPerformance.hasContent(name);
    if (ready) window.__renewletPerformance.markReady();
    return ready;
  }, route, { polling: "raf", timeout: 10_000 });
  await result.dispose();
}

declare global {
  interface Window { __renewletPerformance: BrowserProbe; __renewletReactCommits?: number[] }
}

/** ResourceTiming 在部分 304 响应里不给缓存体大小；用浏览器协议的缓存事件/状态证明复用，不猜测字节阈值。 */
export async function observeHttpCache(page: Page) {
  const session = await page.context().newCDPSession(page);
  const paths = new Map<string, string>();
  const hits = new Map<string, "cache" | "revalidated">();
  session.on("Network.requestWillBeSent", ({ requestId, request }) => paths.set(requestId, new URL(request.url).pathname));
  session.on("Network.requestServedFromCache", ({ requestId }) => hits.set(requestId, "cache"));
  session.on("Network.responseReceived", ({ requestId, response }) => {
    if (response.fromDiskCache) hits.set(requestId, "cache");
  });
  session.on("Network.responseReceivedExtraInfo", ({ requestId, statusCode }) => {
    if (statusCode === 304) hits.set(requestId, "revalidated");
  });
  try {
    await session.send("Network.enable");
  } catch (error) {
    await session.detach();
    throw error;
  }
  return {
    async stop() {
      try {
        return [...hits].flatMap(([requestId, source]) => {
          const path = paths.get(requestId);
          return path?.startsWith("/assets/") ? [{ path, source }] : [];
        });
      } finally {
        await session.detach();
      }
    },
  };
}

export async function installPerformanceProbe(page: Page, fixtureDay: string) {
  if (process.env["RENEWLET_E2E_PROFILE"] === "1") {
    await page.addInitScript(() => {
      const commits: number[] = [];
      window.__renewletReactCommits = commits;
      // 只在诊断 context 接入 React renderer 的 DevTools commit 通知，不读取 Fiber 或修改产品组件。
      Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: {
        supportsFiber: true,
        inject: () => 1,
        onCommitFiberRoot: () => commits.push(performance.now()),
      } });
    });
  }
  // Playwright clock 会替换 Performance 并清空 resource entries；这里只平移业务日期，不接管计时器或性能时钟。
  // 只有固定日期 API 通过原生时钟/资源条目自检后，才可移除这段 Date 专属替换。
  await page.addInitScript((timestamp) => {
    const NativeDate = Date;
    const offset = timestamp - NativeDate.now();
    // Date.now 必须继续流逝，否则 Query 过期与进度条最短展示时间都会被采集器改变。
    const currentTime = () => NativeDate.now() + offset;
    globalThis.Date = new Proxy(NativeDate, {
      apply: () => new NativeDate(currentTime()).toString(),
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [currentTime()], newTarget),
      get: (target, property, receiver) => property === "now" ? currentTime : Reflect.get(target, property, receiver),
    });
  }, new Date(`${fixtureDay}T12:00:00+08:00`).getTime());
  await page.addInitScript(() => {
    const entries: PerformanceEntry[] = [];
    const types = ["longtask", "layout-shift"];
    if (types.some((type) => !PerformanceObserver.supportedEntryTypes.includes(type))) {
      throw new Error("Performance baseline requires Chromium longtask and layout-shift observers");
    }
    const observers = types.map((type) => {
      const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
      observer.observe({ type, buffered: true });
      return observer;
    });
    const drain = () => {
      for (const observer of observers) entries.push(...observer.takeRecords());
    };
    const hasContent = (name: string) => {
      const visible = (element: Element | null) => {
        if (!element) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility === "visible";
    };
    let ready = false;
    switch (name) {
      case "dashboard": ready = visible(document.querySelector('[data-testid="dashboard-stat-grid"]')); break;
      case "subscriptions": ready = visible(document.querySelector('[data-testid="subscription-card"]')); break;
      case "statistics": {
        const charts = [...document.querySelectorAll('[data-testid="statistics-chart-frame"]')];
        ready = charts.length === 3 && charts.every((chart) => chart.querySelectorAll(".recharts-surface").length === 1 && visible(chart.querySelector(".recharts-surface"))) && visible(charts[0]?.querySelector(".recharts-sector") ?? null);
        break;
      }
      case "calendar":
      case "calendar-switch": ready = visible(document.querySelector('button[aria-label="下个月"]')) && document.querySelector("main")?.getAttribute("aria-busy") !== "true"; break;
      // 保留远端语言已提交这一条件；不把初始 auto 草稿或页面外壳算成就绪。
      case "settings": ready = visible(document.querySelector('[data-testid="settings-section-content"]')) && document.querySelector("#locale")?.textContent?.trim() === "中文"; break;
      case "search": {
        const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索订阅、标签或备注..."]');
        const cards = document.querySelectorAll('[data-testid="subscription-card"]');
        const heading = cards[0]?.querySelector("h3");
        ready = cards.length === 1 && Boolean(input?.value) && heading?.textContent === input?.value && visible(heading ?? null);
        break;
      }
      case "scroll": {
        const lastRow = [...document.querySelectorAll('[data-testid="virtualized-subscription-list"] > [data-index]')].at(-1);
        const lastCard = [...document.querySelectorAll('[data-testid="subscription-card"]')].at(-1);
        ready = (document.querySelector("#root")?.scrollTop ?? 0) > 0 && Number(lastRow?.getAttribute("data-index")) > 300 && visible(lastCard ?? null);
        break;
      }
      case "dialog": ready = visible(document.querySelector('[role="dialog"] input[id$="name"]')); break;
    }
    return ready;
    };
    let animationFrame: number | undefined;
    const stop = () => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
      awaitingAction = undefined;
    };
    let measurementStart = 0;
    let awaitingAction: MeasurementAction | undefined;
    let committed: ReturnType<BrowserProbe["finish"]> | undefined;
    const collect = (startedAt: number) => {
      drain();
      const finishedAt = performance.now();
      const tasks = entries.filter((entry) => entry.entryType === "longtask" && entry.startTime + entry.duration > startedAt);
      const shifts = entries.filter((entry) => entry.entryType === "layout-shift" && entry.startTime >= startedAt);
      return {
        durationMs: finishedAt - startedAt,
        longTasks: tasks.length,
        longTaskMs: tasks.reduce((total, entry) => total + Math.max(0, Math.min(finishedAt, entry.startTime + entry.duration) - Math.max(startedAt, entry.startTime)), 0),
        layoutShiftScore: shifts.reduce((total, entry) => {
          if (!("value" in entry) || typeof entry.value !== "number" || !("hadRecentInput" in entry) || entry.hadRecentInput) return total;
          return total + entry.value;
        }, 0),
        domNodes: document.getElementsByTagName("*").length,
      };
    };
    window.__renewletPerformance = {
      hasContent,
      stop,
      start(mode, target) {
        stop();
        drain();
        entries.length = 0;
        committed = undefined;
        awaitingAction = mode;
        measurementStart = performance.now();
        if (target) {
          // 必须在真实动作前启动观察；动作 Promise 可能晚于内容 commit，等待它会把协议延迟混入耗时。
          const check = () => {
            if (!awaitingAction && hasContent(target)) {
              window.__renewletPerformance.markReady();
              animationFrame = undefined;
            } else animationFrame = requestAnimationFrame(check);
          };
          animationFrame = requestAnimationFrame(check);
        }
        return measurementStart;
      },
      markReady() { committed ??= collect(measurementStart); },
      finish(startedAt) {
        stop();
        return committed ?? collect(startedAt);
      },
    };
    // 从对应的真实动作计时；预取、定位及断言轮询不属于交互后的内容等待，后续事件也不能重置起点。
    const onAction = (event: Event) => {
      const navigationClick = awaitingAction === "navigation" && event.type === "click" && event.target instanceof Element && event.target.closest("header a[href]");
      if (navigationClick || awaitingAction === event.type) {
        drain();
        entries.length = 0;
        measurementStart = performance.now();
        awaitingAction = undefined;
      }
    };
    const actionEvents = ["click", "input", "scroll"];
    for (const type of actionEvents) document.addEventListener(type, onAction, true);
    window.addEventListener("pagehide", () => {
      stop();
      for (const observer of observers) observer.disconnect();
      for (const type of actionEvents) document.removeEventListener(type, onAction, true);
    }, { once: true });
  });
}

export async function measurePerformance(
  page: Page,
  testInfo: TestInfo,
  scenario: string,
  cache: PerformanceSample["cache"],
  action: () => Promise<unknown>,
  ready: () => Promise<unknown>,
) {
  const requests = new Map<Request, { pending: boolean; api: boolean; bytes: number }>();
  const sizes: Promise<void>[] = [];
  const errors: string[] = [];
  const events: { atMs: number; event: string; path?: string; status?: number }[] = [];
  const origin = performance.now();
  const recordEvent = (event: string, request?: Request, status?: number) => {
    events.push({ atMs: performance.now() - origin, event, ...(request ? { path: new URL(request.url()).pathname } : {}), ...(status === undefined ? {} : { status }) });
  };
  let abortedReads = 0;
  let metrics: PerformanceMetrics | null = null;
  // 采集器自检不是产品场景，不给它的模拟附件混入 CPU profile。
  const profileSession = process.env["RENEWLET_E2E_PROFILE"] === "1" && testInfo.project.name !== "performance-probe"
    ? await page.context().newCDPSession(page) : undefined;
  const onRequest = (request: Request) => {
    recordEvent("request", request);
    requests.set(request, { pending: true, api: new URL(request.url()).pathname.startsWith("/api/app/"), bytes: 0 });
  };
  const onResponse = (response: Response) => {
    recordEvent(requests.has(response.request()) ? "response" : "previous-response", response.request(), response.status());
    if (requests.has(response.request()) && response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.request().method()} ${new URL(response.url()).pathname}`);
  };
  const onFailed = (request: Request) => {
    recordEvent(requests.has(request) ? "failed" : "previous-failed", request);
    const record = requests.get(request);
    if (!record) return;
    record.pending = false;
    const failure = request.failure()?.errorText ?? "unknown request failure";
    // 页面切换可以取消 GET；保留单独计数，非 GET 取消和其他网络错误仍使样本失败。
    if (request.method() === "GET" && failure === "net::ERR_ABORTED") abortedReads += 1;
    else errors.push(`${request.method()} ${new URL(request.url()).pathname}: ${failure}`);
  };
  const onFinished = (request: Request) => {
    recordEvent(requests.has(request) ? "finished" : "previous-finished", request);
    const record = requests.get(request);
    if (!record) return;
    record.pending = false;
    sizes.push(request.sizes().then((size) => { record.bytes = size.responseBodySize; }).catch(() => {
      errors.push("Request transfer size unavailable");
    }));
  };
  const stopListening = () => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
    page.off("requestfinished", onFinished);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  page.on("requestfinished", onFinished);
  try {
    if (profileSession) {
      await profileSession.send("Profiler.enable");
      await profileSession.send("Profiler.start");
      await page.evaluate(() => { if (window.__renewletReactCommits) window.__renewletReactCommits.length = 0; });
    }
    const actionMode: MeasurementAction | undefined = cache === "warm-spa" ? "navigation"
      : scenario === "search" ? "input" : scenario === "scroll" ? "scroll"
        : scenario === "dialog" || scenario === "calendar-switch" ? "click" : undefined;
    const startedAt = cache === "cold-document" || cache === "warm-document" ? 0 : await page.evaluate(
      ({ mode, target }: { mode: MeasurementAction | undefined; target: string }) => window.__renewletPerformance.start(mode, mode ? target : undefined), { mode: actionMode, target: scenario },
    );
    recordEvent("action-start");
    await action();
    recordEvent("action-end");
    await ready();
    recordEvent("ready");
    // 内容条件在浏览器内冻结指标；这些本地场景仍不等于线上 LCP/INP。
    const browserMetrics = await page.evaluate((start) => window.__renewletPerformance.finish(start), startedAt);
    // 浏览器截止回传后立即冻结网络窗口；读取已完成请求的大小不能把后续刷新混入样本。
    stopListening();
    await Promise.all(sizes);
    const records = [...requests.values()];
    metrics = {
      ...browserMetrics, requests: records.length,
      apiRequests: records.filter((record) => record.api).length,
      responseBodyBytes: records.reduce((total, record) => total + record.bytes, 0),
      pendingRequests: records.filter((record) => record.pending).length,
      abortedReads,
    };
    if (errors.length > 0) throw new Error(errors.join("\n"));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    stopListening();
    if (!page.isClosed()) {
      await page.evaluate(() => window.__renewletPerformance?.stop()).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : "Performance probe cleanup failed");
      });
    }
    if (profileSession) {
      try {
        const { profile } = await profileSession.send("Profiler.stop");
        const profilePath = testInfo.outputPath(`${scenario}-${cache}.cpuprofile`);
        await writeFile(profilePath, JSON.stringify(profile));
        await testInfo.attach("cpu-profile", { path: profilePath, contentType: "application/json" });
        const commits = await page.evaluate(() => window.__renewletReactCommits ?? []);
        await testInfo.attach("react-commits", { body: JSON.stringify({ scenario, cache, commits }), contentType: "application/json" });
      } finally {
        await profileSession.detach();
      }
    }
    await Promise.all(sizes);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Performance sample requires a fixed viewport");
    const sample: PerformanceSample = {
      project: testInfo.project.name, scenario, cache, iteration: testInfo.repeatEachIndex,
      browser: page.context().browser()?.version() ?? "unknown", viewport, metrics, errors,
    };
    await testInfo.attach("performance-sample", { body: JSON.stringify(sample), contentType: "application/json" });
    // 时间线使用 Node 单调时钟，只解释自动化与网络窗口；不把它混入浏览器主内容耗时。
    await testInfo.attach("performance-network", { body: JSON.stringify({ scenario, cache, events }), contentType: "application/json" });
  }
}
