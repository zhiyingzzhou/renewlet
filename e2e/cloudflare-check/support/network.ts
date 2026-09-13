import { expect, type ConsoleMessage, type Page, type Request, type Response, type TestInfo } from "@playwright/test";

type RequestRecord = {
  method: string;
  pathname: string;
  resourceType: string;
  startedAt: number;
  url: string;
};

type ResponseRecord = RequestRecord & {
  durationMs: number;
  status: number;
};

type RequestFailureRecord = RequestRecord & {
  durationMs: number;
  errorText: string;
};

type ConsoleRecord = {
  at: number;
  text: string;
  type: string;
};

type PageErrorRecord = {
  message: string;
  stack: string | undefined;
};

type NetworkAssertionOptions = {
  allowApiError?: (record: ResponseRecord) => boolean;
  allowConsoleError?: RegExp[];
};

const coreApiPaths = [
  "/api/app/auth/session",
  "/api/app/settings",
  "/api/app/custom-config",
  "/api/app/subscriptions",
] as const;

function pathnameFromURL(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isAppApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/app/");
}

function formatResponse(record: ResponseRecord): string {
  return `${record.method} ${record.pathname} -> ${record.status} (${record.durationMs}ms)`;
}

function isExpectedNavigationAbort(record: RequestFailureRecord): boolean {
  // Playwright 的 page.goto 会卸载旧文档；旧页面未完成的 GET fetch 会以 net::ERR_ABORTED 结束，不代表 API 不可用。
  return record.method === "GET" && record.errorText === "net::ERR_ABORTED";
}

function isBlockingRequestFailure(record: RequestFailureRecord): boolean {
  return !isExpectedNavigationAbort(record);
}

export function isApiResponse(response: Response, pathname: string, method?: string): boolean {
  const responsePathname = pathnameFromURL(response.url());
  return responsePathname === pathname && (!method || response.request().method() === method);
}

export function recordResponseTiming(
  started: RequestRecord,
  timing: Pick<ReturnType<Request["timing"]>, "startTime" | "responseStart">,
  status: number,
): ResponseRecord {
  // Node 回调可能排队；并发窗口必须使用浏览器请求开始到响应首字节的时间，不能把事件传输延迟算进 API 耗时。
  return { ...started, startedAt: timing.startTime, durationMs: timing.responseStart, status };
}

export function createNetworkMonitor(page: Page) {
  const requestStarts = new Map<Request, RequestRecord>();
  const inflightByPath = new Map<string, number>();
  const maxConcurrentByPath = new Map<string, number>();
  const requests: RequestRecord[] = [];
  const responses: ResponseRecord[] = [];
  const requestFailures: RequestFailureRecord[] = [];
  const consoleMessages: ConsoleRecord[] = [];
  const pageErrors: PageErrorRecord[] = [];

  const decrementInflight = (pathname: string) => {
    if (!isAppApiPath(pathname)) return;
    inflightByPath.set(pathname, Math.max(0, (inflightByPath.get(pathname) ?? 1) - 1));
  };

  page.on("request", (request) => {
    const pathname = pathnameFromURL(request.url());
    const record: RequestRecord = {
      method: request.method(),
      pathname,
      resourceType: request.resourceType(),
      startedAt: Date.now(),
      url: request.url(),
    };
    requestStarts.set(request, record);
    requests.push(record);

    if (isAppApiPath(pathname)) {
      // 线上巡检关注的是同一路径风暴；跨路径并发是正常首屏加载，不作为失败信号。
      const nextInflight = (inflightByPath.get(pathname) ?? 0) + 1;
      inflightByPath.set(pathname, nextInflight);
      maxConcurrentByPath.set(pathname, Math.max(maxConcurrentByPath.get(pathname) ?? 0, nextInflight));
    }
  });

  page.on("response", (response) => {
    const request = response.request();
    const started = requestStarts.get(request);
    const pathname = started?.pathname ?? pathnameFromURL(response.url());
    decrementInflight(pathname);
    if (!started) return;
    responses.push(recordResponseTiming(started, request.timing(), response.status()));
  });

  page.on("requestfailed", (request) => {
    const started = requestStarts.get(request);
    const pathname = started?.pathname ?? pathnameFromURL(request.url());
    const startedAt = started?.startedAt ?? Date.now();
    decrementInflight(pathname);
    requestFailures.push({
      ...(started ?? {
        method: request.method(),
        pathname,
        resourceType: request.resourceType(),
        startedAt,
        url: request.url(),
      }),
      durationMs: Date.now() - startedAt,
      errorText: request.failure()?.errorText ?? "unknown",
    });
  });

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ at: Date.now(), type: message.type(), text: message.text() });
    }
  });

  page.on("pageerror", (error) => {
    pageErrors.push({ message: error.message, stack: error.stack });
  });

  const summary = () => {
    const apiResponses = responses.filter((record) => isAppApiPath(record.pathname));
    const apiCounts = new Map<string, number>();
    for (const record of apiResponses) {
      const key = `${record.method} ${record.pathname} ${record.status}`;
      apiCounts.set(key, (apiCounts.get(key) ?? 0) + 1);
    }

    const apiRequestFailures = requestFailures.filter((record) => isAppApiPath(record.pathname));

    return {
      apiCounts: Object.fromEntries(apiCounts),
      consoleMessages,
      maxConcurrentByPath: Object.fromEntries(maxConcurrentByPath),
      navigationAbortedApiRequests: apiRequestFailures.filter(isExpectedNavigationAbort),
      pageErrors,
      requestFailures: apiRequestFailures.filter(isBlockingRequestFailure),
      slowApiResponses: apiResponses.filter((record) => record.durationMs >= 5_000),
      unexpectedApiResponses: apiResponses.filter((record) => record.status >= 400),
    };
  };

  return {
    consoleMessages,
    maxConcurrentByPath,
    pageErrors,
    requestFailures,
    requests,
    responses,
    summary,
  };
}

export type NetworkMonitor = ReturnType<typeof createNetworkMonitor>;

export async function attachNetworkSummary(testInfo: TestInfo, monitor: NetworkMonitor) {
  await testInfo.attach("network-summary.json", {
    body: JSON.stringify(monitor.summary(), null, 2),
    contentType: "application/json",
  });
}

export function expectNoBlockingNetworkIssues(
  monitor: NetworkMonitor,
  label: string,
  options: NetworkAssertionOptions = {},
) {
  const ownApiFailures = monitor.requestFailures
    .filter((record) => isAppApiPath(record.pathname))
    .filter(isBlockingRequestFailure)
    .map((record) => `${record.method} ${record.pathname}: ${record.errorText}`);
  expect(ownApiFailures, `${label}: own API request failures`).toEqual([]);

  const unexpectedApiResponses = monitor.responses
    .filter((record) => isAppApiPath(record.pathname))
    .filter((record) => record.status >= 400)
    .filter((record) => !options.allowApiError?.(record))
    .map(formatResponse);
  expect(unexpectedApiResponses, `${label}: unexpected own API errors`).toEqual([]);

  expect(
    monitor.pageErrors.map((error) => error.stack ?? error.message),
    `${label}: unhandled page errors`,
  ).toEqual([]);

  const allowedResourceErrors = getAllowedBrowserResourceErrors(monitor, options);
  const unexpectedConsoleMessages = monitor.consoleMessages
    .filter((message) => {
      if (message.type !== "error") return true;
      if ((options.allowConsoleError ?? []).some((pattern) => pattern.test(message.text))) return false;
      return !consumeAllowedBrowserResourceError(message, allowedResourceErrors);
    })
    .map((message) => `${message.type}: ${message.text}`);
  expect(unexpectedConsoleMessages, `${label}: unexpected console warnings or errors`).toEqual([]);
}

type AllowedBrowserResourceError = {
  at: number;
  status: number;
};

function getAllowedBrowserResourceErrors(
  monitor: NetworkMonitor,
  options: NetworkAssertionOptions,
): AllowedBrowserResourceError[] {
  const errors: AllowedBrowserResourceError[] = [];
  for (const record of monitor.responses) {
    if (!isAppApiPath(record.pathname)) continue;
    if (record.status < 400 || !options.allowApiError?.(record)) continue;
    errors.push({ at: record.startedAt + record.durationMs, status: record.status });
  }
  return errors;
}

function consumeAllowedBrowserResourceError(
  message: ConsoleRecord,
  allowedErrors: AllowedBrowserResourceError[],
): boolean {
  // Chromium 会把 fetch 得到的 401/404 同步记成通用 resource console error；只有 spec 已声明该 API 状态可预期时才抵消。
  const match = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(message.text);
  if (!match) return false;
  const status = Number(match[1]);
  const matchedIndex = allowedErrors.findIndex((error) =>
    error.status === status && Math.abs(message.at - error.at) <= 5_000,
  );
  if (matchedIndex < 0) return false;
  allowedErrors.splice(matchedIndex, 1);
  return true;
}

export function expectNoConcurrentCoreRequests(monitor: SettledRequests, label: string) {
  // 线上巡检把“同页并发核心 API”当质量门；它直接暴露 session/settings/subscriptions 风暴，而不是普通请求计数。
  const maxConcurrentByPath = calculateEffectiveMaxConcurrentByPath(monitor);
  const duplicated = coreApiPaths.flatMap((pathname) =>
    (maxConcurrentByPath.get(pathname) ?? 0) > 1
      ? [`${pathname} concurrent=${maxConcurrentByPath.get(pathname)}`]
      : [],
  );
  expect(duplicated, `${label}: duplicated concurrent core requests`).toEqual([]);
}

export function expectNoRepeatedSessionWithin(monitor: NetworkMonitor, label: string, windowMs = 60_000) {
  // 60 秒窗口对应前端 session staleTime；切 tab/切页不应绕开 single-flight 重新校验同一 token。
  const sessionRequests = effectiveSettledRequests(monitor)
    .filter((record) => record.method === "GET" && record.pathname === "/api/app/auth/session")
    .sort((left, right) => left.startedAt - right.startedAt);
  const repeatedWindows = sessionRequests.flatMap((record, index) => {
    const countInWindow = sessionRequests
      .slice(index)
      .filter((candidate) => candidate.startedAt - record.startedAt <= windowMs)
      .length;
    return countInWindow > 1 ? [`${countInWindow} session requests within ${windowMs}ms`] : [];
  });
  expect(repeatedWindows, `${label}: session should not refetch repeatedly inside stale window`).toEqual([]);
}

type SettledRequestRecord = RequestRecord & { durationMs: number };
type SettledRequests = Pick<NetworkMonitor, "responses" | "requestFailures">;

function effectiveSettledRequests(monitor: SettledRequests): SettledRequestRecord[] {
  const records = [
    ...monitor.responses,
    ...monitor.requestFailures.filter(isBlockingRequestFailure),
  ].filter((record) => isAppApiPath(record.pathname));
  // 缓存静态资源可没有 timing；API 门禁不能用缺失计时证明无并发，也不能换回 Node 时钟凑出区间。
  for (const record of records) {
    if (!Number.isFinite(record.startedAt) || record.startedAt <= 0 ||
        !Number.isFinite(record.durationMs) || record.durationMs < 0) {
      throw new Error(`Missing browser response timing: ${record.method} ${record.pathname}`);
    }
  }
  return records;
}

function calculateEffectiveMaxConcurrentByPath(monitor: SettledRequests): Map<string, number> {
  const eventsByPath = new Map<string, Array<{ at: number; delta: 1 | -1 }>>();
  for (const record of effectiveSettledRequests(monitor)) {
    const events = eventsByPath.get(record.pathname) ?? [];
    events.push({ at: record.startedAt, delta: 1 });
    events.push({ at: record.startedAt + record.durationMs, delta: -1 });
    eventsByPath.set(record.pathname, events);
  }

  const maxConcurrentByPath = new Map<string, number>();
  for (const [pathname, events] of eventsByPath.entries()) {
    let current = 0;
    let max = 0;
    for (const event of events.sort((left, right) => left.at - right.at || left.delta - right.delta)) {
      current += event.delta;
      max = Math.max(max, current);
    }
    maxConcurrentByPath.set(pathname, max);
  }
  return maxConcurrentByPath;
}

export function expectNoNotificationSideEffects(monitor: NetworkMonitor, label: string) {
  const notificationWrites = monitor.requests
    .filter((record) => record.method === "POST")
    .filter((record) => record.pathname === "/api/app/notifications/test" || record.pathname === "/api/app/notifications/run")
    .map((record) => `${record.method} ${record.pathname}`);
  expect(notificationWrites, `${label}: notification test/run must not be triggered`).toEqual([]);
}

export function expectNoSettingsWrites(monitor: NetworkMonitor, label: string) {
  const settingsWrites = monitor.requests
    .filter((record) => ["PATCH", "POST", "PUT", "DELETE"].includes(record.method))
    .filter((record) => record.pathname === "/api/app/settings" || record.pathname === "/api/app/custom-config")
    .map((record) => `${record.method} ${record.pathname}`);
  expect(settingsWrites, `${label}: settings/custom-config should stay read-only`).toEqual([]);
}

export function expectNoAdminWrites(monitor: NetworkMonitor, label: string) {
  const adminWrites = monitor.requests
    .filter((record) => ["PATCH", "POST", "PUT", "DELETE"].includes(record.method))
    .filter((record) => record.pathname === "/api/app/admin/users" || record.pathname.startsWith("/api/app/admin/users/"))
    .map((record) => `${record.method} ${record.pathname}`);
  expect(adminWrites, `${label}: admin users check should stay read-only`).toEqual([]);
}
