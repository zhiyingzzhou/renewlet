import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { activateLoadedLocale, loadLocaleCatalog } from "@/i18n/messages";
import { createFetchGuard } from "./fetch-guard";

const fetchGuard = createFetchGuard();
// 默认禁止单测访问外网；局部 stub/spy 还原后也必须回到守卫，不能恢复真实 fetch。
globalThis.fetch = fetchGuard.fetch;

const [zhCNMessages] = await Promise.all([
  loadLocaleCatalog("zh-CN"),
  loadLocaleCatalog("en-US"),
]);
activateLoadedLocale("zh-CN", zhCNMessages);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom 没有真实浏览器 storage；补内存实现让 auth/theme/i18n 测试保持和浏览器同一 API 形状。
class MemoryStorageMock implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

function installStorage(name: "localStorage" | "sessionStorage") {
  // 这里不用 vi.stubGlobal，也不读取 Node 25 的内建 storage getter；前者会被 vi.unstubAllGlobals() 还原，后者会打印无效路径 warning。
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: new MemoryStorageMock(),
  });
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function rejectUnexpectedConsoleCall(level: "warn" | "error") {
  return (...values: unknown[]): never => {
    throw new Error(`Unexpected console.${level}: ${values.map(formatConsoleValue).join(" ")}`);
  };
}

// 组件库依赖 ResizeObserver/scrollIntoView，但单测只验证 React 状态和可访问输出，不需要真实布局引擎。
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
installStorage("localStorage");
installStorage("sessionStorage");
Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["zh-CN"] });
Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "zh-CN" });
Element.prototype.scrollIntoView = vi.fn();
// Vaul 依赖浏览器 Pointer Events 的 capture API；jsdom 未实现，测试环境只需要保留同一事件 API 边界。
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = vi.fn();
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = vi.fn();
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["zh-CN"] });
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "zh-CN" });
  activateLoadedLocale("zh-CN", zhCNMessages);
  document.documentElement.lang = "zh-CN";
  // 预期故障日志必须由对应测试局部接管并断言；其余 React、Radix 或业务告警都属于回归。
  vi.spyOn(console, "warn").mockImplementation(rejectUnexpectedConsoleCall("warn"));
  vi.spyOn(console, "error").mockImplementation(rejectUnexpectedConsoleCall("error"));
});

afterEach(async () => {
  cleanup();
  // Radix FocusScope卸载后用零延时timer恢复焦点；必须在当前jsdom和断言环境仍存活时完成，不能丢弃或带入下一用例。
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
  installStorage("localStorage");
  installStorage("sessionStorage");
  localStorage.clear();
  sessionStorage.clear();
  fetchGuard.assertNoRequests();
});
