// 俄文页面冒烟测试：真实 catalog 下主要入口渲染俄文，且 DOM 中不出现原始 message id。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MESSAGE_KEYS } from "@/i18n/catalog-keys";
import { loadLocaleCatalog } from "@/i18n/messages";
import NotFound from "./not-found";
import SetupPage from "./setup";

const mocks = vi.hoisted(() => ({
  useSetupStatus: vi.fn(),
  useSession: vi.fn(),
  useSystemVersion: vi.fn(),
  useSystemUpdate: vi.fn(),
  useSystemUpdateStatus: vi.fn(),
  useSystemRestart: vi.fn(),
}));

vi.mock("@/hooks/use-setup-status", () => ({ useSetupStatus: mocks.useSetupStatus }));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/report-client-error", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession: mocks.useSession, signOut: vi.fn() } }));
vi.mock("@/hooks/use-system-version", () => ({
  useSystemVersion: mocks.useSystemVersion,
  useSystemUpdate: mocks.useSystemUpdate,
  useSystemUpdateStatus: mocks.useSystemUpdateStatus,
  useSystemRestart: mocks.useSystemRestart,
}));
vi.mock("@/lib/theme-provider", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/lib/theme-storage", () => ({ writeAppearancePendingToStorage: vi.fn() }));

function renderInApp(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function expectNoRawMessageIds(container: HTMLElement) {
  const text = [
    container.textContent ?? "",
    ...Array.from(container.querySelectorAll("[aria-label],[placeholder],[title]")).flatMap((element) => [
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("placeholder") ?? "",
      element.getAttribute("title") ?? "",
    ]),
  ].join("\n");
  expect(MESSAGE_KEYS.filter((key) => text.includes(key))).toEqual([]);
}

beforeAll(async () => {
  await loadLocaleCatalog("ru-RU");
});

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["ru-RU"] });
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "ru-RU" });
  mocks.useSetupStatus.mockReturnValue({
    setupRequired: true,
    setupEnabled: true,
    demoMode: false,
    turnstile: { enabled: false, siteKey: "" },
    isLoading: false,
  });
  mocks.useSession.mockReturnValue({
    data: {
      session: { expiresAt: "2026-12-31T00:00:00.000Z" },
      user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "admin", banned: false },
    },
    isPending: false,
  });
  mocks.useSystemVersion.mockReturnValue({ data: undefined, isPending: false, isError: false, isFetching: false, refetch: vi.fn() });
  mocks.useSystemUpdate.mockReturnValue({ isPending: false, isSuccess: false, mutateAsync: vi.fn(), reset: vi.fn(), data: undefined });
  mocks.useSystemUpdateStatus.mockReturnValue({ data: { operation: null } });
  mocks.useSystemRestart.mockReturnValue({ isPending: false, mutateAsync: vi.fn(), reset: vi.fn() });
});

describe("Russian UI pages", () => {
  it("renders the first-run setup page in Russian", () => {
    const { container } = renderInApp(<SetupPage />);

    expect(screen.getByLabelText("Пароль")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expectNoRawMessageIds(container);
  });

  it("renders the 404 page in Russian", () => {
    const { container } = renderInApp(<NotFound />);

    expect(screen.getByText("Страница не найдена")).toBeInTheDocument();
    expectNoRawMessageIds(container);
  });

  it("renders the main navigation in Russian", () => {
    const { container } = renderInApp(<Header />);

    for (const label of ["Обзор", "Подписки", "Статистика", "Календарь", "Настройки"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expectNoRawMessageIds(container);
  });
});
