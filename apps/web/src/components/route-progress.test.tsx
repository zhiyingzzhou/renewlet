import { act, fireEvent, render, screen } from "@testing-library/react";
import { lazy, StrictMode, Suspense, type ReactNode } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter } from "@/lib/router";
import Link from "./router-link";
import { RouteNavigationProvider, RouteProgress, useRouteReady } from "./route-progress";

vi.mock("@/lib/route-resources", () => ({ preloadRoute: vi.fn(async () => {}) }));

function Page({ pending = false }: { pending?: boolean }) {
  useRouteReady(pending);
  return <p>{pending ? "waiting" : "ready"}</p>;
}

function tree(children: ReactNode) {
  return (
    <StrictMode>
      <MemoryRouter>
        <RouteNavigationProvider>{children}</RouteNavigationProvider>
      </MemoryRouter>
    </StrictMode>
  );
}

function advance(milliseconds: number) {
  act(() => { vi.advanceTimersByTime(milliseconds); });
}

function progressValue() {
  const bar = screen.getByTestId("route-progress").querySelector<HTMLElement>("div");
  return Number(bar?.style.getPropertyValue("--route-progress"));
}

function ProgrammaticNavigation() {
  const router = useRouter();
  return <button onClick={() => router.replace("/settings")}>replace</button>;
}

describe("route progress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
      matches: false, media, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never flashes on a cached page or restarts for background work", () => {
    const view = render(tree(<><RouteProgress /><Page /></>));
    advance(1000);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
    view.rerender(tree(<><RouteProgress /><Page pending /></>));
    advance(1000);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delays visibility, advances below 90%, then completes without delaying content", () => {
    const view = render(tree(<><RouteProgress /><Page pending /></>));
    advance(149);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
    advance(1);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
    expect(progressValue()).toBe(0.08);
    advance(800);
    expect(progressValue()).toBeGreaterThan(0.08);
    expect(progressValue()).toBeLessThanOrEqual(0.9);
    view.rerender(tree(<><RouteProgress /><Page /></>));
    expect(screen.getByText("ready")).toBeInTheDocument();
    advance(0);
    expect(progressValue()).toBe(1);
    advance(200);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
    advance(200);
    expect(progressValue()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the minimum visible duration only for the indicator", () => {
    const view = render(tree(<><RouteProgress /><Page pending /></>));
    advance(150);
    view.rerender(tree(<><RouteProgress /><Page /></>));
    expect(screen.getByText("ready")).toBeInTheDocument();
    advance(249);
    expect(progressValue()).toBeLessThan(1);
    advance(1);
    expect(progressValue()).toBe(1);
  });

  it("does not let an old completion timer hide a new navigation", () => {
    const routes = (pending: boolean) => tree(<>
      <RouteProgress /><Link href="/settings">settings</Link>
      <Routes>
        <Route path="/" element={<Page pending={pending} />} />
        <Route path="/settings" element={<Page pending />} />
      </Routes>
    </>);
    const view = render(routes(true));
    advance(150);
    view.rerender(routes(false));
    fireEvent.click(screen.getByRole("link", { name: "settings" }));
    advance(1000);
    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
    expect(progressValue()).toBeLessThan(1);
  });

  it("finishes when the page commits its existing error UI", () => {
    function ErrorPage() {
      useRouteReady();
      return <p role="alert">request failed</p>;
    }
    const view = render(tree(<><RouteProgress /><Page pending /></>));
    advance(150);
    view.rerender(tree(<><RouteProgress /><ErrorPage /></>));
    expect(screen.getByRole("alert")).toHaveTextContent("request failed");
    advance(650);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops advancing at 90% and cleans up all timers on unmount", () => {
    const view = render(tree(<><RouteProgress /><Page pending /></>));
    advance(60_000);
    expect(progressValue()).toBe(0.9);
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up an active tick and the popstate listener when the app unmounts", () => {
    const removeListener = vi.spyOn(window, "removeEventListener");
    const view = render(tree(<><RouteProgress /><Page pending /></>));
    advance(150);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("popstate", expect.any(Function));
  });

  it("keeps progress when the skeleton header is replaced by the real header", () => {
    const view = render(tree(<><header key="skeleton"><RouteProgress /></header><Page pending /></>));
    advance(950);
    const value = progressValue();
    view.rerender(tree(<><header key="real"><RouteProgress /></header><Page pending /></>));
    expect(progressValue()).toBe(value);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
  });

  it("does not rerender page consumers on progress ticks", () => {
    const rendered = vi.fn();
    function Content() {
      rendered();
      useRouteReady(true);
      return <p>content</p>;
    }
    render(tree(<><RouteProgress /><Content /></>));
    const initialRenders = rendered.mock.calls.length;
    advance(2550);
    expect(progressValue()).toBeGreaterThan(0.08);
    expect(rendered).toHaveBeenCalledTimes(initialRenders);
  });

  it("does not schedule progress ticks for reduced motion", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
    render(tree(<><RouteProgress /><Page pending /></>));
    advance(150);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
    expect(screen.getByTestId("route-progress").firstElementChild).toHaveClass("motion-reduce:scale-x-100");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores hover, focus and touch preloads but follows an actual link navigation", () => {
    render(tree(<>
      <RouteProgress />
      <Link href="/settings">settings</Link>
      <Routes>
        <Route path="/" element={<Page />} />
        <Route path="/settings" element={<Page pending />} />
      </Routes>
    </>));
    const link = screen.getByRole("link", { name: "settings" });
    fireEvent.pointerEnter(link);
    fireEvent.focus(link);
    fireEvent.touchStart(link);
    advance(1000);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
    fireEvent.click(link);
    advance(150);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
  });

  it("does not start when an unsaved-changes guard intercepts the click", () => {
    render(tree(<><RouteProgress /><Page /><Link href="/settings">settings</Link></>));
    const intercept = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", intercept, true);
    try {
      fireEvent.click(screen.getByRole("link", { name: "settings" }));
      advance(1000);
      expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      document.removeEventListener("click", intercept, true);
    }
  });

  it("follows programmatic navigation and ignores completion from the previous route", () => {
    render(tree(<>
      <RouteProgress /><ProgrammaticNavigation />
      <Routes>
        <Route path="/" element={<Page />} />
        <Route path="/settings" element={<Page pending />} />
      </Routes>
    </>));
    fireEvent.click(screen.getByRole("button", { name: "replace" }));
    advance(150);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
    expect(screen.getByText("waiting")).toBeInTheDocument();
  });

  it("finishes redirected routes using the destination readiness", () => {
    render(tree(<>
      <RouteProgress />
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<Page />} />
      </Routes>
    </>));
    advance(1000);
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps loading after the lazy module resolves until its data is committed", async () => {
    let resolveModule: ((module: { default: typeof Page }) => void) | undefined;
    const module = new Promise<{ default: typeof Page }>((resolve) => { resolveModule = resolve; });
    const LazyPage = lazy(() => module);
    const view = render(tree(
      <Suspense fallback={<RouteProgress />}><RouteProgress /><LazyPage pending /></Suspense>,
    ));
    advance(150);
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
    await act(async () => {
      resolveModule?.({ default: Page });
      await module;
    });
    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-100");
    view.rerender(tree(
      <Suspense fallback={<RouteProgress />}><RouteProgress /><LazyPage /></Suspense>,
    ));
    advance(650);
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("route-progress")).toHaveClass("opacity-0");
  });
});
