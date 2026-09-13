import assert from "node:assert/strict";
import test from "node:test";
import { expectNoConcurrentCoreRequests, recordResponseTiming } from "../e2e/cloudflare-check/support/network";

const request = {
  method: "GET", pathname: "/api/app/settings", resourceType: "fetch",
  startedAt: 1_000, url: "http://localhost/api/app/settings",
};

test("delayed Node callbacks cannot turn sequential browser requests into concurrent requests", () => {
  // 时间差来自失败 trace：首条等待 37.126ms，第二条在 42ms 后开始；回调顺序不能改变此事实。
  const first = recordResponseTiming(request, { startTime: 2_000, responseStart: 37.126 }, 200);
  const second = recordResponseTiming(request, { startTime: 2_042, responseStart: 15.605 }, 200);
  assert.equal(first.startedAt, 2_000);
  assert.equal(first.durationMs, 37.126);
  assert.doesNotThrow(() => expectNoConcurrentCoreRequests({ responses: [second, first], requestFailures: [] }, "sequential"));
});

test("genuinely overlapping core responses still fail the unchanged concurrency budget", () => {
  const first = recordResponseTiming(request, { startTime: 2_000, responseStart: 50 }, 200);
  const second = recordResponseTiming(request, { startTime: 2_042, responseStart: 15.605 }, 200);
  assert.throws(() => expectNoConcurrentCoreRequests({ responses: [first, second], requestFailures: [] }, "overlap"), /concurrent=2/);
});

test("missing browser timings fail instead of falling back to a different clock", () => {
  for (const timing of [
    { startTime: 0, responseStart: 10 },
    { startTime: 2_000, responseStart: -1 },
    { startTime: Number.NaN, responseStart: 10 },
    { startTime: 2_000, responseStart: Number.POSITIVE_INFINITY },
  ]) {
    const response = recordResponseTiming(request, timing, 200);
    assert.equal(response.startedAt, timing.startTime);
    assert.equal(response.durationMs, timing.responseStart);
    assert.throws(() => expectNoConcurrentCoreRequests({ responses: [response], requestFailures: [] }, "missing"), /Missing browser response timing/);
  }
});

test("cached static resources retain unavailable timing without entering the API concurrency budget", () => {
  const response = recordResponseTiming({ ...request, pathname: "/node_modules/.vite/deps/react.js" }, { startTime: 0, responseStart: -1 }, 200);
  assert.equal(response.durationMs, -1);
  assert.doesNotThrow(() => expectNoConcurrentCoreRequests({ responses: [response], requestFailures: [] }, "static cache"));
});
