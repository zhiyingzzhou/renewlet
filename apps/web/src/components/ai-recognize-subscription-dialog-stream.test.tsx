import type { ReactNode } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualItem } from "@tanstack/react-virtual";
import { ApiError } from "@/lib/api-client";
import type { AiRecognitionStreamEvent, AiRecognizeResponse } from "@/lib/api/schemas/ai-recognition";
import {
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
}));

vi.mock("@/services/ai-recognition-service", () => ({
  aiRecognitionService: {
    recognizeSubscriptionsStream: mocks.recognizeSubscriptionsStream,
  },
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

const TEXT_PLACEHOLDER = "粘贴记事本、备忘录或从 Excel 复制出的订阅列表...";

async function enterTextAndGenerate(user: ReturnType<typeof userEvent.setup>, text: string, button = "生成订阅草稿") {
  await user.type(screen.getByPlaceholderText(TEXT_PLACEHOLDER), text);
  await user.click(screen.getByRole("button", { name: button }));
}

describe("AIRecognizeSubscriptionDialog stream overlay", () => {
  beforeEach(() => {
    mocks.recognizeSubscriptionsStream.mockReset();
    mocks.previewPrepared.mockReset();
    mocks.resetImportPreview.mockReset();
    mocks.setError.mockReset();
    mocks.importPreviewPanel.mockReset();
    mocks.previewState.prepared = null;
    mocks.previewState.preview = null;
    mocks.previewState.error = null;
    mocks.setError.mockImplementation((error: string | null) => {
      mocks.previewState.error = error;
    });
    mocks.previewPrepared.mockImplementation(async () => {
      mocks.previewState.prepared = {};
      mocks.previewState.preview = makePreview();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("生成时显示遮罩、真实流式反馈和耗时，final 后进入草稿", async () => {
    vi.useFakeTimers();
    let streamHandlers: { onEvent?: (event: AiRecognitionStreamEvent) => void } | undefined;
    let resolveRecognition: (response: AiRecognizeResponse) => void = () => undefined;
    mocks.recognizeSubscriptionsStream.mockImplementation((_input: unknown, handlers?: { onEvent?: (event: AiRecognitionStreamEvent) => void }) => {
      streamHandlers = handlers;
      return new Promise<AiRecognizeResponse>((resolve) => {
        resolveRecognition = resolve;
      });
    });
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText(TEXT_PLACEHOLDER), { target: { value: "apple 50刀 1年" } });
    fireEvent.click(screen.getByRole("button", { name: "生成订阅草稿" }));

    // 遮罩必须挂在 workspace 上方而不是 body portal，否则移动端 footer/滚动容器会和流式状态错层。
    const overlay = screen.getByTestId("ai-recognition-stream-overlay");
    const panel = within(overlay).getByTestId("ai-recognition-stream-panel");
    expect(screen.getByTestId("ai-recognition-dialog-workspace")).toHaveClass("relative", "overflow-hidden");
    expect(overlay).toHaveClass("absolute", "inset-0", "z-20", "bg-card/75", "backdrop-blur-[2px]");
    expect(screen.getByTestId("ai-recognition-dialog-body")).not.toContainElement(panel);
    expect(screen.getByPlaceholderText(TEXT_PLACEHOLDER)).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" })).toBeEnabled();
    expect(panel).toHaveTextContent("识别进度");
    expect(panel).toHaveTextContent("生成中");
    expect(panel).toHaveTextContent("等待模型返回");
    expect(panel).toHaveTextContent("已用时 1 秒");
    expect(panel).not.toHaveTextContent("思考过程");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(panel).toHaveTextContent(/已用时 \d+ 秒/);

    await act(async () => {
      streamHandlers?.onEvent?.({ type: "recognition/progress", stage: "model-start" });
      streamHandlers?.onEvent?.({ type: "recognition/partial", subscriptionsSeen: 1, warningsSeen: 2 });
      streamHandlers?.onEvent?.({ type: "recognition/text-delta", delta: "{\"subscriptions\"" });
    });
    expect(panel).toHaveTextContent("连接模型");
    expect(panel).toHaveTextContent("已看到草稿");
    expect(panel).toHaveTextContent("2");
    expect(panel).toHaveTextContent("可见输出");
    expect(panel).toHaveTextContent("{\"subscriptions\"");
    expect(panel).not.toHaveTextContent("思考过程");

    await act(async () => {
      streamHandlers?.onEvent?.({ type: "recognition/reasoning-delta", delta: "先确认服务名称" });
    });
    expect(panel).not.toHaveTextContent("思考过程");
    expect(panel).not.toHaveTextContent("先确认服务名称");

    await act(async () => {
      streamHandlers?.onEvent?.({ type: "recognition/final", response: makeResponse([makeDraft()]) });
      resolveRecognition(makeResponse([makeDraft()]));
      await Promise.resolve();
    });
    // final 是唯一进入草稿列表的事件；前面的 text/reasoning delta 只允许影响状态面板。
    expect(screen.getByText("Apple Music")).toBeInTheDocument();
    expect(screen.getByText(/1 条草稿 · 生成用时 \d+ 秒/)).toBeInTheDocument();
    expect(screen.queryByTestId("ai-recognition-stream-overlay")).not.toBeInTheDocument();
  });

  it("收到清洗后的 nullable website final 后关闭遮罩并进入草稿", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([
      makeDraft({ name: "LocVPS", website: null, notes: { value: "LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。", source: "suggested" }, tags: ["VPS", "云主机"] }),
    ]));
    renderDialog();

    await enterTextAndGenerate(user, "locvps 20元 一个月");

    expect(await screen.findByText("LocVPS")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-recognition-stream-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 返回内容无法整理成订阅草稿，请换用更强的模型或补充更明确的价格、周期和名称。")).not.toBeInTheDocument();
  });

  it("识别错误后可以关闭遮罩并回到输入区", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const rawResponse = "{\"code\":\"INVALID_API_KEY\",\"message\":\"bad key\"}";
    const prettyResponse = JSON.stringify(JSON.parse(rawResponse), null, 2);
    mocks.recognizeSubscriptionsStream.mockRejectedValue(new ApiError(
      "AI 识别失败",
      400,
      {
        rawResponseText: rawResponse,
      },
      "AI_RECOGNITION_FAILED",
      rawResponse,
    ));
    renderDialog();

    await enterTextAndGenerate(user, "apple 50刀 1年");

    const detailsDialog = await screen.findByRole("dialog", { name: "AI 错误详情" });
    const fixedDialogClass = "h-[min(calc(var(--app-viewport-height)-2rem),42rem)]";
    expect(detailsDialog).toHaveClass(fixedDialogClass);
    expect(detailsDialog).not.toHaveClass("h-fit");
    expect(within(detailsDialog).getByText(/INVALID_API_KEY/)).toBeInTheDocument();
    await user.click(within(detailsDialog).getByRole("button", { name: "复制错误详情" }));
    expect(writeText).toHaveBeenCalledWith(prettyResponse);
    await user.click(within(detailsDialog).getByRole("button", { name: "关闭" }));

    const panel = within(await screen.findByTestId("ai-recognition-stream-overlay")).getByTestId("ai-recognition-stream-panel");
    expect(panel).toHaveTextContent("出错");
    expect(panel).toHaveTextContent(/用时 \d+ 秒/);
    expect(within(panel).getByRole("button", { name: "查看错误响应" })).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "重新生成草稿" })).not.toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "关闭" }));

    expect(screen.queryByTestId("ai-recognition-stream-overlay")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("apple 50刀 1年")).toBeEnabled();
    expect(screen.getByRole("button", { name: "查看上次响应" })).toBeInTheDocument();
    expect(screen.queryByText(/生成用时 \d+ 秒/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-draft-virtualized-list")).not.toBeInTheDocument();
    expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(1);
  });

  it("识别 schema 失败时原始响应显示接口 body", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const rawResponse = "{\"code\":\"AI_RECOGNITION_SCHEMA_MISMATCH\",\"message\":\"schema mismatch\"}";
    const prettyResponse = JSON.stringify(JSON.parse(rawResponse), null, 2);
    mocks.recognizeSubscriptionsStream.mockRejectedValue(new ApiError(
      "AI 返回内容无法整理成订阅草稿",
      400,
      {
        rawResponseText: rawResponse,
      },
      "AI_RECOGNITION_SCHEMA_MISMATCH",
      rawResponse,
    ));
    renderDialog();

    await enterTextAndGenerate(user, "bad model output");

    const detailsDialog = await screen.findByRole("dialog", { name: "AI 错误详情" });
    expect(detailsDialog.querySelector("pre")?.textContent).toBe(prettyResponse);
    await user.click(within(detailsDialog).getByRole("button", { name: "复制错误详情" }));
    expect(writeText).toHaveBeenCalledWith(prettyResponse);
  });

  it("没有 response body 时显示错误 message", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.recognizeSubscriptionsStream.mockRejectedValue(new ApiError(
      "AI 识别失败",
      400,
      undefined,
      "AI_RECOGNITION_FAILED",
    ));
    renderDialog();

    await enterTextAndGenerate(user, "empty provider response");

    const detailsDialog = await screen.findByRole("dialog", { name: "AI 错误详情" });
    expect(within(detailsDialog).getAllByText("AI 识别失败").length).toBeGreaterThan(0);
    await user.click(within(detailsDialog).getByRole("button", { name: "复制错误详情" }));
    expect(writeText).toHaveBeenCalledWith("AI 识别失败");
  });

  it("识别错误后通过 footer 重新生成，避免遮罩内重复操作", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream
      .mockResolvedValueOnce(makeResponse([makeDraft()]))
      .mockRejectedValueOnce(new Error("provider timeout"))
      .mockResolvedValueOnce(makeResponse([makeDraft({ name: "Spotify" })]));
    renderDialog();

    await enterTextAndGenerate(user, "apple 50刀 1年");
    await screen.findByText("Apple Music");
    await user.click(screen.getByRole("button", { name: "返回输入" }));
    await enterTextAndGenerate(user, "\nspotify 10刀 1个月", "重新生成草稿");

    const overlay = await screen.findByTestId("ai-recognition-stream-overlay");
    // 错误态遮罩只解释本次失败；重新生成必须回到 footer，保证新 runId/AbortController 重新建立。
    expect(within(overlay).queryByRole("button", { name: "重新生成草稿" })).not.toBeInTheDocument();
    const detailsDialog = await screen.findByRole("dialog", { name: "AI 错误详情" });
    await user.click(within(detailsDialog).getByRole("button", { name: "关闭" }));
    await user.click(within(overlay).getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "重新生成草稿" }));

    expect(await screen.findByText("Spotify")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-recognition-stream-overlay")).not.toBeInTheDocument();
    expect(mocks.recognizeSubscriptionsStream).toHaveBeenCalledTimes(3);
  });

  it("识别中止后不会把停止态遮罩卡在工作区", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockRejectedValue({ code: "aborted", message: "请求已取消" });
    renderDialog();

    await enterTextAndGenerate(user, "apple 50刀 1年");

    const panel = await screen.findByTestId("ai-recognition-stream-panel");
    expect(panel).toHaveTextContent("已停止");
    expect(panel).toHaveTextContent(/用时 \d+ 秒/);
    await user.click(within(panel).getByRole("button", { name: "关闭" }));

    expect(screen.queryByTestId("ai-recognition-stream-overlay")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("apple 50刀 1年")).toBeEnabled();
    expect(screen.queryByText(/生成用时 \d+ 秒/)).not.toBeInTheDocument();
  });

  it("H5 生成时遮罩只覆盖工作区，不覆盖底部操作区", async () => {
    const user = userEvent.setup();
    let resolveRecognition: (response: AiRecognizeResponse) => void = () => undefined;
    mockMobile();
    mocks.recognizeSubscriptionsStream.mockReturnValue(new Promise<AiRecognizeResponse>((resolve) => {
      resolveRecognition = resolve;
    }));
    renderDialog();

    await enterTextAndGenerate(user, "apple 50刀 1年");

    const overlay = await screen.findByTestId("ai-recognition-stream-overlay");
    const footer = screen.getByTestId("ai-recognition-mobile-footer");
    expect(overlay).toHaveClass("absolute", "inset-0", "z-20");
    expect(overlay).not.toContainElement(footer);
    expect(within(overlay).getByTestId("ai-recognition-stream-panel")).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "识别中..." })).toBeDisabled();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" })).toBeEnabled();

    await act(async () => {
      resolveRecognition(makeResponse([makeDraft()]));
    });
    expect(await screen.findByText("Apple Music")).toBeInTheDocument();
  });
});
