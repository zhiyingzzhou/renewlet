import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  createRenewSubscriptionLoadingSlots,
  RenewSubscriptionScaffold,
} from "@/components/renew-subscription-scaffold";
import {
  createSubscriptionCalendarLoadingSlots,
  SubscriptionCalendarScaffold,
} from "@/components/subscription-calendar-scaffold";
import {
  createSubscriptionDetailLoadingSlots,
  SubscriptionDetailScaffold,
} from "@/components/subscription-detail-scaffold";
import {
  createSubscriptionFormLoadingSlots,
  SubscriptionFormScaffold,
  type SubscriptionFormLoadingStructure,
} from "@/components/subscription-form-scaffold";

function regionOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-dialog-region]"))
    .map((region) => region.dataset["dialogRegion"] ?? "");
}

function expectDetailFrameContract(container: HTMLElement): {
  footer: HTMLElement;
  frame: HTMLElement;
  scrollBody: HTMLElement;
} {
  const frame = container.firstElementChild;
  const scrollBody = container.querySelector<HTMLElement>("[data-subscription-dialog-scroll]");
  const footer = container.querySelector<HTMLElement>("[data-subscription-dialog-footer]");
  if (!(frame instanceof HTMLElement) || !scrollBody || !footer) {
    throw new Error("Missing subscription detail frame regions");
  }

  expect(frame).toHaveClass(
    "grid",
    "min-h-0",
    "flex-1",
    "grid-rows-[minmax(0,1fr)_auto]",
    "overflow-hidden",
  );
  expect(scrollBody).toHaveClass("h5-mobile-sheet-scroll");
  expect(footer.tagName).toBe("FOOTER");
  expect(frame.children).toHaveLength(2);
  expect(scrollBody.parentElement).toBe(frame);
  expect(scrollBody.nextElementSibling).toBe(footer);
  expect(footer.parentElement).toBe(frame);
  expect(container.querySelector('[data-dialog-region="subscription-actions"]')).toBe(footer);
  expect(scrollBody).not.toContainElement(footer);

  return { footer, frame, scrollBody };
}

describe("subscription dialog scaffolds", () => {
  it("keeps form loading and resolved regions in the same order", () => {
    const resolved = render(
      <SubscriptionFormScaffold fields="fields" actions="actions" />,
    );
    expect(regionOrder(resolved.container)).toEqual(["subscription-fields", "subscription-actions"]);
    resolved.unmount();

    const loadingSlots = createSubscriptionFormLoadingSlots({
      label: "加载中",
      structure: { cycle: "custom", balanceEnabled: false, reminderEnabled: true, repeatReminderEnabled: false },
    });
    const loading = render(<SubscriptionFormScaffold {...loadingSlots} />);
    expect(regionOrder(loading.container)).toEqual(["subscription-fields", "subscription-actions"]);
  });

  it("selects distinct form skeleton leaves for custom, buyout, and fixed-term cycles", () => {
    const skeletonCount = (structure: SubscriptionFormLoadingStructure) => {
      const loadingSlots = createSubscriptionFormLoadingSlots({
        label: "加载中",
        structure,
      });
      const rendered = render(<SubscriptionFormScaffold {...loadingSlots} />);
      const count = rendered.container.querySelectorAll(".animate-pulse").length;
      rendered.unmount();
      return count;
    };

    const recurring = skeletonCount({
      cycle: "recurring",
      balanceEnabled: false, reminderEnabled: true,
      repeatReminderEnabled: false,
    });
    const custom = skeletonCount({
      cycle: "custom",
      balanceEnabled: false, reminderEnabled: true,
      repeatReminderEnabled: false,
    });
    const buyout = skeletonCount({
      cycle: "one-time-buyout",
      balanceEnabled: false, reminderEnabled: true,
      repeatReminderEnabled: false,
    });
    const fixedTerm = skeletonCount({
      cycle: "one-time-fixed-term",
      balanceEnabled: false, reminderEnabled: true,
      repeatReminderEnabled: false,
    });

    expect(custom).toBeGreaterThan(recurring);
    expect(fixedTerm).toBeGreaterThan(buyout);
  });

  it("keeps renewal loading and resolved regions in the same order for continue and restart", () => {
    const resolved = render(
      <Dialog open>
        <DialogContent>
          <RenewSubscriptionScaffold
            heading="续订"
            description="续订说明"
            mode="mode"
            pricing="pricing"
            schedule="schedule"
            actions="actions"
          />
        </DialogContent>
      </Dialog>,
    );
    expect(regionOrder(resolved.baseElement)).toEqual(["renewal-fields", "renewal-actions"]);
    resolved.unmount();

    const skeletonCounts: number[] = [];
    for (const restartMode of [false, true]) {
      const loadingSlots = createRenewSubscriptionLoadingSlots({ label: "加载中", restartMode });
      const loading = render(
        <Dialog open>
          <DialogContent>
            <RenewSubscriptionScaffold
              heading="续订"
              description="续订说明"
              {...loadingSlots}
            />
          </DialogContent>
        </Dialog>,
      );
      expect(regionOrder(loading.baseElement)).toEqual(["renewal-fields", "renewal-actions"]);
      skeletonCounts.push(loading.baseElement.querySelectorAll(".animate-pulse").length);
      loading.unmount();
    }
    expect(skeletonCounts[1] ?? 0).toBeGreaterThan(skeletonCounts[0] ?? 0);
  });

  it("keeps detail loading and resolved frames on the same body and footer contract", () => {
    const expected = ["subscription-summary", "subscription-facts", "subscription-actions"];
    const resolved = render(
      <SubscriptionDetailScaffold
        summary="summary"
        facts="facts"
        extensions="extensions"
        actions="actions"
      />,
    );
    expect(regionOrder(resolved.container)).toEqual(expected);
    expectDetailFrameContract(resolved.container);
    resolved.unmount();

    const loadingSlots = createSubscriptionDetailLoadingSlots({
      structure: {
        showCalendarAction: false,
        showBalance: false, showCostSharing: false,
        showDailyAverage: false,
        showNextBillingDate: false,
        showPaymentMethod: false,
        showStartDate: false,
        showTrialEndDate: false,
      },
      canEdit: true,
      canRenew: true,
      label: "加载中",
    });
    const loading = render(<SubscriptionDetailScaffold {...loadingSlots} />);
    expect(regionOrder(loading.container)).toEqual(expected);
    const loadingFrame = expectDetailFrameContract(loading.container);
    expect(loadingFrame.scrollBody).toContainElement(
      loading.container.querySelector('[data-dialog-region="subscription-summary"]'),
    );
    expect(loadingFrame.scrollBody).toContainElement(
      loading.container.querySelector('[data-dialog-region="subscription-facts"]'),
    );
  });

  it("adds detail leaves for family sharing and trial facts", () => {
    const minimalSlots = createSubscriptionDetailLoadingSlots({
      structure: {
        showCalendarAction: true,
        showBalance: false, showCostSharing: false,
        showDailyAverage: false,
        showNextBillingDate: true,
        showPaymentMethod: false,
        showStartDate: true,
        showTrialEndDate: false,
      },
      canEdit: false,
      canRenew: false,
      label: "加载中",
    });
    const richSlots = createSubscriptionDetailLoadingSlots({
      structure: {
        showCalendarAction: true,
        showBalance: false, showCostSharing: true,
        showDailyAverage: true,
        showNextBillingDate: true,
        showPaymentMethod: true,
        showStartDate: true,
        showTrialEndDate: true,
      },
      canEdit: false,
      canRenew: false,
      label: "加载中",
    });
    const minimal = render(<SubscriptionDetailScaffold {...minimalSlots} />);
    const minimalCount = minimal.container.querySelectorAll(".animate-pulse").length;
    minimal.unmount();
    const rich = render(<SubscriptionDetailScaffold {...richSlots} />);

    expect(rich.container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(minimalCount);
  });

  it("keeps calendar loading and resolved regions in the same order", () => {
    const expected = ["calendar-facts", "calendar-feed-actions", "calendar-one-time-actions", "calendar-providers"];
    const resolved = render(
      <SubscriptionCalendarScaffold
        facts="facts"
        syncHeading="sync heading"
        syncContent="sync content"
        oneTimeHeading="one-time heading"
        oneTimeActions="one-time actions"
        notice="notice"
        providerHeading="providers"
        providers="links"
      />,
    );
    expect(regionOrder(resolved.container)).toEqual(expected);
    resolved.unmount();

    const loadingSlots = createSubscriptionCalendarLoadingSlots("加载中");
    const loading = render(<SubscriptionCalendarScaffold {...loadingSlots} />);
    expect(regionOrder(loading.container)).toEqual(expected);
    const facts = loading.container.querySelector('[data-dialog-region="calendar-facts"]');
    expect(facts).toBeInstanceOf(HTMLDListElement);
    expect(Array.from(facts?.children ?? []).map((child) => child.tagName)).toEqual(["DIV", "DIV", "DIV"]);
    expect(facts?.querySelectorAll(":scope > div > dt")).toHaveLength(3);
    expect(facts?.querySelectorAll(":scope > div > dd")).toHaveLength(3);
  });
});
