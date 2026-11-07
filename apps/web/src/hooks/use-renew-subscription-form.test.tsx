import { act, renderHook } from "@testing-library/react";
import { createRef, type FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useRenewSubscriptionForm } from "./use-renew-subscription-form";
import { assertDateOnly } from "@/lib/time/date-only";
import { ApiError } from "@/lib/api-client";
import type { Subscription } from "@/types/subscription";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";

vi.mock("@/i18n/I18nProvider", () => ({ useI18n: () => ({ t: (key: string) => key, formatCurrency: String, formatDateOnly: String }) }));
const source: Subscription = { id: "renew", updatedAt: "2026-11-06T15:09:08.957Z", name: "Netflix", price: "10", currency: "USD",
  logo: undefined, paymentMethod: undefined, trialEndDate: undefined, website: undefined, notes: undefined,
  billingCycle: "monthly", category: "entertainment", status: "active", pinned: false, publicHidden: false,
  startDate: assertDateOnly("2026-01-01"), nextBillingDate: assertDateOnly("2027-01-01"), autoRenew: false, autoCalculateNextBillingDate: false,
  reminderDays: -1, repeatReminderEnabled: false, repeatReminderInterval: "1h", repeatReminderWindow: "72h", tags: [], extra: {},
  costSharing: { enabled: true, splitMode: "equal", members: [
    { id: "old", name: "Alice", joinedDate: assertDateOnly("2026-01-31") },
    { id: "inside", name: "Bob", joinedDate: assertDateOnly("2026-11-10") },
    { id: "late", name: "Carol", joinedDate: assertDateOnly("2027-01-01") },
    { id: "inherited", name: "Dan" },
  ] },
};
const event = { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
function setup() {
  const onSubmit = vi.fn<(payload: SubscriptionRenewBody) => Promise<void>>().mockResolvedValue(undefined);
  const onRefresh = vi.fn<() => Promise<Subscription | null>>().mockResolvedValue(source);
  const props = { subscription: source, today: assertDateOnly("2026-11-07"), submitting: false, currencyOptions: [],
    formRef: createRef<HTMLFormElement>(), onSubmit, onRefresh };
  return { ...renderHook(p => useRenewSubscriptionForm(p), { initialProps: props }), onSubmit, onRefresh, props };
}
describe("restart member date session", () => {
  it("proposes only out-of-range dates, preserves edits across modes and sends no member changes in continue mode", async () => {
    const { result, onSubmit } = setup();
    expect(result.current.memberDates).toEqual([]);
    act(() => result.current.switchMode("restart"));
    expect(result.current.memberDates.map(({ id, joinedDate }) => ({ id, joinedDate }))).toEqual([
      { id: "old", joinedDate: "2026-11-07" }, { id: "late", joinedDate: "2026-11-07" },
    ]);
    act(() => result.current.setMemberDate("old", assertDateOnly("2026-11-20")));
    act(() => result.current.switchMode("continue"));
    await act(() => result.current.submit(event));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("costSharingMemberJoinedDates");
    act(() => result.current.switchMode("restart"));
    await act(() => result.current.submit(event));
    expect(onSubmit.mock.calls[1]?.[0]).toMatchObject({ costSharingMemberJoinedDates: [
      { id: "old", joinedDate: "2026-11-20" }, { id: "late", joinedDate: "2026-11-07" },
    ] });
    expect(source.costSharing?.members[0]?.joinedDate).toBe("2026-01-31");
  });
  it("updates untouched suggestions but keeps edited dates for field validation when the range moves", async () => {
    const { result, onSubmit } = setup();
    act(() => result.current.switchMode("restart"));
    act(() => result.current.setMemberDate("old", assertDateOnly("2026-11-20")));
    act(() => result.current.handleRestartStartDateChange(assertDateOnly("2026-12-01")));
    expect(result.current.memberDates.find(m => m.id === "old")).toMatchObject({ joinedDate: "2026-11-20", invalid: true });
    expect(result.current.memberDates.find(m => m.id === "inside")).toMatchObject({ joinedDate: "2026-12-01", invalid: false });
    await act(() => result.current.submit(event));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(result.current.memberDateErrors.has("old")).toBe(true);
    act(() => result.current.switchMode("continue"));
    expect(result.current.memberDateErrors.size).toBe(0);
    await act(() => result.current.submit(event));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
  it("preserves drafts on failed save, background refresh, timezone changes and explicit conflict refresh", async () => {
    const { result, rerender, props, onSubmit, onRefresh } = setup();
    act(() => result.current.switchMode("restart"));
    act(() => result.current.setMemberDate("old", assertDateOnly("2026-11-20")));
    onSubmit.mockRejectedValueOnce(new ApiError("conflict", 409, undefined, "SUBSCRIPTION_RENEW_CONFLICT"));
    await act(() => result.current.submit(event));
    expect(result.current.recoveryRequired).toBe(true);
    const latest = { ...source, price: "25", updatedAt: "2026-11-07T15:09:08.957Z" };
    rerender({ ...props, subscription: latest, today: assertDateOnly("2026-11-08") });
    expect(result.current.source?.price).toBe("10");
    onRefresh.mockResolvedValueOnce(latest);
    await act(() => result.current.refresh());
    expect(result.current.source?.price).toBe("25");
    expect(result.current.currentForm?.price).toBe("10");
    expect(result.current.memberDates.find(m => m.id === "old")?.joinedDate).toBe("2026-11-20");
    await act(() => result.current.submit(event));
    expect(onSubmit.mock.calls.at(-1)?.[0]).toMatchObject({ expectedUpdatedAt: latest.updatedAt, costSharingMemberJoinedDates: [
      { id: "old", joinedDate: "2026-11-20" }, { id: "late", joinedDate: "2026-11-07" },
    ] });
  });
  it("refreshes member identities explicitly and resets drafts when reopened", async () => {
    const { result, onRefresh, onSubmit, unmount } = setup();
    act(() => result.current.switchMode("restart"));
    act(() => result.current.setMemberDate("old", assertDateOnly("2026-11-20")));
    onRefresh.mockResolvedValueOnce({ ...source, costSharing: { ...source.costSharing!, members: source.costSharing!.members.filter(m => m.id !== "old") } });
    await act(() => result.current.refresh());
    expect(result.current.memberDates.map(m => m.id)).toEqual(["late"]);
    await act(() => result.current.submit(event));
    expect(onSubmit.mock.calls[0]?.[0].costSharingMemberJoinedDates).toEqual([{ id: "late", joinedDate: "2026-11-07" }]);
    unmount();
    const reopened = setup();
    expect(reopened.result.current.currentForm?.mode).toBe("continue");
    act(() => reopened.result.current.switchMode("restart"));
    expect(reopened.result.current.memberDates.find(m => m.id === "old")?.joinedDate).toBe("2026-11-07");
  });
});
