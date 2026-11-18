import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarEventList } from "./calendar-event-list";

afterEach(() => vi.restoreAllMocks());

describe("calendar long lists", () => {
  it("keeps small lists in normal document order", () => {
    render(<CalendarEventList count={3} estimatedItemSize={64} testId="events"
      getItemKey={String} renderItem={(index) => <button>{`Event ${index}`}</button>} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Event 0", "Event 1", "Event 2"]);
  });

  it("bounds mounted rows and retains keyboard navigation after scrolling away", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 320, this.hasAttribute("data-index") ? 64 : 400);
    });
    render(<div data-testid="scroll" style={{ height: 400, overflowY: "auto" }}>
      <CalendarEventList count={1000} estimatedItemSize={64} testId="events"
        getItemKey={String} renderItem={(index) => <button>{`Event ${index}`}</button>} />
    </div>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Event 0" })).toBeInTheDocument());
    expect(screen.getAllByRole("button").length).toBeLessThan(40);
    const first = screen.getByRole("button", { name: "Event 0" });
    act(() => first.focus());
    fireEvent.scroll(screen.getByTestId("scroll"), { target: { scrollTop: 32_000 } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Event 500" })).toBeInTheDocument());
    expect(first).toHaveFocus();
    expect(screen.getAllByRole("button").length).toBeLessThan(40);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Event 1" })).toHaveFocus();
  });
});
