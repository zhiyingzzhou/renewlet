import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import type { Subscription } from "@/types/subscription";
import Subscriptions from "./subscriptions";

type SubscriptionBaseFixture = Omit<
  Subscription,
  "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit"
>;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

export function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  const base: SubscriptionBaseFixture = {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "USD",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    pinned: false,
    publicHidden: false,
  };

  return {
    ...base,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

export function renderSubscriptionsPage(initialEntries: string[] = ["/subscriptions"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const renderResult = render(
    <div id="root" style={{ height: 800, overflowY: "auto" }}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <TooltipProvider delayDuration={0}>
            <Subscriptions />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </div>,
  );

  return {
    ...renderResult,
    queryClient,
    rerenderSubscriptionsPage: () => renderResult.rerender(
      <div id="root" style={{ height: 800, overflowY: "auto" }}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={initialEntries}>
            <TooltipProvider delayDuration={0}>
              <Subscriptions />
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </div>,
    ),
  };
}

export function visibleSubscriptionNames() {
  return screen.getAllByTestId("subscription-card").map((card) => card.firstChild?.textContent ?? "");
}

export function mockMobileTagFilterMatch(isMobile: boolean, width = isMobile ? 390 : 1280) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        query === "(max-width: 767px)"
          ? isMobile
          : query === "(min-width: 640px)"
            ? width >= 640
            : query === "(min-width: 1024px)"
              ? width >= 1024
              : false,
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

export function manySubscriptions(count: number) {
  return Array.from({ length: count }, (_, index) =>
    subscription({
      id: `service-${index.toString().padStart(3, "0")}`,
      name: `Service ${index.toString().padStart(3, "0")}`,
      price: String(index + 1),
    }),
  );
}

export function installPointerCaptureMocks() {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
  Element.prototype.scrollIntoView ??= vi.fn();
}
