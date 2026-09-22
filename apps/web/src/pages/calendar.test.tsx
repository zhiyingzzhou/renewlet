import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import Calendar from "./calendar";

const mocks = vi.hoisted(() => ({
  useSubscriptionCalendar: vi.fn(),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useSubscriptionCalendar: mocks.useSubscriptionCalendar,
  useSubscriptionFacets: () => ({
    data: { total: 0, categoryCounts: {}, tags: [], visibleCount: 0, hiddenCount: 0, expiredCount: 0, lifetimeCount: 0 },
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: () => ({
    editingSubscription: null,
    editDialogOpen: false,
    editDetailPending: false,
    handleAddSubscription: vi.fn(),
    handleEditSubscription: vi.fn(),
    handleSaveSubscription: vi.fn(),
    handleEditDialogOpenChange: vi.fn(),
  }),
}));

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/components/subscription-calendar", () => ({
  SubscriptionCalendar: () => <div data-testid="subscription-calendar" />,
}));

vi.mock("@/components/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: () => null,
}));

function mockMatchMedia(matchesByQuery: Record<string, boolean>) {
  // 日历页是否启用按钮依赖媒体查询；jsdom 需要显式 mock 才能覆盖 H5/桌面两个分支。
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchesByQuery[query] ?? false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function setScrollMetrics(element: HTMLElement) {
  // jsdom 不会根据 DOM 内容计算滚动高度，手动补齐滚动指标才能触发按钮的阈值逻辑。
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 800 });
  element.scrollTop = 420;
}

function renderCalendarPage({ mobile }: { mobile: boolean }) {
  mockMatchMedia({
    "(max-width: 639px)": mobile,
    "(prefers-reduced-motion: reduce)": false,
  });
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  setScrollMetrics(root);

  render(
    <TooltipProvider delayDuration={0}>
      <Calendar />
    </TooltipProvider>,
    { container: root },
  );

  return root;
}

describe("Calendar page", () => {
  beforeEach(() => {
    mocks.useSubscriptionCalendar.mockReturnValue({
      data: [],
      error: null,
      isFetching: false,
      isPending: false,
    });
  });

  it("renders a page-isomorphic skeleton while subscriptions are pending", () => {
    mocks.useSubscriptionCalendar.mockReturnValue({
      data: undefined,
      isPending: true,
    });

    renderCalendarPage({ mobile: false });

    const skeleton = screen.getByTestId("calendar-skeleton");
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(skeleton.querySelectorAll(".grid-cols-7 .animate-pulse")).toHaveLength(49);
    expect(screen.queryByTestId("subscription-calendar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a recoverable error instead of an empty calendar", () => {
    const refetch = vi.fn();
    mocks.useSubscriptionCalendar.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error(),
      refetch,
    });

    renderCalendarPage({ mobile: false });

    expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请稍后重试");
    expect(screen.queryByTestId("subscription-calendar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the calendar mounted and marks background month loading as busy", () => {
    mocks.useSubscriptionCalendar.mockReturnValue({
      data: [],
      error: null,
      isFetching: true,
      isPending: false,
      isPlaceholderData: true,
    });

    renderCalendarPage({ mobile: false });

    expect(screen.getByTestId("subscription-calendar")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-skeleton")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  });

  it("keeps resolved calendar data visible after a background refresh error", () => {
    mocks.useSubscriptionCalendar.mockReturnValue({
      data: [],
      error: new Error(),
      isFetching: false,
      isPending: false,
    });

    renderCalendarPage({ mobile: false });

    expect(screen.getByTestId("subscription-calendar")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
  });

  it("shows the back-to-top float button on H5 calendar pages", async () => {
    const root = renderCalendarPage({ mobile: true });

    fireEvent.scroll(root);

    expect(await screen.findByRole("button", { name: "回到顶部" })).toBeInTheDocument();
  });

  it("does not show the back-to-top float button on desktop calendar pages", async () => {
    const root = renderCalendarPage({ mobile: false });

    fireEvent.scroll(root);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();
    });
  });
});
