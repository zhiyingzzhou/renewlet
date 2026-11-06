import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { DeferredRenewSubscriptionDialog } from "./renew-subscription-dialog-loader";

vi.mock("@/components/renew-subscription-dialog", () => { throw new Error("module offline"); });
vi.mock("@/i18n/I18nProvider", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it("keeps a module load failure inside a closable dialog with retry", async () => {
  const close = vi.fn();
  render(<DeferredRenewSubscriptionDialog subscription={null} loadingPreview={null} open today={assertDateOnly("2026-11-06")} submitting={false} onSubmit={vi.fn()} onOpenChange={close} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("subscription.renew.loadFailed");
  expect(screen.getByRole("button", { name: "system.retry" })).toBeEnabled();
  await userEvent.setup().click(screen.getByRole("button", { name: "common.close" }));
  expect(close).toHaveBeenCalledWith(false);
});
