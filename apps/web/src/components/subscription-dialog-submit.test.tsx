import { ApiError } from "@/lib/api-client";
// 订阅弹窗提交测试保护上传中禁止保存、标签 pending 文本提交和一次性购买字段清理。
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import { createSubscriptionFormState } from "@/types/subscription-form";
import { preloadSubscriptionDialog, SubscriptionDialog } from "./subscription-dialog";

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: [{ id: "productivity", value: "productivity", labels: { "zh-CN": "效率工具", "en-US": "Productivity" } }],
      statuses: [{ id: "active", value: "active", labels: { "zh-CN": "活跃", "en-US": "Active" } }],
      paymentMethods: [{ id: "alipay", value: "alipay", labels: { "zh-CN": "支付宝", "en-US": "Alipay" } }],
      currencies: [
        { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
        { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
      ],
    },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { defaultCurrency: "USD" },
  }),
}));

vi.mock("@/components/subscription-form-fields", () => ({
  SubscriptionFormFields: ({ setFormData, errors }: {
    setFormData: (updater: ReturnType<typeof createSubscriptionFormState>) => void;
    errors?: Record<string, string> | undefined;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          setFormData(createSubscriptionFormState({
            name: "Aws",
            price: "15",
            currency: "USD",
            startDate: assertDateOnly("2026-05-14"),
            nextBillingDate: assertDateOnly("2026-06-14"),
            tags: [],
          }))
        }
      >
        填充有效订阅
      </button>
      <button
        type="button"
        onClick={() =>
          setFormData(createSubscriptionFormState({
            name: "Free uptime check",
            price: "0",
            currency: "USD",
            startDate: assertDateOnly("2026-05-14"),
            nextBillingDate: assertDateOnly("2026-06-14"),
            tags: [],
          }))
        }
      >
        填充零元订阅
      </button>
      <button
        type="button"
        onClick={() =>
          setFormData(createSubscriptionFormState({
            name: "Aws",
            price: "15",
            currency: "USD",
            startDate: assertDateOnly("2026-05-14"),
            nextBillingDate: assertDateOnly("2026-06-14"),
            website: "ftp://example.com",
          }))
        }
      >
        填充非法网站订阅
      </button>
      <button
        type="button"
        onClick={() =>
          setFormData(createSubscriptionFormState({
            name: "QQ Music",
            price: "18",
            currency: "USD",
            startDate: undefined,
            nextBillingDate: assertDateOnly("2026-08-01"),
            autoCalculate: false,
          }))
        }
      >
        填充未知开始日期订阅
      </button>
      <button
        type="button"
        onClick={() =>
          setFormData(createSubscriptionFormState({
            name: "Auto Date",
            price: "18",
            currency: "USD",
            startDate: undefined,
            nextBillingDate: assertDateOnly("2026-08-01"),
            autoCalculate: true,
          }))
        }
      >
        填充缺少自动计算开始日期订阅
      </button>
      {errors?.["dates"] ? <p role="alert">{errors["dates"]}</p> : null}
      {errors?.["website"] ? <p role="alert">{errors["website"]}</p> : null}
    </>
  ),
}));

beforeAll(async () => {
  await preloadSubscriptionDialog();
});

describe("SubscriptionDialog submit", () => {
  it("submits an empty tags array when the create form tags input is blank", () => {
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "填充有效订阅" }));
    fireEvent.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Aws",
      tags: [],
    }));
  });

  it("shows a field error for invalid website URLs", () => {
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "填充非法网站订阅" }));
    fireEvent.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(screen.getByRole("alert")).toHaveTextContent("网站地址必须使用 http:// 或 https://");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits zero-price subscriptions", () => {
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "填充零元订阅" }));
    fireEvent.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Free uptime check",
      price: "0",
    }));
  });

  it("submits manual recurring subscriptions without a start date", () => {
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "填充未知开始日期订阅" }));
    fireEvent.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "QQ Music",
      startDate: null,
      nextBillingDate: "2026-08-01",
      autoCalculateNextBillingDate: false,
    }));
  });

  it("blocks automatic date calculation when the start date is missing", () => {
    const onSubmit = vi.fn();

    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDialog
          loadingPreview={null}
          mode="create"
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "填充缺少自动计算开始日期订阅" }));
    fireEvent.click(screen.getByRole("button", { name: "添加订阅" }));

    expect(screen.getByRole("alert")).toHaveTextContent("开启自动计算时需要开始日期");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

it("waits for save, blocks duplicate submit and closing, then preserves inputs on failure", async () => {
  let rejectSave: ((reason: Error) => void) | undefined;
  const onSubmit = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
  const onOpenChange = vi.fn();
  render(<TooltipProvider><SubscriptionDialog mode="create" open loadingPreview={null} onSubmit={onSubmit} onOpenChange={onOpenChange} /></TooltipProvider>);
  fireEvent.click(screen.getByRole("button", { name: "填充有效订阅" }));
  const submit = screen.getByRole("button", { name: "添加订阅" });
  const form = submit.closest("form");
  if (!form) throw new Error("missing form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(submit).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
  expect(onOpenChange).not.toHaveBeenCalled();
  await act(async () => { rejectSave?.(new ApiError("Connection lost", 0, undefined, "network")); });
  expect(screen.getByRole("alert")).toHaveTextContent("未能确认保存结果");
  expect(submit).toBeEnabled();
  onSubmit.mockImplementationOnce(async () => undefined);
  fireEvent.click(submit);
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Aws", price: "15" }));
});
