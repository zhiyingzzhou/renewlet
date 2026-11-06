import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import type { SubscriptionFormState } from "@/types/subscription-form";
import { aiDraftToSubscriptionFormState } from "@/modules/ai-recognition/domain/ai-recognition-form";
import { getAIDraftBlockingIssues } from "@/modules/ai-recognition/domain/ai-draft-preflight";
import { configuredSettings, makeDraft } from "../ai-recognize-subscription-dialog.test-utils";
import { AIDraftEditorPanel } from "./ai-draft-editor-panel";

const currencyManagerOrderConfig: CustomConfig = {
  ...DEFAULT_CUSTOM_CONFIG,
  currencies: [
    { id: "PHP", value: "PHP", labels: { "zh-CN": "₱ 菲律宾比索 (PHP)", "en-US": "₱ Philippine Peso (PHP)" }, enabled: true },
    { id: "AED", value: "AED", labels: { "zh-CN": "AED 阿联酋迪拉姆", "en-US": "AED United Arab Emirates Dirham" }, enabled: true },
    { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
    { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
    { id: "EUR", value: "EUR", labels: { "zh-CN": "€ 欧元 (EUR)", "en-US": "€ Euro (EUR)" }, enabled: true },
  ],
};

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
});

function EditorHarness({ config = currencyManagerOrderConfig, statusMissing = false }: { config?: CustomConfig; statusMissing?: boolean }) {
  const sourceDraft = makeDraft({ currency: "CNY", status: statusMissing ? null : "active" });
  const settings = configuredSettings();
  const [formData, setFormData] = useState<SubscriptionFormState>(() => (
    aiDraftToSubscriptionFormState(sourceDraft, { settings })
  ));
  return (
    <AIDraftEditorPanel
      draftId="ai-draft-1"
      sourceDraft={sourceDraft}
      formData={formData}
      draftNumber={1}
      config={config}
      settings={settings}
      blockingIssues={statusMissing ? getAIDraftBlockingIssues({
        formData,
        pendingConfirmationFields: ["status"],
      }) : []}
      setFormData={setFormData}
      onFieldChange={vi.fn()}
      onConfirmField={vi.fn()}
      onRemove={vi.fn()}
    />
  );
}

function getCurrencyOptionTexts(): string[] {
  const listbox = screen.getByRole("listbox");
  return Array.from(listbox.querySelectorAll<HTMLElement>("[cmdk-item]"))
    .map((item) => item.textContent ?? "");
}

describe("AIDraftEditorPanel", () => {
  it("uses the currency manager order for the draft currency selector", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider delayDuration={0}><EditorHarness /></TooltipProvider>);

    await user.click(screen.getByRole("combobox", { name: /选择货币|Select currency/ }));

    const optionTexts = getCurrencyOptionTexts();
    expect(optionTexts.map((text) => text.match(/PHP|AED|USD|CNY|EUR/)?.[0])).toEqual(["PHP", "AED", "USD", "CNY", "EUR"]);
  });

  it("edits the single controlled form state without a draft mirror", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider delayDuration={0}><EditorHarness /></TooltipProvider>);

    const nameInput = screen.getByLabelText("服务名称");
    await user.clear(nameInput);
    await user.type(nameInput, "Apple One Family");
    await user.click(screen.getByRole("switch", { name: "自动续订" }));
    await user.click(screen.getByRole("switch", { name: "从公开页隐藏" }));

    expect(nameInput).toHaveValue("Apple One Family");
    expect(screen.getByRole("switch", { name: "自动续订" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "从公开页隐藏" })).toBeChecked();
  });

  it("makes an unconfirmed status actionable from the blocking summary", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider delayDuration={0}><EditorHarness statusMissing /></TooltipProvider>);

    expect(screen.getByText("状态待确认")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认当前状态" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "状态" }));
  });
});
