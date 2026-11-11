import type { ReactNode } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { AiRecognizeResponse } from "@/lib/api/schemas/ai-recognition";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";
import {
  clipboardDataWithFiles,
  clipboardDataWithItems,
  configuredSettings,
  expectRecognizeStreamCalledWith,
  makeDraft,
  makePreview,
  makeResponse,
  mockMobile,
  renderDialog,
} from "./ai-recognize-subscription-dialog.test-utils";
const mocks = vi.hoisted(() => ({
  recognizeSubscriptionsStream: vi.fn(),
  previewPrepared: vi.fn(),
  resetImportPreview: vi.fn(),
  setError: vi.fn(),
  handleConflictModeChange: vi.fn(),
  handleLogoChange: vi.fn(),
  handleSkipChange: vi.fn(),
  handleApply: vi.fn(),
  importPreviewPanel: vi.fn(),
  previewState: {
    prepared: null as unknown,
    preview: null as unknown,
    error: null as string | null,
  },
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
  imageTargetBytes: vi.fn(),
  prepareAIRecognitionImage: vi.fn(),
}));

vi.mock("@/services/ai-recognition-service", () => ({
  aiRecognitionService: {
    recognizeSubscriptionsStream: mocks.recognizeSubscriptionsStream,
  },
}));

vi.mock("@/modules/ai-recognition/domain/ai-image-preprocess", () => ({
  AIRecognitionImagePreprocessError: class AIRecognitionImagePreprocessError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "AIRecognitionImagePreprocessError";
    }
  },
  aiRecognitionImageTargetBytes: mocks.imageTargetBytes,
  isAIRecognitionImageAbort: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError")),
  prepareAIRecognitionImage: mocks.prepareAIRecognitionImage,
}));

vi.mock("@/modules/import-export/application/use-import-preview-apply", () => ({
  useImportPreviewApply: () => ({
    prepared: mocks.previewState.prepared,
    preview: mocks.previewState.preview,
    conflictMode: "skip",
    previewFilter: "all",
    skippedIndexes: new Set<number>(),
    error: mocks.previewState.error,
    applying: false,
    assetProgress: null,
    applyProgress: null,
    setError: mocks.setError,
    setPreviewFilter: vi.fn(),
    resetImportPreview: mocks.resetImportPreview,
    previewPrepared: mocks.previewPrepared,
    handleConflictModeChange: mocks.handleConflictModeChange,
    handleLogoChange: mocks.handleLogoChange,
    handleSkipChange: mocks.handleSkipChange,
    handleApply: mocks.handleApply,
  }),
}));

vi.mock("@/components/import-preview-panel", () => ({
  ImportPreviewPanel: (props: { showImportOptions?: boolean }) => {
    mocks.importPreviewPanel(props);
    return <div data-testid="import-preview-panel" />;
  },
}));

vi.mock("@/components/ui/virtualized-list", () => ({
  VirtualizedList: ({
    count,
    renderItem,
    testId,
  }: {
    count: number;
    renderItem: (index: number, virtualItem: VirtualItem) => ReactNode;
    testId?: string;
  }) => (
    <div data-testid={testId}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          {renderItem(index, {
            index,
            key: index,
            start: index * 112,
            size: 112,
            end: (index + 1) * 112,
            lane: 0,
          })}
        </div>
      ))}
    </div>
  ),
}));

describe("AIRecognizeSubscriptionDialog", () => {
  beforeEach(() => {
    mocks.recognizeSubscriptionsStream.mockReset();
    mocks.previewPrepared.mockReset();
    mocks.resetImportPreview.mockReset();
    mocks.setError.mockReset();
    mocks.importPreviewPanel.mockReset();
    mocks.previewState.prepared = null;
    mocks.previewState.preview = null;
    mocks.previewState.error = null;
    mocks.createObjectURL.mockReset();
    mocks.revokeObjectURL.mockReset();
    mocks.imageTargetBytes.mockReset();
    mocks.imageTargetBytes.mockReturnValue(2 * 1024 * 1024);
    mocks.prepareAIRecognitionImage.mockReset();
    mocks.prepareAIRecognitionImage.mockImplementation(async (file: File) => ({
      file,
      originalSizeBytes: file.size,
      targetSizeBytes: 2 * 1024 * 1024,
      optimized: false,
      warning: null,
    }));
    mocks.setError.mockImplementation((error: string | null) => {
      mocks.previewState.error = error;
    });
    mocks.previewPrepared.mockImplementation(async (prepared: PreparedImport) => {
      mocks.previewState.prepared = prepared;
      mocks.previewState.preview = makePreview();
    });
    mocks.createObjectURL.mockImplementation((file: File) => `blob:${file.name}`);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: mocks.createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: mocks.revokeObjectURL,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("requires explicit controls to close the workflow dialog", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    const overlay = document.querySelector("[data-dialog-overlay]");
    if (!overlay) throw new Error("Dialog overlay was not rendered");
    await user.click(overlay);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("输入阶段不渲染草稿列表和导入预览", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog");
    const body = screen.getByTestId("ai-recognition-dialog-body");

    expect(screen.getByTestId("ai-recognition-input-tabs")).toBeInTheDocument();
    const dialogDescription = screen.getByText("使用已配置的 AI 模型生成可编辑订阅草稿，确认后再导入。");
    expect(dialogDescription).toHaveClass("sr-only");
    expect(dialogDescription).not.toHaveTextContent("粘贴备忘录");
    expect(dialogDescription).not.toHaveTextContent("上传图片");
    expect(screen.queryByRole("heading", { name: "文本内容" })).not.toBeInTheDocument();
    expect(screen.getByText("支持纯文本、CSV/TSV 和表格复制文本；.xlsx 文件请先复制内容。")).toBeInTheDocument();
    expect(dialog).toHaveClass("h5-ai-recognition-input-dialog-frame");
    expect(dialog).not.toHaveClass("h-fit");
    expect(body).toHaveClass("overflow-hidden");
    expect(body).not.toHaveClass("overflow-y-auto");
    expect(screen.queryByTestId("ai-draft-virtualized-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-preview-panel")).not.toBeInTheDocument();
  });

  it("H5 输入阶段使用近全屏工作台并固定紧凑头尾", () => {
    mockMobile();
    renderDialog();

    const dialog = screen.getByRole("dialog");
    const stepper = screen.getByTestId("ai-recognition-mobile-stepper");
    const footer = screen.getByTestId("ai-recognition-mobile-footer");
    const textarea = screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表...");

    expect(dialog).toHaveClass("h5-ai-recognition-workbench-frame");
    expect(dialog).not.toHaveClass("h5-ai-recognition-drawer");
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeInTheDocument();
    expect(stepper).toHaveTextContent("1/4");
    expect(stepper).toHaveTextContent("输入");
    expect(footer).toHaveClass("border-t", "pb-[calc(0.5rem+env(safe-area-inset-bottom))]");
    expect(within(footer).getByRole("button", { name: "生成订阅草稿" })).toHaveClass("h-11", "flex-1");
    expect(textarea).not.toHaveFocus();
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });

  it("H5 输入阶段使用紧凑设置面板并保留内部滚动主人", () => {
    mockMobile();
    renderDialog();

    const body = screen.getByTestId("ai-recognition-dialog-body");
    const runSettingsPanel = screen.getByTestId("ai-recognition-run-settings-panel");
    const inputTabs = screen.getByTestId("ai-recognition-input-tabs");
    const textPanel = screen.getByTestId("ai-recognition-text-panel");
    const textarea = screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表...");

    expect(body).toHaveClass("overflow-hidden");
    expect(runSettingsPanel).toHaveAttribute("data-layout", "mobile-bar");
    expect(inputTabs).toHaveAttribute("data-layout", "mobile-compact");
    expect(textPanel).toHaveClass("grid-rows-[minmax(10rem,1fr)_auto_auto]");
    expect(textarea).toHaveClass("h-full", "min-h-0", "resize-none");
  });

  it("H5 图片输入首屏保留大号上传入口并在有图后切到紧凑添加行", async () => {
    const user = userEvent.setup();
    const image = new File(["one"], "one.png", { type: "image/png" });
    mockMobile();
    renderDialog();

    const uploadButton = screen.getByTestId("ai-recognition-image-upload-button");
    expect(uploadButton).toHaveClass("min-h-48", "w-full");
    expect(screen.getByTestId("ai-recognition-image-scrollport")).toHaveClass("min-h-0", "overflow-y-auto");

    await user.upload(screen.getByLabelText("添加订阅图片"), image);
    expect(await screen.findByRole("button", { name: "预览图片 one.png" })).toBeInTheDocument();
    expect(screen.getByTestId("ai-recognition-image-upload-button")).toHaveClass("h-12", "w-full");
  });

  it("输入工作区同时展示文本和图片并保留图片约束", async () => {
    renderDialog();

    const imagePanel = screen.getByTestId("ai-recognition-image-panel");
    expect(screen.queryByRole("heading", { name: "上传订阅图片" })).not.toBeInTheDocument();
    expect(screen.getAllByText("点击、拖拽或粘贴添加 PNG、JPG、WebP 图片，最多 5 张。")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /添加图片/ })).toBeInTheDocument();
    expect(within(imagePanel).getByText("0/5 张图片")).toBeInTheDocument();
    expect(screen.queryByText(/已选择/)).not.toBeInTheDocument();
    expect(screen.queryByText("还没有选择图片。")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无图片")).not.toBeInTheDocument();
  });

  it("文本和图片输入区共用稳定内部滚动区域", async () => {
    const user = userEvent.setup();
    const firstImage = new File(["one"], "one.png", { type: "image/png" });
    const secondImage = new File(["two"], "two.png", { type: "image/png" });
    renderDialog();

    const body = screen.getByTestId("ai-recognition-dialog-body");
    const textarea = screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表...");
    await user.type(textarea, "apple 50刀 1年\nnetflix 10刀 1个月");

    expect(screen.getByTestId("ai-recognition-text-panel")).toHaveClass("grid-rows-[minmax(10rem,1fr)_auto_auto]");
    expect(textarea).toHaveClass("h-full", "min-h-0", "resize-none");
    expect(body).toHaveClass("overflow-hidden");

    expect(screen.getByTestId("ai-recognition-image-panel")).toHaveClass("min-h-0", "overflow-hidden");
    expect(screen.getByTestId("ai-recognition-image-scrollport")).toHaveClass("min-h-0", "overflow-y-auto");
    expect(screen.queryByTestId("ai-draft-virtualized-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-preview-panel")).not.toBeInTheDocument();

    await user.upload(screen.getByLabelText("添加订阅图片"), [firstImage, secondImage]);
    await screen.findByRole("button", { name: "预览图片 one.png" });
    expect(mocks.imageTargetBytes).toHaveBeenCalledWith(2);
    expect(within(screen.getByTestId("ai-recognition-image-panel")).getByRole("button", { name: /继续添加/ })).toBeInTheDocument();
    expect(within(screen.getByTestId("ai-recognition-image-panel")).getByText("2/5 张图片")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览图片 one.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览图片 two.png" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("h5-ai-recognition-input-dialog-frame");
  });

  it("输入工作区支持粘贴剪贴板图片并复用图片墙预览", async () => {
    const pastedImage = new File(["pasted"], "clipboard.png", { type: "image/png" });
    renderDialog();

    const pasteAccepted = fireEvent.paste(screen.getByTestId("ai-recognition-image-panel"), {
      clipboardData: clipboardDataWithItems([{ file: pastedImage }]),
    });

    expect(pasteAccepted).toBe(false);
    expect(await screen.findByRole("button", { name: "预览图片 clipboard.png" })).toBeInTheDocument();
    expect(mocks.createObjectURL).toHaveBeenCalledWith(pastedImage);
  });

  it("输入工作区粘贴可 fallback 到 clipboardData.files", async () => {
    const pastedImage = new File(["fallback"], "fallback.webp", { type: "image/webp" });
    renderDialog();

    fireEvent.paste(screen.getByTestId("ai-recognition-image-panel"), {
      clipboardData: clipboardDataWithFiles([pastedImage]),
    });

    expect(await screen.findByRole("button", { name: "预览图片 fallback.webp" })).toBeInTheDocument();
    expect(mocks.createObjectURL).toHaveBeenCalledWith(pastedImage);
  });

  it("粘贴多张图片时沿用现有数量上限和错误提示", async () => {
    const pastedImages = Array.from({ length: 6 }, (_, index) => (
      new File([`image-${index + 1}`], `image-${index + 1}.png`, { type: "image/png" })
    ));
    renderDialog();

    fireEvent.paste(screen.getByTestId("ai-recognition-image-panel"), {
      clipboardData: clipboardDataWithItems(pastedImages.map((file) => ({ file }))),
    });

    expect(await screen.findByRole("button", { name: "预览图片 image-1.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览图片 image-1.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览图片 image-5.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "预览图片 image-6.png" })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("ai-recognition-image-panel")).getByRole("button", { name: /已达上限/ })).toBeDisabled();
    expect(mocks.setError).toHaveBeenCalledWith("最多上传 5 张图片。");
  });

  it("文本和图片可以组合输入，非图片剪贴板内容不会触发图片上传", async () => {
    const image = new File(["pasted"], "clipboard.png", { type: "image/png" });
    const textFile = new File(["plain"], "note.txt", { type: "text/plain" });
    renderDialog();

    const textarea = screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表...");
    const imagePasteAccepted = fireEvent.paste(textarea, {
      clipboardData: clipboardDataWithItems([{ file: image }]),
    });
    expect(imagePasteAccepted).toBe(false);
    expect(await screen.findByRole("button", { name: "预览图片 clipboard.png" })).toBeInTheDocument();

    const textOnlyPasteAccepted = fireEvent.paste(screen.getByTestId("ai-recognition-image-panel"), {
      clipboardData: clipboardDataWithItems([{ file: textFile }]),
    });
    expect(textOnlyPasteAccepted).toBe(true);
  });

  it("提交时把同一工作区的文本和图片一起发送", async () => {
    const user = userEvent.setup();
    const image = new File(["receipt"], "receipt.png", { type: "image/png" });
    mocks.prepareAIRecognitionImage.mockResolvedValueOnce({
      file: image,
      originalSizeBytes: image.size,
      targetSizeBytes: image.size,
      optimized: false,
      warning: null,
    });
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.upload(screen.getByLabelText("添加订阅图片"), image);
    await screen.findByRole("button", { name: "预览图片 receipt.png" });
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await waitFor(() => expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(1));
    expectRecognizeStreamCalledWith(mocks.recognizeSubscriptionsStream.mock.calls, {
      text: "apple 50刀 1年",
      images: [image],
      thinkingControl: null,
    });
  });

  it("识别 loading 禁用状态下粘贴图片不会追加图片", async () => {
    const user = userEvent.setup();
    const firstImage = new File(["first"], "first.png", { type: "image/png" });
    const pastedImage = new File(["pasted"], "disabled.png", { type: "image/png" });
    let resolveRecognition: (response: AiRecognizeResponse) => void = () => undefined;
    mocks.recognizeSubscriptionsStream.mockReturnValue(new Promise<AiRecognizeResponse>((resolve) => {
      resolveRecognition = resolve;
    }));
    renderDialog();

    await user.upload(screen.getByLabelText("添加订阅图片"), firstImage);
    await screen.findByRole("button", { name: "预览图片 first.png" });
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));
    fireEvent.paste(screen.getByTestId("ai-recognition-image-panel"), {
      clipboardData: clipboardDataWithItems([{ file: pastedImage }]),
    });

    expect(screen.queryByRole("button", { name: "预览图片 disabled.png" })).not.toBeInTheDocument();
    expect(mocks.createObjectURL).toHaveBeenCalledTimes(1);

    resolveRecognition(makeResponse([makeDraft()]));
  });

  it("草稿阶段由内部工作区滚动，外层弹窗 body 不滚动", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await screen.findByText("Apple Music");
    const body = screen.getByTestId("ai-recognition-dialog-body");
    expect(body).toHaveClass("overflow-hidden");
    expect(body).not.toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("ai-draft-list-scrollport")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("ai-draft-editor-scrollport")).toHaveClass("lg:overflow-y-auto");
  });

  it("H5 草稿和预览阶段只保留必要返回动作和主动作", async () => {
    const user = userEvent.setup();
    mockMobile();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await screen.findByText("Apple Music");
    const footer = screen.getByTestId("ai-recognition-mobile-footer");
    expect(screen.getByTestId("ai-recognition-mobile-stepper")).toHaveTextContent("2/4");
    expect(screen.getByTestId("ai-recognition-mobile-stepper")).toHaveTextContent("草稿");
    expect(within(footer).getByRole("button", { name: "返回输入" })).toHaveClass("h-11", "flex-1");
    expect(within(footer).getByRole("button", { name: "生成导入预览" })).toHaveClass("h-11", "flex-1");

    await user.click(within(footer).getByRole("button", { name: "生成导入预览" }));

    expect(await screen.findByTestId("import-preview-panel")).toBeInTheDocument();
    expect(screen.getByTestId("ai-recognition-mobile-stepper")).toHaveTextContent("4/4");
    expect(screen.getByTestId("ai-recognition-mobile-stepper")).toHaveTextContent("执行");
    expect(within(footer).getByRole("button", { name: "返回草稿" })).toHaveClass("h-11", "flex-1");
    expect(within(footer).getByRole("button", { name: "确认添加" })).toHaveClass("h-11", "flex-1");
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });

  it("周期草稿缺少到期日期时在草稿阶段拦截导入预览", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([
      makeDraft({
        startDate: null,
        nextBillingDate: null,
        autoCalculateNextBillingDate: false,
      }),
    ]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    expect(await screen.findByText("1 条草稿还有 1 个必填项待补全，补全后才能生成导入预览。")).toBeInTheDocument();
    const startDateButton = document.getElementById("ai-draft-1-startDate");
    const nextBillingDateButton = document.getElementById("ai-draft-1-nextBillingDate");
    if (!(startDateButton instanceof HTMLButtonElement) || !(nextBillingDateButton instanceof HTMLButtonElement)) {
      throw new Error("AI draft date buttons were not rendered");
    }
    expect(startDateButton).toHaveAttribute("aria-invalid", "false");
    expect(nextBillingDateButton).toHaveAttribute("aria-invalid", "true");
    expect(nextBillingDateButton).toHaveAttribute("aria-describedby", "ai-draft-1-nextBillingDate-error");
    expect(nextBillingDateButton.closest('[data-slot="form-field-row"]')).toHaveTextContent("请选择到期日期");
    expect(nextBillingDateButton.closest('[data-slot="form-field"]')).not.toHaveTextContent("请选择到期日期");
    expect(startDateButton.closest('[data-slot="form-field"]')).not.toHaveTextContent("请选择到期日期");
    expect(startDateButton.closest('[data-slot="form-field"]')).not.toHaveTextContent("请选择购买日期");
    expect(screen.getByRole("button", { name: "生成导入预览" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "生成导入预览" }));
    expect(mocks.previewPrepared).not.toHaveBeenCalled();
  });

  it("一次性购买固定服务期缺购买日期时在购买日期字段提示", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([
      makeDraft({
        billingCycle: "one-time",
        startDate: null,
        nextBillingDate: null,
        oneTimeTermCount: 1,
        oneTimeTermUnit: "month",
        autoCalculateNextBillingDate: false,
      }),
    ]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 买断");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    expect(await screen.findByText("1 条草稿还有 1 个必填项待补全，补全后才能生成导入预览。")).toBeInTheDocument();
    const purchaseDateButton = document.getElementById("ai-draft-1-startDate");
    const expiryDateButton = document.getElementById("ai-draft-1-nextBillingDate");
    if (!(purchaseDateButton instanceof HTMLButtonElement) || !(expiryDateButton instanceof HTMLButtonElement)) {
      throw new Error("AI draft one-time date buttons were not rendered");
    }
    expect(purchaseDateButton).toHaveAttribute("aria-invalid", "true");
    expect(purchaseDateButton).toHaveAttribute("aria-describedby", "ai-draft-1-startDate-error");
    expect(purchaseDateButton.closest('[data-slot="form-field-row"]')).toHaveTextContent("请选择购买日期");
    expect(purchaseDateButton.closest('[data-slot="form-field"]')).not.toHaveTextContent("请选择购买日期");
    expect(expiryDateButton).toHaveAttribute("aria-invalid", "false");
    expect(expiryDateButton.closest('[data-slot="form-field"]')).not.toHaveTextContent("请选择到期日期");
    expect(screen.getByRole("button", { name: "生成导入预览" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "生成导入预览" }));
    expect(mocks.previewPrepared).not.toHaveBeenCalled();
  });

  it("可用当前表单默认值确认货币和周期", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([
      makeDraft({
        currency: null,
        billingCycle: null,
        nextBillingDate: "2026-07-01",
      }),
    ]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    expect(await screen.findByText("1 条草稿还有 2 个必填项待补全，补全后才能生成导入预览。")).toBeInTheDocument();
    expect(screen.getAllByText("请确认货币。").length).toBeGreaterThan(0);
    expect(screen.getAllByText("请确认扣费周期。").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "生成导入预览" })).toBeDisabled();

    await user.click(screen.getAllByRole("button", { name: "使用当前值" })[0]!);
    await waitFor(() => expect(screen.queryByText("请确认货币。")).not.toBeInTheDocument());
    expect(screen.getAllByText("请确认扣费周期。").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "生成导入预览" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "使用当前值" }));
    await waitFor(() => expect(screen.queryByText("请确认扣费周期。")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "生成导入预览" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "生成导入预览" }));

    await waitFor(() => expect(mocks.previewPrepared).toHaveBeenCalledTimes(1));
    const prepared = mocks.previewPrepared.mock.calls[0]?.[0] as PreparedImport;
    expect(prepared.payload.subscriptions[0]?.currency).toBe("CNY");
    expect(prepared.payload.subscriptions[0]?.billingCycle).toBe("monthly");
  });

  it("文本和图片同时提交", async () => {
    const user = userEvent.setup();
    const image = new File(["image"], "subscriptions.png", { type: "image/png" });
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await user.upload(screen.getByLabelText("添加订阅图片"), image);
    await screen.findByRole("button", { name: "预览图片 subscriptions.png" });
    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await waitFor(() => expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(1));
    expectRecognizeStreamCalledWith(mocks.recognizeSubscriptionsStream.mock.calls, {
      text: "apple 50刀 1年",
      images: [image],
      thinkingControl: null,
    });
  });

  it("图片和文本同时提交，并在删除缩略图时释放 object URL", async () => {
    const user = userEvent.setup();
    const image = new File(["image"], "subscriptions.png", { type: "image/png" });
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.upload(screen.getByLabelText("添加订阅图片"), image);
    await screen.findByRole("button", { name: "预览图片 subscriptions.png" });
    await user.click(screen.getByRole("button", { name: "移除图片" }));
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:subscriptions.png");

    await user.upload(screen.getByLabelText("添加订阅图片"), image);
    await screen.findByRole("button", { name: "预览图片 subscriptions.png" });
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await waitFor(() => expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(1));
    expectRecognizeStreamCalledWith(mocks.recognizeSubscriptionsStream.mock.calls, {
      text: "apple 50刀 1年",
      images: [image],
      thinkingControl: null,
    });
  });

  it("图片模式提交优化后的文件并展示优化后大小", async () => {
    const user = userEvent.setup();
    const original = new File([new Uint8Array(4 * 1024 * 1024)], "bill.png", { type: "image/png" });
    const optimized = new File([new Uint8Array(1536 * 1024)], "bill.webp", { type: "image/webp" });
    mocks.prepareAIRecognitionImage.mockResolvedValueOnce({
      file: optimized,
      originalSizeBytes: original.size,
      targetSizeBytes: 2 * 1024 * 1024,
      optimized: true,
      warning: null,
    });
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await user.upload(screen.getByLabelText("添加订阅图片"), original);

    expect(await screen.findByRole("button", { name: "预览图片 bill.webp" })).toBeInTheDocument();
    expect(screen.getByText(/1.5 MB/)).toBeInTheDocument();
    expect(screen.getByText(/原图 4.0 MB/)).toBeInTheDocument();
    expect(mocks.createObjectURL).toHaveBeenCalledWith(optimized);

    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await waitFor(() => expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(1));
    expectRecognizeStreamCalledWith(mocks.recognizeSubscriptionsStream.mock.calls, {
      text: "",
      images: [optimized],
      thinkingControl: null,
    });
  });

  it("图片优化中禁用继续添加和生成", async () => {
    const user = userEvent.setup();
    const image = new File(["image"], "slow.png", { type: "image/png" });
    let resolvePrepare: (value: unknown) => void = () => undefined;
    mocks.prepareAIRecognitionImage.mockReturnValueOnce(new Promise((resolve) => {
      resolvePrepare = resolve;
    }));
    renderDialog();

    await user.upload(screen.getByLabelText("添加订阅图片"), image);

    expect(await screen.findByText("正在优化")).toBeInTheDocument();
    expect(screen.getByTestId("ai-recognition-image-upload-button")).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成订阅草稿" })).toBeDisabled();

    resolvePrepare({
      file: image,
      originalSizeBytes: image.size,
      targetSizeBytes: 2 * 1024 * 1024,
      optimized: false,
      warning: null,
    });
    expect(await screen.findByRole("button", { name: "预览图片 slow.png" })).toBeInTheDocument();
  });

  it("超过 5MB 的图片上传前失败，不进入预处理和模型请求", async () => {
    const user = userEvent.setup();
    const image = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "too-large.png", { type: "image/png" });
    renderDialog();

    await user.upload(screen.getByLabelText("添加订阅图片"), image);

    await waitFor(() => expect(mocks.setError).toHaveBeenCalledWith("图片超过 5MB，请选择更小且清晰的截图。"));
    expect(mocks.prepareAIRecognitionImage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "预览图片 too-large.png" })).not.toBeInTheDocument();
  });

  it("按当前模型的思考控制选项传入本次识别请求", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    const settings = configuredSettings();
    renderDialog({
      ...settings,
      aiRecognition: {
        ...settings.aiRecognition,
        defaultThinkingControl: { provider: "openai", effort: "high" },
      },
    });

    expect(screen.getByRole("combobox", { name: "思考控制" })).toHaveTextContent("High");
    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await waitFor(() => expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(1));
    expectRecognizeStreamCalledWith(mocks.recognizeSubscriptionsStream.mock.calls, {
      text: "apple 50刀 1年",
      images: [],
      thinkingControl: { provider: "openai", effort: "high" },
    });
  });

  it("支持筛选、编辑选中草稿并复用导入预览构建", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([
      makeDraft(),
      makeDraft({
        name: "Netflix",
        price: null,
        currency: "USD",
        billingCycle: "monthly",
        category: "streaming",
        website: { value: "https://www.netflix.com/", source: "suggested" },
        tags: ["Streaming"],
        confidence: "low",
        warnings: ["AI_WARNING_PRICE_UNCERTAIN"],
      }),
    ]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年\nnetflix 1个月");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    await screen.findByText("Netflix");
    await user.click(screen.getByRole("button", { name: "缺核心字段" }));
    expect(screen.queryByText("Apple Music")).not.toBeInTheDocument();

    const nameInput = await screen.findByDisplayValue("Netflix");
    await user.clear(nameInput);
    await user.type(nameInput, "Netflix Premium");
    const priceInput = screen.getByLabelText("价格");
    await user.clear(priceInput);
    await user.type(priceInput, "66");
    await waitFor(() => expect(screen.getByRole("button", { name: "生成导入预览" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "生成导入预览" }));

    await waitFor(() => expect(mocks.previewPrepared).toHaveBeenCalledTimes(1));
    const prepared = mocks.previewPrepared.mock.calls[0]?.[0] as PreparedImport;
    expect(prepared.payload.source).toBe("ai");
    expect(prepared.payload.subscriptions.some((subscription) => subscription.name === "Netflix Premium")).toBe(true);
  });

  it("草稿阶段可以返回输入，修改输入后需要重新生成草稿", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream
      .mockResolvedValueOnce(makeResponse([makeDraft()]))
      .mockResolvedValueOnce(makeResponse([makeDraft({ name: "Spotify" })]));
    renderDialog();

    const textarea = screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表...");
    await user.type(textarea, "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));
    await screen.findByText("Apple Music");
    expect(screen.getByText(/1 条草稿 · 生成用时 \d+ 秒/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回输入" }));
    expect(screen.getByDisplayValue("apple 50刀 1年")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-draft-virtualized-list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回草稿" })).toBeInTheDocument();

    const returnedTextarea = screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表...");
    await user.type(returnedTextarea, "\nspotify 10刀 1个月");
    expect(screen.getByText("输入已变更，请重新生成草稿后再预览。")).toBeInTheDocument();
    expect(screen.queryByText(/生成用时 \d+ 秒/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回草稿" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新生成草稿" }));

    await screen.findByText("Spotify");
    expect(screen.getByText(/1 条草稿 · 生成用时 \d+ 秒/)).toBeInTheDocument();
    expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(2);
  });

  it("草稿编辑器不把 AI 返回的新配置名塞进下拉，导入预览仍会创建新项", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([
      makeDraft({
        category: "Cloud lab",
        paymentMethod: "Personal card",
        tags: ["Apple"],
      }),
    ]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    expect(await screen.findByRole("combobox", { name: "选择货币" })).toBeInTheDocument();
    expect(screen.queryByText("Cloud lab")).not.toBeInTheDocument();
    expect(screen.queryByText("Personal card")).not.toBeInTheDocument();
    expect(screen.getByText("Apple")).toBeInTheDocument();

    const addAsNewConfigButtons = screen.getAllByRole("button", { name: "添加为新配置" });
    expect(addAsNewConfigButtons).toHaveLength(2);
    await user.click(addAsNewConfigButtons[0]!);
    await user.click(screen.getByRole("button", { name: "添加为新配置" }));

    const priceInput = screen.getByLabelText("价格");
    await user.clear(priceInput);
    await user.type(priceInput, "66");
    await waitFor(() => expect(screen.getByRole("button", { name: "生成导入预览" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "生成导入预览" }));

    await waitFor(() => expect(mocks.previewPrepared).toHaveBeenCalledTimes(1));
    const prepared = mocks.previewPrepared.mock.calls[0]?.[0] as PreparedImport;
    expect(prepared.payload.subscriptions[0]?.price).toBe("66");
    expect(prepared.payload.customConfig?.categories.some((item) => item.labels["zh-CN"] === "Cloud lab")).toBe(true);
    expect(prepared.payload.customConfig?.paymentMethods.some((item) => item.labels["zh-CN"] === "Personal card")).toBe(true);
  });

});
