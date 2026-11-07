import { describe, expect, it } from "vitest";
import { restartCostSharingMemberDates, type CostSharing } from "./cost-sharing";
import type { DateOnly } from "./runtime";

const sharing: CostSharing = { enabled: true, splitMode: "custom", collectionReminder: { enabled: true, reminderDays: 3 }, members: [
  { id: "old", name: "Old member", joinedDate: "2026-01-31" as DateOnly, currency: "JPY", customAmount: "0", note: "keep" },
  { id: "inside", name: "Inside", joinedDate: "2026-11-10" as DateOnly, customAmount: "2" },
  { id: "after", name: "After", joinedDate: "2027-01-01" as DateOnly, customAmount: "3" },
  { id: "inherited", name: "Inherited", customAmount: "4" },
] };
describe("restart member date confirmation", () => {
  const updates = [{ id: "old", joinedDate: "2026-11-07" }, { id: "after", joinedDate: "2026-12-07" }];
  it("preserves member facts and inherited dates and accepts inclusive boundaries without mutating the source", () => {
    const before = structuredClone(sharing);
    const result = restartCostSharingMemberDates(sharing, updates, "2026-11-07", "2026-12-07");
    expect(result).toEqual({ ...sharing, members: sharing.members.map(member => ({ ...member, ...(updates.find(u => u.id === member.id) ?? {}) })) });
    expect(sharing).toEqual(before);
  });
  it("rejects missing, duplicate, unknown, malformed and out-of-range resolutions", () => {
    for (const invalid of [[], updates.slice(0, 1), [...updates, updates[0]!], [...updates, { id: "other", joinedDate: "2026-11-07" }],
      [{ id: "old", joinedDate: "2026-11-06" }, updates[1]!], [{ id: "old", joinedDate: "2026-12-08" }, updates[1]!],
      [{ id: "old", joinedDate: "2026-02-30" }, updates[1]!]]) {
      expect(() => restartCostSharingMemberDates(sharing, invalid, "2026-11-07", "2026-12-07")).toThrow("SUBSCRIPTION_RENEW_COST_SHARING_INVALID");
    }
    expect(() => restartCostSharingMemberDates(undefined, updates, "2026-11-07", "2026-12-07")).toThrow();
    expect(() => restartCostSharingMemberDates({ ...sharing, enabled: false }, updates, "2026-11-07", "2026-12-07")).toThrow();
    expect(restartCostSharingMemberDates(undefined, [], "2026-11-07", "2026-12-07")).toBeUndefined();
  });
});
