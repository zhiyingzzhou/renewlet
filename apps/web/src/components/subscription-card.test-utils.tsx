import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { moneyToNumber } from "@renewlet/shared/money";
import { SubscriptionCard } from "./subscription-card";

export const originalWindowOpen = window.open;
export const mediaUtilitiesCss = readFileSync(join(process.cwd(), "src/styles/media-utilities.css"), "utf8");

type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;
type SubscriptionCardHandlers = {
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onClone?: (id: string) => void;
  onTogglePinned?: (id: string) => void;
  onTogglePublicHidden?: (id: string) => void;
  onViewDetails?: (id: string) => void;
  onAddToCalendar?: (id: string) => void;
  onPrefetchDetails?: (id: string) => void;
  onSelect?: (id: string, selected: boolean) => void;
};
type SubscriptionCardRenderOptions = {
  viewMode?: "grid" | "list";
  selectionMode?: boolean;
  selected?: boolean;
  currencyRatesReady?: boolean;
  priceReferenceCurrency?: string | null;
  currencyConvert?: (amount: number | string, fromCurrency: string, toCurrency: string) => number;
};
type SubscriptionCardTestMocks = {
  categories: Array<{
    color: string;
    id: string;
    labels: Record<"en-US" | "zh-CN", string>;
    value: string;
  }>;
  paymentMethods: Array<{
    icon: string;
    id: string;
    labels: Record<"en-US" | "zh-CN", string>;
    value: string;
  }>;
};

let subscriptionCardTestMocks: SubscriptionCardTestMocks | undefined;

export function setSubscriptionCardTestMocks(mocks: SubscriptionCardTestMocks) {
  subscriptionCardTestMocks = mocks;
}

function getSubscriptionCardTestMocks() {
  if (!subscriptionCardTestMocks) {
    throw new Error("SubscriptionCard test mocks must be initialized before rendering.");
  }
  return subscriptionCardTestMocks;
}

export const baseSubscription: Subscription = {
  id: "sub-1",
  name: "dmit",
  logo: undefined,
  price: "159",
  currency: "USD",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  oneTimeTermCount: undefined,
  oneTimeTermUnit: undefined,
  category: "developer-tools",
  status: "active",
  paymentMethod: undefined,
  startDate: assertDateOnly("2026-05-15"),
  nextBillingDate: assertDateOnly("2026-06-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: undefined,
  notes: undefined,
  tags: [],
  reminderDays: 7,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  pinned: false,
  publicHidden: false,
};

export function createSubscription(overrides: SubscriptionOverrides = {}): Subscription {
  return {
    ...baseSubscription,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

export function renderSubscriptionCard(
  overrides: SubscriptionOverrides = {},
  handlers: SubscriptionCardHandlers = {},
  options: SubscriptionCardRenderOptions = {},
) {
  const mocks = getSubscriptionCardTestMocks();
  return render(
    <TooltipProvider delayDuration={0}>
      <SubscriptionCard
        subscription={createSubscription(overrides)}
        {...(options.viewMode ? { viewMode: options.viewMode } : {})}
        today={assertDateOnly("2026-05-18")}
        inheritedReminderDays={5}
        currencyConvert={options.currencyConvert ?? ((amount, from, to) => {
          const value = moneyToNumber(amount);
          if (from === to) return value;
          if (from === "USD" && to === "CNY") return value * 7;
          if (from === "CNY" && to === "USD") return value / 7;
          return value;
        })}
        currencyRatesReady={options.currencyRatesReady ?? true}
        priceReferenceCurrency={options.priceReferenceCurrency ?? null}
        selectionMode={options.selectionMode ?? false}
        selected={options.selected ?? false}
        categoryByValue={new Map(mocks.categories.map((category) => [category.value, category]))}
        paymentMethodByValue={new Map(mocks.paymentMethods.map((method) => [method.value, method]))}
        onEdit={handlers.onEdit ?? vi.fn()}
        onDelete={handlers.onDelete ?? vi.fn()}
        onClone={handlers.onClone ?? vi.fn()}
        {...(handlers.onTogglePinned ? { onTogglePinned: handlers.onTogglePinned } : {})}
        {...(handlers.onTogglePublicHidden ? { onTogglePublicHidden: handlers.onTogglePublicHidden } : {})}
        {...(handlers.onViewDetails ? { onViewDetails: handlers.onViewDetails } : {})}
        {...(handlers.onSelect ? { onSelect: handlers.onSelect } : {})}
        onAddToCalendar={handlers.onAddToCalendar ?? vi.fn()}
        onPrefetchDetails={handlers.onPrefetchDetails ?? vi.fn()}
      />
    </TooltipProvider>,
  );
}

export function openMoreActionsMenu() {
  const menuButton = screen.getByRole("button", { name: "更多操作" });
  fireEvent.pointerDown(menuButton, { button: 0, ctrlKey: false });
  fireEvent.click(menuButton);
}

export function expectMetaFlowItemsInOrder(...texts: string[]) {
  const metaFlow = screen.getByTestId("subscription-card-meta-flow");
  const metaText = metaFlow.textContent ?? "";

  for (const text of texts) {
    expect(within(metaFlow).getByText(text)).toBeInTheDocument();
  }

  for (let index = 0; index < texts.length - 1; index += 1) {
    expect(metaText.indexOf(texts[index]!)).toBeLessThan(metaText.indexOf(texts[index + 1]!));
  }

  return metaFlow;
}

export function mockUserAgent(userAgent: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: userAgent });
  return () => {
    if (descriptor) {
      Object.defineProperty(window.navigator, "userAgent", descriptor);
    } else {
      Reflect.deleteProperty(window.navigator, "userAgent");
    }
  };
}
