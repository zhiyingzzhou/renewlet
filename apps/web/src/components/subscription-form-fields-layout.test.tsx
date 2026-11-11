import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { assertDateOnly } from "@/lib/time/date-only";
import { createSubscriptionFormState, type SubscriptionFormState } from "@/types/subscription-form";
import { SubscriptionFormFields, type SubscriptionFormErrors } from "./subscription-form-fields";

const config = {
  categories: [{ id: "productivity", value: "productivity", labels: { "zh-CN": "效率工具", "en-US": "Productivity" } }],
  statuses: [{ id: "active", value: "active", labels: { "zh-CN": "活跃", "en-US": "Active" } }],
  paymentMethods: [{ id: "alipay", value: "alipay", labels: { "zh-CN": "支付宝", "en-US": "Alipay" } }],
  currencies: [
    { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
    { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
  ],
};

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
});

function Harness({
  errors,
  formOverrides = {},
}: {
  errors: SubscriptionFormErrors;
  formOverrides?: Partial<SubscriptionFormState>;
}) {
  const [formErrors, setFormErrors] = useState(errors);
  const [formData, setFormData] = useState(() => createSubscriptionFormState({
    currency: "CNY",
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    ...formOverrides,
  }));
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: formData.currency,
    locale: "zh-CN",
  });

  return (
    <TooltipProvider delayDuration={0}>
      <SubscriptionFormFields
        idPrefix=""
        config={config}
        formData={formData}
        setFormData={setFormData}
        currencyOptions={currencyOptions}
        balanceCurrencyOptions={currencyOptions}
        showLogoField={false}
        onLogoUploadStatusChange={vi.fn()}
        errors={formErrors}
        onClearFieldError={(field) => {
          setFormErrors((prev) => {
            if (!prev[field]) return prev;
            const next = { ...prev };
            delete next[field];
            return next;
          });
        }}
        notificationReminderDays={5}
      />
    </TooltipProvider>
  );
}

describe("SubscriptionFormFields layout", () => {
  it("renders price and currency errors at row level instead of inside one column", () => {
    render(<Harness errors={{ price: "请输入价格" }} />);

    const priceInput = screen.getByPlaceholderText("0.00");
    const priceField = priceInput.closest('[data-slot="form-field"]');
    const priceRow = priceInput.closest('[data-slot="form-field-row"]');
    const error = screen.getByRole("alert");

    expect(priceInput).toHaveAttribute("aria-describedby", "price-error");
    expect(error).toHaveAttribute("id", "price-error");
    expect(priceField).not.toContainElement(error);
    expect(priceRow).toContainElement(error);
    expect(priceRow).toHaveAttribute("data-align-at", "sm");
    expect(priceRow).toHaveAttribute("data-tracks", "2");
  });

  it("keeps start date before next billing date in the date row", () => {
    render(<Harness errors={{}} />);

    const startLabel = screen.getByText("开始日期（可选）");
    const nextLabel = screen.getByText("到期日期");

    expect(Boolean(startLabel.compareDocumentPosition(nextLabel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("renders missing next billing date errors in the shared date row", () => {
    render(<Harness
      errors={{ dates: "请选择到期日期" }}
      formOverrides={{ startDate: undefined, nextBillingDate: undefined }}
    />);

    const startDateButton = document.getElementById("startDate");
    const nextBillingDateButton = document.getElementById("nextBillingDate");
    const dateError = screen.getByRole("alert");
    const startDateField = startDateButton?.closest('[data-slot="form-field"]');
    const nextBillingDateField = nextBillingDateButton?.closest('[data-slot="form-field"]');

    expect(nextBillingDateButton).toHaveAttribute("aria-invalid", "true");
    expect(nextBillingDateButton).toHaveAttribute("aria-describedby", "nextBillingDate-error");
    expect(dateError).toHaveAttribute("id", "nextBillingDate-error");
    expect(nextBillingDateField).not.toContainElement(dateError);
    expect(nextBillingDateButton?.closest('[data-slot="form-field-row"]')).toContainElement(dateError);
    expect(startDateField).not.toContainElement(dateError);
  });

  it("associates auto-calculate start-date errors with the start date button", () => {
    render(<Harness
      errors={{ dates: "开启自动计算时需要开始日期" }}
      formOverrides={{ startDate: undefined, autoCalculate: true }}
    />);

    const startDateButton = document.getElementById("startDate");
    const nextBillingDateButton = document.getElementById("nextBillingDate");
    const dateError = screen.getByRole("alert");
    const startDateField = startDateButton?.closest('[data-slot="form-field"]');
    const nextBillingDateField = nextBillingDateButton?.closest('[data-slot="form-field"]');

    expect(startDateButton).toHaveAttribute("aria-invalid", "true");
    expect(startDateButton).toHaveAttribute("aria-describedby", "startDate-error");
    expect(nextBillingDateButton).toHaveAttribute("aria-invalid", "false");
    expect(dateError).toHaveAttribute("id", "startDate-error");
    expect(startDateField).not.toContainElement(dateError);
    expect(startDateButton?.closest('[data-slot="form-field-row"]')).toContainElement(dateError);
    expect(nextBillingDateField).not.toContainElement(dateError);
  });

  it("renders date-order errors in the shared date row", () => {
    render(<Harness
      errors={{ dates: "到期日期不能早于开始日期" }}
      formOverrides={{
        startDate: assertDateOnly("2026-02-01"),
        nextBillingDate: assertDateOnly("2026-01-01"),
      }}
    />);

    const nextBillingDateButton = document.getElementById("nextBillingDate");
    const dateError = screen.getByRole("alert");
    const nextBillingDateField = nextBillingDateButton?.closest('[data-slot="form-field"]');

    expect(nextBillingDateButton).toHaveAttribute("aria-invalid", "true");
    expect(nextBillingDateButton).toHaveAttribute("aria-describedby", "nextBillingDate-error");
    expect(dateError).toHaveAttribute("id", "nextBillingDate-error");
    expect(nextBillingDateField).not.toContainElement(dateError);
    expect(nextBillingDateButton?.closest('[data-slot="form-field-row"]')).toContainElement(dateError);
  });

  it("clears stale date errors when switching billing cycle shape", async () => {
    const user = userEvent.setup();
    render(<Harness
      errors={{
        dates: "请选择到期日期",
        price: "金额必须是 0 到 1,000,000,000 之间的有效数字",
      }}
      formOverrides={{ startDate: undefined, nextBillingDate: undefined }}
    />);

    await user.click(screen.getByRole("combobox", { name: "扣费周期" }));
    await user.click(await screen.findByRole("option", { name: "一次性购买" }));

    const purchaseDateButton = document.getElementById("startDate");
    expect(screen.queryByText("请选择到期日期")).not.toBeInTheDocument();
    expect(purchaseDateButton).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByText("金额必须是 0 到 1,000,000,000 之间的有效数字")).toBeInTheDocument();
  });

  it("clears one-time date and term errors when switching one-time mode", async () => {
    const user = userEvent.setup();
    render(<Harness
      errors={{
        dates: "请选择购买日期",
        oneTimeTerm: "请输入有效的服务时长",
      }}
      formOverrides={{
        billingCycle: "one-time",
        oneTimeMode: "term",
        startDate: undefined,
        nextBillingDate: undefined,
        oneTimeTermCount: "",
      }}
    />);

    expect(screen.getByText("请输入有效的服务时长")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "一次性购买类型" })).toHaveAttribute(
      "aria-labelledby",
      "oneTimeMode-label",
    );

    await user.click(screen.getByRole("button", { name: "长期有效" }));

    const purchaseDateButton = document.getElementById("startDate");
    expect(screen.queryByText("请选择购买日期")).not.toBeInTheDocument();
    expect(screen.queryByText("请输入有效的服务时长")).not.toBeInTheDocument();
    expect(purchaseDateButton).toHaveAttribute("aria-invalid", "false");
  });

  it("clears stale date errors when toggling automatic date calculation", async () => {
    const user = userEvent.setup();
    render(<Harness
      errors={{ dates: "请选择到期日期" }}
      formOverrides={{ startDate: undefined, nextBillingDate: undefined }}
    />);

    await user.click(screen.getByRole("switch", { name: "自动计算到期日" }));

    const startDateButton = document.getElementById("startDate");
    expect(screen.queryByText("请选择到期日期")).not.toBeInTheDocument();
    expect(startDateButton).toHaveAttribute("aria-invalid", "false");
  });
});

it("unmounts disabled balance fields, clears errors, and restores the same session draft", async () => {
  const user = userEvent.setup();
  render(<Harness errors={{ balance: "余额错误" }} formOverrides={{ balanceEnabled: true, balance: "0.000001", balanceCurrency: "USD" }} />);
  const toggle = screen.getByRole("switch", { name: "记录账户余额" });
  expect(screen.getByLabelText("账户余额")).toHaveValue("0.000001");
  await user.click(toggle);
  expect(screen.queryByLabelText("账户余额")).not.toBeInTheDocument();
  expect(screen.queryByText("余额错误")).not.toBeInTheDocument();
  await user.click(toggle);
  expect(screen.getByLabelText("账户余额")).toHaveValue("0.000001");
  expect(screen.getByLabelText("余额币种")).toHaveTextContent("USD");
  expect(toggle).toHaveFocus();
});
