import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromApiSubscriptionCollectionItem, subscriptionService, type SubscriptionListFilters } from "@/services/subscription-service";
import { SubscriptionBulkVisibilityToolbar } from "./subscription-bulk-visibility-toolbar";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(), success: vi.fn(), error: vi.fn(), busy: vi.fn(),
}));
vi.mock("@/services/subscription-public-visibility-service", () => ({ bulkPublicVisibility: mocks.apply }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const subscriptions = Array.from({ length: 3 }, (_, index) => fromApiSubscriptionCollectionItem({
  id: `sub-${index}`, name: `Service ${index}`, price: "10", currency: "USD", billingCycle: "monthly",
  category: "productivity", status: "active", pinned: false, publicHidden: false,
  startDate: "2026-01-01", nextBillingDate: "2026-10-01", autoRenew: false, autoCalculateNextBillingDate: true,
  reminderDays: 3,
}));
const ids = subscriptions.map((item) => item.id);

function setup(initialIds: string[] = [], total = 3) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let changeSelection: (nextIds: string[]) => void = () => undefined;
  function Harness({ filters }: { filters?: SubscriptionListFilters | undefined }) {
    const [selectedIds, setSelectedIds] = useState(new Set(initialIds));
    changeSelection = (nextIds) => setSelectedIds(new Set(nextIds));
    return <QueryClientProvider client={client}>
      <SubscriptionBulkVisibilityToolbar
        key={JSON.stringify(filters)} subscriptions={subscriptions.slice(0, 2)} filters={filters} total={total}
        selectedIds={selectedIds} onSelectionChange={setSelectedIds} onBusyChange={mocks.busy}
      />
      <output data-testid="selection">{[...selectedIds].join(",")}</output>
    </QueryClientProvider>;
  }
  const view = render(<Harness />);
  return {
    ...view,
    changeFilters: (filters: SubscriptionListFilters) => view.rerender(<Harness filters={filters} />),
    changeSelection: (nextIds: string[]) => act(() => changeSelection(nextIds)),
  };
}

async function confirmHide() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "从公开页隐藏" }));
  const dialog = screen.getByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "从公开页隐藏" }));
}

beforeEach(() => {
  mocks.apply.mockReset().mockResolvedValue({ matchedCount: 2, changedCount: 2, skippedCount: 0, failedIds: [] });
});

describe("SubscriptionBulkVisibilityToolbar", () => {
  it("keeps visibility commands at the same emphasis and names the confirmed action", async () => {
    setup(ids.slice(0, 2));
    const user = userEvent.setup();
    const hide = screen.getByRole("button", { name: "从公开页隐藏" });
    const show = screen.getByRole("button", { name: "在公开页展示" });
    expect(hide).toHaveClass("border-input");
    expect(show).toHaveClass("border-input");
    expect(hide).not.toHaveAttribute("aria-pressed");
    expect(show).not.toHaveAttribute("aria-pressed");
    expect(hide.parentElement).toHaveClass("grid", "sm:flex");

    await user.click(hide);
    let dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "从公开页隐藏" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(mocks.apply).not.toHaveBeenCalled();

    await user.click(show);
    dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "在公开页展示" })).toBeVisible();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("keeps the selection summary compact and hides the floating actions without a selection", () => {
    setup();
    const summary = screen.getByTestId("public-visibility-selection-summary");
    expect(summary).toBeVisible();
    expect(within(summary).getByText("全选", { exact: true })).toBeVisible();
    expect(within(summary).getByRole("checkbox", { name: "全选所有匹配订阅" })).not.toBeChecked();
    expect(within(summary).getByRole("button", { name: "清空选择" })).toBeDisabled();
    expect(summary.querySelector("svg")).toBeNull();
    expect(summary).not.toHaveTextContent("已选择");
    expect(screen.queryByTestId("public-visibility-bulk-dock")).not.toBeInTheDocument();
  });

  it("shows the selection count only in the dock when part of the page is selected", () => {
    setup([ids[0]!]);
    expect(screen.getByTestId("public-visibility-bulk-dock")).toBeVisible();
    const dock = screen.getByRole("toolbar", { name: "批量管理公开可见性" });
    expect(screen.getAllByText("已选择 1 条")).toHaveLength(1);
    const summary = screen.getByTestId("public-visibility-selection-summary");
    expect(within(summary).getByRole("checkbox", { name: "全选所有匹配订阅" })).toBePartiallyChecked();
    expect(within(summary).getByRole("button", { name: "清空选择" })).toBeEnabled();
    expect(summary).not.toHaveTextContent("已选择");
    expect(screen.getByTestId("public-visibility-bulk-dock-container")).toHaveClass("fixed", "inset-x-0", "justify-center");
    expect(screen.getByTestId("public-visibility-bulk-dock")).toHaveClass("w-full", "max-w-2xl");
    expect(dock).toContainElement(within(dock).getByRole("button", { name: "清空选择" }));
  });

  it("keeps loaded-page selection tri-state while preserving selected IDs from other pages", async () => {
    const user = userEvent.setup();
    setup([ids[0]!, ids[2]!], 2);
    const checkbox = screen.getByRole("checkbox", { name: "全选所有匹配订阅" });
    expect(checkbox).toBePartiallyChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByTestId("selection").textContent?.split(",")).toEqual(expect.arrayContaining(ids));
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByTestId("selection")).toHaveTextContent(ids[2]!);
  });

  it("uses one shared index request only after explicit cross-page selection", async () => {
    const user = userEvent.setup();
    const index = vi.spyOn(subscriptionService, "index").mockResolvedValue({ subscriptions, total: 3 });
    setup();
    expect(index).not.toHaveBeenCalled();
    const summary = screen.getByTestId("public-visibility-selection-summary");
    await user.click(within(summary).getByText("全选", { exact: true }));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(ids.join(",")));
    expect(index).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal));
    expect(within(summary).getByRole("checkbox", { name: "全选所有匹配订阅" })).toBeChecked();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("selects all matching subscriptions in one action and returns to an indeterminate state after deselection", async () => {
    const index = vi.spyOn(subscriptionService, "index").mockResolvedValue({ subscriptions, total: 3 });
    const view = setup([], 3);
    const selectPage = screen.getByRole("checkbox", { name: "全选所有匹配订阅" });
    await userEvent.setup().click(screen.getByText("全选", { exact: true }));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(ids.join(",")));
    expect(index).toHaveBeenCalledOnce();
    view.changeSelection([ids[0]!, ids[2]!]);
    expect(selectPage).toBePartiallyChecked();
    expect(screen.getByTestId("selection").textContent).toBe([ids[0], ids[2]].join(","));
  });

  it("keeps clear next to page selection and disables it in place after clearing", async () => {
    setup(ids.slice(0, 2));
    const summary = screen.getByTestId("public-visibility-selection-summary");
    const checkbox = within(summary).getByRole("checkbox", { name: "全选所有匹配订阅" });
    const clear = within(summary).getByRole("button", { name: "清空选择" });
    expect(clear.parentElement).toBe(checkbox.parentElement);
    await userEvent.setup().click(clear);
    expect(within(summary).getByRole("button", { name: "清空选择" })).toBe(clear);
    expect(clear).toBeDisabled();
    expect(checkbox).not.toBeChecked();
    expect(screen.getByTestId("selection")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("public-visibility-bulk-dock")).not.toBeInTheDocument();
  });

  it("ignores an old all-matching response after filters change", async () => {
    let resolveResponse: (value: { subscriptions: typeof subscriptions; total: number }) => void = () => undefined;
    const response = new Promise<{ subscriptions: typeof subscriptions; total: number }>((resolve) => { resolveResponse = resolve; });
    vi.spyOn(subscriptionService, "index").mockReturnValue(response);
    const view = setup(ids.slice(0, 2));
    await userEvent.setup().click(screen.getByText("全选", { exact: true }));
    view.changeFilters({ publicHidden: true });
    view.changeSelection([]);
    await act(async () => resolveResponse({ subscriptions, total: 3 }));
    expect(screen.getByTestId("selection")).toBeEmptyDOMElement();
    expect(mocks.busy).toHaveBeenLastCalledWith(false);
  });

  it("retains failed IDs for retry after a partial result", async () => {
    mocks.apply.mockResolvedValue({ matchedCount: 2, changedCount: 1, skippedCount: 0, failedIds: [ids[1]] });
    setup(ids.slice(0, 2));
    await confirmHide();
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(ids[1]!));
    expect(screen.getByTestId("selection")).not.toHaveTextContent(ids[0]!);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith({ selection: { ids: ids.slice(0, 2) }, publicHidden: true, dryRun: false }, expect.anything());
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("1 条失败"));
    mocks.apply.mockResolvedValue({ matchedCount: 1, changedCount: 1, skippedCount: 0, failedIds: [] });
    await confirmHide();
    await waitFor(() => expect(screen.getByTestId("selection")).toBeEmptyDOMElement());
    expect(mocks.apply).toHaveBeenLastCalledWith({ selection: { ids: [ids[1]] }, publicHidden: true, dryRun: false }, expect.anything());
    expect(screen.queryByTestId("public-visibility-bulk-dock")).not.toBeInTheDocument();
  });

  it("keeps the selection and confirmation available on request failure", async () => {
    mocks.apply.mockRejectedValue(new Error("request failed"));
    setup(ids.slice(0, 2));
    await confirmHide();
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(screen.getByTestId("selection")).toHaveTextContent(ids.slice(0, 2).join(","));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    mocks.apply.mockResolvedValue({ matchedCount: 2, changedCount: 2, skippedCount: 0, failedIds: [] });
    await userEvent.setup().click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "从公开页隐藏" }));
    await waitFor(() => expect(screen.getByTestId("selection")).toBeEmptyDOMElement());
    expect(screen.queryByTestId("public-visibility-bulk-dock")).not.toBeInTheDocument();
  });

  it("reports an idempotent result while keeping the selection available", async () => {
    mocks.apply.mockResolvedValue({ matchedCount: 2, changedCount: 0, skippedCount: 2, failedIds: [] });
    setup(ids.slice(0, 2));
    await confirmHide();
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("所选订阅已是目标可见性，无需修改"));
    expect(screen.getByTestId("selection")).toHaveTextContent(ids.slice(0, 2).join(","));
  });
});
